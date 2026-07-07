begin;

create extension if not exists postgis;

create table if not exists public.auction_dpe_diagnostics (
  id uuid primary key default gen_random_uuid(),
  source_url text not null references public.auction_sales(source_url) on delete cascade,
  diagnostic_number text not null,
  dpe_class text check (dpe_class is null or dpe_class in ('A', 'B', 'C', 'D', 'E', 'F', 'G')),
  ges_class text check (ges_class is null or ges_class in ('A', 'B', 'C', 'D', 'E', 'F', 'G')),
  established_at date,
  valid_until date,
  last_modified_at date,
  property_type text,
  address text,
  city text,
  postal_code text,
  insee_code text,
  department text,
  surface_m2 numeric check (surface_m2 is null or surface_m2 > 0),
  energy_consumption_kwh_m2_year numeric check (
    energy_consumption_kwh_m2_year is null or energy_consumption_kwh_m2_year >= 0
  ),
  emissions_kg_co2_m2_year numeric check (
    emissions_kg_co2_m2_year is null or emissions_kg_co2_m2_year >= 0
  ),
  ban_score numeric check (ban_score is null or (ban_score >= 0 and ban_score <= 1)),
  latitude double precision check (latitude is null or latitude between -90 and 90),
  longitude double precision check (longitude is null or longitude between -180 and 180),
  location geography(Point, 4326) generated always as (
    case
      when latitude is not null and longitude is not null
        then st_setsrid(st_makepoint(longitude, latitude), 4326)::geography
      else null
    end
  ) stored,
  match_kind text not null default 'geo_distance' check (
    match_kind in ('geo_distance', 'address_query', 'source_number', 'manual')
  ),
  confidence numeric not null default 0.65 check (confidence >= 0 and confidence <= 1),
  source_api text not null default 'ADEME DPE Open Data',
  source_api_url text,
  raw_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.auction_dpe_diagnostics is
  'Structured DPE diagnostics matched to judicial sales from ADEME open data, consumed by plan-gated ImmoJudis APIs and reports.';

create unique index if not exists auction_dpe_diagnostics_source_number_uidx
  on public.auction_dpe_diagnostics (source_url, diagnostic_number);

create index if not exists auction_dpe_diagnostics_source_url_idx
  on public.auction_dpe_diagnostics (source_url);

create index if not exists auction_dpe_diagnostics_classes_idx
  on public.auction_dpe_diagnostics (dpe_class, ges_class);

create index if not exists auction_dpe_diagnostics_department_city_idx
  on public.auction_dpe_diagnostics (department, city);

create index if not exists auction_dpe_diagnostics_established_idx
  on public.auction_dpe_diagnostics (established_at desc nulls last);

create index if not exists auction_dpe_diagnostics_location_gix
  on public.auction_dpe_diagnostics using gist (location)
  where location is not null;

drop trigger if exists immojudis_auction_dpe_diagnostics_updated_at
on public.auction_dpe_diagnostics;
create trigger immojudis_auction_dpe_diagnostics_updated_at
before update on public.auction_dpe_diagnostics
for each row
execute function app_private.set_user_profiles_updated_at();

alter table public.auction_dpe_diagnostics enable row level security;

revoke all on table public.auction_dpe_diagnostics from anon, authenticated;
grant select, insert, update, delete on table public.auction_dpe_diagnostics to service_role;

notify pgrst, 'reload schema';

commit;
