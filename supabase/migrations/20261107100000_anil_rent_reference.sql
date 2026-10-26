begin;

set local lock_timeout = '5s';

-- ANIL rent map 2025 (data.gouv.fr dataset 693aa2feed1bf4da603faa49, Licence Ouverte 2.0).
-- One row per commune (per arrondissement in Paris, Lyon and Marseille) and segment:
-- all apartments, 1-2 room apartments, 3 rooms or more, houses. The rent is an advertised
-- rent in euros per square metre per month, charges included, unfurnished, so it is
-- never a "hors charges" rent and never an observed or guaranteed rent.
--
-- Imported in bulk by the manual "Reference data import" workflow (`rents`), read by the
-- server only (service role). Credit required wherever a rent or a yield derived from it
-- is shown: « Estimations ANIL, à partir des données du Groupe SeLoger et de leboncoin ».

create table if not exists public.anil_rents (
  commune_code text not null check (commune_code ~ '^[0-9][0-9AB][0-9]{3}$'),
  segment text not null check (segment in ('apt_all', 'apt_1_2', 'apt_3p', 'house')),
  commune_name text not null check (btrim(commune_name) <> ''),
  department_code text not null check (department_code ~ '^([0-9]{2}|2A|2B|97[1-8])$'),
  epci_code text check (epci_code is null or epci_code ~ '^[0-9]{9}$'),
  zone_id integer,
  rent_per_m2 numeric(8, 4) not null check (rent_per_m2 > 0),
  rent_low_per_m2 numeric(8, 4) check (rent_low_per_m2 is null or rent_low_per_m2 > 0),
  rent_high_per_m2 numeric(8, 4) check (rent_high_per_m2 is null or rent_high_per_m2 > 0),
  -- TYPPRED of the source, normalised: commune (computed on the commune itself), maille
  -- (computed on a group of communes) or epci. The source spells it "maille", "maile" and
  -- "EPCI".
  prediction_type text not null check (prediction_type in ('commune', 'maille', 'epci')),
  observations_commune integer check (observations_commune is null or observations_commune >= 0),
  observations_mesh integer check (observations_mesh is null or observations_mesh >= 0),
  r2_adj numeric(7, 6),
  vintage smallint not null check (vintage between 2020 and 2100),
  -- Publication date of the CSV file on data.gouv.fr (« mise à jour du 11 décembre 2025 »).
  source_updated_on date,
  source_url text not null,
  imported_at timestamptz not null default now(),
  primary key (commune_code, segment),
  check (rent_low_per_m2 is null or rent_high_per_m2 is null or rent_low_per_m2 <= rent_high_per_m2)
);

comment on table public.anil_rents is
  'ANIL rent map (Licence Ouverte 2.0): advertised rent in EUR per square metre per month, charges included, unfurnished, per commune and segment. Estimations ANIL, à partir des données du Groupe SeLoger et de leboncoin.';
comment on column public.anil_rents.prediction_type is
  'TYPPRED of the source, normalised to commune, maille or epci.';
comment on column public.anil_rents.observations_commune is
  'nbobs_com: advertisements observed in the commune itself.';
comment on column public.anil_rents.observations_mesh is
  'nbobs_mail: advertisements observed in the calculation mesh.';

alter table public.anil_rents enable row level security;

revoke all on table public.anil_rents from public, anon, authenticated;

grant select, insert, update, delete on table public.anil_rents to service_role;

notify pgrst, 'reload schema';

commit;
