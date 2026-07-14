begin;

create table if not exists public.valuation_model_versions (
  id uuid primary key default gen_random_uuid(),
  model_key text not null default 'immojudis_market_value',
  version text not null,
  segment text not null check (
    segment in ('apartment', 'house', 'building', 'commercial', 'land')
  ),
  framework text not null check (
    framework in ('comparable_ensemble', 'lightgbm_quantile')
  ),
  status text not null default 'draft' check (
    status in ('draft', 'active', 'retired', 'failed')
  ),
  feature_names text[] not null default '{}'::text[],
  artifact jsonb not null default '{}'::jsonb,
  calibration jsonb not null default '{}'::jsonb,
  training_metrics jsonb not null default '{}'::jsonb,
  training_rows integer check (training_rows is null or training_rows >= 0),
  training_period_start date,
  training_period_end date,
  trained_at timestamptz,
  activated_at timestamptz,
  retired_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (model_key, segment, version)
);

comment on table public.valuation_model_versions is
  'Internal registry for versioned comparable and LightGBM quantile valuation artifacts. Artifacts are only read by trusted server routes.';

create unique index if not exists valuation_model_versions_one_active_idx
  on public.valuation_model_versions (model_key, segment)
  where status = 'active';

create index if not exists valuation_model_versions_status_created_idx
  on public.valuation_model_versions (status, created_at desc);

create table if not exists public.valuation_estimates (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete set null,
  auction_sale_id uuid references public.auction_sales(id) on delete set null,
  model_version_id uuid references public.valuation_model_versions(id) on delete set null,
  engine_version text not null,
  engine_kind text not null check (
    engine_kind in ('comparable_ensemble', 'hybrid_lightgbm')
  ),
  segment text not null check (
    segment in ('apartment', 'house', 'building', 'commercial', 'land')
  ),
  market_cell text,
  request_fingerprint text,
  input_snapshot jsonb not null default '{}'::jsonb,
  result_snapshot jsonb not null default '{}'::jsonb,
  value_p10_eur numeric check (value_p10_eur is null or value_p10_eur >= 0),
  value_p50_eur numeric check (value_p50_eur is null or value_p50_eur >= 0),
  value_p90_eur numeric check (value_p90_eur is null or value_p90_eur >= 0),
  confidence_score integer check (confidence_score is null or confidence_score between 0 and 100),
  comparable_count integer not null default 0 check (comparable_count >= 0),
  actionable boolean not null default false,
  latency_ms integer check (latency_ms is null or latency_ms >= 0),
  created_at timestamptz not null default now()
);

comment on table public.valuation_estimates is
  'Immutable audit trail for market-value estimates. It stores model provenance and uncertainty separately from the auction bid ceiling.';

create index if not exists valuation_estimates_sale_created_idx
  on public.valuation_estimates (auction_sale_id, created_at desc)
  where auction_sale_id is not null;

create index if not exists valuation_estimates_user_created_idx
  on public.valuation_estimates (user_id, created_at desc)
  where user_id is not null;

create index if not exists valuation_estimates_model_created_idx
  on public.valuation_estimates (model_version_id, created_at desc)
  where model_version_id is not null;

create index if not exists valuation_estimates_market_cell_created_idx
  on public.valuation_estimates (market_cell, created_at desc)
  where market_cell is not null;

drop trigger if exists immojudis_valuation_model_versions_updated_at
on public.valuation_model_versions;
create trigger immojudis_valuation_model_versions_updated_at
before update on public.valuation_model_versions
for each row
execute function app_private.set_user_profiles_updated_at();

alter table public.valuation_model_versions enable row level security;
alter table public.valuation_estimates enable row level security;

revoke all on table public.valuation_model_versions from public, anon, authenticated;
revoke all on table public.valuation_estimates from public, anon, authenticated;

grant select, insert, update, delete on table public.valuation_model_versions to service_role;
grant select, insert, update, delete on table public.valuation_estimates to service_role;

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
      'valuation.backtest_viewed',
      'valuation.estimated',
      'workspace.audience_tracking_viewed',
      'sale_changes.monitored',
      'lawyer.referral_requested',
      'data_refresh.requested'
    )
  );

notify pgrst, 'reload schema';

commit;
