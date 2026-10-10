begin;

set local lock_timeout = '5s';

-- Official reference data behind the "Risques environnementaux" and
-- "Historique météo" blocks of a listing. Everything is imported in bulk by
-- the manual "Reference data import" workflow, so a listing page never
-- depends on a third-party widget or a rate-limited API at render time.

create table public.reference_communes (
  code_insee text primary key check (code_insee ~ '^[0-9][0-9AB][0-9]{3}$'),
  name text not null check (btrim(name) <> ''),
  name_normalized text not null check (btrim(name_normalized) <> ''),
  department_code text not null check (department_code ~ '^([0-9]{2}|2A|2B|97[1-8])$'),
  postal_codes text[] not null default '{}',
  latitude double precision check (latitude is null or latitude between -90 and 90),
  longitude double precision check (longitude is null or longitude between -180 and 180),
  source_url text not null,
  imported_at timestamptz not null default now()
);

comment on table public.reference_communes is
  'Official commune list (geo.api.gouv.fr, Licence Ouverte). Resolves a listing city or postal code to its INSEE code when coordinates are missing.';

create index reference_communes_department_name_idx
  on public.reference_communes (department_code, name_normalized);
create index reference_communes_postal_codes_idx
  on public.reference_communes using gin (postal_codes);

create table public.commune_risk_profiles (
  code_insee text primary key check (code_insee ~ '^[0-9][0-9AB][0-9]{3}$'),
  commune_name text not null check (btrim(commune_name) <> ''),
  risks jsonb not null default '[]'::jsonb check (jsonb_typeof(risks) = 'array'),
  catnat_total integer not null default 0 check (catnat_total >= 0),
  catnat_by_type jsonb not null default '[]'::jsonb check (jsonb_typeof(catnat_by_type) = 'array'),
  catnat_recent jsonb not null default '[]'::jsonb check (jsonb_typeof(catnat_recent) = 'array'),
  prevention_plans jsonb not null default '[]'::jsonb check (jsonb_typeof(prevention_plans) = 'array'),
  seismic_zone smallint check (seismic_zone is null or seismic_zone between 1 and 5),
  radon_class smallint check (radon_class is null or radon_class between 1 and 3),
  gaspar_snapshot date,
  zoning_checked_at timestamptz,
  source_url text not null,
  imported_at timestamptz not null default now()
);

comment on table public.commune_risk_profiles is
  'Commune risk summary built from the official GASPAR base (Géorisques): DDRM risks, CatNat decrees, prevention plans, seismic zone and radon potential.';

create table public.climate_stations (
  station_id text primary key check (station_id ~ '^[0-9]{8}$'),
  name text not null check (btrim(name) <> ''),
  department_code text not null,
  latitude double precision not null check (latitude between -90 and 90),
  longitude double precision not null check (longitude between -180 and 180),
  altitude_m integer,
  first_month date not null,
  last_month date not null check (last_month >= first_month),
  has_temperature boolean not null default false,
  has_precipitation boolean not null default false,
  has_sunshine boolean not null default false,
  source_url text not null,
  imported_at timestamptz not null default now()
);

comment on table public.climate_stations is
  'Météo-France stations with monthly climatological data (Licence Ouverte Etalab 2.0).';

create index climate_stations_location_idx on public.climate_stations (latitude, longitude);

create table public.climate_station_months (
  station_id text not null references public.climate_stations (station_id) on delete cascade,
  month date not null check (extract(day from month) = 1),
  precipitation_mm numeric(7, 1) check (precipitation_mm is null or precipitation_mm >= 0),
  mean_temperature_c numeric(5, 1),
  mean_min_temperature_c numeric(5, 1),
  mean_max_temperature_c numeric(5, 1),
  sunshine_minutes integer check (sunshine_minutes is null or sunshine_minutes >= 0),
  rain_days smallint check (rain_days is null or rain_days between 0 and 31),
  frost_days smallint check (frost_days is null or frost_days between 0 and 31),
  hot_days smallint check (hot_days is null or hot_days between 0 and 31),
  primary key (station_id, month)
);

comment on table public.climate_station_months is
  'Monthly Météo-France observations per station (RR, TM, TN, TX, INST, NBJRR1, NBJGELEE, NBJTX30).';

alter table public.reference_communes enable row level security;
alter table public.commune_risk_profiles enable row level security;
alter table public.climate_stations enable row level security;
alter table public.climate_station_months enable row level security;

revoke all on table public.reference_communes from public, anon, authenticated;
revoke all on table public.commune_risk_profiles from public, anon, authenticated;
revoke all on table public.climate_stations from public, anon, authenticated;
revoke all on table public.climate_station_months from public, anon, authenticated;

grant select, insert, update, delete on table public.reference_communes to service_role;
grant select, insert, update, delete on table public.commune_risk_profiles to service_role;
grant select, insert, update, delete on table public.climate_stations to service_role;
grant select, insert, update, delete on table public.climate_station_months to service_role;

notify pgrst, 'reload schema';

commit;
