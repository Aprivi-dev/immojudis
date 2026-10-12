begin;

set local lock_timeout = '5s';

-- Owner decision (11/10/2026): a free Découverte account sees every fact of
-- the listing (description, occupancy, organizer contact, all photos), the
-- case documents themselves staying with the Analyse offer. The view now
-- publishes how many documents exist so the page can say they are available
-- with Analyse instead of « no document ». Source URLs stay private: the
-- source checks are re-keyed so their keys no longer reveal the listing URL.
create or replace view public.v_auction_sales_discovery
with (security_invoker = false, security_barrier = true) as
select
  s.id,
  s.title,
  s.description,
  nullif(s.raw_payload ->> 'source_description', '') as source_description,
  null::text as llm_display_description,
  null::text as about_description,
  s.city,
  s.department,
  s.postal_code,
  s.address,
  s.tribunal,
  s.tribunal_code,
  t.canonical_name as tribunal_name,
  t.city as tribunal_city,
  s.property_type,
  s.starting_price_eur,
  s.sale_date,
  s.visit_dates,
  s.lawyer_name,
  s.lawyer_contact,
  null::numeric as adjudication_price_eur,
  s.latitude,
  s.longitude,
  s.occupancy_status,
  s.surface_m2,
  s.habitable_surface_m2,
  s.carrez_surface_m2,
  s.land_surface_m2,
  s.app_surface_m2,
  s.app_surface_kind,
  s.surface_scope,
  s.surface_source,
  null::double precision as surface_confidence,
  null::text as surface_evidence,
  s.rooms_count,
  s.bedrooms_count,
  s.bathrooms_count,
  s.parking_count,
  s.has_garden,
  s.has_terrace,
  s.has_garage,
  s.has_pool,
  s.has_air_conditioning,
  s.has_double_glazing,
  null::double precision as investment_score,
  null::text as investment_summary,
  null::text as score_version,
  null::double precision as score_confidence,
  '[]'::jsonb as score_factors,
  null::text as risk_notes,
  '[]'::jsonb as risks,
  null::text as source_name,
  null::text as primary_source,
  null::text as source_url,
  '[]'::jsonb as source_urls,
  null::text as dedupe_confidence,
  '[]'::jsonb as documents,
  '[]'::jsonb as documents_rich,
  s.status,
  '[]'::jsonb as quality_flags,
  s.created_at,
  s.updated_at,
  coalesce(m.media, '[]'::jsonb) as media,
  jsonb_build_object('sale_procedure', s.sale_procedure) as source_blocks,
  '{}'::jsonb as source_blocks_by_source,
  s.sale_venue_type,
  s.sale_legal_framework,
  s.sale_verification_status,
  s.sale_procedure,
  coalesce(c.source_checks, '{}'::jsonb) as source_checks,
  coalesce(s.raw_payload -> 'source_conflicts', '[]'::jsonb) as source_conflicts,
  case
    when (s.raw_payload ->> 'source_content_changed') = 'true' then 'pending'
    when nullif(s.raw_payload ->> 'llm_display_description', '') is not null then 'complete'
    else coalesce(s.raw_payload ->> 'llm_display_status', 'pending')
  end as analysis_status,
  app_private.auction_sale_source_presence_json(s.id) as source_presence,
  coalesce(dc.document_count, 0) as document_count
from public.auction_sales s
left join public.tribunals t on t.code = s.tribunal_code
-- Source checks keyed by an opaque rank: the original keys are listing URLs.
left join lateral (
  select jsonb_object_agg('source_' || checks.ordinality, checks.value) as source_checks
    from jsonb_each(
      case when jsonb_typeof(s.raw_payload -> 'source_checks') = 'object'
           then s.raw_payload -> 'source_checks' else '{}'::jsonb end
    ) with ordinality as checks(key, value, ordinality)
) c on true
left join lateral (
  select count(*)::integer as document_count
    from public.auction_documents ad
   where ad.source_url = s.source_url
) dc on true
left join lateral (
  select jsonb_agg(
           jsonb_build_object('type', 'image', 'url', deduped.image_url)
           order by deduped.source_rank, deduped.image_url
         ) as media
    from (
      select distinct on (images.image_url) images.image_url, images.source_rank
        from (
          select nullif(s.raw_payload ->> 'raw_image_url', '') as image_url, 0 as source_rank
          union all
          select nullif(image.value, ''), 1
            from jsonb_array_elements_text(
              case when jsonb_typeof(s.raw_payload -> 'source_images') = 'array'
                   then s.raw_payload -> 'source_images' else '[]'::jsonb end
            ) as image(value)
        ) images
       where images.image_url is not null
         and images.image_url ~* '^https?://'
         and images.image_url !~* '\.(pdf|docx?|svg)([?#].*)?$'
         and images.image_url !~* '(^|[/_.-])(avatar|brand|default|favicon|icon|icone|logo|placeholder|profile|sprite|user)([/_.-]|$)'
       order by images.image_url, images.source_rank
    ) deduped
) m on true
where s.status = any (array['upcoming', 'unknown', 'postponed'])
  and app_private.sale_catalogue_entry_is_live_materialized(
    s.catalogue_expiry_materialized, s.catalogue_expiry_deadline, s.sale_date, s.raw_payload, s.sale_procedure
  )
  and coalesce(s.raw_payload ->> 'publication_quarantine', '') = '';

commit;
