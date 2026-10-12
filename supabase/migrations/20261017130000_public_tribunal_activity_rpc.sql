begin;

set local lock_timeout = '5s';

-- Public activity of each court, for the signed-out « Statistiques Tribunaux »
-- page: upcoming sales of the public catalogue, next hearing, median starting
-- price and property mix. These figures only restate what the public catalogue
-- already lists; adjudication prices and results stay reserved to Analyse.

create or replace function app_private.get_public_tribunal_activity()
returns table (
  tribunal_code text,
  tribunal_name text,
  tribunal_city text,
  department text,
  upcoming_count integer,
  next_sale_date timestamptz,
  median_starting_price_eur numeric,
  house_count integer,
  apartment_count integer,
  other_count integer
)
language sql
stable
security definer
set search_path = ''
as $function$
  select
    t.code,
    t.canonical_name,
    t.city,
    t.department,
    count(*)::integer,
    min(s.sale_date) filter (where s.sale_date >= current_date)::timestamptz,
    (percentile_cont(0.5) within group (order by s.starting_price_eur)
      filter (where s.starting_price_eur > 0))::numeric,
    (count(*) filter (where s.property_type = 'house'))::integer,
    (count(*) filter (where s.property_type = 'apartment'))::integer,
    (count(*) filter (where coalesce(s.property_type, '') not in ('house', 'apartment')))::integer
  from public.auction_sales s
  join public.tribunals t on t.code = s.tribunal_code
  where s.sale_venue_type = 'tribunal'
    and coalesce(s.status, 'unknown') in ('upcoming', 'unknown', 'postponed')
    and app_private.sale_catalogue_entry_is_live_materialized(
      s.catalogue_expiry_materialized,
      s.catalogue_expiry_deadline,
      s.sale_date,
      s.raw_payload,
      s.sale_procedure
    )
    and coalesce(s.raw_payload->>'publication_quarantine', '') = ''
  group by t.code, t.canonical_name, t.city, t.department;
$function$;

revoke all on function app_private.get_public_tribunal_activity()
  from public, anon, authenticated;
grant execute on function app_private.get_public_tribunal_activity()
  to anon, authenticated, service_role;

create or replace function public.get_public_tribunal_activity()
returns table (
  tribunal_code text,
  tribunal_name text,
  tribunal_city text,
  department text,
  upcoming_count integer,
  next_sale_date timestamptz,
  median_starting_price_eur numeric,
  house_count integer,
  apartment_count integer,
  other_count integer
)
language sql
stable
set search_path = ''
as $function$
  select * from app_private.get_public_tribunal_activity();
$function$;

revoke all on function public.get_public_tribunal_activity() from public;
grant execute on function public.get_public_tribunal_activity()
  to anon, authenticated, service_role;

notify pgrst, 'reload schema';

commit;
