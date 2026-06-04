begin;

-- The catalog is now account-gated: the homepage stays public, but auction
-- listings, map pins, documents, risks and scoring evidence require Supabase Auth.

-- Public/legacy read models must no longer be reachable by the anon role.
revoke all on table public.public_auction_sales from anon;
revoke all on table public.auction_sales_quality_issues from anon;
revoke all on table public.auction_sales_investment_candidates from anon;
revoke all on table public.auction_source_coverage from anon;
revoke all on table public.v_auction_sales_app from anon;
revoke all on table public.v_auction_map_pins from anon;

grant select on table public.public_auction_sales to authenticated;
grant select on table public.auction_sales_quality_issues to authenticated;
grant select on table public.auction_sales_investment_candidates to authenticated;
grant select on table public.auction_source_coverage to authenticated;
grant select on table public.v_auction_sales_app to authenticated;
grant select on table public.v_auction_map_pins to authenticated;

-- Base read model used by the app and map.
alter table public.auction_sales_app_read enable row level security;
revoke all on table public.auction_sales_app_read from anon;
grant select (
  source_url, id, title, city, department, postal_code, property_type,
  starting_price_eur, sale_date, latitude, longitude, occupancy_status,
  app_surface_m2, investment_score, score_confidence, score_version,
  deal_memo, quality_summary, risks, score_factors, documents_rich,
  created_at, updated_at
) on table public.auction_sales_app_read to authenticated;

drop policy if exists auction_sales_app_read_public_read on public.auction_sales_app_read;
drop policy if exists auction_sales_app_read_authenticated_read on public.auction_sales_app_read;
create policy auction_sales_app_read_authenticated_read
on public.auction_sales_app_read for select
to authenticated
using (true);

-- Canonical sales and document rows are still needed by security_invoker views,
-- but only for authenticated users.
alter table public.auction_sales enable row level security;
alter table public.auction_documents enable row level security;

revoke all on table public.auction_sales from anon;
revoke all on table public.auction_documents from anon;

grant select (
  id, source_url, source_name, primary_source, tribunal, tribunal_code,
  department, city, address, postal_code, property_type, title, description,
  habitable_surface_m2, land_surface_m2, carrez_surface_m2, surface_m2,
  app_surface_m2, app_surface_kind, surface_scope, surface_source,
  surface_confidence, surface_evidence, rooms_count, bedrooms_count,
  bathrooms_count, parking_count, has_garden, has_terrace, has_garage,
  has_pool, has_air_conditioning, has_double_glazing, starting_price_eur,
  sale_date, visit_dates, status, documents, latitude, longitude,
  occupancy_status, risk_notes, investment_score, investment_summary,
  source_urls, score_version, score_confidence, score_factors,
  dedupe_confidence, quality_flags, first_seen_at, last_seen_at,
  created_at, updated_at
) on table public.auction_sales to authenticated;

grant select (
  source_url, document_url, label, document_type, download_status,
  extraction_status, docling_status, text_chars, updated_at
) on table public.auction_documents to authenticated;

drop policy if exists auction_sales_public_read on public.auction_sales;
drop policy if exists auction_sales_authenticated_read on public.auction_sales;
create policy auction_sales_authenticated_read
on public.auction_sales for select
to authenticated
using (true);

drop policy if exists auction_documents_public_read on public.auction_documents;
drop policy if exists auction_documents_authenticated_read on public.auction_documents;
create policy auction_documents_authenticated_read
on public.auction_documents for select
to authenticated
using (true);

-- Structured scoring evidence and contextual facts.
alter table public.auction_features enable row level security;
alter table public.auction_surfaces enable row level security;
alter table public.auction_risks enable row level security;
alter table public.auction_risk_occurrences enable row level security;
alter table public.auction_score_factors enable row level security;
alter table public.auction_scoring_versions enable row level security;
alter table public.tribunals enable row level security;

revoke all on table public.auction_features from anon;
revoke all on table public.auction_surfaces from anon;
revoke all on table public.auction_risks from anon;
revoke all on table public.auction_risk_occurrences from anon;
revoke all on table public.auction_score_factors from anon;
revoke all on table public.auction_scoring_versions from anon;
revoke all on table public.tribunals from anon;

grant select on table public.auction_features to authenticated;
grant select on table public.auction_surfaces to authenticated;
grant select (
  source_url, risk_type, risk_label, severity, evidence, evidence_json,
  confidence, detector, detector_version, score_impact, updated_at
) on table public.auction_risks to authenticated;
grant select (
  source_url, risk_type, risk_label, severity, document_url, document_label,
  document_type, page_number, excerpt, confidence, detector, detector_version,
  matched_terms, is_negated, score_impact, created_at, updated_at
) on table public.auction_risk_occurrences to authenticated;
grant select (
  source_url, factor_order, factor_key, label, reason, delta, weight,
  raw_value, normalized_value, confidence, evidence, evidence_refs,
  created_at, updated_at
) on table public.auction_score_factors to authenticated;
grant select on table public.auction_scoring_versions to authenticated;
grant select on table public.tribunals to authenticated;

drop policy if exists auction_features_public_read on public.auction_features;
drop policy if exists auction_features_authenticated_read on public.auction_features;
create policy auction_features_authenticated_read
on public.auction_features for select
to authenticated
using (true);

drop policy if exists auction_surfaces_public_read on public.auction_surfaces;
drop policy if exists auction_surfaces_authenticated_read on public.auction_surfaces;
create policy auction_surfaces_authenticated_read
on public.auction_surfaces for select
to authenticated
using (true);

drop policy if exists auction_risks_public_read on public.auction_risks;
drop policy if exists auction_risks_authenticated_read on public.auction_risks;
create policy auction_risks_authenticated_read
on public.auction_risks for select
to authenticated
using (true);

drop policy if exists auction_risk_occurrences_public_read on public.auction_risk_occurrences;
drop policy if exists auction_risk_occurrences_authenticated_read on public.auction_risk_occurrences;
create policy auction_risk_occurrences_authenticated_read
on public.auction_risk_occurrences for select
to authenticated
using (true);

drop policy if exists auction_score_factors_public_read on public.auction_score_factors;
drop policy if exists auction_score_factors_authenticated_read on public.auction_score_factors;
create policy auction_score_factors_authenticated_read
on public.auction_score_factors for select
to authenticated
using (true);

drop policy if exists auction_scoring_versions_public_read on public.auction_scoring_versions;
drop policy if exists auction_scoring_versions_authenticated_read on public.auction_scoring_versions;
create policy auction_scoring_versions_authenticated_read
on public.auction_scoring_versions for select
to authenticated
using (true);

drop policy if exists tribunals_public_read on public.tribunals;
drop policy if exists tribunals_authenticated_read on public.tribunals;
create policy tribunals_authenticated_read
on public.tribunals for select
to authenticated
using (true);

notify pgrst, 'reload schema';

commit;
