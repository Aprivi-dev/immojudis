begin;

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

  -- A process can die after the final claim and before it reports the error.
  -- Quarantine that stale lease so the row cannot remain permanently stuck in
  -- processing once the ten-attempt retry budget has been consumed.
  update public.information_agent_inbound_jobs
  set status = 'review',
      locked_at = null,
      lease_id = null,
      last_error = coalesce(
        last_error,
        'Inbound worker lease expired after retry budget was exhausted.'
      ),
      updated_at = p_now
  where status = 'processing'
    and attempts >= 10
    and locked_at < p_now - interval '10 minutes';

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

commit;
