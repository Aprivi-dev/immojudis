begin;

alter table public.auction_sales
  add column if not exists sale_venue_type text not null default 'unknown',
  add column if not exists sale_legal_framework text not null default 'unknown',
  add column if not exists sale_verification_status text not null default 'pending',
  add column if not exists sale_procedure jsonb not null default '{}'::jsonb;

alter table public.auction_sales
  drop constraint if exists auction_sales_sale_venue_type_check,
  add constraint auction_sales_sale_venue_type_check
    check (sale_venue_type in ('tribunal', 'notary', 'state', 'online', 'unknown')),
  drop constraint if exists auction_sales_sale_legal_framework_check,
  add constraint auction_sales_sale_legal_framework_check
    check (
      sale_legal_framework in (
        'judicial_seizure',
        'judicial_partition',
        'insolvency',
        'voluntary_notarial',
        'state_sale',
        'unknown'
      )
    ),
  drop constraint if exists auction_sales_sale_verification_status_check,
  add constraint auction_sales_sale_verification_status_check
    check (sale_verification_status in ('verified', 'cross_checked', 'pending', 'conflict')),
  drop constraint if exists auction_sales_sale_procedure_object_check,
  add constraint auction_sales_sale_procedure_object_check
    check (jsonb_typeof(sale_procedure) = 'object');

-- Preserve already computed procedure payloads when the migration is applied
-- after a pipeline run. Rows without evidence remain explicitly pending.
update public.auction_sales
set
  sale_procedure = raw_payload->'sale_procedure',
  sale_venue_type = case
    when raw_payload->'sale_procedure'->>'venue_type'
      in ('tribunal', 'notary', 'state', 'online', 'unknown')
      then raw_payload->'sale_procedure'->>'venue_type'
    else 'unknown'
  end,
  sale_legal_framework = case
    when raw_payload->'sale_procedure'->>'legal_framework'
      in (
        'judicial_seizure',
        'judicial_partition',
        'insolvency',
        'voluntary_notarial',
        'state_sale',
        'unknown'
      )
      then raw_payload->'sale_procedure'->>'legal_framework'
    else 'unknown'
  end,
  sale_verification_status = case
    when raw_payload->'sale_procedure'->'verification'->>'status'
      in ('verified', 'cross_checked', 'pending', 'conflict')
      then raw_payload->'sale_procedure'->'verification'->>'status'
    else 'pending'
  end
where jsonb_typeof(raw_payload->'sale_procedure') = 'object'
  and raw_payload->'sale_procedure' <> '{}'::jsonb;

create index if not exists auction_sales_venue_status_idx
  on public.auction_sales (sale_venue_type, status);

comment on column public.auction_sales.sale_venue_type is
  'Verified sale venue/operator axis: tribunal, notary, state, online or unknown.';
comment on column public.auction_sales.sale_legal_framework is
  'Legal framework kept separate from the venue so judicial notarial sales are not mislabelled.';
comment on column public.auction_sales.sale_verification_status is
  'Publication status for sale-specific venue facts: verified, cross_checked, pending or conflict.';
comment on column public.auction_sales.sale_procedure is
  'Versioned participation rules, evidence, official legal sources and per-fact verification.';

-- The participation guide is part of the free catalogue promise. Keep premium
-- analysis fields redacted, but expose the versioned procedure and its evidence
-- so a Discovery visitor does not need to research the sale mechanics elsewhere.
create or replace view public.v_auction_sales_discovery
with (security_invoker = false, security_barrier = true)
as
select
  s.id,
  s.title,
  null::text as description,
  null::text as source_description,
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
  null::text as lawyer_name,
  null::text as lawyer_contact,
  null::numeric as adjudication_price_eur,
  s.latitude,
  s.longitude,
  null::text as occupancy_status,
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
  case
    when nullif(s.raw_payload->>'raw_image_url', '') ~* '^https?://'
      then jsonb_build_array(jsonb_build_object(
        'type', 'image',
        'url', nullif(s.raw_payload->>'raw_image_url', '')
      ))
    else '[]'::jsonb
  end as media,
  jsonb_build_object('sale_procedure', s.sale_procedure) as source_blocks,
  '{}'::jsonb as source_blocks_by_source
from public.auction_sales s
left join public.tribunals t on t.code = s.tribunal_code
where s.status in ('upcoming', 'unknown')
  and s.latitude is not null
  and s.longitude is not null;

revoke all on table public.v_auction_sales_discovery from public, anon;
grant select on table public.v_auction_sales_discovery to authenticated;

-- Anonymous visitors only receive the mode and verification state in addition
-- to the existing teaser price. Detailed evidence remains behind registration.
create or replace view public.v_auction_sales_app_preview
with (security_invoker = true)
as
select
  s.id,
  s.starting_price_eur,
  s.sale_venue_type,
  s.sale_verification_status
from public.auction_sales s;

grant select (
  id,
  starting_price_eur,
  sale_venue_type,
  sale_verification_status
) on table public.auction_sales to anon;
revoke all on table public.v_auction_sales_app_preview from anon, authenticated;
grant select on table public.v_auction_sales_app_preview to anon, authenticated;

notify pgrst, 'reload schema';

commit;
