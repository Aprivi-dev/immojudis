drop view if exists public.v_auction_sales_app;

create view public.v_auction_sales_app
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
  s.score_version,
  s.created_at,
  s.updated_at
from public.auction_sales s
left join public.tribunals t on t.code = s.tribunal_code
left join lateral (
  select jsonb_agg(
    jsonb_build_object(
      'risk_type', ar.risk_type,
      'risk_label', ar.risk_label,
      'severity', ar.severity,
      'evidence', ar.evidence,
      'updated_at', ar.updated_at
    )
    order by ar.severity desc nulls last, ar.risk_label
  ) as risks
  from public.auction_risks ar
  where ar.source_url = s.source_url
) r on true
left join lateral (
  select jsonb_agg(
    jsonb_build_object(
      'label', ad.label,
      'url', ad.document_url,
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
where s.status in ('upcoming', 'unknown')
  and s.latitude is not null
  and s.longitude is not null;

revoke all on table public.v_auction_sales_app from anon, authenticated;
grant select (
  id,
  title,
  city,
  department,
  postal_code,
  address,
  tribunal,
  tribunal_code,
  property_type,
  starting_price_eur,
  sale_date,
  latitude,
  longitude,
  occupancy_status,
  surface_m2,
  habitable_surface_m2,
  carrez_surface_m2,
  land_surface_m2,
  app_surface_m2,
  app_surface_kind,
  surface_scope,
  surface_source,
  surface_confidence,
  surface_evidence,
  rooms_count,
  bedrooms_count,
  bathrooms_count,
  parking_count,
  has_garden,
  has_terrace,
  has_garage,
  has_pool,
  has_air_conditioning,
  has_double_glazing,
  investment_score,
  investment_summary,
  risk_notes,
  source_name,
  primary_source,
  source_url,
  source_urls,
  dedupe_confidence,
  documents,
  status,
  quality_flags,
  score_version,
  created_at,
  updated_at
) on table public.auction_sales to anon, authenticated;
grant select (source_url, risk_type, risk_label, severity, evidence, updated_at)
  on table public.auction_risks to anon, authenticated;
grant select (
  source_url,
  document_url,
  label,
  document_type,
  download_status,
  extraction_status,
  docling_status,
  text_chars,
  updated_at
) on table public.auction_documents to anon, authenticated;
drop policy if exists auction_documents_public_read on public.auction_documents;
create policy auction_documents_public_read
on public.auction_documents
for select
to anon, authenticated
using (true);
grant select on table public.v_auction_sales_app to anon, authenticated;

notify pgrst, 'reload schema';
