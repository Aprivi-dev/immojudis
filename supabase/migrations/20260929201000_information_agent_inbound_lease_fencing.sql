begin;

-- The queue lease and the message checkpoint must move together. A worker can
-- be paused after a claim and resumed after another worker has reclaimed the
-- job; replacing the lease in the message metadata makes every subsequent
-- checkpoint update an atomic compare-and-set as well.
with expired as (
  update public.information_agent_inbound_jobs job
  set status = 'review',
      locked_at = null,
      lease_id = null,
      last_error = coalesce(
        last_error,
        'Inbound worker lease expired after retry budget was exhausted.'
      ),
      updated_at = statement_timestamp()
  where job.status = 'processing'
    and job.attempts >= 10
    and job.locked_at < statement_timestamp() - interval '10 minutes'
  returning job.message_id
)
update public.information_agent_messages message
set metadata = jsonb_set(
  coalesce(message.metadata, '{}'::jsonb),
  '{inbound_processing}',
  (
    (
      case
        when jsonb_typeof(message.metadata->'inbound_processing') = 'object'
          then message.metadata->'inbound_processing'
        else '{}'::jsonb
      end
      || jsonb_build_object(
        'status', 'review',
        'reason', 'retry_budget_exhausted'
      )
    ) #- '{lease_id}'
  ),
  true
)
from expired
where message.id = expired.message_id;

create or replace function public.claim_information_agent_inbound_jobs(
  p_limit integer default 5,
  p_now timestamptz default statement_timestamp()
)
returns setof public.information_agent_inbound_jobs
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_limit is null or p_limit < 1 or p_limit > 10 or p_now is null then
    raise exception using
      errcode = '22023',
      message = 'Inbound queue claim requires a timestamp and a batch size between 1 and 10.';
  end if;

  with expired as (
    update public.information_agent_inbound_jobs job
    set status = 'review',
        locked_at = null,
        lease_id = null,
        last_error = coalesce(
          last_error,
          'Inbound worker lease expired after retry budget was exhausted.'
        ),
        updated_at = p_now
    where job.status = 'processing'
      and job.attempts >= 10
      and job.locked_at < p_now - interval '10 minutes'
    returning job.message_id
  )
  update public.information_agent_messages message
  set metadata = jsonb_set(
    coalesce(message.metadata, '{}'::jsonb),
    '{inbound_processing}',
    (
      (
        case
          when jsonb_typeof(message.metadata->'inbound_processing') = 'object'
            then message.metadata->'inbound_processing'
          else '{}'::jsonb
        end
        || jsonb_build_object(
          'status', 'review',
          'reason', 'retry_budget_exhausted'
        )
      ) #- '{lease_id}'
    ),
    true
  )
  from expired
  where message.id = expired.message_id;

  return query
  with candidates as (
    select job.id
    from public.information_agent_inbound_jobs job
    where job.attempts < 10
      and job.available_at <= p_now
      and (
        job.status in ('queued', 'failed')
        or (
          job.status = 'processing'
          and job.locked_at < p_now - interval '10 minutes'
        )
      )
    order by job.available_at asc, job.created_at asc
    for update skip locked
    limit p_limit
  ),
  claimed as (
    update public.information_agent_inbound_jobs job
    set status = 'processing',
        attempts = job.attempts + 1,
        locked_at = p_now,
        lease_id = gen_random_uuid(),
        last_error = null,
        updated_at = p_now
    from candidates
    where job.id = candidates.id
    returning job.*
  ),
  fenced_messages as (
    update public.information_agent_messages message
    set metadata = jsonb_set(
      coalesce(message.metadata, '{}'::jsonb),
      '{inbound_processing}',
      (
        case
          when jsonb_typeof(message.metadata->'inbound_processing') = 'object'
            then message.metadata->'inbound_processing'
          else '{}'::jsonb
        end
        || jsonb_build_object('lease_id', claimed.lease_id::text)
      ),
      true
    )
    from claimed
    where message.id = claimed.message_id
    returning message.id as message_id
  )
  select claimed.*
  from claimed
  join fenced_messages fenced on fenced.message_id = claimed.message_id;
end;
$$;

revoke all on function public.claim_information_agent_inbound_jobs(integer, timestamptz)
from public, anon, authenticated;
grant execute on function public.claim_information_agent_inbound_jobs(integer, timestamptz)
to service_role;

-- Inbound business writes carry the worker lease and message ID in their
-- transient metadata. Locking the queue row and then the parent message in
-- the same order as the claim function serializes these writes with the
-- claim-side metadata replacement, so a stale worker cannot publish a row
-- after its lease has been reclaimed.
create or replace function app_private.enforce_information_agent_inbound_write_lease()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  expected_lease text := new.metadata->>'inbound_lease_id';
  expected_message_id text;
  row_message_id text := pg_catalog.to_jsonb(new)->>'message_id';
  row_case_id text := pg_catalog.to_jsonb(new)->>'case_id';
  row_id text := pg_catalog.to_jsonb(new)->>'id';
  current_job_status text;
  current_job_lease text;
  current_message_case_id text;
  current_lease text;
begin
  if expected_lease is null then
    return new;
  end if;

  expected_message_id := nullif(new.metadata->>'inbound_message_id', '');

  -- Match the claim function's job-then-message lock order. A single joined
  -- SELECT would leave row-lock order to the planner and could deadlock a
  -- claim racing a business write.
  select job.status, job.lease_id::text
  into current_job_status, current_job_lease
  from public.information_agent_inbound_jobs job
  where job.message_id::text = expected_message_id
  for update;

  if current_job_status is distinct from 'processing'
     or current_job_lease is distinct from expected_lease then
    raise exception using
      errcode = '40001',
      message = 'Inbound worker lease lost.';
  end if;

  select message.metadata #>> '{inbound_processing,lease_id}'
       , message.case_id::text
  into current_lease, current_message_case_id
  from public.information_agent_messages message
  where message.id::text = expected_message_id
  for update;

  if current_lease is distinct from expected_lease then
    raise exception using
      errcode = '40001',
      message = 'Inbound worker lease lost.';
  end if;

  if tg_table_name in ('information_agent_evidence_assets', 'information_agent_fact_candidates')
     and (row_message_id is distinct from expected_message_id
          or row_case_id is distinct from current_message_case_id)
  then
    raise exception using
      errcode = '40001',
      message = 'Inbound worker lease target mismatch.';
  elsif tg_table_name = 'information_agent_cases'
     and row_id is distinct from current_message_case_id
  then
    raise exception using
      errcode = '40001',
      message = 'Inbound worker lease target mismatch.';
  elsif tg_table_name = 'information_agent_missions'
     and row_case_id is distinct from current_message_case_id
  then
    raise exception using
      errcode = '40001',
      message = 'Inbound worker lease target mismatch.';
  elsif tg_table_name not in (
    'information_agent_evidence_assets',
    'information_agent_fact_candidates',
    'information_agent_cases',
    'information_agent_missions'
  )
  then
    raise exception using
      errcode = '40001',
      message = 'Inbound worker lease trigger target unsupported.';
  end if;

  -- The token is an internal fence, not application data for subscribers.
  new.metadata := new.metadata - 'inbound_lease_id' - 'inbound_message_id';
  return new;
end;
$$;

revoke all on function app_private.enforce_information_agent_inbound_write_lease()
from public, anon, authenticated;

drop trigger if exists information_agent_evidence_assets_inbound_lease
on public.information_agent_evidence_assets;
create trigger information_agent_evidence_assets_inbound_lease
before insert on public.information_agent_evidence_assets
for each row
execute function app_private.enforce_information_agent_inbound_write_lease();

drop trigger if exists information_agent_cases_inbound_lease
on public.information_agent_cases;
create trigger information_agent_cases_inbound_lease
before update on public.information_agent_cases
for each row
execute function app_private.enforce_information_agent_inbound_write_lease();

drop trigger if exists information_agent_missions_inbound_lease
on public.information_agent_missions;
create trigger information_agent_missions_inbound_lease
before update on public.information_agent_missions
for each row
execute function app_private.enforce_information_agent_inbound_write_lease();

drop trigger if exists information_agent_fact_candidates_inbound_lease
on public.information_agent_fact_candidates;
create trigger information_agent_fact_candidates_inbound_lease
before insert on public.information_agent_fact_candidates
for each row
execute function app_private.enforce_information_agent_inbound_write_lease();

notify pgrst, 'reload schema';

commit;
