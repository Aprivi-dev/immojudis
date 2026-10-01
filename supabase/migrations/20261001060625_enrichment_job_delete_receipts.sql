begin;

-- Queue rows can disappear with their catalogue parent. Claim receipts prove
-- that work was leased, but intentionally do not record its final disposition.
-- Keep deletion evidence separately; never turn a missing row into a success.
create table app_private.auction_enrichment_delete_receipts (
  job_id uuid primary key,
  job_type text not null,
  status_before_delete text not null,
  attempt_count integer not null,
  max_attempts integer not null,
  next_attempt_at timestamptz not null,
  locked_at timestamptz,
  completed_at timestamptz,
  job_created_at timestamptz not null,
  job_updated_at timestamptz not null,
  deleted_at timestamptz not null default statement_timestamp(),
  deletion_context text not null check (
    deletion_context in ('catalogue_row_absent', 'catalogue_row_present')
  )
);

create index auction_enrichment_delete_receipts_deleted_at_idx
  on app_private.auction_enrichment_delete_receipts(deleted_at, job_id);

comment on table app_private.auction_enrichment_delete_receipts is
  'Private transactional DELETE evidence, retained for 30 days. The observed status is not a success assertion. No URL, input hash, error text, contact or document is retained. No historical backfill.';
comment on column app_private.auction_enrichment_delete_receipts.deletion_context is
  'Only parent existence at deletion is observed. Absence does not assert expiry, sale outcome, or the identity of the deleting process.';

alter table app_private.auction_enrichment_delete_receipts enable row level security;
revoke all on table app_private.auction_enrichment_delete_receipts
  from public, anon, authenticated, service_role;
grant select on table app_private.auction_enrichment_delete_receipts to service_role;
create policy auction_enrichment_delete_receipts_internal_read
  on app_private.auction_enrichment_delete_receipts
  for select to service_role using (true);

-- The trusted trigger needs write access to the private evidence table;
-- callers receive no INSERT/UPDATE/DELETE or function EXECUTE permission.
create function app_private.record_auction_enrichment_job_delete()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op <> 'DELETE' or tg_relid <> 'public.auction_enrichment_jobs'::regclass then
    raise exception using errcode = '55000',
      message = 'Enrichment deletion evidence requires the queue DELETE trigger.';
  end if;

  insert into app_private.auction_enrichment_delete_receipts (
    job_id, job_type, status_before_delete, attempt_count, max_attempts,
    next_attempt_at, locked_at, completed_at, job_created_at, job_updated_at,
    deleted_at, deletion_context
  ) values (
    old.id, old.job_type, old.status, old.attempt_count, old.max_attempts,
    old.next_attempt_at, old.locked_at, old.completed_at, old.created_at, old.updated_at,
    statement_timestamp(),
    case when exists (
      select 1 from public.auction_sales where source_url = old.source_url
    ) then 'catalogue_row_present' else 'catalogue_row_absent' end
  );
  return old;
end;
$$;

revoke all on function app_private.record_auction_enrichment_job_delete()
  from public, anon, authenticated, service_role;

create trigger auction_enrichment_jobs_delete_receipt
after delete on public.auction_enrichment_jobs
for each row execute function app_private.record_auction_enrichment_job_delete();

-- TRUNCATE bypasses row deletion evidence. Use the existing bounded DELETE
-- procedures so even catalogue cascades preserve the observed queue state.
create function app_private.reject_auction_enrichment_jobs_truncate()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  raise exception using errcode = '55000',
    message = 'Enrichment queue requires DELETE with transactional evidence.';
end;
$$;
revoke all on function app_private.reject_auction_enrichment_jobs_truncate()
  from public, anon, authenticated, service_role;
revoke truncate on public.auction_enrichment_jobs
  from public, anon, authenticated, service_role;
create trigger auction_enrichment_jobs_no_truncate
before truncate on public.auction_enrichment_jobs
for each statement execute function app_private.reject_auction_enrichment_jobs_truncate();

create function app_private.purge_auction_enrichment_delete_receipts(
  p_limit integer default 10000
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  deleted_count bigint;
begin
  if p_limit is null or p_limit < 1 or p_limit > 100000 then
    raise exception using errcode = '22023',
      message = 'Deletion receipt retention requires a batch size between 1 and 100000.';
  end if;

  with doomed as (
    select job_id from app_private.auction_enrichment_delete_receipts
    where deleted_at < statement_timestamp() - interval '30 days'
    order by deleted_at, job_id limit p_limit
  )
  delete from app_private.auction_enrichment_delete_receipts receipt
  using doomed where receipt.job_id = doomed.job_id;
  get diagnostics deleted_count = row_count;
  return deleted_count;
end;
$$;
revoke all on function app_private.purge_auction_enrichment_delete_receipts(integer)
  from public, anon, authenticated, service_role;
grant execute on function app_private.purge_auction_enrichment_delete_receipts(integer)
  to service_role;

-- Add one bounded purge to the existing daily job; do not add a scheduler.
do $retention_hook$
declare
  retention_job_id bigint;
  retention_command text;
begin
  if to_regclass('cron.job') is null then
    return;
  end if;
  execute 'select jobid, command from cron.job where jobname = $1'
    into retention_job_id, retention_command
    using 'immojudis-operational-history-retention';
  if retention_job_id is null or retention_command is null then
    raise exception using errcode = '55000',
      message = 'Deletion receipt retention requires the existing operational history job.';
  end if;
  if position('purge_auction_enrichment_delete_receipts' in retention_command) > 0 then
    return;
  end if;
  retention_command := rtrim(retention_command);
  if right(retention_command, 1) <> ';' then
    retention_command := retention_command || ';';
  end if;
  execute 'select cron.alter_job($1, command := $2)'
    using retention_job_id,
      retention_command || E'\nselect app_private.purge_auction_enrichment_delete_receipts();';
end;
$retention_hook$;

commit;
