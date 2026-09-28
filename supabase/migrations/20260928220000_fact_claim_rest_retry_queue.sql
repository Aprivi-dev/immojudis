begin;

-- The PostgREST publication fallback writes the catalogue before its
-- additive, source-backed fact claims. Keep a failed claim write in the
-- existing bounded enrichment queue so the catalogue does not need to be
-- republished and the retry can be observed and leased like other work.
alter table public.auction_enrichment_jobs
  drop constraint if exists auction_enrichment_jobs_job_type_check;

alter table public.auction_enrichment_jobs
  add constraint auction_enrichment_jobs_job_type_check
  check (job_type in ('pdf', 'fact_extraction', 'display_description', 'source_detail', 'fact_claims'));

comment on constraint auction_enrichment_jobs_job_type_check
  on public.auction_enrichment_jobs is
  'fact_claims is a bounded, non-LLM replay of REST fact-candidate publication failures.';

-- A REST claim failure is an observation write failure, so the retry must keep
-- the candidate rows that were actually extracted.  The queue is service-role
-- only; this snapshot never becomes part of the public listing payload.
alter table public.auction_enrichment_jobs
  add column if not exists fact_claims_snapshot jsonb;

alter table public.auction_enrichment_jobs
  drop constraint if exists auction_enrichment_jobs_fact_claims_snapshot_check;

alter table public.auction_enrichment_jobs
  add constraint auction_enrichment_jobs_fact_claims_snapshot_check
  check (
    fact_claims_snapshot is null
    or (
      job_type = 'fact_claims'
      and jsonb_typeof(fact_claims_snapshot) = 'array'
      and jsonb_array_length(fact_claims_snapshot) > 0
    )
  );

comment on column public.auction_enrichment_jobs.fact_claims_snapshot is
  'Service-role-only candidate rows captured when a fact_claims REST publication fails; replay rekeys them to the current canonical sale id.';

-- The family claim RPC predates fact_claims and cancels older revisions by
-- (source_url, job_type).  Protect only that exact supersession reason for
-- fact_claims so append-only observations remain replayable.  Other queue
-- cleanup, including retention cancellation, keeps its existing behavior.
create or replace function app_private.protect_fact_claim_retry_snapshot()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if old.job_type = 'fact_claims'
     and new.status = 'cancelled'
     and new.last_error = 'Superseded by a newer input revision' then
    -- Skip the generic supersession update altogether.  The claim RPC does
    -- not use RETURNING for this cleanup, so no caller depends on a row count.
    return null;
  end if;
  return new;
end;
$$;

revoke all on function app_private.protect_fact_claim_retry_snapshot()
  from public, anon, authenticated;
grant execute on function app_private.protect_fact_claim_retry_snapshot()
  to service_role;

drop trigger if exists protect_fact_claim_retry_snapshot
  on public.auction_enrichment_jobs;
create trigger protect_fact_claim_retry_snapshot
before update of status, last_error on public.auction_enrichment_jobs
for each row
when (
  old.job_type = 'fact_claims'
  and new.status = 'cancelled'
  and new.last_error = 'Superseded by a newer input revision'
)
execute function app_private.protect_fact_claim_retry_snapshot();

comment on trigger protect_fact_claim_retry_snapshot on public.auction_enrichment_jobs is
  'Fact claim observations are not discarded by the generic superseded-revision cleanup; retention cancellation remains unchanged.';

notify pgrst, 'reload schema';

commit;
