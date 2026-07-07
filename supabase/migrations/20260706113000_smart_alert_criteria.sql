begin;

alter table public.user_alerts
  add column if not exists max_price_per_m2 numeric check (
    max_price_per_m2 is null or max_price_per_m2 >= 0
  ),
  add column if not exists min_yield_pct numeric check (
    min_yield_pct is null or min_yield_pct >= 0
  ),
  add column if not exists min_market_discount_pct numeric check (
    min_market_discount_pct is null
    or (min_market_discount_pct >= 0 and min_market_discount_pct <= 100)
  ),
  add column if not exists dpe_classes text[] not null default '{}'::text[] check (
    dpe_classes <@ array['A', 'B', 'C', 'D', 'E', 'F', 'G']::text[]
  ),
  add column if not exists require_house_with_land boolean not null default false,
  add column if not exists alert_frequency text not null default 'daily' check (
    alert_frequency in ('instant', 'daily', 'weekly')
  ),
  add column if not exists last_evaluated_at timestamptz,
  add column if not exists last_match_count integer not null default 0 check (
    last_match_count >= 0
  ),
  add column if not exists advanced_criteria jsonb not null default '{}'::jsonb;

comment on column public.user_alerts.min_market_discount_pct is
  'Minimum apparent discount versus market estimate required for smart alerts. Filled by app matching when a market reference exists.';

comment on column public.user_alerts.min_yield_pct is
  'Minimum estimated gross yield. Uses current ImmoJudis heuristic until rent data is available.';

comment on column public.user_alerts.dpe_classes is
  'Accepted DPE classes for smart alerts, extracted from source blocks or documents.';

comment on column public.user_alerts.require_house_with_land is
  'When true, alert only matches houses/buildings with known land or garden signal.';

create index if not exists user_alerts_dpe_classes_idx
  on public.user_alerts using gin (dpe_classes);

create index if not exists user_alerts_advanced_filters_idx
  on public.user_alerts (
    user_id,
    is_active,
    max_price_per_m2,
    min_yield_pct,
    min_market_discount_pct
  );

notify pgrst, 'reload schema';

commit;
