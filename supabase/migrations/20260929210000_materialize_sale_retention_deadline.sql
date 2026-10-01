begin;

-- Retention eligibility is a row property. Persist it once so the scheduled
-- purge can use a B-tree range instead of parsing large JSON payloads for the
-- full catalogue on every tick. The ready fence distinguishes a legitimate
-- NULL deadline (unknown/postponed/malformed data is retained) from a row
-- which has not completed the bounded backfill yet.
alter table public.auction_sales
  add column if not exists retention_deadline timestamptz,
  add column if not exists retention_deadline_materialized boolean not null default false;

comment on column public.auction_sales.retention_deadline is
  'Computed sale retention deadline. NULL means the retention policy keeps the sale.';
comment on column public.auction_sales.retention_deadline_materialized is
  'Internal backfill fence; true means retention_deadline was computed from the four source fields.';

create or replace function app_private.set_auction_sale_retention_deadline()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.retention_deadline := app_private.sale_retention_deadline(
    new.sale_date,
    new.status,
    new.sale_procedure,
    new.raw_payload
  );
  new.retention_deadline_materialized := true;
  return new;
end;
$$;

revoke all on function app_private.set_auction_sale_retention_deadline()
  from public, anon, authenticated, service_role;
grant execute on function app_private.set_auction_sale_retention_deadline()
  to service_role;

-- PostgreSQL's UPDATE OF list is based on the columns named by the original
-- UPDATE statement.  It does not notice a previous BEFORE trigger changing a
-- source field in NEW.  Same-kind triggers run alphabetically, so the zzzz
-- prefix keeps this trigger after the existing catalogue guards.  The WHEN
-- clause keeps an unrelated write cheap while a guard changing raw_payload or
-- status still refreshes the deadline.
drop trigger if exists auction_sales_retention_deadline on public.auction_sales;
drop trigger if exists zzzz_auction_sales_retention_deadline_insert on public.auction_sales;
drop trigger if exists zzzz_auction_sales_retention_deadline_update on public.auction_sales;
create trigger zzzz_auction_sales_retention_deadline_insert
before insert on public.auction_sales
for each row
execute function app_private.set_auction_sale_retention_deadline();

create trigger zzzz_auction_sales_retention_deadline_update
before update on public.auction_sales
for each row
when (
  old.sale_date is distinct from new.sale_date
  or old.status is distinct from new.status
  or old.sale_procedure is distinct from new.sale_procedure
  or old.raw_payload is distinct from new.raw_payload
  or old.retention_deadline is distinct from new.retention_deadline
  or old.retention_deadline_materialized is distinct from new.retention_deadline_materialized
)
execute function app_private.set_auction_sale_retention_deadline();

-- Keep each update bounded. A migration with more than 100,000 rows fails and
-- rolls back instead of silently leaving NULL fences that would under-count
-- remaining retention work. The trigger above also covers writes committed
-- after this backfill.
do $$
declare
  batch_size constant integer := 500;
  max_batches constant integer := 200;
  changed integer;
  batches integer := 0;
begin
  loop
    batches := batches + 1;

    with batch as materialized (
      select sale.id
      from public.auction_sales sale
      where not sale.retention_deadline_materialized
      order by sale.id
      limit batch_size
      for update skip locked
    )
    update public.auction_sales sale
       set retention_deadline = app_private.sale_retention_deadline(
             sale.sale_date,
             sale.status,
             sale.sale_procedure,
             sale.raw_payload
           ),
           retention_deadline_materialized = true
      from batch
     where sale.id = batch.id;

    get diagnostics changed = row_count;
    exit when changed = 0;

    if batches >= max_batches then
      if exists (
        select 1
        from public.auction_sales sale
        where not sale.retention_deadline_materialized
      ) then
        raise exception using
          errcode = '54000',
          message = 'Sale retention deadline backfill exceeded its 100000-row safety bound.';
      end if;
      exit;
    end if;
  end loop;

  if exists (
    select 1
    from public.auction_sales sale
    where not sale.retention_deadline_materialized
  ) then
    raise exception using
      errcode = '54000',
      message = 'Sale retention deadline backfill left unmaterialized rows.';
  end if;
end;
$$;

create index if not exists auction_sales_retention_deadline_idx
  on public.auction_sales (retention_deadline, sale_date, id)
  where retention_deadline_materialized and retention_deadline is not null;

-- Keep the existing non-blocking lock and one-row transaction budget. Only the
-- deadline column is consulted after the trigger/backfill fence is complete;
-- remaining therefore stays exact while the count is indexable.
create or replace function public.purge_expired_auction_sales(
  p_now timestamptz default statement_timestamp(),
  p_limit integer default 25
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  sale_row public.auction_sales%rowtype;
  previous_id uuid;
  bridge_result record;
  deleted_count integer := 0;
  remaining_count integer;
begin
  if p_limit is null or p_limit < 1 or p_limit > 25 or p_now is null then
    raise exception using
      errcode = '22023',
      message = 'Retention requires a timestamp and batch size between 1 and 25.';
  end if;

  if not pg_try_advisory_xact_lock(
    hashtextextended('immojudis:outcome_catalogue_bridge:v1', 0)
  ) then
    return jsonb_build_object('deleted', 0, 'busy', true, 'remaining', null);
  end if;

  begin
    lock table public.auction_sales in share row exclusive mode nowait;
  exception when lock_not_available then
    return jsonb_build_object('deleted', 0, 'busy', true, 'remaining', null);
  end;

  for sale_row in
    select sale.*
    from public.auction_sales sale
    where sale.retention_deadline_materialized
      and sale.retention_deadline <= p_now
    order by sale.sale_date, sale.id
    limit least(p_limit, 1)
  loop
    select id
      into previous_id
      from public.auction_sales
     where id < sale_row.id
     order by id desc
     limit 1;

    select *
      into bridge_result
      from public.bridge_auction_sales_to_outcome_graph_batch(previous_id, 1);

    if not bridge_result.complete or bridge_result.next_cursor <> sale_row.id then
      raise exception 'Incomplete statistical archive before retention';
    end if;

    insert into public.sale_retention_storage_queue(bucket, object_path)
      select storage_bucket, storage_path
        from public.information_agent_evidence_assets
       where sale_id = sale_row.id
         and storage_bucket = 'information-agent-evidence'
      union
      select 'information-agent-approved', metadata->>'approved_public_path'
        from public.information_agent_evidence_assets
       where sale_id = sale_row.id
         and nullif(metadata->>'approved_public_path', '') is not null
      union
      select 'information-agent-approved', file_path
        from public.auction_documents
       where source_url = sale_row.source_url
         and file_path like sale_row.id::text || '/%'
         and document_url like '%/storage/v1/object/public/information-agent-approved/%'
      on conflict (bucket, object_path) do nothing;

    delete from public.valuation_estimates
     where auction_sale_id = sale_row.id;
    delete from public.information_agent_missions
     where sale_id = sale_row.id;
    delete from public.lawyer_placement_events
     where sale_id = sale_row.id;
    delete from public.lawyer_referral_requests
     where sale_id = sale_row.id;
    delete from public.auction_observations
     where canonical_source_url = sale_row.source_url
        or source_url = sale_row.source_url;
    delete from public.auction_sales
     where id = sale_row.id;

    deleted_count := deleted_count + 1;
  end loop;

  select count(*)
    into remaining_count
    from public.auction_sales sale
   where sale.retention_deadline_materialized
     and sale.retention_deadline <= p_now;

  return jsonb_build_object(
    'deleted', deleted_count,
    'remaining', remaining_count,
    'busy', false
  );
end;
$$;

revoke all on function public.purge_expired_auction_sales(timestamptz, integer)
  from public, anon, authenticated;
grant execute on function public.purge_expired_auction_sales(timestamptz, integer)
  to service_role;

notify pgrst, 'reload schema';

commit;
