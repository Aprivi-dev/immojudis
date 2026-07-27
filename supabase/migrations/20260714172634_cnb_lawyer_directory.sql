begin;

create table public.cnb_lawyer_directory_imports (
  resource_id text primary key,
  resource_title text not null,
  resource_url text not null,
  source_published_at timestamptz not null,
  status text not null check (status in ('running', 'success', 'failed')),
  record_count integer not null default 0 check (record_count >= 0),
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  error_message text
);

comment on table public.cnb_lawyer_directory_imports is
  'Suivi des imports de l annuaire officiel des avocats publie par le CNB sur data.gouv.fr.';

create table public.cnb_lawyer_directory (
  source_key text primary key,
  bar_association text not null,
  bar_key text not null,
  last_name text not null,
  first_name text,
  display_name text not null,
  firm_name text,
  firm_siret_siren text,
  address_line_1 text,
  address_line_2 text,
  postal_code text,
  city text,
  specializations text[] not null,
  oath_date date,
  languages text[] not null default '{}'::text[],
  source_resource_id text not null references public.cnb_lawyer_directory_imports(resource_id),
  source_updated_at timestamptz not null,
  imported_at timestamptz not null default now(),
  check (cardinality(specializations) > 0)
);

comment on table public.cnb_lawyer_directory is
  'Avocats ayant la specialisation Droit immobilier dans l annuaire CNB open data. Source distincte des profils commerciaux ImmoJudis.';

create index cnb_lawyer_directory_bar_display_name_idx
on public.cnb_lawyer_directory (bar_key, display_name);

create index cnb_lawyer_directory_resource_idx
on public.cnb_lawyer_directory (source_resource_id);

alter table public.cnb_lawyer_directory_imports enable row level security;
alter table public.cnb_lawyer_directory enable row level security;

revoke all on table public.cnb_lawyer_directory_imports from anon, authenticated;
revoke all on table public.cnb_lawyer_directory from anon, authenticated;

grant select, insert, update, delete
on table public.cnb_lawyer_directory_imports
to service_role;

grant select, insert, update, delete
on table public.cnb_lawyer_directory
to service_role;

commit;
