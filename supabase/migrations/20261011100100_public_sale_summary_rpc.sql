begin;

set local lock_timeout = '5s';

-- The signed-out page of a sale needs the card-level facts of ONE publicly
-- visible sale (type, surface, city, department, hearing date, tribunal,
-- thumbnail), i.e. what the public catalogue card already shows, looked up by
-- identifier. It uses the same visibility predicate as
-- search_auction_sales_preview_v4, so a sale outside the public catalogue is
-- never returned. Coordinates, address, documents, analyses and organizer
-- contacts stay out of the contract.

create or replace function app_private.get_public_sale_summary(p_sale_id uuid)
returns table (
  id uuid,
  starting_price_eur numeric,
  sale_venue_type text,
  sale_verification_status text,
  city text,
  department text,
  property_type text,
  sale_date timestamptz,
  app_surface_m2 numeric,
  app_surface_kind text,
  rooms_count integer,
  bedrooms_count integer,
  bathrooms_count integer,
  tribunal_name text,
  tribunal_city text,
  thumbnail_url text,
  updated_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $function$
  select
    s.id,
    s.starting_price_eur::numeric,
    s.sale_venue_type,
    s.sale_verification_status,
    s.city,
    s.department,
    s.property_type,
    s.sale_date::timestamptz,
    s.app_surface_m2::numeric,
    s.app_surface_kind,
    s.rooms_count::integer,
    s.bedrooms_count::integer,
    s.bathrooms_count::integer,
    case
      when s.sale_venue_type = 'tribunal' then coalesce(t.canonical_name, s.tribunal)
    end as tribunal_name,
    case
      when s.sale_venue_type = 'tribunal' then t.city
    end as tribunal_city,
    case
      when s.raw_payload->>'raw_image_url' ~* '^https?://'
        and length(s.raw_payload->>'raw_image_url') <= 2048
        then s.raw_payload->>'raw_image_url'
    end as thumbnail_url,
    s.updated_at::timestamptz
  from public.auction_sales s
  left join public.tribunals t on t.code = s.tribunal_code
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

revoke all on function app_private.get_public_sale_summary(uuid)
  from public, anon, authenticated;
grant execute on function app_private.get_public_sale_summary(uuid)
  to anon, authenticated, service_role;

create or replace function public.get_public_sale_summary(p_sale_id uuid)
returns table (
  id uuid,
  starting_price_eur numeric,
  sale_venue_type text,
  sale_verification_status text,
  city text,
  department text,
  property_type text,
  sale_date timestamptz,
  app_surface_m2 numeric,
  app_surface_kind text,
  rooms_count integer,
  bedrooms_count integer,
  bathrooms_count integer,
  tribunal_name text,
  tribunal_city text,
  thumbnail_url text,
  updated_at timestamptz
)
language sql
stable
set search_path = ''
as $function$
  select * from app_private.get_public_sale_summary(p_sale_id);
$function$;

revoke all on function public.get_public_sale_summary(uuid) from public;
grant execute on function public.get_public_sale_summary(uuid)
  to anon, authenticated, service_role;

notify pgrst, 'reload schema';

commit;
