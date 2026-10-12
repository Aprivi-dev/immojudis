begin;

set local lock_timeout = '5s';

-- Extra facts for the signed-out page of ONE publicly visible sale, so a
-- visitor gets a real description of the property before creating an account:
-- land, amenities, whether visits are organised, how many photos and case
-- documents exist. Same visibility predicate as get_public_sale_summary.
-- The visit text itself, the address, the photos beyond the thumbnail and the
-- documents stay out of the contract: visit announcements often name the exact
-- address, which is reserved to signed-in accounts.

create or replace function app_private.get_public_sale_details(p_sale_id uuid)
returns table (
  id uuid,
  land_surface_m2 numeric,
  parking_count integer,
  has_garden boolean,
  has_terrace boolean,
  has_garage boolean,
  has_pool boolean,
  has_air_conditioning boolean,
  has_double_glazing boolean,
  has_visit_dates boolean,
  photo_count integer,
  document_count integer
)
language sql
stable
security definer
set search_path = ''
as $function$
  select
    s.id,
    s.land_surface_m2::numeric,
    s.parking_count::integer,
    s.has_garden,
    s.has_terrace,
    s.has_garage,
    s.has_pool,
    s.has_air_conditioning,
    s.has_double_glazing,
    jsonb_typeof(s.visit_dates) = 'array' and jsonb_array_length(s.visit_dates) > 0,
    coalesce(m.photo_count, 0),
    coalesce(dc.document_count, 0)
  from public.auction_sales s
  left join lateral (
    select count(*)::integer as document_count
      from public.auction_documents ad
     where ad.source_url = s.source_url
  ) dc on true
  left join lateral (
    select count(distinct images.image_url)::integer as photo_count
      from (
        select nullif(s.raw_payload ->> 'raw_image_url', '') as image_url
        union all
        select nullif(image.value, '')
          from jsonb_array_elements_text(
            case when jsonb_typeof(s.raw_payload -> 'source_images') = 'array'
                 then s.raw_payload -> 'source_images' else '[]'::jsonb end
          ) as image(value)
      ) images
     where images.image_url is not null
       and images.image_url ~* '^https?://'
       and images.image_url !~* '\.(pdf|docx?|svg)([?#].*)?$'
       and images.image_url !~* '(^|[/_.-])(avatar|brand|default|favicon|icon|icone|logo|placeholder|profile|sprite|user)([/_.-]|$)'
  ) m on true
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

revoke all on function app_private.get_public_sale_details(uuid)
  from public, anon, authenticated;
grant execute on function app_private.get_public_sale_details(uuid)
  to anon, authenticated, service_role;

create or replace function public.get_public_sale_details(p_sale_id uuid)
returns table (
  id uuid,
  land_surface_m2 numeric,
  parking_count integer,
  has_garden boolean,
  has_terrace boolean,
  has_garage boolean,
  has_pool boolean,
  has_air_conditioning boolean,
  has_double_glazing boolean,
  has_visit_dates boolean,
  photo_count integer,
  document_count integer
)
language sql
stable
set search_path = ''
as $function$
  select * from app_private.get_public_sale_details(p_sale_id);
$function$;

revoke all on function public.get_public_sale_details(uuid) from public;
grant execute on function public.get_public_sale_details(uuid)
  to anon, authenticated, service_role;

notify pgrst, 'reload schema';

commit;
