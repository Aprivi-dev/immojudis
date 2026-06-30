begin;

create or replace view public.v_auction_sales_app
with (security_invoker = true)
as
select
  s.id,
  s.title,
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
  s.surface_confidence,
  s.surface_evidence,
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
  s.investment_score,
  s.investment_summary,
  s.score_version,
  s.score_confidence,
  coalesce(sf.score_factors, nullif(s.score_factors, '[]'::jsonb), '[]'::jsonb) as score_factors,
  s.risk_notes,
  coalesce(r.risks, '[]'::jsonb) as risks,
  s.source_name,
  s.primary_source,
  s.source_url,
  s.source_urls,
  s.dedupe_confidence,
  s.documents,
  coalesce(d.documents_rich, '[]'::jsonb) as documents_rich,
  s.status,
  s.quality_flags,
  s.created_at,
  s.updated_at,
  coalesce(m.media, '[]'::jsonb) as media,
  s.raw_payload->'source_blocks' as source_blocks,
  s.description,
  nullif(s.raw_payload->>'source_description', '') as source_description,
  nullif(s.raw_payload->>'llm_display_description', '') as llm_display_description,
  coalesce(
    nullif(s.raw_payload->>'llm_display_description', ''),
    nullif(s.raw_payload->>'source_description', ''),
    nullif(s.raw_payload->'source_blocks'->>'description', ''),
    nullif(s.description, '')
  ) as about_description
from public.auction_sales s
left join public.tribunals t on t.code = s.tribunal_code
left join lateral (
  select jsonb_agg(
    jsonb_build_object(
      'risk_type', ar.risk_type,
      'risk_label', ar.risk_label,
      'severity', ar.severity,
      'evidence', ar.evidence,
      'evidence_json', ar.evidence_json,
      'confidence', ar.confidence,
      'detector', ar.detector,
      'detector_version', ar.detector_version,
      'score_impact', ar.score_impact,
      'updated_at', ar.updated_at,
      'occurrences', coalesce(ro.occurrences, '[]'::jsonb)
    )
    order by ar.severity desc nulls last, ar.risk_label
  ) as risks
  from public.auction_risks ar
  left join lateral (
    select jsonb_agg(
      jsonb_build_object(
        'document_url', aro.document_url,
        'document_label', aro.document_label,
        'document_type', aro.document_type,
        'page_number', aro.page_number,
        'excerpt', aro.excerpt,
        'confidence', aro.confidence,
        'detector', aro.detector,
        'detector_version', aro.detector_version,
        'matched_terms', aro.matched_terms,
        'score_impact', aro.score_impact,
        'updated_at', aro.updated_at
      )
      order by aro.confidence desc nulls last, aro.page_number nulls last
    ) as occurrences
    from public.auction_risk_occurrences aro
    where aro.source_url = ar.source_url
      and aro.risk_label = ar.risk_label
      and aro.is_negated = false
  ) ro on true
  where ar.source_url = s.source_url
) r on true
left join lateral (
  select jsonb_agg(
    jsonb_build_object(
      'factor_order', asf.factor_order,
      'factor_key', asf.factor_key,
      'label', asf.label,
      'reason', asf.reason,
      'delta', asf.delta,
      'weight', asf.weight,
      'raw_value', asf.raw_value,
      'normalized_value', asf.normalized_value,
      'confidence', asf.confidence,
      'evidence', asf.evidence,
      'evidence_refs', asf.evidence_refs
    )
    order by asf.factor_order, asf.factor_key
  ) as score_factors
  from public.auction_score_factors asf
  where asf.source_url = s.source_url
) sf on true
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
left join lateral (
  select jsonb_agg(
    jsonb_build_object(
      'type', 'image',
      'url', image_url,
      'source', image_source
    )
    order by source_rank, image_url
  ) as media
  from (
    select distinct on (image_url)
      image_url,
      image_source,
      source_rank
    from (
      select
        nullif(s.raw_payload->>'raw_image_url', '') as image_url,
        s.source_name as image_source,
        0 as source_rank
      union all
      select
        nullif(source_image.value, '') as image_url,
        s.source_name as image_source,
        1 as source_rank
      from jsonb_array_elements_text(
        case
          when jsonb_typeof(s.raw_payload->'source_images') = 'array'
            then s.raw_payload->'source_images'
          else '[]'::jsonb
        end
      ) as source_image(value)
      union all
      select
        nullif(observation.value->'raw_payload'->>'raw_image_url', '') as image_url,
        coalesce(observation.value->>'source_name', s.source_name) as image_source,
        2 as source_rank
      from jsonb_array_elements(
        case
          when jsonb_typeof(s.observations) = 'array'
            then s.observations
          else '[]'::jsonb
        end
      ) as observation(value)
      union all
      select
        nullif(observation_image.value, '') as image_url,
        coalesce(observation.value->>'source_name', s.source_name) as image_source,
        3 as source_rank
      from jsonb_array_elements(
        case
          when jsonb_typeof(s.observations) = 'array'
            then s.observations
          else '[]'::jsonb
        end
      ) as observation(value)
      cross join lateral jsonb_array_elements_text(
        case
          when jsonb_typeof(observation.value->'raw_payload'->'source_images') = 'array'
            then observation.value->'raw_payload'->'source_images'
          else '[]'::jsonb
        end
      ) as observation_image(value)
    ) source_media
    where image_url is not null
      and image_url ~* '^https?://'
      and image_url !~* '\.(pdf|docx?|svg)([?#].*)?$'
      and image_url !~* '(^|[/_.-])(avatar|brand|default|favicon|icon|icone|logo|placeholder|profile|sprite|user)([/_.-]|$)'
    order by image_url, source_rank
  ) deduped_media
) m on true
where s.status in ('upcoming', 'unknown')
  and s.latitude is not null
  and s.longitude is not null;

grant select on table public.v_auction_sales_app to anon, authenticated;

notify pgrst, 'reload schema';

commit;
