create extension if not exists pgcrypto;
create extension if not exists postgis;

create table if not exists tribunals (
  code text primary key,
  canonical_name text not null unique,
  department text not null,
  city text not null,
  aliases jsonb default '[]'::jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

insert into tribunals (code, canonical_name, department, city, aliases) values
  ('bordeaux', 'TJ Bordeaux', '33', 'Bordeaux', '["TJ BORDEAUX", "Tribunal Judiciaire de Bordeaux", "Tribunal Judiciaire de Bordeaux (Gironde)"]'::jsonb),
  ('libourne', 'TJ Libourne', '33', 'Libourne', '["TJ LIBOURNE", "Tribunal Judiciaire de Libourne"]'::jsonb),
  ('perigueux', 'TJ Périgueux', '24', 'Périgueux', '["TJ PERIGUEUX", "TJ PÉRIGUEUX", "Tribunal Judiciaire de Périgueux"]'::jsonb),
  ('bergerac', 'TJ Bergerac', '24', 'Bergerac', '["TJ BERGERAC", "Tribunal Judiciaire de Bergerac"]'::jsonb),
  ('dax', 'TJ Dax', '40', 'Dax', '["TJ DAX", "Tribunal Judiciaire de Dax"]'::jsonb),
  ('mont_de_marsan', 'TJ Mont-de-Marsan', '40', 'Mont-de-Marsan', '["TJ MONT-DE-MARSAN", "TJ Mont de Marsan", "Tribunal Judiciaire de Mont-de-Marsan"]'::jsonb),
  ('agen', 'TJ Agen', '47', 'Agen', '["TJ AGEN", "Tribunal Judiciaire de Agen", "Tribunal Judiciaire d''Agen"]'::jsonb),
  ('marmande', 'TJ Marmande', '47', 'Marmande', '["TJ MARMANDE", "Tribunal Judiciaire de Marmande"]'::jsonb),
  ('bayonne', 'TJ Bayonne', '64', 'Bayonne', '["TJ BAYONNE", "Tribunal Judiciaire de Bayonne"]'::jsonb),
  ('pau', 'TJ Pau', '64', 'Pau', '["TJ PAU", "Tribunal Judiciaire de Pau"]'::jsonb)
on conflict (code) do update set
  canonical_name = excluded.canonical_name,
  department = excluded.department,
  city = excluded.city,
  aliases = excluded.aliases,
  updated_at = now();

create table if not exists auction_sales (
  id uuid primary key default gen_random_uuid(),
  source_name text not null,
  source_url text not null unique,
  primary_source text,
  source_urls jsonb default '[]'::jsonb,
  dedupe_confidence text,
  external_id text,
  tribunal text,
  tribunal_code text references tribunals(code),
  department text,
  city text,
  address text,
  postal_code text,
  property_type text,
  title text,
  description text,
  surface_m2 numeric,
  habitable_surface_m2 numeric,
  land_surface_m2 numeric,
  carrez_surface_m2 numeric,
  app_surface_m2 numeric,
  app_surface_kind text,
  surface_scope text,
  surface_source text,
  surface_confidence numeric,
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
  status text default 'upcoming',
  adjudication_price_eur numeric,
  documents jsonb,
  latitude numeric,
  longitude numeric,
  occupancy_status text,
  risk_notes text,
  investment_score numeric,
  investment_summary text,
  score_version text,
  score_confidence numeric,
  score_factors jsonb default '[]'::jsonb,
  quality_flags jsonb default '[]'::jsonb,
  raw_text text,
  raw_payload jsonb,
  observations jsonb default '[]'::jsonb,
  content_hash text,
  last_run_id uuid,
  first_seen_at timestamptz default now(),
  last_seen_at timestamptz default now(),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'auction_sales'
      and column_name = 'department' and data_type <> 'text'
  ) then
    alter table auction_sales alter column department type text using department::text;
  end if;
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'auction_sales'
      and column_name = 'postal_code' and data_type <> 'text'
  ) then
    alter table auction_sales alter column postal_code type text using postal_code::text;
  end if;
end $$;
alter table auction_sales add column if not exists rooms_count integer;
alter table auction_sales add column if not exists bedrooms_count integer;
alter table auction_sales add column if not exists tribunal_code text references tribunals(code);
alter table auction_sales add column if not exists primary_source text;
alter table auction_sales add column if not exists source_urls jsonb default '[]'::jsonb;
alter table auction_sales add column if not exists dedupe_confidence text;
alter table auction_sales add column if not exists habitable_surface_m2 numeric;
alter table auction_sales add column if not exists land_surface_m2 numeric;
alter table auction_sales add column if not exists carrez_surface_m2 numeric;
alter table auction_sales add column if not exists app_surface_m2 numeric;
alter table auction_sales add column if not exists app_surface_kind text;
alter table auction_sales add column if not exists surface_scope text;
alter table auction_sales add column if not exists surface_source text;
alter table auction_sales add column if not exists surface_confidence numeric;
alter table auction_sales add column if not exists surface_evidence text;
alter table auction_sales add column if not exists bathrooms_count integer;
alter table auction_sales add column if not exists parking_count integer;
alter table auction_sales add column if not exists has_garden boolean;
alter table auction_sales add column if not exists has_terrace boolean;
alter table auction_sales add column if not exists has_garage boolean;
alter table auction_sales add column if not exists has_pool boolean;
alter table auction_sales add column if not exists has_air_conditioning boolean;
alter table auction_sales add column if not exists has_double_glazing boolean;
alter table auction_sales add column if not exists investment_score numeric;
alter table auction_sales add column if not exists investment_summary text;
alter table auction_sales add column if not exists score_version text;
alter table auction_sales add column if not exists score_confidence numeric;
alter table auction_sales add column if not exists score_factors jsonb default '[]'::jsonb;
alter table auction_sales add column if not exists quality_flags jsonb default '[]'::jsonb;
alter table auction_sales add column if not exists observations jsonb default '[]'::jsonb;
alter table auction_sales add column if not exists last_run_id uuid;
alter table auction_sales add column if not exists location geography(Point, 4326)
  generated always as (
    case
      when latitude is not null and longitude is not null
      then st_setsrid(st_makepoint(longitude::float8, latitude::float8), 4326)::geography
      else null
    end
  ) stored;

update auction_sales
set tribunal_code = case
  when tribunal ilike '%bordeaux%' then 'bordeaux'
  when tribunal ilike '%libourne%' then 'libourne'
  when tribunal ilike '%périgueux%' or tribunal ilike '%perigueux%' then 'perigueux'
  when tribunal ilike '%bergerac%' then 'bergerac'
  when tribunal ilike '%mont%marsan%' then 'mont_de_marsan'
  when tribunal ilike '%dax%' then 'dax'
  when tribunal ilike '%bayonne%' then 'bayonne'
  when tribunal ilike '%pau%' then 'pau'
  when tribunal ilike '%agen%' then 'agen'
  when tribunal ilike '%marmande%' then 'marmande'
  else tribunal_code
end
where tribunal_code is null and tribunal is not null;

update auction_sales s
set tribunal = t.canonical_name
from tribunals t
where s.tribunal_code = t.code;

create table if not exists auction_observations (
  source_url text primary key,
  source_name text not null,
  external_id text,
  canonical_source_url text references auction_sales(source_url) on delete set null,
  content_hash text,
  raw_payload jsonb,
  observed_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists auction_features (
  source_url text primary key references auction_sales(source_url) on delete cascade,
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

create table if not exists auction_surfaces (
  source_url text primary key references auction_sales(source_url) on delete cascade,
  surface_m2 numeric,
  habitable_surface_m2 numeric,
  land_surface_m2 numeric,
  carrez_surface_m2 numeric,
  app_surface_m2 numeric,
  app_surface_kind text,
  surface_scope text,
  surface_source text,
  surface_confidence numeric,
  surface_evidence text,
  rooms_count integer,
  bedrooms_count integer,
  bathrooms_count integer,
  parking_count integer,
  updated_at timestamptz default now()
);

alter table auction_surfaces add column if not exists app_surface_m2 numeric;
alter table auction_surfaces add column if not exists app_surface_kind text;
alter table auction_surfaces add column if not exists surface_scope text;
alter table auction_surfaces add column if not exists surface_source text;
alter table auction_surfaces add column if not exists surface_confidence numeric;
alter table auction_surfaces add column if not exists surface_evidence text;

create table if not exists auction_risks (
  id uuid primary key default gen_random_uuid(),
  source_url text not null references auction_sales(source_url) on delete cascade,
  risk_type text not null,
  risk_label text not null,
  severity integer default 1,
  evidence text,
  evidence_json jsonb default '{}'::jsonb,
  confidence numeric,
  detector text,
  detector_version text,
  score_impact numeric,
  updated_at timestamptz default now()
);

create table if not exists auction_runs (
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

create table if not exists auction_documents (
  id uuid primary key default gen_random_uuid(),
  source_url text not null references auction_sales(source_url) on delete cascade,
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

create table if not exists auction_extractions (
  id uuid primary key default gen_random_uuid(),
  source_url text not null references auction_sales(source_url) on delete cascade,
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

create table if not exists auction_risk_occurrences (
  id uuid primary key default gen_random_uuid(),
  source_url text not null references auction_sales(source_url) on delete cascade,
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
  matched_terms jsonb default '[]'::jsonb,
  is_negated boolean default false,
  score_impact numeric,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists auction_score_factors (
  id uuid primary key default gen_random_uuid(),
  source_url text not null references auction_sales(source_url) on delete cascade,
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
  evidence_refs jsonb default '[]'::jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists auction_scoring_versions (
  version text primary key,
  weights jsonb not null,
  notes text,
  created_at timestamptz default now()
);

insert into auction_scoring_versions (version, weights, notes) values
  ('v1', '{"base_score":50,"occupation":1,"état":1,"type":1,"localisation":1,"surface":1,"prix_m2":1,"atouts":1,"risques":1}'::jsonb, 'Initial explicable scoring weights'),
  ('v3_contextual_evidence', '{"base_score":50,"occupation":1,"état":1,"type":1,"localisation":1,"surface":1,"prix_m2":1,"atouts":1,"risques":1,"qualité":1}'::jsonb, 'Contextual risk scoring: document type, property-specific assertions and positive diagnostic evidence')
on conflict (version) do update set weights = excluded.weights, notes = excluded.notes;

create table if not exists auction_sale_history (
  id uuid primary key default gen_random_uuid(),
  source_url text not null,
  changed_at timestamptz default now(),
  old_row jsonb,
  new_row jsonb
);

create or replace function log_auction_sale_change()
returns trigger
language plpgsql
as $$
begin
  if (to_jsonb(old) - 'updated_at' - 'last_seen_at') is distinct from (to_jsonb(new) - 'updated_at' - 'last_seen_at') then
    insert into auction_sale_history (source_url, old_row, new_row)
    values (new.source_url, to_jsonb(old), to_jsonb(new));
  end if;
  return new;
end;
$$;

drop trigger if exists trg_log_auction_sale_change on auction_sales;
create trigger trg_log_auction_sale_change
after update on auction_sales
for each row execute function log_auction_sale_change();

create index if not exists idx_auction_sales_department on auction_sales(department);
create index if not exists idx_auction_sales_city on auction_sales(city);
create index if not exists idx_auction_sales_sale_date on auction_sales(sale_date);
create index if not exists idx_auction_sales_status on auction_sales(status);
create index if not exists idx_auction_sales_content_hash on auction_sales(content_hash);
create index if not exists idx_auction_sales_investment_score on auction_sales(investment_score);
create index if not exists idx_auction_sales_primary_source on auction_sales(primary_source);
create index if not exists idx_auction_sales_property_type on auction_sales(property_type);
create index if not exists idx_auction_sales_starting_price on auction_sales(starting_price_eur);
create index if not exists idx_auction_sales_latlng on auction_sales(latitude, longitude);
create index if not exists idx_auction_sales_location on auction_sales using gist(location);
create index if not exists idx_auction_sales_tribunal_code on auction_sales(tribunal_code);
create index if not exists idx_auction_observations_source_name on auction_observations(source_name);
create index if not exists idx_auction_observations_content_hash on auction_observations(content_hash);
create index if not exists idx_auction_features_investment_score on auction_features(investment_score);
create index if not exists idx_auction_risks_source_url on auction_risks(source_url);
create index if not exists idx_auction_risks_label on auction_risks(risk_label);
create index if not exists idx_auction_risks_type_label on auction_risks(risk_type, risk_label);
create index if not exists idx_auction_documents_source_url on auction_documents(source_url);
create index if not exists idx_auction_documents_type on auction_documents(document_type);
create index if not exists idx_auction_extractions_source_url on auction_extractions(source_url);
create index if not exists idx_auction_extractions_provider on auction_extractions(provider);
create unique index if not exists idx_auction_score_factors_source_key on auction_score_factors(source_url, factor_key);
create index if not exists idx_auction_score_factors_source_url on auction_score_factors(source_url);
create index if not exists idx_auction_risk_occurrences_source_url on auction_risk_occurrences(source_url);
create index if not exists idx_auction_risk_occurrences_label on auction_risk_occurrences(risk_label);
create index if not exists idx_auction_risk_occurrences_document_url on auction_risk_occurrences(document_url);
create index if not exists idx_auction_runs_started_at on auction_runs(started_at);
create index if not exists idx_auction_sale_history_source_url on auction_sale_history(source_url);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'auction_sales_status_check') then
    alter table auction_sales add constraint auction_sales_status_check check (status in ('upcoming','past','adjudicated','unknown'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'auction_sales_property_type_check') then
    alter table auction_sales add constraint auction_sales_property_type_check check (property_type is null or property_type in ('apartment','house','building','land','commercial','parking','mixed','other','unknown'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'auction_sales_occupancy_status_check') then
    alter table auction_sales add constraint auction_sales_occupancy_status_check check (occupancy_status is null or occupancy_status in ('vacant','occupied','rented','owner_occupied','squatted','unknown'));
  end if;
  if exists (select 1 from pg_constraint where conname = 'auction_sales_department_check') then
    alter table auction_sales drop constraint auction_sales_department_check;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'auction_sales_surface_confidence_check') then
    alter table auction_sales add constraint auction_sales_surface_confidence_check check (surface_confidence is null or (surface_confidence >= 0 and surface_confidence <= 1));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'auction_sales_investment_score_check') then
    alter table auction_sales add constraint auction_sales_investment_score_check check (investment_score is null or (investment_score >= 0 and investment_score <= 100));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'auction_sales_score_confidence_check') then
    alter table auction_sales add constraint auction_sales_score_confidence_check check (score_confidence is null or (score_confidence >= 0 and score_confidence <= 1));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'auction_sales_rooms_bedrooms_check') then
    alter table auction_sales add constraint auction_sales_rooms_bedrooms_check check (rooms_count is null or bedrooms_count is null or rooms_count >= bedrooms_count);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'auction_sales_latitude_check') then
    alter table auction_sales add constraint auction_sales_latitude_check check (latitude is null or (latitude >= -90 and latitude <= 90));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'auction_sales_longitude_check') then
    alter table auction_sales add constraint auction_sales_longitude_check check (longitude is null or (longitude >= -180 and longitude <= 180));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'auction_sales_surface_scope_check') then
    alter table auction_sales add constraint auction_sales_surface_scope_check check (surface_scope is null or surface_scope in ('total','room','annex','room_or_annex','land','unknown'));
  end if;
end $$;

create or replace view public_auction_sales
with (security_invoker = true)
as
select
  source_url, source_name, primary_source, tribunal, tribunal_code, department, city, address, postal_code,
  property_type, title, description, habitable_surface_m2, land_surface_m2, carrez_surface_m2,
  app_surface_m2, app_surface_kind, surface_scope, rooms_count, bedrooms_count, bathrooms_count,
  parking_count, has_garden, has_terrace, has_garage, has_pool, has_air_conditioning,
  has_double_glazing, starting_price_eur, sale_date, visit_dates, status, documents,
  latitude, longitude, occupancy_status, investment_score, investment_summary,
  score_version, score_confidence, score_factors, quality_flags,
  first_seen_at, last_seen_at, updated_at
from auction_sales;

create or replace view auction_sales_quality_issues
with (security_invoker = true)
as
select source_url, source_name, city, department, tribunal, quality_flags, app_surface_m2, rooms_count,
       bedrooms_count, latitude, longitude, updated_at
from auction_sales
where quality_flags <> '[]'::jsonb
   or app_surface_m2 is null
   or rooms_count is null
   or bedrooms_count is null
   or latitude is null
   or longitude is null;

create or replace view auction_sales_investment_candidates
with (security_invoker = true)
as
select *
from public_auction_sales
where status = 'upcoming'
  and investment_score is not null
order by investment_score desc nulls last, sale_date asc;

create or replace view auction_source_coverage
with (security_invoker = true)
as
select source_name, department, count(*) as sales_count,
       count(*) filter (where app_surface_m2 is not null) as with_app_surface,
       count(*) filter (where latitude is not null and longitude is not null) as with_gps
from auction_sales
group by source_name, department;

create or replace view v_auction_sales_app
with (security_invoker = true)
as
select
  id, title, city, department, postal_code, address, tribunal, property_type,
  starting_price_eur, sale_date, latitude, longitude, occupancy_status,
  habitable_surface_m2, carrez_surface_m2, land_surface_m2, rooms_count,
  bedrooms_count, has_garden, has_terrace, has_garage, has_pool,
  has_air_conditioning, has_double_glazing, investment_score,
  investment_summary, risk_notes, source_name, source_url, documents,
  status, created_at, updated_at,
  description,
  nullif(raw_payload->>'source_description', '') as source_description,
  nullif(raw_payload->>'llm_display_description', '') as llm_display_description,
  coalesce(
    nullif(raw_payload->>'llm_display_description', ''),
    nullif(raw_payload->>'source_description', ''),
    nullif(raw_payload->'source_blocks'->>'description', ''),
    nullif(description, '')
  ) as about_description
from auction_sales
where status in ('upcoming', 'unknown')
  and latitude is not null
  and longitude is not null;

create or replace view v_auction_sales_app_preview
with (security_invoker = true)
as
select
  id,
  starting_price_eur
from auction_sales;

create table if not exists auction_sales_app_read (
  source_url text primary key references auction_sales(source_url) on delete cascade,
  id uuid,
  title text,
  city text,
  department text,
  postal_code text,
  property_type text,
  starting_price_eur numeric,
  sale_date timestamptz,
  latitude double precision,
  longitude double precision,
  occupancy_status text,
  app_surface_m2 numeric,
  investment_score numeric,
  score_confidence numeric,
  score_version text,
  deal_memo jsonb not null default '{}'::jsonb,
  quality_summary jsonb not null default '{}'::jsonb,
  risks jsonb not null default '[]'::jsonb,
  score_factors jsonb not null default '[]'::jsonb,
  documents_rich jsonb not null default '[]'::jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists idx_auction_sales_app_read_sale_date
  on auction_sales_app_read(sale_date);
create index if not exists idx_auction_sales_app_read_department
  on auction_sales_app_read(department);
create index if not exists idx_auction_sales_app_read_score
  on auction_sales_app_read(investment_score desc nulls last);
create index if not exists idx_auction_sales_app_read_location
  on auction_sales_app_read(latitude, longitude)
  where latitude is not null and longitude is not null;
create index if not exists idx_auction_sales_app_read_quality_gin
  on auction_sales_app_read using gin(quality_summary);
create index if not exists idx_auction_sales_app_read_risks_gin
  on auction_sales_app_read using gin(risks);

create or replace view v_auction_map_pins
with (security_invoker = true)
as
select
  id,
  title,
  city,
  department,
  property_type,
  starting_price_eur,
  sale_date,
  latitude,
  longitude,
  occupancy_status,
  app_surface_m2,
  investment_score,
  score_confidence,
  status,
  created_at
from auction_sales_app_read
where id is not null
  and latitude is not null
  and longitude is not null
  and coalesce(status, 'unknown') in ('upcoming', 'unknown');

alter table auction_sales enable row level security;
alter table tribunals enable row level security;
alter table auction_observations enable row level security;
alter table auction_features enable row level security;
alter table auction_surfaces enable row level security;
alter table auction_risks enable row level security;
alter table auction_runs enable row level security;
alter table auction_documents enable row level security;
alter table auction_extractions enable row level security;
alter table auction_risk_occurrences enable row level security;
alter table auction_score_factors enable row level security;
alter table auction_scoring_versions enable row level security;
alter table auction_sale_history enable row level security;
alter table auction_sales_app_read enable row level security;
do $$
begin
  if exists (
    select 1
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'spatial_ref_sys'
      and pg_get_userbyid(c.relowner) = current_user
  ) then
    alter table spatial_ref_sys enable row level security;
  end if;
end $$;

grant usage on schema public to service_role;
grant select, insert, update, delete on table auction_sales to service_role;
grant select, insert, update, delete on table auction_observations to service_role;
grant select, insert, update, delete on table auction_features to service_role;
grant select, insert, update, delete on table auction_surfaces to service_role;
grant select, insert, update, delete on table auction_risks to service_role;
grant select, insert, update, delete on table tribunals to service_role;
grant select, insert, update, delete on table auction_runs to service_role;
grant select, insert, update, delete on table auction_documents to service_role;
grant select, insert, update, delete on table auction_extractions to service_role;
grant select, insert, update, delete on table auction_risk_occurrences to service_role;
grant select, insert, update, delete on table auction_score_factors to service_role;
grant select, insert, update, delete on table auction_scoring_versions to service_role;
grant select, insert, update, delete on table auction_sale_history to service_role;
grant select, insert, update, delete on table auction_sales_app_read to service_role;

revoke all on table auction_sales from anon, authenticated;
revoke all on table auction_observations from anon, authenticated;
revoke all on table auction_features from anon, authenticated;
revoke all on table auction_surfaces from anon, authenticated;
revoke all on table auction_risks from anon, authenticated;
revoke all on table auction_runs from anon, authenticated;
revoke all on table auction_documents from anon, authenticated;
revoke all on table auction_extractions from anon, authenticated;
revoke all on table auction_risk_occurrences from anon, authenticated;
revoke all on table auction_score_factors from anon, authenticated;
revoke all on table auction_scoring_versions from anon, authenticated;
revoke all on table auction_sale_history from anon, authenticated;
revoke all on table public_auction_sales from anon, authenticated;
revoke all on table auction_sales_quality_issues from anon, authenticated;
revoke all on table auction_sales_investment_candidates from anon, authenticated;
revoke all on table auction_source_coverage from anon, authenticated;
revoke all on table v_auction_sales_app from anon, authenticated;
revoke all on table v_auction_sales_app_preview from anon, authenticated;
revoke all on table auction_sales_app_read from anon, authenticated;
revoke all on table v_auction_map_pins from anon, authenticated;
do $$
begin
  if to_regclass('public.spatial_ref_sys') is not null then
    revoke insert, update, delete, truncate, references, trigger on table spatial_ref_sys from anon, authenticated;
  end if;
end $$;

grant select (id, starting_price_eur) on auction_sales to anon;
grant select on v_auction_sales_app_preview to anon, authenticated;

grant select on auction_sales to authenticated;
grant select on auction_features to authenticated;
grant select on auction_surfaces to authenticated;
grant select on auction_risks to authenticated;
grant select on auction_documents to authenticated;
grant select on auction_risk_occurrences to authenticated;
grant select on auction_score_factors to authenticated;
grant select on tribunals to authenticated;
grant select on auction_scoring_versions to authenticated;
grant select on public_auction_sales to authenticated;
grant select on auction_sales_quality_issues to authenticated;
grant select on auction_sales_investment_candidates to authenticated;
grant select on auction_source_coverage to authenticated;
grant select on v_auction_sales_app to authenticated;
grant select (
  source_url, id, title, city, department, postal_code, property_type,
  starting_price_eur, sale_date, latitude, longitude, occupancy_status,
  app_surface_m2, investment_score, score_confidence, score_version,
  deal_memo, quality_summary, risks, score_factors, documents_rich,
  created_at, updated_at
) on auction_sales_app_read to authenticated;
grant select on v_auction_map_pins to authenticated;

drop policy if exists auction_sales_public_read on auction_sales;
drop policy if exists auction_sales_public_preview_read on auction_sales;
drop policy if exists auction_sales_authenticated_read on auction_sales;
create policy auction_sales_public_preview_read on auction_sales for select to anon using (
  coalesce(status, 'unknown') in ('upcoming', 'unknown')
  and latitude is not null
  and longitude is not null
);
create policy auction_sales_authenticated_read on auction_sales for select to authenticated using (true);
drop policy if exists auction_features_public_read on auction_features;
drop policy if exists auction_features_authenticated_read on auction_features;
create policy auction_features_authenticated_read on auction_features for select to authenticated using (true);
drop policy if exists auction_surfaces_public_read on auction_surfaces;
drop policy if exists auction_surfaces_authenticated_read on auction_surfaces;
create policy auction_surfaces_authenticated_read on auction_surfaces for select to authenticated using (true);
drop policy if exists auction_risks_public_read on auction_risks;
drop policy if exists auction_risks_authenticated_read on auction_risks;
create policy auction_risks_authenticated_read on auction_risks for select to authenticated using (true);
drop policy if exists auction_documents_public_read on auction_documents;
drop policy if exists auction_documents_authenticated_read on auction_documents;
create policy auction_documents_authenticated_read on auction_documents for select to authenticated using (true);
drop policy if exists auction_risk_occurrences_public_read on auction_risk_occurrences;
drop policy if exists auction_risk_occurrences_authenticated_read on auction_risk_occurrences;
create policy auction_risk_occurrences_authenticated_read on auction_risk_occurrences for select to authenticated using (true);
drop policy if exists auction_score_factors_public_read on auction_score_factors;
drop policy if exists auction_score_factors_authenticated_read on auction_score_factors;
create policy auction_score_factors_authenticated_read on auction_score_factors for select to authenticated using (true);
drop policy if exists tribunals_public_read on tribunals;
drop policy if exists tribunals_authenticated_read on tribunals;
create policy tribunals_authenticated_read on tribunals for select to authenticated using (true);
drop policy if exists auction_scoring_versions_public_read on auction_scoring_versions;
drop policy if exists auction_scoring_versions_authenticated_read on auction_scoring_versions;
create policy auction_scoring_versions_authenticated_read on auction_scoring_versions for select to authenticated using (true);
drop policy if exists auction_sales_app_read_public_read on auction_sales_app_read;
drop policy if exists auction_sales_app_read_authenticated_read on auction_sales_app_read;
create policy auction_sales_app_read_authenticated_read on auction_sales_app_read for select to authenticated using (true);
do $$
begin
  if exists (
    select 1
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'spatial_ref_sys'
      and pg_get_userbyid(c.relowner) = current_user
  ) then
    grant select on spatial_ref_sys to authenticated;
    drop policy if exists spatial_ref_sys_public_read on spatial_ref_sys;
    drop policy if exists spatial_ref_sys_authenticated_read on spatial_ref_sys;
    create policy spatial_ref_sys_authenticated_read on spatial_ref_sys for select to authenticated using (true);
  end if;
end $$;

notify pgrst, 'reload schema';
