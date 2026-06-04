begin;

alter table public.auction_sales
  add column if not exists score_confidence numeric,
  add column if not exists score_factors jsonb not null default '[]'::jsonb;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'auction_sales_score_confidence_check') then
    alter table public.auction_sales
      add constraint auction_sales_score_confidence_check
      check (score_confidence is null or (score_confidence >= 0 and score_confidence <= 1));
  end if;
end $$;

alter table public.auction_risks
  add column if not exists evidence_json jsonb not null default '{}'::jsonb,
  add column if not exists confidence numeric,
  add column if not exists detector text,
  add column if not exists detector_version text,
  add column if not exists score_impact numeric;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'auction_risks_confidence_check') then
    alter table public.auction_risks
      add constraint auction_risks_confidence_check
      check (confidence is null or (confidence >= 0 and confidence <= 1));
  end if;
end $$;

create table if not exists public.auction_risk_occurrences (
  id uuid primary key default gen_random_uuid(),
  source_url text not null references public.auction_sales(source_url) on delete cascade,
  risk_type text not null,
  risk_label text not null,
  severity integer default 1,
  document_url text,
  document_label text,
  document_type text,
  page_number integer,
  excerpt text not null,
  confidence numeric,
  detector text,
  detector_version text,
  matched_terms jsonb not null default '[]'::jsonb,
  is_negated boolean not null default false,
  score_impact numeric,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists public.auction_score_factors (
  id uuid primary key default gen_random_uuid(),
  source_url text not null references public.auction_sales(source_url) on delete cascade,
  factor_order integer not null default 0,
  factor_key text not null,
  label text,
  reason text,
  delta numeric not null default 0,
  weight numeric not null default 1,
  raw_value jsonb,
  normalized_value jsonb,
  confidence numeric,
  evidence text,
  evidence_refs jsonb not null default '[]'::jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'auction_score_factors_confidence_check') then
    alter table public.auction_score_factors
      add constraint auction_score_factors_confidence_check
      check (confidence is null or (confidence >= 0 and confidence <= 1));
  end if;
end $$;

create unique index if not exists idx_auction_score_factors_source_key
  on public.auction_score_factors(source_url, factor_key);
create index if not exists idx_auction_score_factors_source_url
  on public.auction_score_factors(source_url);
create index if not exists idx_auction_risk_occurrences_source_url
  on public.auction_risk_occurrences(source_url);
create index if not exists idx_auction_risk_occurrences_label
  on public.auction_risk_occurrences(risk_label);
create index if not exists idx_auction_risk_occurrences_document_url
  on public.auction_risk_occurrences(document_url);
create index if not exists idx_auction_risks_type_label
  on public.auction_risks(risk_type, risk_label);

alter table public.auction_risk_occurrences enable row level security;
alter table public.auction_score_factors enable row level security;

grant select, insert, update, delete on table public.auction_risk_occurrences to service_role;
grant select, insert, update, delete on table public.auction_score_factors to service_role;
grant select (
  source_url, risk_type, risk_label, severity, document_url, document_label,
  document_type, page_number, excerpt, confidence, detector, detector_version,
  matched_terms, is_negated, score_impact, created_at, updated_at
) on public.auction_risk_occurrences to anon, authenticated;
grant select (
  source_url, factor_order, factor_key, label, reason, delta, weight,
  raw_value, normalized_value, confidence, evidence, evidence_refs, created_at, updated_at
) on public.auction_score_factors to anon, authenticated;

drop policy if exists auction_risk_occurrences_public_read on public.auction_risk_occurrences;
create policy auction_risk_occurrences_public_read
on public.auction_risk_occurrences for select
to anon, authenticated
using (true);

drop policy if exists auction_score_factors_public_read on public.auction_score_factors;
create policy auction_score_factors_public_read
on public.auction_score_factors for select
to anon, authenticated
using (true);

grant select (
  source_url, risk_type, risk_label, severity, evidence, evidence_json,
  confidence, detector, detector_version, score_impact, updated_at
) on public.auction_risks to anon, authenticated;

grant select (
  id, source_url, source_name, primary_source, tribunal, tribunal_code, department,
  city, address, postal_code, property_type, title, description, habitable_surface_m2,
  land_surface_m2, carrez_surface_m2, surface_m2, app_surface_m2, app_surface_kind,
  surface_scope, surface_source, surface_confidence, surface_evidence, rooms_count,
  bedrooms_count, bathrooms_count, parking_count, has_garden, has_terrace, has_garage,
  has_pool, has_air_conditioning, has_double_glazing, starting_price_eur, sale_date,
  visit_dates, status, documents, latitude, longitude, occupancy_status, risk_notes,
  investment_score, investment_summary, score_version, score_confidence, score_factors,
  source_urls, dedupe_confidence, quality_flags, first_seen_at, last_seen_at,
  created_at, updated_at
) on public.auction_sales to anon, authenticated;

insert into public.auction_scoring_versions(version, weights, notes)
values (
  'v2_quality_adjusted',
  '{"base_score":50,"occupation":1,"état":1,"type":1,"localisation":1,"surface":1,"prix_m2":1,"atouts":1,"risques":1,"qualité":1}'::jsonb,
  'Explainable scoring with confidence and evidence-ready factors'
)
on conflict (version) do update
set weights = excluded.weights,
    notes = excluded.notes;

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
where s.status in ('upcoming', 'unknown')
  and s.latitude is not null
  and s.longitude is not null;

grant select on table public.v_auction_sales_app to anon, authenticated;

notify pgrst, 'reload schema';

commit;
