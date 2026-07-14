begin;

create table public.auction_sale_market_estimates (
  auction_sale_id uuid primary key references public.auction_sales(id) on delete cascade,
  status text not null default 'pending' check (
    status in ('pending', 'processing', 'ready', 'insufficient_data', 'failed')
  ),
  input_fingerprint text not null,
  source_updated_at timestamptz,
  estimate jsonb,
  error_message text,
  engine_version text,
  engine_kind text check (
    engine_kind is null or engine_kind in ('comparable_ensemble', 'hybrid_lightgbm')
  ),
  model_version_id uuid references public.valuation_model_versions(id) on delete set null,
  model_version text,
  segment text check (
    segment is null or segment in ('apartment', 'house', 'building', 'commercial', 'land')
  ),
  value_p10_eur numeric check (value_p10_eur is null or value_p10_eur >= 0),
  value_p50_eur numeric check (value_p50_eur is null or value_p50_eur >= 0),
  value_p90_eur numeric check (value_p90_eur is null or value_p90_eur >= 0),
  confidence_score integer check (confidence_score is null or confidence_score between 0 and 100),
  comparable_count integer not null default 0 check (comparable_count >= 0),
  actionable boolean not null default false,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  last_started_at timestamptz,
  computed_at timestamptz,
  next_refresh_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint auction_sale_market_estimates_ready_payload_check check (
    status <> 'ready' or estimate is not null
  )
);

comment on table public.auction_sale_market_estimates is
  'Current precomputed market estimate for each auction sale. Trusted background workers write it; visitor requests only read it through authenticated server routes.';

create index auction_sale_market_estimates_refresh_idx
  on public.auction_sale_market_estimates (next_refresh_at, status);

create index auction_sale_market_estimates_computed_idx
  on public.auction_sale_market_estimates (computed_at desc)
  where status = 'ready';

create or replace function app_private.queue_auction_sale_market_estimate()
returns trigger
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
begin
  if new.status is null or new.status not in ('active', 'upcoming') then
    delete from public.auction_sale_market_estimates
    where auction_sale_id = new.id;
    return new;
  end if;

  insert into public.auction_sale_market_estimates (
    auction_sale_id,
    status,
    input_fingerprint,
    source_updated_at,
    next_refresh_at
  )
  values (
    new.id,
    'pending',
    'pending:' || new.id::text || ':' || coalesce(new.updated_at::text, ''),
    new.updated_at,
    now()
  )
  on conflict (auction_sale_id) do update
  set status = 'pending',
      input_fingerprint = excluded.input_fingerprint,
      source_updated_at = excluded.source_updated_at,
      error_message = null,
      next_refresh_at = now();

  return new;
end;
$$;

revoke all on function app_private.queue_auction_sale_market_estimate() from public;

drop trigger if exists immojudis_queue_auction_sale_market_estimate on public.auction_sales;
create trigger immojudis_queue_auction_sale_market_estimate
after insert or update of
  status,
  address,
  city,
  postal_code,
  property_type,
  latitude,
  longitude,
  app_surface_m2,
  habitable_surface_m2,
  carrez_surface_m2,
  land_surface_m2,
  app_surface_kind,
  surface_scope,
  rooms_count,
  bedrooms_count
on public.auction_sales
for each row
execute function app_private.queue_auction_sale_market_estimate();

insert into public.auction_sale_market_estimates (
  auction_sale_id,
  status,
  input_fingerprint,
  source_updated_at,
  next_refresh_at
)
select
  sale.id,
  'pending',
  'pending:' || sale.id::text || ':' || coalesce(sale.updated_at::text, ''),
  sale.updated_at,
  now()
from public.auction_sales sale
where sale.status in ('active', 'upcoming')
on conflict (auction_sale_id) do nothing;

drop trigger if exists immojudis_auction_sale_market_estimates_updated_at
on public.auction_sale_market_estimates;
create trigger immojudis_auction_sale_market_estimates_updated_at
before update on public.auction_sale_market_estimates
for each row
execute function app_private.set_user_profiles_updated_at();

alter table public.auction_sale_market_estimates enable row level security;

revoke all on table public.auction_sale_market_estimates from public, anon, authenticated;
grant select, insert, update, delete on table public.auction_sale_market_estimates to service_role;

notify pgrst, 'reload schema';

commit;
