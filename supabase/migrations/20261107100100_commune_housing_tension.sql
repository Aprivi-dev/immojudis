begin;

set local lock_timeout = '5s';

-- Rental-tension zoning ("zonage TLV") by commune (data.gouv.fr, « Liste des communes
-- selon le zonage TLV », Licence Ouverte 2.0): the 2013 zoning, the 2023 zoning and the
-- zoning after the decree n° 2025-1267 of 22 December 2025. Paris, Lyon and Marseille are
-- listed once (75056, 69123, 13055), never per arrondissement.
--
-- Imported in bulk by the manual "Reference data import" workflow (`tension`), read by the
-- server only (service role). Nothing displays it yet.

create table if not exists public.commune_housing_tension (
  commune_code text primary key check (commune_code ~ '^[0-9][0-9AB][0-9]{3}$'),
  commune_name text not null check (btrim(commune_name) <> ''),
  department_code text not null check (department_code ~ '^([0-9]{2}|2A|2B|97[1-8])$'),
  epci_code text check (epci_code is null or epci_code ~ '^[0-9]{9}$'),
  epci_name text,
  -- "Zonage TLV 2013": tlv (in the zone) or non_tlv.
  zoning_2013 text not null check (zoning_2013 in ('tlv', 'non_tlv')),
  -- "Zonage TLV 2023" and "post décret": tendue, touristique_tendue (zone touristique et
  -- tendue) or non_tendue.
  zoning_2023 text not null check (zoning_2023 in ('tendue', 'touristique_tendue', 'non_tendue')),
  zoning_post_decree text not null
    check (zoning_post_decree in ('tendue', 'touristique_tendue', 'non_tendue')),
  decree_reference text not null check (btrim(decree_reference) <> ''),
  decree_date date,
  -- Publication date of the CSV file on data.gouv.fr.
  source_updated_on date,
  source_url text not null,
  imported_at timestamptz not null default now()
);

comment on table public.commune_housing_tension is
  'Rental-tension zoning by commune (zonage TLV, Licence Ouverte 2.0): 2013, 2023 and post-decree n° 2025-1267 of 22 December 2025.';

create index if not exists commune_housing_tension_department_idx
  on public.commune_housing_tension (department_code);

alter table public.commune_housing_tension enable row level security;

revoke all on table public.commune_housing_tension from public, anon, authenticated;

grant select, insert, update, delete on table public.commune_housing_tension to service_role;

notify pgrst, 'reload schema';

commit;
