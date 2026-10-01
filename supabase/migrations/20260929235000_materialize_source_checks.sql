begin;

set local lock_timeout = '5s';

-- Keep the small freshness authority separate from auction_sales.raw_payload.
-- The latter contains large source documents and must not be detoasted by every
-- operational-health tick. sale_id is the stable relationship; source_url is
-- retained as the canonical identity consumed by the freshness function.
grant usage on schema app_private to service_role;

create table if not exists app_private.auction_sale_source_checks (
  sale_id uuid primary key
    references public.auction_sales(id) on delete cascade,
  source_url text not null unique,
  source_name text not null,
  sale_date timestamptz,
  status text,
  checks jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default statement_timestamp(),
  constraint auction_sale_source_checks_object
    check (jsonb_typeof(checks) = 'object')
);

comment on table app_private.auction_sale_source_checks is
  'Compact server-side source_checks projection used by freshness and detail admission; raw sale payloads remain in auction_sales.';
comment on column app_private.auction_sale_source_checks.checks is
  'The object at auction_sales.raw_payload.source_checks, or an empty object for missing/non-object values.';

create index if not exists auction_sale_source_checks_status_idx
  on app_private.auction_sale_source_checks(status, sale_id);

alter table app_private.auction_sale_source_checks enable row level security;
revoke all on table app_private.auction_sale_source_checks
  from public, anon, authenticated, service_role;
grant select
  on table app_private.auction_sale_source_checks to service_role;
drop policy if exists auction_sale_source_checks_service_role
  on app_private.auction_sale_source_checks;
create policy auction_sale_source_checks_service_role
  on app_private.auction_sale_source_checks
  for select to service_role
  using (true);

-- Keep the projection in the same transaction as the sale write. The trigger
-- deliberately writes only the compact private row: it never updates
-- auction_sales, so a cache refresh cannot re-enter sale history, content-hash,
-- AI-review or enrichment-job triggers on the wide table.
create or replace function app_private.sync_auction_sale_source_checks()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  normalized_checks jsonb;
begin
  if tg_op = 'DELETE' then
    delete from app_private.auction_sale_source_checks
     where sale_id = old.id;
    return old;
  end if;

  normalized_checks := case
    when pg_catalog.jsonb_typeof(new.raw_payload->'source_checks') = 'object'
      then new.raw_payload->'source_checks'
    else '{}'::jsonb
  end;

  insert into app_private.auction_sale_source_checks (
    sale_id,
    source_url,
    source_name,
    sale_date,
    status,
    checks,
    updated_at
  )
  values (
    new.id,
    new.source_url,
    new.source_name,
    new.sale_date,
    new.status,
    normalized_checks,
    pg_catalog.statement_timestamp()
  )
  on conflict (sale_id) do update
    set source_url = excluded.source_url,
        source_name = excluded.source_name,
        sale_date = excluded.sale_date,
        status = excluded.status,
        checks = excluded.checks,
        updated_at = excluded.updated_at;

  return new;
end;
$function$;

revoke all on function app_private.sync_auction_sale_source_checks()
  from public, anon, authenticated;
grant execute on function app_private.sync_auction_sale_source_checks()
  to service_role;

drop trigger if exists auction_sales_sync_source_checks on public.auction_sales;
create trigger auction_sales_sync_source_checks
after insert or delete or update of source_url, source_name, sale_date, status, raw_payload
on public.auction_sales
for each row execute function app_private.sync_auction_sale_source_checks();

-- Never silently under-count a sale when the projection is incomplete. Both
-- health freshness and source-detail admission fail closed before reading
-- their JSON-heavy branches.
create or replace function app_private.assert_auction_sale_source_checks_complete()
returns void
language plpgsql
stable
security invoker
set search_path = ''
as $function$
begin
  if exists (
    select 1
      from public.auction_sales sale
      left join app_private.auction_sale_source_checks cache
        on cache.sale_id = sale.id
     where sale.status in ('active', 'upcoming', 'postponed', 'unknown')
       and cache.sale_id is null
  ) then
    raise exception using
      errcode = '55000',
      message = 'Source-checks projection is incomplete';
  end if;
end;
$function$;

revoke all on function app_private.assert_auction_sale_source_checks_complete()
  from public, anon, authenticated;
grant execute on function app_private.assert_auction_sale_source_checks_complete()
  to service_role;

-- Backfill the cache directly. In particular, do not UPDATE auction_sales:
-- that would execute its generic AFTER UPDATE history and AI-review triggers.
insert into app_private.auction_sale_source_checks (
  sale_id,
  source_url,
  source_name,
  sale_date,
  status,
  checks,
  updated_at
)
select
  sale.id,
  sale.source_url,
  sale.source_name,
  sale.sale_date,
  sale.status,
  case
    when pg_catalog.jsonb_typeof(sale.raw_payload->'source_checks') = 'object'
      then sale.raw_payload->'source_checks'
    else '{}'::jsonb
  end,
  pg_catalog.statement_timestamp()
from public.auction_sales sale
on conflict (sale_id) do update
  set source_url = excluded.source_url,
      source_name = excluded.source_name,
      sale_date = excluded.sale_date,
      status = excluded.status,
      checks = excluded.checks,
      updated_at = excluded.updated_at;

-- Read the compact projection while preserving the existing canonical,
-- normalized-observation and JSON-map alias branches and timestamp semantics.
create or replace function public.auction_all_source_freshness(p_now timestamptz default now())
returns table(source_name text, active_listings bigint, fresh_listings bigint)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform app_private.assert_auction_sale_source_checks_complete();

  return query
    with active as materialized (
      select cache.source_url, cache.source_name, cache.sale_date, cache.checks
      from app_private.auction_sale_source_checks cache
      where cache.status in ('active', 'upcoming', 'postponed', 'unknown')
    ), links as (
      select a.source_url as canonical_url, a.source_name,
        a.source_url as checked_url, a.sale_date, a.checks
      from active a
      union all
      select a.source_url, o.source_name, o.source_url, a.sale_date, a.checks
      from active a
      join public.auction_observations o on o.canonical_source_url = a.source_url
      union all
      select a.source_url, c.value->>'source_name', c.key, a.sale_date, a.checks
      from active a
      cross join lateral jsonb_each(a.checks) c
    ), checked as materialized (
      select l.canonical_url, l.source_name, l.sale_date,
        app_private.pipeline_checked_at(l.checks->l.checked_url->>'checked_at') as checked_at
      from links l
      where l.source_name is not null and l.checked_url is not null
    ), latest as (
      select c.canonical_url, c.source_name, c.sale_date,
        max(c.checked_at) filter (where c.checked_at <= p_now) as checked_at
      from checked c
      group by c.canonical_url, c.source_name, c.sale_date
    )
    select l.source_name, count(*),
      count(*) filter (where l.checked_at >= p_now -
        case when l.sale_date between p_now and p_now + interval '7 days'
          then interval '6 hours' else interval '24 hours' end)
    from latest l
    group by l.source_name;
end;
$$;
revoke all on function public.auction_all_source_freshness(timestamptz)
  from public, anon, authenticated;
grant execute on function public.auction_all_source_freshness(timestamptz)
  to service_role;

-- The source-detail admission path uses the same source_checks map. Patch only
-- that expression and its source row so all retention, identity, alias, retry,
-- conflict and limit logic in 2330 remains unchanged.
do $patch$
declare
  function_body text;
  old_case constant text := $old_case$case
        when jsonb_typeof(s.raw_payload->'source_checks') = 'object'
          then s.raw_payload->'source_checks'
        else '{}'::jsonb
      end as checks,$old_case$;
  old_from constant text := $old_from$from public.auction_sales s
    where s.status in ('active', 'upcoming', 'postponed', 'unknown')$old_from$;
  old_guard constant text := $old_guard$end if;

  with base as materialized ($old_guard$;
begin
  select procedure.prosrc
    into function_body
    from pg_catalog.pg_proc procedure
    join pg_catalog.pg_namespace namespace
      on namespace.oid = procedure.pronamespace
   where namespace.nspname = 'public'
     and procedure.oid =
       'public.enqueue_due_source_details_unlocked(timestamptz,integer)'::regprocedure;

  if function_body is null
     or position(old_case in function_body) = 0
     or position(old_from in function_body) = 0
     or position(old_guard in function_body) = 0 then
    raise exception using
      errcode = '55000',
      message = 'The 2330 source-detail function no longer has the expected source_checks projection.';
  end if;
  if length(function_body) - length(replace(function_body, old_case, '')) <> length(old_case)
     or length(function_body) - length(replace(function_body, old_from, '')) <> length(old_from)
     or length(function_body) - length(replace(function_body, old_guard, '')) <> length(old_guard) then
    raise exception using
      errcode = '55000',
      message = 'The 2330 source-detail function has an unexpected number of source_checks projections.';
  end if;

  function_body := replace(function_body, old_case, 'cache.checks as checks,');
  function_body := replace(
    function_body,
    old_from,
    $replacement$from public.auction_sales s
    join app_private.auction_sale_source_checks cache
      on cache.sale_id = s.id
    where s.status in ('active', 'upcoming', 'postponed', 'unknown')$replacement$
  );
  function_body := replace(
    function_body,
    old_guard,
    $replacement$end if;

  perform app_private.assert_auction_sale_source_checks_complete();

  with base as materialized ($replacement$
  );

  execute format(
    $sql$create or replace function public.enqueue_due_source_details_unlocked(
      p_now timestamptz default now(),
      p_limit integer default 500
    )
    returns integer
    language plpgsql
    security invoker
    set search_path = ''
    as %L$sql$,
    function_body
  );
end;
$patch$;

revoke all on function public.enqueue_due_source_details_unlocked(timestamptz, integer)
  from public, anon, authenticated;
grant execute on function public.enqueue_due_source_details_unlocked(timestamptz, integer)
  to service_role;

notify pgrst, 'reload schema';

commit;
