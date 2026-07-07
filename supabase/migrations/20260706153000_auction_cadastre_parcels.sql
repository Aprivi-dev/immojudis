begin;

create extension if not exists postgis;

create table if not exists public.auction_cadastre_parcels (
  id uuid primary key default gen_random_uuid(),
  source_url text not null references public.auction_sales(source_url) on delete cascade,
  parcel_key text not null,
  parcel_id text,
  code_insee text,
  department text,
  city text,
  section text,
  parcel_number text,
  surface_m2 numeric check (surface_m2 is null or surface_m2 >= 0),
  centroid_lat double precision check (centroid_lat is null or centroid_lat between -90 and 90),
  centroid_lng double precision check (centroid_lng is null or centroid_lng between -180 and 180),
  geometry_geojson jsonb not null default '{}'::jsonb,
  match_kind text not null default 'point_intersection' check (
    match_kind in ('point_intersection', 'reference_lookup', 'manual')
  ),
  confidence numeric not null default 0.8 check (confidence >= 0 and confidence <= 1),
  source_api text not null default 'API Carto Cadastre',
  source_api_url text,
  raw_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.auction_cadastre_parcels is
  'Structured cadastral parcel matches for judicial sales, populated from API Carto and consumed by server-side opportunity reports.';

create unique index if not exists auction_cadastre_parcels_source_key_uidx
  on public.auction_cadastre_parcels (source_url, parcel_key);

create index if not exists auction_cadastre_parcels_source_url_idx
  on public.auction_cadastre_parcels (source_url);

create index if not exists auction_cadastre_parcels_insee_section_idx
  on public.auction_cadastre_parcels (code_insee, section, parcel_number);

create index if not exists auction_cadastre_parcels_centroid_idx
  on public.auction_cadastre_parcels (centroid_lat, centroid_lng)
  where centroid_lat is not null and centroid_lng is not null;

drop trigger if exists immojudis_auction_cadastre_parcels_updated_at
on public.auction_cadastre_parcels;
create trigger immojudis_auction_cadastre_parcels_updated_at
before update on public.auction_cadastre_parcels
for each row
execute function app_private.set_user_profiles_updated_at();

alter table public.auction_cadastre_parcels enable row level security;

revoke all on table public.auction_cadastre_parcels from anon, authenticated;
grant select, insert, update, delete on table public.auction_cadastre_parcels to service_role;

notify pgrst, 'reload schema';

commit;
