begin;

create extension if not exists postgis;

create table if not exists public.dvf_import_batches (
  id uuid primary key default gen_random_uuid(),
  source text not null default 'DVF',
  source_url text,
  file_name text,
  period_start date,
  period_end date,
  status text not null default 'pending' check (
    status in ('pending', 'running', 'completed', 'failed')
  ),
  imported_rows integer not null default 0 check (imported_rows >= 0),
  error_message text,
  metadata jsonb not null default '{}'::jsonb,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.dvf_import_batches is
  'Traceability for semi-annual DVF imports used by ImmoJudis market estimates and comparable-sale analysis.';

create table if not exists public.dvf_transactions (
  id uuid primary key default gen_random_uuid(),
  import_batch_id uuid references public.dvf_import_batches(id) on delete set null,
  source text not null default 'DVF',
  source_mutation_id text not null,
  source_url text,
  sale_date date not null,
  mutation_nature text,
  total_price_eur numeric not null check (total_price_eur > 0),
  built_surface_m2 numeric check (built_surface_m2 is null or built_surface_m2 > 0),
  land_surface_m2 numeric check (land_surface_m2 is null or land_surface_m2 >= 0),
  price_per_m2 numeric generated always as (
    case
      when total_price_eur > 0 and built_surface_m2 > 0
        then round(total_price_eur / built_surface_m2)
      else null
    end
  ) stored,
  property_type text,
  dvf_property_type_code text,
  rooms_count integer check (rooms_count is null or rooms_count >= 0),
  lots_count integer check (lots_count is null or lots_count >= 0),
  address text,
  city text,
  postal_code text,
  insee_code text,
  department text,
  parcel_id text,
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
  source_last_seen_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.dvf_transactions is
  'Normalized DVF transactions for comparable-sale scoring. Access stays behind ImmoJudis plan-gated APIs rather than direct client reads.';

create unique index if not exists dvf_transactions_source_mutation_parcel_uidx
  on public.dvf_transactions (source, source_mutation_id, coalesce(parcel_id, ''));

create index if not exists dvf_import_batches_source_created_idx
  on public.dvf_import_batches (source, created_at desc);

create index if not exists dvf_transactions_import_batch_idx
  on public.dvf_transactions (import_batch_id);

create index if not exists dvf_transactions_sale_date_idx
  on public.dvf_transactions (sale_date desc);

create index if not exists dvf_transactions_department_city_type_idx
  on public.dvf_transactions (department, city, property_type);

create index if not exists dvf_transactions_price_per_m2_idx
  on public.dvf_transactions (price_per_m2)
  where price_per_m2 is not null;

create index if not exists dvf_transactions_lat_lng_idx
  on public.dvf_transactions (latitude, longitude)
  where latitude is not null and longitude is not null;

create index if not exists dvf_transactions_location_gix
  on public.dvf_transactions using gist (location)
  where location is not null;

drop trigger if exists immojudis_dvf_import_batches_updated_at
on public.dvf_import_batches;
create trigger immojudis_dvf_import_batches_updated_at
before update on public.dvf_import_batches
for each row
execute function app_private.set_user_profiles_updated_at();

drop trigger if exists immojudis_dvf_transactions_updated_at
on public.dvf_transactions;
create trigger immojudis_dvf_transactions_updated_at
before update on public.dvf_transactions
for each row
execute function app_private.set_user_profiles_updated_at();

alter table public.dvf_import_batches enable row level security;
alter table public.dvf_transactions enable row level security;

revoke all on table public.dvf_import_batches from anon, authenticated;
revoke all on table public.dvf_transactions from anon, authenticated;

grant select, insert, update, delete on table public.dvf_import_batches to service_role;
grant select, insert, update, delete on table public.dvf_transactions to service_role;

alter table public.feature_usage_events
  drop constraint if exists feature_usage_events_event_key_check;

alter table public.feature_usage_events
  add constraint feature_usage_events_event_key_check check (
    event_key in (
      'property_report.created',
      'property_report.pdf_exported',
      'sales.csv_exported',
      'sales.api_feed_requested',
      'sale_history.viewed',
      'market.analytics_viewed',
      'dpe.explorer_viewed',
      'sales.favorite_added',
      'sales.favorite_removed',
      'sales.statistics_viewed',
      'bid_ceiling.calculated',
      'dvf.comparables_viewed',
      'workspace.audience_tracking_viewed',
      'sale_changes.monitored',
      'lawyer.referral_requested'
    )
  );

notify pgrst, 'reload schema';

commit;
