begin;

set local lock_timeout = '5s';
set local statement_timeout = '120s';

-- The health observer only needs one timestamp and source name per checked
-- alias. Keep that read model separate from the JSON source_checks payload so
-- each health tick can use ordinary indexed rows instead of expanding every
-- JSON object.
create table if not exists app_private.auction_sale_source_check_links (
  sale_id uuid not null
    references app_private.auction_sale_source_checks(sale_id) on delete cascade,
  checked_url text not null,
  source_name text not null,
  checked_at timestamptz,
  primary key (sale_id, checked_url, source_name)
);

comment on table app_private.auction_sale_source_check_links is
  'Normalized source-check aliases used by the health observer; source_checks remains the write-side authority.';

create index if not exists auction_sale_source_check_links_sale_source_idx
  on app_private.auction_sale_source_check_links (sale_id, source_name, checked_at);

alter table app_private.auction_sale_source_check_links enable row level security;
revoke all on table app_private.auction_sale_source_check_links
  from public, anon, authenticated, service_role;
grant select on table app_private.auction_sale_source_check_links to service_role;
drop policy if exists auction_sale_source_check_links_service_role
  on app_private.auction_sale_source_check_links;
create policy auction_sale_source_check_links_service_role
  on app_private.auction_sale_source_check_links
  for select to service_role
  using (true);

-- Keep the normalized aliases transactionally aligned with the existing
-- compact source-check projection. A missing/invalid source_name is omitted,
-- matching the observer's existing source_name-is-not-null filter.
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

  delete from app_private.auction_sale_source_check_links
   where sale_id = new.id;

  insert into app_private.auction_sale_source_check_links (
    sale_id,
    checked_url,
    source_name,
    checked_at
  )
  select new.id, candidate.checked_url, candidate.source_name,
         max(candidate.checked_at)
    from (
      select new.source_url as checked_url,
             new.source_name as source_name,
             app_private.pipeline_checked_at(
               normalized_checks->new.source_url->>'checked_at'
             ) as checked_at
      where new.source_url is not null
        and new.source_name is not null
      union all
      select entry.key,
             entry.value->>'source_name',
             app_private.pipeline_checked_at(entry.value->>'checked_at')
        from pg_catalog.jsonb_each(normalized_checks) entry
       where entry.key is not null
         and entry.value->>'source_name' is not null
    ) candidate
   group by candidate.checked_url, candidate.source_name
  on conflict (sale_id, checked_url, source_name) do update
    set checked_at = excluded.checked_at;

  return new;
end;
$function$;

revoke all on function app_private.sync_auction_sale_source_checks()
  from public, anon, authenticated;
grant execute on function app_private.sync_auction_sale_source_checks()
  to service_role;

-- The trigger already exists from the source-check projection migration and
-- keeps writes to auction_sales transactionally aligned with the cache. Hold
-- the same ShareRowExclusiveLock while this migration snapshots the cache into
-- source-check links; otherwise a legacy writer could commit between the
-- backfill snapshot and the new function definition becoming visible, leaving
-- one link stale until a later sale write.
lock table public.auction_sales in share row exclusive mode;

-- Backfill the read model without touching auction_sales or firing its wide
-- history/revision triggers.
insert into app_private.auction_sale_source_check_links (
  sale_id,
  checked_url,
  source_name,
  checked_at
)
select candidate.sale_id,
       candidate.checked_url,
       candidate.source_name,
       max(candidate.checked_at)
  from (
    select cache.sale_id,
           cache.source_url as checked_url,
           cache.source_name,
           app_private.pipeline_checked_at(
             cache.checks->cache.source_url->>'checked_at'
           ) as checked_at
      from app_private.auction_sale_source_checks cache
     where cache.source_url is not null
       and cache.source_name is not null
    union all
    select cache.sale_id,
           entry.key,
           entry.value->>'source_name',
           app_private.pipeline_checked_at(entry.value->>'checked_at')
      from app_private.auction_sale_source_checks cache
      cross join lateral pg_catalog.jsonb_each(cache.checks) entry
     where entry.key is not null
       and entry.value->>'source_name' is not null
  ) candidate
 group by candidate.sale_id, candidate.checked_url, candidate.source_name
on conflict (sale_id, checked_url, source_name) do update
  set checked_at = excluded.checked_at;

create or replace function public.auction_all_source_freshness(
  p_now timestamptz default now()
)
returns table(source_name text, active_listings bigint, fresh_listings bigint)
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  perform app_private.assert_auction_sale_source_checks_complete();

  return query
    with active as materialized (
      select cache.sale_id,
             cache.source_url,
             cache.sale_date
        from app_private.auction_sale_source_checks cache
       where cache.status in ('active', 'upcoming', 'postponed', 'unknown')
    ),
    links as materialized (
      select active.source_url as canonical_url,
             link.source_name,
             link.checked_url,
             active.sale_date,
             link.checked_at
        from active
        join app_private.auction_sale_source_check_links link
          on link.sale_id = active.sale_id
      union all
      select active.source_url,
             observation.source_name,
             observation.source_url,
             active.sale_date,
             checked.checked_at
        from active
        join public.auction_observations observation
          on observation.canonical_source_url = active.source_url
        left join lateral (
          select max(link.checked_at) as checked_at
            from app_private.auction_sale_source_check_links link
           where link.sale_id = active.sale_id
             and link.checked_url = observation.source_url
        ) checked on true
    ),
    latest as (
      select link.canonical_url,
             link.source_name,
             link.sale_date,
             max(link.checked_at) filter (
               where link.checked_at <= p_now
             ) as checked_at
        from links link
       where link.source_name is not null
         and link.checked_url is not null
       group by link.canonical_url, link.source_name, link.sale_date
    )
    select latest.source_name,
           count(*),
           count(*) filter (
             where latest.checked_at >= p_now -
               case
                 when latest.sale_date between p_now and p_now + interval '7 days'
                   then interval '6 hours'
                 else interval '24 hours'
               end
           )
      from latest
     group by latest.source_name;
end;
$function$;

revoke all on function public.auction_all_source_freshness(timestamptz)
  from public, anon, authenticated;
grant execute on function public.auction_all_source_freshness(timestamptz)
  to service_role;

notify pgrst, 'reload schema';

commit;
