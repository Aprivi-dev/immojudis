create extension if not exists pgcrypto;
create extension if not exists postgis;

create table if not exists public.properties (
  id uuid primary key default gen_random_uuid(),
  source_url text not null unique references public.auction_sales(source_url) on delete cascade,
  source_name text not null,
  primary_source text,
  source_urls jsonb not null default '[]'::jsonb,
  external_id text,
  department text,
  city text,
  postal_code text,
  address text,
  property_type text,
  title text,
  description text,
  surface_m2 numeric check (surface_m2 is null or surface_m2 >= 0),
  habitable_surface_m2 numeric check (habitable_surface_m2 is null or habitable_surface_m2 >= 0),
  land_surface_m2 numeric check (land_surface_m2 is null or land_surface_m2 >= 0),
  carrez_surface_m2 numeric check (carrez_surface_m2 is null or carrez_surface_m2 >= 0),
  app_surface_m2 numeric check (app_surface_m2 is null or app_surface_m2 >= 0),
  app_surface_kind text,
  surface_scope text,
  surface_source text,
  surface_confidence numeric check (surface_confidence is null or (surface_confidence >= 0 and surface_confidence <= 1)),
  surface_evidence text,
  rooms_count integer check (rooms_count is null or rooms_count >= 0),
  bedrooms_count integer check (bedrooms_count is null or bedrooms_count >= 0),
  bathrooms_count integer check (bathrooms_count is null or bathrooms_count >= 0),
  parking_count integer check (parking_count is null or parking_count >= 0),
  has_garden boolean,
  has_terrace boolean,
  has_garage boolean,
  has_pool boolean,
  has_air_conditioning boolean,
  has_double_glazing boolean,
  occupancy_status text,
  latitude double precision check (latitude is null or latitude between -90 and 90),
  longitude double precision check (longitude is null or longitude between -180 and 180),
  location geography(Point, 4326) generated always as (
    case
      when latitude is not null and longitude is not null
      then st_setsrid(st_makepoint(longitude, latitude), 4326)::geography
      else null
    end
  ) stored,
  raw_payload jsonb not null default '{}'::jsonb,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.judicial_sales (
  id uuid primary key default gen_random_uuid(),
  source_url text not null unique references public.auction_sales(source_url) on delete cascade,
  property_source_url text not null references public.properties(source_url) on delete cascade,
  source_name text not null,
  primary_source text,
  source_urls jsonb not null default '[]'::jsonb,
  external_id text,
  tribunal text,
  tribunal_code text references public.tribunals(code),
  starting_price_eur numeric check (starting_price_eur is null or starting_price_eur >= 0),
  sale_date timestamptz,
  visit_dates jsonb not null default '[]'::jsonb,
  status text not null default 'upcoming',
  adjudication_price_eur numeric check (adjudication_price_eur is null or adjudication_price_eur >= 0),
  source_lawyer_name text,
  source_lawyer_contact text,
  documents_count integer not null default 0 check (documents_count >= 0),
  investment_score numeric check (investment_score is null or (investment_score >= 0 and investment_score <= 100)),
  investment_summary text,
  score_version text,
  score_confidence numeric check (score_confidence is null or (score_confidence >= 0 and score_confidence <= 1)),
  score_factors jsonb not null default '[]'::jsonb,
  quality_flags jsonb not null default '[]'::jsonb,
  content_hash text,
  last_run_id uuid,
  raw_payload jsonb not null default '{}'::jsonb,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_properties_department_city on public.properties(department, city);
create index if not exists idx_properties_type on public.properties(property_type);
create index if not exists idx_properties_location on public.properties using gist(location);
create index if not exists idx_properties_source_urls on public.properties using gin(source_urls);

create index if not exists idx_judicial_sales_property_source_url on public.judicial_sales(property_source_url);
create index if not exists idx_judicial_sales_date on public.judicial_sales(sale_date);
create index if not exists idx_judicial_sales_status_date on public.judicial_sales(status, sale_date);
create index if not exists idx_judicial_sales_tribunal on public.judicial_sales(tribunal_code);
create index if not exists idx_judicial_sales_source_urls on public.judicial_sales using gin(source_urls);

insert into public.properties (
  source_url, source_name, primary_source, source_urls, external_id,
  department, city, postal_code, address, property_type, title, description,
  surface_m2, habitable_surface_m2, land_surface_m2, carrez_surface_m2,
  app_surface_m2, app_surface_kind, surface_scope, surface_source,
  surface_confidence, surface_evidence, rooms_count, bedrooms_count,
  bathrooms_count, parking_count, has_garden, has_terrace, has_garage,
  has_pool, has_air_conditioning, has_double_glazing, occupancy_status,
  latitude, longitude, raw_payload, first_seen_at, last_seen_at, updated_at
)
select
  s.source_url, s.source_name, s.primary_source, coalesce(s.source_urls, '[]'::jsonb), s.external_id,
  s.department, s.city, s.postal_code, s.address, s.property_type, s.title, s.description,
  s.surface_m2, s.habitable_surface_m2, s.land_surface_m2, s.carrez_surface_m2,
  s.app_surface_m2, s.app_surface_kind, s.surface_scope, s.surface_source,
  s.surface_confidence, s.surface_evidence, s.rooms_count, s.bedrooms_count,
  s.bathrooms_count, s.parking_count, s.has_garden, s.has_terrace, s.has_garage,
  s.has_pool, s.has_air_conditioning, s.has_double_glazing, s.occupancy_status,
  s.latitude::double precision, s.longitude::double precision, coalesce(s.raw_payload, '{}'::jsonb),
  coalesce(s.first_seen_at, now()), coalesce(s.last_seen_at, now()), now()
from public.auction_sales s
on conflict (source_url) do update set
  source_name = excluded.source_name,
  primary_source = excluded.primary_source,
  source_urls = excluded.source_urls,
  external_id = excluded.external_id,
  department = excluded.department,
  city = excluded.city,
  postal_code = excluded.postal_code,
  address = excluded.address,
  property_type = excluded.property_type,
  title = excluded.title,
  description = excluded.description,
  surface_m2 = excluded.surface_m2,
  habitable_surface_m2 = excluded.habitable_surface_m2,
  land_surface_m2 = excluded.land_surface_m2,
  carrez_surface_m2 = excluded.carrez_surface_m2,
  app_surface_m2 = excluded.app_surface_m2,
  app_surface_kind = excluded.app_surface_kind,
  surface_scope = excluded.surface_scope,
  surface_source = excluded.surface_source,
  surface_confidence = excluded.surface_confidence,
  surface_evidence = excluded.surface_evidence,
  rooms_count = excluded.rooms_count,
  bedrooms_count = excluded.bedrooms_count,
  bathrooms_count = excluded.bathrooms_count,
  parking_count = excluded.parking_count,
  has_garden = excluded.has_garden,
  has_terrace = excluded.has_terrace,
  has_garage = excluded.has_garage,
  has_pool = excluded.has_pool,
  has_air_conditioning = excluded.has_air_conditioning,
  has_double_glazing = excluded.has_double_glazing,
  occupancy_status = excluded.occupancy_status,
  latitude = excluded.latitude,
  longitude = excluded.longitude,
  raw_payload = excluded.raw_payload,
  last_seen_at = excluded.last_seen_at,
  updated_at = excluded.updated_at;

insert into public.judicial_sales (
  source_url, property_source_url, source_name, primary_source, source_urls,
  external_id, tribunal, tribunal_code, starting_price_eur, sale_date,
  visit_dates, status, adjudication_price_eur, source_lawyer_name,
  source_lawyer_contact, documents_count, investment_score, investment_summary,
  score_version, score_confidence, score_factors, quality_flags, content_hash,
  last_run_id, raw_payload, first_seen_at, last_seen_at, updated_at
)
select
  s.source_url, p.source_url, s.source_name, s.primary_source, coalesce(s.source_urls, '[]'::jsonb),
  s.external_id, s.tribunal, s.tribunal_code, s.starting_price_eur, s.sale_date,
  coalesce(s.visit_dates, '[]'::jsonb), coalesce(s.status, 'upcoming'), s.adjudication_price_eur,
  s.lawyer_name,
  s.lawyer_contact,
  case when jsonb_typeof(s.documents) = 'array' then jsonb_array_length(s.documents) else 0 end,
  s.investment_score, s.investment_summary, s.score_version, s.score_confidence,
  coalesce(s.score_factors, '[]'::jsonb), coalesce(s.quality_flags, '[]'::jsonb),
  s.content_hash, s.last_run_id, coalesce(s.raw_payload, '{}'::jsonb),
  coalesce(s.first_seen_at, now()), coalesce(s.last_seen_at, now()), now()
from public.auction_sales s
join public.properties p on p.source_url = s.source_url
on conflict (source_url) do update set
  property_source_url = excluded.property_source_url,
  source_name = excluded.source_name,
  primary_source = excluded.primary_source,
  source_urls = excluded.source_urls,
  external_id = excluded.external_id,
  tribunal = excluded.tribunal,
  tribunal_code = excluded.tribunal_code,
  starting_price_eur = excluded.starting_price_eur,
  sale_date = excluded.sale_date,
  visit_dates = excluded.visit_dates,
  status = excluded.status,
  adjudication_price_eur = excluded.adjudication_price_eur,
  source_lawyer_name = excluded.source_lawyer_name,
  source_lawyer_contact = excluded.source_lawyer_contact,
  documents_count = excluded.documents_count,
  investment_score = excluded.investment_score,
  investment_summary = excluded.investment_summary,
  score_version = excluded.score_version,
  score_confidence = excluded.score_confidence,
  score_factors = excluded.score_factors,
  quality_flags = excluded.quality_flags,
  content_hash = excluded.content_hash,
  last_run_id = excluded.last_run_id,
  raw_payload = excluded.raw_payload,
  last_seen_at = excluded.last_seen_at,
  updated_at = excluded.updated_at;

alter table public.properties enable row level security;
alter table public.judicial_sales enable row level security;

revoke all on table public.properties from anon, authenticated;
revoke all on table public.judicial_sales from anon, authenticated;
grant select, insert, update, delete on table public.properties to service_role;
grant select, insert, update, delete on table public.judicial_sales to service_role;
grant select on table public.properties to authenticated;
grant select on table public.judicial_sales to authenticated;

drop policy if exists properties_authenticated_read on public.properties;
create policy properties_authenticated_read
on public.properties for select
to authenticated
using (true);

drop policy if exists judicial_sales_authenticated_read on public.judicial_sales;
create policy judicial_sales_authenticated_read
on public.judicial_sales for select
to authenticated
using (true);
