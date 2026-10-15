begin;

set local lock_timeout = '5s';

-- A "thin" public sale page (no city, no usable date, no precise type, neither surface nor
-- starting price) is not worth a place in a search index. One predicate decides it for both
-- consumers, so they cannot drift apart:
--   * the sitemap (app_private.list_public_sale_sitemap_entries below) lists only indexable sales;
--   * the page <meta name="robots"> of /sales/[id] asks public.get_public_sale_indexability(id)
--     and emits noindex, follow for the others.
-- The TypeScript mirror is isIndexablePublicSale in src/lib/seo.ts (a test keeps both in line).
--
-- Rules:
--   1. city filled (not null, not blank, not '-');
--   2. sale date not null and not flagged sale_date_implausible in quality_flags, EXCEPT State
--      disposals (primary_source = 'cessions_etat' or sale_venue_type = 'state'), which are sold
--      on offers and have no hearing date;
--   3. precise property type (not null/blank and neither 'other' nor 'unknown'), EXCEPT a
--      documented sale (at least one case document, or a description of 500 characters or more);
--   4. at least a surface (> 0) or a starting price (> 0).
-- completeness_tier plays no part in it.

create or replace function app_private.is_indexable_public_sale(
  p_city text,
  p_sale_date timestamptz,
  p_property_type text,
  p_surface_m2 numeric,
  p_starting_price_eur numeric,
  p_quality_flags jsonb,
  p_primary_source text,
  p_sale_venue_type text,
  p_description_length integer,
  p_document_count integer
)
returns boolean
language sql
immutable
parallel safe
set search_path = ''
as $function$
  select coalesce(
    -- 1. city
    coalesce(nullif(btrim(p_city), ''), '-') <> '-'
    -- 2. hearing date (not required for State disposals)
    and (
      coalesce(p_primary_source = 'cessions_etat', false)
      or coalesce(p_sale_venue_type = 'state', false)
      or (
        p_sale_date is not null
        and not (coalesce(p_quality_flags, '[]'::jsonb) @> '["sale_date_implausible"]'::jsonb)
      )
    )
    -- 3. precise type (or a documented sale)
    and (
      coalesce(lower(nullif(btrim(p_property_type), '')) not in ('other', 'unknown'), false)
      or coalesce(p_document_count, 0) >= 1
      or coalesce(p_description_length, 0) >= 500
    )
    -- 4. surface or starting price
    and (coalesce(p_surface_m2, 0) > 0 or coalesce(p_starting_price_eur, 0) > 0),
    false
  );
$function$;

revoke all on function app_private.is_indexable_public_sale(
  text, timestamptz, text, numeric, numeric, jsonb, text, text, integer, integer
) from public, anon, authenticated;
grant execute on function app_private.is_indexable_public_sale(
  text, timestamptz, text, numeric, numeric, jsonb, text, text, integer, integer
) to service_role;

-- Sitemap: same signature and grants as 20261012100000_sitemap_use_materialized_projection.sql,
-- with the indexability predicate added to the visible set (so total_count counts listed URLs).
create or replace function app_private.list_public_sale_sitemap_entries(
  p_limit integer default 1000,
  p_offset integer default 0
)
returns table (
  id uuid,
  updated_at timestamptz,
  total_count bigint
)
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  if coalesce(p_limit, 1000) < 1
    or coalesce(p_limit, 1000) > 5000
    or coalesce(p_offset, 0) < 0
    or coalesce(p_offset, 0) > 200000 then
    raise exception using errcode = '22023', message = 'Invalid sitemap pagination.';
  end if;

  return query
  with visible as (
    select s.id, s.updated_at
    from public.auction_sales s
    where coalesce(s.status, 'unknown') in ('upcoming', 'unknown', 'postponed')
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
      and app_private.is_indexable_public_sale(
        s.city,
        s.sale_date::timestamptz,
        s.property_type,
        s.app_surface_m2::numeric,
        s.starting_price_eur::numeric,
        s.quality_flags,
        s.primary_source,
        s.sale_venue_type,
        char_length(s.description),
        case
          when exists (
            select 1 from public.auction_documents ad where ad.source_url = s.source_url
          ) then 1
          else 0
        end
      )
  )
  select visible.id, visible.updated_at::timestamptz, count(*) over () as total_count
  from visible
  order by visible.id
  limit coalesce(p_limit, 1000)
  offset coalesce(p_offset, 0);
end;
$function$;

revoke all on function app_private.list_public_sale_sitemap_entries(integer, integer)
  from public, anon, authenticated;
grant execute on function app_private.list_public_sale_sitemap_entries(integer, integer)
  to anon, authenticated, service_role;

-- Page: the verdict for ONE publicly visible sale (same visibility predicate as
-- get_public_sale_summary). No row (null) for a sale outside the public catalogue. Returns only a
-- boolean: no sale fact leaves the database.
create or replace function app_private.get_public_sale_indexability(p_sale_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select app_private.is_indexable_public_sale(
    s.city,
    s.sale_date::timestamptz,
    s.property_type,
    s.app_surface_m2::numeric,
    s.starting_price_eur::numeric,
    s.quality_flags,
    s.primary_source,
    s.sale_venue_type,
    char_length(s.description),
    case
      when exists (
        select 1 from public.auction_documents ad where ad.source_url = s.source_url
      ) then 1
      else 0
    end
  )
  from public.auction_sales s
  where s.id = p_sale_id
    and coalesce(s.status, 'unknown') in ('upcoming', 'unknown', 'postponed')
    and app_private.sale_catalogue_entry_is_live_materialized(
      s.catalogue_expiry_materialized,
      s.catalogue_expiry_deadline,
      s.sale_date,
      s.raw_payload,
      s.sale_procedure
    )
    and coalesce(s.raw_payload->>'publication_quarantine', '') = '';
$function$;

revoke all on function app_private.get_public_sale_indexability(uuid)
  from public, anon, authenticated;
grant execute on function app_private.get_public_sale_indexability(uuid)
  to anon, authenticated, service_role;

create or replace function public.get_public_sale_indexability(p_sale_id uuid)
returns boolean
language sql
stable
set search_path = ''
as $function$
  select app_private.get_public_sale_indexability(p_sale_id);
$function$;

revoke all on function public.get_public_sale_indexability(uuid) from public;
grant execute on function public.get_public_sale_indexability(uuid)
  to anon, authenticated, service_role;

notify pgrst, 'reload schema';

commit;
