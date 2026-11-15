-- L'adresse de l'annonce d'origine n'est plus servie aux comptes sans l'offre Analyse (correctif validé
-- par le propriétaire le 15/11/2026 : toute adresse de l'annonce d'origine servie à un tel compte).
--
-- v_auction_sales_discovery (compte Découverte ; v_auction_sales_discovery_search la lit) et
-- v_auction_sales_unlocked (vente débloquée) vident source_url, source_urls et source_name, mais servaient
-- tels quels trois champs qui les recopient :
--   * sale_procedure (et source_blocks.sale_procedure dans la vue découverte), écrit par
--     services/data-pipeline/src/sale_procedure.py : verification.case_sources[] porte une entrée « listing »
--     (adresse et nom de la plateforme) et des pièces « document » qui recopient ce nom ; l'adresse de
--     l'annonce est encore dans verification.facts[].source_url, sale_window.source_url,
--     sale_session.source_url et rules.payment_deadline_source_url. Les pièces, réservées à un déblocage
--     ou à l'offre Analyse (la vue découverte vide documents et documents_rich), y gardaient leur adresse ;
--   * source_conflicts (raw_payload, écrit par services/data-pipeline/src/dedupe.py) : selected_source,
--     alternative_source et observed_primary_source sont des adresses d'annonces ;
--   * source_presence (app_private.auction_sale_source_presence_json) : indexé par le nom des plateformes,
--     et ses extras recopient sans filtre les clés héritées de raw_payload.source_presence.
--
-- Projections, fermées par défaut, avec leurs jumelles TypeScript (src/lib/property-report/entitlements.ts,
-- test de parité src/lib/property-report/sale-procedure-without-listing-source.test.ts) :
--   * app_private.sale_procedure_without_listing_source(procédure, p_keep_document_urls) : case_sources ne
--     garde que les kinds « document » et « official_reference » (tout autre kind, inconnu compris, est
--     retiré ; un case_sources qui n'est pas un tableau devient vide) ; source_name est retiré des pièces,
--     et leur url aussi sauf pour une vente débloquée (p_keep_document_urls) ; toute clé dont le nom se
--     termine par « source_url » est retirée, à toute profondeur. La référence officielle garde son url ;
--     règles, dates, base légale (Légifrance) restent ;
--   * app_private.source_conflicts_without_listing_source : chaque conflit ne garde que field, seule clé que
--     l'application lit pour ces comptes (fact-reliability.ts, sale-procedure.ts, ai-review-display.ts ;
--     listing-completeness.ts ne lit que la présence d'un conflit) ;
--   * app_private.source_presence_without_listing_source : entrées ré-indexées source_1, source_2... et
--     réduites à availability et state, seules clés lues (listing-completeness.ts).
-- Les vues de l'offre Analyse (v_auction_sales_app, v_auction_sales_app_search) ne changent pas.
--
-- Les deux vues sont redéfinies en entier (depuis le lot R2b, une migration n'exécute pas de SQL assemblé).
-- Chaque définition est la dernière définition statique (20261017100000 pour la vue découverte,
-- 20261023100000 pour la vue des ventes débloquées) avec, dans l'ordre, les réécritures faites depuis sur
-- place :
--   * 20261027100200 (découverte) : sale_catalogue_projection_is_live et « not s.catalogue_quarantined » ;
--   * 20261101110000 : public_position_quality_flags et la colonne location_precision ;
--   * 20261103110000 (débloquée) : la colonne sale_conditions ;
--   * 20261111030117 : sale_document_photo_media ;
--   * 20261111040000 : le filtre des images « default » ;
-- puis les seules modifications de cette migration : les colonnes sale_procedure (et, pour la vue
-- découverte, le sale_procedure de source_blocks), source_conflicts et source_presence passent par leur
-- projection. Mêmes colonnes, même ordre, mêmes types, mêmes options ; create or replace view garde droits
-- et commentaires, les droits sont redonnés à l'identique. v_auction_sales_discovery_search lit les
-- colonnes de la vue découverte : elle suit sans changement. Le test supabase/tests/902 vérifie les
-- définitions et ce que lit chaque compte.
begin;

set local lock_timeout = '5s';

-- Retire, à toute profondeur, les clés dont le nom se termine par « source_url ». Récursive : PL/pgSQL.
create or replace function app_private.jsonb_without_source_url_keys(p_value jsonb)
returns jsonb
language plpgsql
immutable
parallel safe
security invoker
set search_path = ''
as $$
begin
  if pg_catalog.jsonb_typeof(p_value) = 'object' then
    return coalesce(
      (
        select pg_catalog.jsonb_object_agg(
          entry.key,
          app_private.jsonb_without_source_url_keys(entry.value)
        )
        from pg_catalog.jsonb_each(p_value) as entry(key, value)
        where entry.key !~ 'source_url$'
      ),
      '{}'::jsonb
    );
  end if;
  if pg_catalog.jsonb_typeof(p_value) = 'array' then
    return coalesce(
      (
        select pg_catalog.jsonb_agg(
          app_private.jsonb_without_source_url_keys(element.value)
          order by element.ordinality
        )
        from pg_catalog.jsonb_array_elements(p_value) with ordinality as element(value, ordinality)
      ),
      '[]'::jsonb
    );
  end if;
  return p_value;
end;
$$;

-- p_keep_document_urls : vrai pour une vente débloquée (les pièces lui sont ouvertes), faux pour la vue
-- découverte (vente non débloquée : la pièce garde son libellé et sa nature, pas son adresse).
create or replace function app_private.sale_procedure_without_listing_source(
  p_procedure jsonb,
  p_keep_document_urls boolean
)
returns jsonb
language sql
immutable
parallel safe
security invoker
set search_path = ''
as $$
  select case
    when pg_catalog.jsonb_typeof(stripped.procedure) = 'object'
      and pg_catalog.jsonb_typeof(stripped.procedure -> 'verification') = 'object'
      and stripped.procedure -> 'verification' ? 'case_sources'
      then pg_catalog.jsonb_set(
        stripped.procedure,
        '{verification,case_sources}',
        coalesce(
          (
            select pg_catalog.jsonb_agg(
              case
                when source.value ->> 'kind' = 'document' then source.value - (
                  case
                    when p_keep_document_urls is true then array['source_name']
                    else array['source_name', 'url']
                  end
                )
                else source.value
              end
              order by source.ordinality
            )
            -- case_sources qui n'est pas un tableau ne garde rien (fermé par défaut).
            from pg_catalog.jsonb_array_elements(
              case
                when pg_catalog.jsonb_typeof(stripped.procedure -> 'verification' -> 'case_sources') = 'array'
                  then stripped.procedure -> 'verification' -> 'case_sources'
                else '[]'::jsonb
              end
            ) with ordinality as source(value, ordinality)
            where source.value ->> 'kind' in ('document', 'official_reference')
          ),
          '[]'::jsonb
        )
      )
    else stripped.procedure
  end
  from (select app_private.jsonb_without_source_url_keys(p_procedure) as procedure) as stripped;
$$;

-- Les conflits entre sources (raw_payload.source_conflicts, écrits par services/data-pipeline/src/dedupe.py)
-- portent les adresses des annonces (selected_source, alternative_source, observed_primary_source). Sans
-- l'offre Analyse, l'application ne lit d'un conflit que son champ (field) et la présence d'un conflit :
-- chaque conflit ne garde que field (une chaîne), un conflit sans field reste un objet vide.
create or replace function app_private.source_conflicts_without_listing_source(p_conflicts jsonb)
returns jsonb
language sql
immutable
parallel safe
security invoker
set search_path = ''
as $$
  select coalesce(
    (
      select pg_catalog.jsonb_agg(
        case
          when pg_catalog.jsonb_typeof(conflict.value -> 'field') = 'string'
            then pg_catalog.jsonb_build_object('field', conflict.value -> 'field')
          else '{}'::jsonb
        end
        order by conflict.ordinality
      )
      from pg_catalog.jsonb_array_elements(
        case when pg_catalog.jsonb_typeof(p_conflicts) = 'array' then p_conflicts else '[]'::jsonb end
      ) with ordinality as conflict(value, ordinality)
    ),
    '[]'::jsonb
  );
$$;

-- La présence d'une vente dans ses sources (app_private.auction_sale_source_presence_json) est indexée par
-- le nom des plateformes, et ses extras recopient sans filtre les clés héritées de raw_payload.source_presence.
-- Sans l'offre Analyse, l'application n'en lit que availability et state : les entrées sont ré-indexées
-- source_1, source_2... (ordre des noms, collation C) et ne gardent que ces deux clés.
create or replace function app_private.source_presence_without_listing_source(p_presence jsonb)
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
          pg_catalog.row_number() over (order by presence.key collate "C") as rank,
          coalesce(
            (
              select pg_catalog.jsonb_object_agg(kept.key, kept.value)
              from pg_catalog.jsonb_each(
                case
                  when pg_catalog.jsonb_typeof(presence.value) = 'object' then presence.value
                  else '{}'::jsonb
                end
              ) as kept(key, value)
              where kept.key in ('availability', 'state')
            ),
            '{}'::jsonb
          ) as entry
        from pg_catalog.jsonb_each(
          case when pg_catalog.jsonb_typeof(p_presence) = 'object' then p_presence else '{}'::jsonb end
        ) as presence(key, value)
      ) as ranked
    ),
    '{}'::jsonb
  );
$$;

revoke all on function app_private.jsonb_without_source_url_keys(jsonb) from public, anon;
revoke all on function app_private.sale_procedure_without_listing_source(jsonb, boolean) from public, anon;
revoke all on function app_private.source_conflicts_without_listing_source(jsonb) from public, anon;
revoke all on function app_private.source_presence_without_listing_source(jsonb) from public, anon;
-- Exécutées avec les droits de l'appelant par les vues (security definer) ci-dessous.
grant execute on function app_private.jsonb_without_source_url_keys(jsonb)
  to authenticated, service_role;
grant execute on function app_private.sale_procedure_without_listing_source(jsonb, boolean)
  to authenticated, service_role;
grant execute on function app_private.source_conflicts_without_listing_source(jsonb)
  to authenticated, service_role;
grant execute on function app_private.source_presence_without_listing_source(jsonb)
  to authenticated, service_role;

comment on function app_private.sale_procedure_without_listing_source(jsonb, boolean) is
  'sale_procedure sans la source de l''annonce, pour un lecteur sans l''offre Analyse : case_sources limitées aux kinds document et official_reference, sans source_name sur les pièces (ni url si p_keep_document_urls n''est pas vrai), sans aucune clé *source_url. Même règle que saleProcedureWithoutListingSource (src/lib/property-report/entitlements.ts).';
comment on function app_private.source_conflicts_without_listing_source(jsonb) is
  'source_conflicts pour un lecteur sans l''offre Analyse : chaque conflit ne garde que field. Même règle que sourceConflictsWithoutListingSource (src/lib/property-report/entitlements.ts).';
comment on function app_private.source_presence_without_listing_source(jsonb) is
  'source_presence pour un lecteur sans l''offre Analyse : entrées ré-indexées source_N, availability et state seulement. Même règle que sourcePresenceWithoutListingSource (src/lib/property-report/entitlements.ts).';

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
  coalesce(c.source_checks, '{}'::jsonb) as source_checks,
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
  coalesce(c.source_checks, '{}'::jsonb) as source_checks,
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
