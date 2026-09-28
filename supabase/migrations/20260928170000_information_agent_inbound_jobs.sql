begin;

-- The Resend webhook only records a verified receipt.  Attachment downloads and
-- fact extraction run from this durable queue so a short-lived provider link is
-- refreshed on every retry instead of being held by a request invocation.
create table if not exists public.information_agent_inbound_jobs (
  id uuid primary key default gen_random_uuid(),
  message_id uuid not null unique
    references public.information_agent_messages(id) on delete cascade,
  case_id uuid not null
    references public.information_agent_cases(id) on delete cascade,
  provider_email_id text not null unique check (char_length(provider_email_id) between 1 and 200),
  status text not null default 'queued' check (
    status in ('queued', 'processing', 'completed', 'failed', 'review', 'ignored')
  ),
  attempts integer not null default 0 check (attempts between 0 and 10),
  available_at timestamptz not null default now(),
  locked_at timestamptz,
  lease_id uuid,
  attachment_link_expires_at timestamptz not null,
  last_error text check (last_error is null or char_length(last_error) <= 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.information_agent_inbound_jobs is
  'Durable, service-only queue for verified inbound replies. Body receipt is persisted before attachment processing.';

create index if not exists information_agent_inbound_jobs_queue_idx
  on public.information_agent_inbound_jobs (status, available_at, created_at)
  where status in ('queued', 'failed', 'processing');

create index if not exists information_agent_inbound_jobs_case_idx
  on public.information_agent_inbound_jobs (case_id, created_at desc);

alter table public.information_agent_inbound_jobs enable row level security;
revoke all on table public.information_agent_inbound_jobs from public, anon, authenticated;
grant select, insert, update, delete on table public.information_agent_inbound_jobs to service_role;

drop trigger if exists information_agent_inbound_jobs_updated_at
on public.information_agent_inbound_jobs;
create trigger information_agent_inbound_jobs_updated_at
before update on public.information_agent_inbound_jobs
for each row execute function app_private.set_user_profiles_updated_at();

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
  )
  update public.information_agent_inbound_jobs job
  set status = 'processing',
      attempts = job.attempts + 1,
      locked_at = p_now,
      lease_id = gen_random_uuid(),
      last_error = null,
      updated_at = p_now
  from candidates
  where job.id = candidates.id
  returning job.*;
end;
$$;

revoke all on function public.claim_information_agent_inbound_jobs(integer, timestamptz)
from public, anon, authenticated;
grant execute on function public.claim_information_agent_inbound_jobs(integer, timestamptz)
to service_role;

-- Include the two-minute worker in the existing operational-health stale-job
-- check.  Refuse to guess if a later migration changed that expected list.
do $$
declare
  definition text;
begin
  definition := pg_get_functiondef('app_private.evaluate_operational_health(timestamptz)'::regprocedure);
  if position('(''information-agent-inbound''' in definition) = 0 then
    if position('(''sale-retention'', interval ''20 minutes''),' in definition) = 0 then
      raise exception 'Operational health expected-jobs list changed; review inbound queue monitoring';
    end if;
    execute replace(
      definition,
      '(''sale-retention'', interval ''20 minutes''),',
      '(''sale-retention'', interval ''20 minutes''), (''information-agent-inbound'', interval ''10 minutes''),'
    );
  end if;
end $$;

notify pgrst, 'reload schema';

commit;
