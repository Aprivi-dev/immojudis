-- The production project predates the repository migration history. Its core
-- schema used to exist only in the remote database, which made a clean local
-- `supabase start` fail on the first index below. Keep that original baseline
-- here so the checked-in migration chain can rebuild an empty database.
create table if not exists public.tribunals (
  code text primary key,
  canonical_name text not null unique,
  department text not null,
  city text not null,
  aliases jsonb default '[]'::jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists public.auction_runs (
  id uuid primary key default gen_random_uuid(),
  status text not null default 'running',
  source text,
  use_llm boolean default true,
  started_at timestamptz default now(),
  finished_at timestamptz,
  summary jsonb default '{}'::jsonb,
  errors jsonb default '{}'::jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists public.auction_sales (
  id uuid primary key default gen_random_uuid(),
  source_name text not null,
  source_url text not null unique,
  external_id text,
  primary_source text,
  source_urls jsonb default '[]'::jsonb,
  tribunal text,
  tribunal_code text references public.tribunals(code),
  department text,
  city text,
  address text,
  postal_code text,
  property_type text check (
    property_type is null
    or property_type in ('apartment', 'house', 'building', 'land', 'commercial', 'parking', 'mixed', 'other', 'unknown')
  ),
  title text,
  description text,
  surface_m2 numeric,
  habitable_surface_m2 numeric,
  land_surface_m2 numeric,
  carrez_surface_m2 numeric,
  app_surface_m2 numeric,
  app_surface_kind text,
  surface_scope text check (
    surface_scope is null
    or surface_scope in ('total', 'room', 'annex', 'room_or_annex', 'land', 'unknown')
  ),
  surface_source text,
  surface_confidence numeric check (
    surface_confidence is null or surface_confidence between 0 and 1
  ),
  surface_evidence text,
  rooms_count integer,
  bedrooms_count integer,
  bathrooms_count integer,
  parking_count integer,
  has_garden boolean,
  has_terrace boolean,
  has_garage boolean,
  has_pool boolean,
  has_air_conditioning boolean,
  has_double_glazing boolean,
  starting_price_eur numeric,
  sale_date timestamptz,
  visit_dates jsonb,
  lawyer_name text,
  lawyer_contact text,
  status text default 'upcoming' check (
    status in ('upcoming', 'past', 'adjudicated', 'unknown')
  ),
  adjudication_price_eur numeric,
  documents jsonb,
  latitude numeric check (latitude is null or latitude between -90 and 90),
  longitude numeric check (longitude is null or longitude between -180 and 180),
  occupancy_status text check (
    occupancy_status is null
    or occupancy_status in ('vacant', 'occupied', 'rented', 'owner_occupied', 'squatted', 'unknown')
  ),
  risk_notes text,
  investment_score numeric check (
    investment_score is null or investment_score between 0 and 100
  ),
  investment_summary text,
  score_version text,
  quality_flags jsonb default '[]'::jsonb,
  dedupe_confidence text,
  observations jsonb default '[]'::jsonb,
  raw_text text,
  raw_payload jsonb,
  content_hash text,
  last_run_id uuid,
  first_seen_at timestamptz default now(),
  last_seen_at timestamptz default now(),
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  constraint auction_sales_rooms_bedrooms_check check (
    rooms_count is null or bedrooms_count is null or rooms_count >= bedrooms_count
  )
);

create table if not exists public.auction_features (
  source_url text primary key references public.auction_sales(source_url) on delete cascade,
  bathrooms_count integer,
  parking_count integer,
  has_garden boolean,
  has_terrace boolean,
  has_garage boolean,
  has_pool boolean,
  has_air_conditioning boolean,
  has_double_glazing boolean,
  investment_score numeric,
  investment_summary text,
  updated_at timestamptz default now()
);

create table if not exists public.auction_surfaces (
  source_url text primary key references public.auction_sales(source_url) on delete cascade,
  surface_m2 numeric,
  habitable_surface_m2 numeric,
  land_surface_m2 numeric,
  carrez_surface_m2 numeric,
  rooms_count integer,
  bedrooms_count integer,
  bathrooms_count integer,
  parking_count integer,
  app_surface_m2 numeric,
  app_surface_kind text,
  surface_source text,
  surface_confidence numeric,
  surface_evidence text,
  surface_scope text,
  updated_at timestamptz default now()
);

create table if not exists public.auction_risks (
  id uuid primary key default gen_random_uuid(),
  source_url text not null references public.auction_sales(source_url) on delete cascade,
  risk_type text not null,
  risk_label text not null,
  severity integer default 1,
  evidence text,
  updated_at timestamptz default now()
);

create table if not exists public.auction_observations (
  source_url text primary key,
  source_name text not null,
  external_id text,
  canonical_source_url text references public.auction_sales(source_url) on delete set null,
  content_hash text,
  raw_payload jsonb,
  observed_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists public.auction_documents (
  id uuid primary key default gen_random_uuid(),
  source_url text not null references public.auction_sales(source_url) on delete cascade,
  document_url text not null unique,
  label text,
  document_type text,
  file_path text,
  sha256 text,
  download_status text default 'unknown',
  extraction_status text default 'pending',
  docling_status text,
  docling_duration_ms integer,
  text_chars integer,
  error_message text,
  raw_payload jsonb default '{}'::jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists public.auction_extractions (
  id uuid primary key default gen_random_uuid(),
  source_url text not null references public.auction_sales(source_url) on delete cascade,
  provider text not null,
  model text,
  input_hash text not null,
  schema_version text not null default 'v1',
  confidence jsonb default '{}'::jsonb,
  result jsonb default '{}'::jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique (source_url, provider, input_hash)
);

create table if not exists public.auction_scoring_versions (
  version text primary key,
  weights jsonb not null,
  notes text,
  created_at timestamptz default now()
);

create table if not exists public.auction_sale_history (
  id uuid primary key default gen_random_uuid(),
  source_url text not null,
  changed_at timestamptz default now(),
  old_row jsonb,
  new_row jsonb
);

create table if not exists public.user_favorites (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  sale_id uuid not null references public.auction_sales(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (user_id, sale_id)
);

create table if not exists public.user_alerts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  department text,
  city text,
  property_type text,
  max_price_eur numeric,
  min_surface_m2 numeric,
  occupancy_status text,
  min_investment_score numeric,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.auction_sales enable row level security;
alter table public.auction_features enable row level security;
alter table public.auction_surfaces enable row level security;
alter table public.auction_risks enable row level security;
alter table public.auction_observations enable row level security;
alter table public.auction_documents enable row level security;
alter table public.auction_extractions enable row level security;
alter table public.auction_scoring_versions enable row level security;
alter table public.auction_sale_history enable row level security;
alter table public.auction_runs enable row level security;
alter table public.tribunals enable row level security;
alter table public.user_favorites enable row level security;
alter table public.user_alerts enable row level security;

-- These tables predate the later default-privilege hardening. Preserve the
-- original trusted-worker access explicitly so fresh projects behave like the
-- production project instead of depending on platform defaults.
grant select, insert, update, delete on table
  public.tribunals,
  public.auction_runs,
  public.auction_sales,
  public.auction_features,
  public.auction_surfaces,
  public.auction_risks,
  public.auction_observations,
  public.auction_documents,
  public.auction_extractions,
  public.auction_scoring_versions,
  public.auction_sale_history,
  public.user_favorites,
  public.user_alerts
to service_role;

create index if not exists idx_auction_sales_department on public.auction_sales(department);
create index if not exists idx_auction_sales_city on public.auction_sales(city);
create index if not exists idx_auction_sales_sale_date on public.auction_sales(sale_date);
create index if not exists idx_auction_sales_status on public.auction_sales(status);
create index if not exists idx_auction_sales_content_hash on public.auction_sales(content_hash);
create index if not exists idx_auction_documents_source_url on public.auction_documents(source_url);
create index if not exists idx_auction_risks_source_url on public.auction_risks(source_url);
create index if not exists idx_auction_observations_source_name on public.auction_observations(source_name);
create index if not exists idx_user_favorites_user on public.user_favorites(user_id);
create index if not exists idx_user_alerts_user on public.user_alerts(user_id);

create or replace view public.public_auction_sales
with (security_invoker = true)
as
select
  source_url, source_name, primary_source, tribunal, tribunal_code, department,
  city, address, postal_code, property_type, title, description,
  habitable_surface_m2, land_surface_m2, carrez_surface_m2, app_surface_m2,
  app_surface_kind, surface_scope, rooms_count, bedrooms_count, bathrooms_count,
  parking_count, has_garden, has_terrace, has_garage, has_pool,
  has_air_conditioning, has_double_glazing, starting_price_eur, sale_date,
  visit_dates, status, documents, latitude, longitude, occupancy_status,
  investment_score, investment_summary, quality_flags, first_seen_at,
  last_seen_at, updated_at
from public.auction_sales;

create or replace view public.auction_sales_quality_issues
with (security_invoker = true)
as
select
  source_url, source_name, city, department, tribunal, quality_flags,
  app_surface_m2, rooms_count, bedrooms_count, latitude, longitude, updated_at
from public.auction_sales
where quality_flags <> '[]'::jsonb
   or app_surface_m2 is null
   or rooms_count is null
   or bedrooms_count is null
   or latitude is null
   or longitude is null;

create or replace view public.auction_sales_investment_candidates
with (security_invoker = true)
as
select *
from public.public_auction_sales
where status = 'upcoming' and investment_score is not null;

create or replace view public.auction_source_coverage
with (security_invoker = true)
as
select
  source_name,
  department,
  count(*) as sales_count,
  count(*) filter (where app_surface_m2 is not null) as with_app_surface,
  count(*) filter (where latitude is not null and longitude is not null) as with_gps
from public.auction_sales
group by source_name, department;

-- Index composite pour accélérer les requêtes par bounding box (carte, ventes voisines, DVF).
-- La vue v_auction_sales_app expose lat/lng depuis la table auction_sales.
CREATE INDEX IF NOT EXISTS auction_sales_lat_lng_idx
  ON public.auction_sales (latitude, longitude)
  WHERE latitude IS NOT NULL AND longitude IS NOT NULL;

-- Index pour le tri principal (date de vente) avec filtre département très courant.
CREATE INDEX IF NOT EXISTS auction_sales_department_sale_date_idx
  ON public.auction_sales (department, sale_date);

-- Index pour le tri par score (filtre "meilleur score").
CREATE INDEX IF NOT EXISTS auction_sales_investment_score_idx
  ON public.auction_sales (investment_score DESC NULLS LAST);
