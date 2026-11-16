-- Le nom de la plateforme d'origine n'est plus servi dans source_checks aux comptes sans l'offre Analyse
-- (audit de sécurité du 16/11/2026, constat n° 5 a, validé par le propriétaire le 16/11/2026).
--
-- 20261123100000 a retiré l'adresse et le nom de la plateforme de l'annonce d'origine de sale_procedure,
-- source_conflicts et source_presence dans v_auction_sales_discovery (compte Découverte ;
-- v_auction_sales_discovery_search la lit) et v_auction_sales_unlocked (vente débloquée). Il restait
-- source_checks : les deux vues ré-indexaient ses clés (les adresses des annonces) en source_1, source_2...
-- mais recopiaient ses valeurs telles quelles. Or chaque contrôle écrit par le pipeline
-- (services/data-pipeline/src/freshness.py) porte source_name, le nom de la plateforme, avec des empreintes
-- et l'état de la capture. Mesure du 16/11/2026 en production : 1 328 ventes sur 1 390 portaient ce nom,
-- lisible par tout compte connecté (GET /rest/v1/v_auction_sales_discovery?select=id,source_checks, ou
-- /api/favorites).
--
-- Projection, fermée par défaut, avec sa jumelle TypeScript sourceChecksWithoutListingSource
-- (src/lib/property-report/entitlements.ts, test de parité
-- src/lib/property-report/sale-procedure-without-listing-source.test.ts) :
--   * app_private.source_checks_without_listing_source : entrées ré-indexées source_1, source_2... (ordre des
--     clés, collation C, comme source_presence) et réduites à checked_at, extractor_version, field et fields,
--     seules clés que l'application lit pour ces comptes (fact-reliability.ts : checked_at, field, fields ;
--     listing-completeness.ts : checked_at, extractor_version). extractor_version est la version du code
--     d'extraction, la même pour toutes les sources. Une entrée qui n'est pas un objet devient un objet vide ;
--     un source_checks qui n'est pas un objet devient vide.
-- L'ordre des entrées change (ordre des clés au lieu de l'ordre interne du jsonb) : les clés source_N sont
-- opaques, aucun lecteur ne s'y fie. Les vues de l'offre Analyse (v_auction_sales_app,
-- v_auction_sales_app_search) ne changent pas.
--
-- Les deux vues sont redéfinies en entier (depuis le lot R2b, une migration n'exécute pas de SQL assemblé).
-- Chaque définition est celle de 20261123100000, à deux différences près : la colonne source_checks passe
-- par la projection, et la jointure latérale « c » qui la calculait disparaît. Mêmes colonnes, même ordre,
-- mêmes types, mêmes options ; create or replace view garde droits et commentaires, les droits sont redonnés
-- à l'identique. Le test supabase/tests/902 vérifie ce que lit chaque compte.
begin;

set local lock_timeout = '5s';

create or replace function app_private.source_checks_without_listing_source(p_checks jsonb)
returns jsonb
language sql
immutable
parallel safe
security invoker
set search_path = ''
as $$
  select coalesce(
    (
      select pg_catalog.jsonb_object_agg('source_' || ranked.rank, ranked.entry)
      from (
        select
          pg_catalog.row_number() over (order by checks.key collate "C") as rank,
          coalesce(
            (
              select pg_catalog.jsonb_object_agg(kept.key, kept.value)
              from pg_catalog.jsonb_each(
                case
                  when pg_catalog.jsonb_typeof(checks.value) = 'object' then checks.value
                  else '{}'::jsonb
                end
              ) as kept(key, value)
              where kept.key in ('checked_at', 'extractor_version', 'field', 'fields')
            ),
            '{}'::jsonb
          ) as entry
        from pg_catalog.jsonb_each(
          case when pg_catalog.jsonb_typeof(p_checks) = 'object' then p_checks else '{}'::jsonb end
        ) as checks(key, value)
      ) as ranked
    ),
    '{}'::jsonb
  );
$$;

revoke all on function app_private.source_checks_without_listing_source(jsonb) from public, anon;
-- Exécutée avec les droits de l'appelant par les vues (security definer) ci-dessous.
grant execute on function app_private.source_checks_without_listing_source(jsonb)
  to authenticated, service_role;

comment on function app_private.source_checks_without_listing_source(jsonb) is
  'source_checks pour un lecteur sans l''offre Analyse : entrées ré-indexées source_N, checked_at, extractor_version, field et fields seulement (ni source_name, ni empreintes, ni état de capture). Même règle que sourceChecksWithoutListingSource (src/lib/property-report/entitlements.ts).';

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
  app_private.public_position_quality_flags(s.quality_flags) as quality_flags,
  s.created_at,
  s.updated_at,
  app_private.sale_document_photo_media(coalesce(m.media, '[]'::jsonb), s.id) as media,
  jsonb_build_object('sale_procedure', app_private.sale_procedure_without_listing_source(s.sale_procedure, false)) as source_blocks,
  '{}'::jsonb as source_blocks_by_source,
  s.sale_venue_type,
  s.sale_legal_framework,
  s.sale_verification_status,
  app_private.sale_procedure_without_listing_source(s.sale_procedure, false) as sale_procedure,
  app_private.source_checks_without_listing_source(s.raw_payload -> 'source_checks') as source_checks,
  app_private.source_conflicts_without_listing_source(s.raw_payload -> 'source_conflicts') as source_conflicts,
  case
    when (s.raw_payload ->> 'source_content_changed') = 'true' then 'pending'
    when nullif(s.raw_payload ->> 'llm_display_description', '') is not null then 'complete'
    else coalesce(s.raw_payload ->> 'llm_display_status', 'pending')
  end as analysis_status,
  app_private.source_presence_without_listing_source(app_private.auction_sale_source_presence_json(s.id))
    as source_presence,
  coalesce(dc.document_count, 0) as document_count,
  app_private.sale_location_precision(s.raw_payload) as location_precision
from public.auction_sales s
left join public.tribunals t on t.code = s.tribunal_code
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
         and images.image_url !~* '(^|[/_.-])(avatar|brand|favicon|icon|icone|logo|placeholder|profile|sprite|user)([/_.-]|$)|(^|[/_.-])default([_.-][^/?#]*)?([?#].*)?$'
       order by images.image_url, images.source_rank
    ) deduped
) m on true
where s.status = any (array['upcoming', 'unknown', 'postponed'])
  and app_private.sale_catalogue_projection_is_live(
    s.catalogue_expiry_materialized, s.catalogue_expiry_deadline, s.sale_date,
    s.catalogue_expiry_fallback, s.catalogue_state_observed_at, s.catalogue_state_end_estimate
  )
  and not s.catalogue_quarantined;

revoke all on table public.v_auction_sales_discovery from public, anon;
grant select on table public.v_auction_sales_discovery to authenticated;

create or replace view public.v_auction_sales_unlocked
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
  coalesce(s.documents, '[]'::jsonb) as documents,
  coalesce(d.documents_rich, '[]'::jsonb) as documents_rich,
  s.status,
  app_private.public_position_quality_flags(s.quality_flags) as quality_flags,
  s.created_at,
  s.updated_at,
  app_private.sale_document_photo_media(coalesce(m.media, '[]'::jsonb), s.id) as media,
  app_private.unlocked_ceiling_blocks(s.raw_payload -> 'source_blocks') as source_blocks,
  app_private.unlocked_ceiling_blocks_by_source(s.raw_payload -> 'source_blocks', s.observations)
    as source_blocks_by_source,
  s.sale_venue_type,
  s.sale_legal_framework,
  s.sale_verification_status,
  app_private.sale_procedure_without_listing_source(s.sale_procedure, true) as sale_procedure,
  app_private.source_checks_without_listing_source(s.raw_payload -> 'source_checks') as source_checks,
  app_private.source_conflicts_without_listing_source(s.raw_payload -> 'source_conflicts') as source_conflicts,
  case
    when (s.raw_payload ->> 'source_content_changed') = 'true' then 'pending'
    when nullif(s.raw_payload ->> 'llm_display_description', '') is not null then 'complete'
    else coalesce(s.raw_payload ->> 'llm_display_status', 'pending')
  end as analysis_status,
  app_private.source_presence_without_listing_source(app_private.auction_sale_source_presence_json(s.id))
    as source_presence,
  coalesce(dc.document_count, 0) as document_count,
  app_private.sale_location_precision(s.raw_payload) as location_precision,
  case when s.source_name = 'notaires' then app_private.public_sale_conditions(s.raw_payload) else null::jsonb end
    as sale_conditions
from public.user_sale_unlocks unlock_row
join public.auction_sales s on s.id = unlock_row.sale_id
left join public.tribunals t on t.code = s.tribunal_code
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
         and images.image_url !~* '(^|[/_.-])(avatar|brand|favicon|icon|icone|logo|placeholder|profile|sprite|user)([/_.-]|$)|(^|[/_.-])default([_.-][^/?#]*)?([?#].*)?$'
       order by images.image_url, images.source_rank
    ) deduped
) m on true
-- Official documents, with the same projection as v_auction_sales_app.
left join lateral (
  select jsonb_agg(
    jsonb_build_object(
      'label', ad.label,
      'url', ad.document_url,
      'type', ad.document_type,
      'document_type', ad.document_type,
      'download_status', ad.download_status,
      'extraction_status', ad.extraction_status,
      'docling_status', ad.docling_status,
      'text_chars', ad.text_chars,
      'updated_at', ad.updated_at
    )
    order by ad.document_type, ad.label
  ) as documents_rich
  from public.auction_documents ad
  where ad.source_url = s.source_url
) d on true
where unlock_row.user_id = (select auth.uid())
  and app_private.current_user_unlocked_sale(s.id);

revoke all on table public.v_auction_sales_unlocked from public, anon;
grant select on table public.v_auction_sales_unlocked to authenticated;

notify pgrst, 'reload schema';

commit;
