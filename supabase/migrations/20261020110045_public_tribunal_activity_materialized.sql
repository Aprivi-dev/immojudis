begin;

set local lock_timeout = '5s';

-- get_public_tribunal_activity() read raw_payload (about 37 kB of TOAST per sale) twice per
-- candidate sale: once to evaluate the expiry and once for the quarantine flag. Use the same
-- predicate as search_auction_sales_preview_v4 and list_public_sale_sitemap_entries (see
-- 20261012100000_sitemap_use_materialized_projection.sql): the materialized expiry deadline and
-- the materialized quarantine flag, and fall back to the full function only for the rows whose
-- deadline is not materialized yet. Signature, grants, security definer and search_path are
-- unchanged; so is the public wrapper public.get_public_tribunal_activity().

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
    and (
      case
        when s.catalogue_expiry_materialized and s.catalogue_expiry_deadline is not null
          then s.catalogue_expiry_deadline > current_timestamp
        else app_private.sale_catalogue_entry_is_live_materialized(
          false,
          null,
          s.sale_date,
          s.raw_payload,
          s.sale_procedure
        )
      end
    )
    and not s.catalogue_quarantined
  group by t.code, t.canonical_name, t.city, t.department;
$function$;

revoke all on function app_private.get_public_tribunal_activity()
  from public, anon, authenticated;
grant execute on function app_private.get_public_tribunal_activity()
  to anon, authenticated, service_role;

commit;
