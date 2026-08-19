begin;

alter table public.auction_sale_market_estimates
  add column if not exists priority integer not null default 10,
  add column if not exists refresh_reason text not null default 'scheduled_refresh',
  add column if not exists requested_at timestamptz,
  add column if not exists last_finished_at timestamptz,
  add column if not exists last_error_code text;

alter table public.auction_sale_market_estimates
  drop constraint if exists auction_sale_market_estimates_priority_check;

alter table public.auction_sale_market_estimates
  add constraint auction_sale_market_estimates_priority_check
  check (priority between 0 and 100);

drop index if exists public.auction_sale_market_estimates_refresh_idx;
create index auction_sale_market_estimates_dispatch_idx
  on public.auction_sale_market_estimates (priority desc, next_refresh_at, auction_sale_id)
  where status in ('pending', 'processing', 'ready', 'insufficient_data', 'failed');

create table public.valuation_estimate_attempts (
  id uuid primary key default gen_random_uuid(),
  auction_sale_id uuid not null references public.auction_sales(id) on delete cascade,
  attempt_number integer not null check (attempt_number > 0),
  request_source text not null,
  input_fingerprint text not null,
  outcome text not null check (
    outcome in ('ready', 'insufficient_data', 'failed', 'superseded')
  ),
  error_code text,
  error_message text,
  engine_kind text,
  segment text,
  comparable_count integer check (comparable_count is null or comparable_count >= 0),
  confidence_score integer check (confidence_score is null or confidence_score between 0 and 100),
  actionable boolean,
  latency_ms integer not null check (latency_ms >= 0),
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (auction_sale_id, attempt_number)
);

comment on table public.valuation_estimate_attempts is
  'One immutable operational outcome per claimed valuation attempt, including failures and insufficient-data results.';

create index valuation_estimate_attempts_created_idx
  on public.valuation_estimate_attempts (created_at desc);

create index valuation_estimate_attempts_outcome_created_idx
  on public.valuation_estimate_attempts (outcome, created_at desc);

alter table public.valuation_estimate_attempts enable row level security;
revoke all on table public.valuation_estimate_attempts from public, anon, authenticated;
grant select, insert on table public.valuation_estimate_attempts to service_role;

create or replace function app_private.queue_auction_sale_market_estimate()
returns trigger
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  input_changed boolean;
  queued_fingerprint text;
  queued_priority integer;
  queued_reason text;
begin
  if new.status is null or new.status not in ('active', 'upcoming') then
    delete from public.auction_sale_market_estimates
    where auction_sale_id = new.id;
    return new;
  end if;

  if tg_op = 'INSERT' then
    input_changed := true;
  else
    input_changed := (
      old.status is distinct from new.status
      or old.address is distinct from new.address
      or old.city is distinct from new.city
      or old.postal_code is distinct from new.postal_code
      or old.property_type is distinct from new.property_type
      or old.latitude is distinct from new.latitude
      or old.longitude is distinct from new.longitude
      or old.app_surface_m2 is distinct from new.app_surface_m2
      or old.habitable_surface_m2 is distinct from new.habitable_surface_m2
      or old.carrez_surface_m2 is distinct from new.carrez_surface_m2
      or old.land_surface_m2 is distinct from new.land_surface_m2
      or old.app_surface_kind is distinct from new.app_surface_kind
      or old.surface_scope is distinct from new.surface_scope
      or old.rooms_count is distinct from new.rooms_count
      or old.bedrooms_count is distinct from new.bedrooms_count
    );
  end if;

  if not input_changed then
    return new;
  end if;

  queued_fingerprint := 'queued:' || md5(jsonb_build_array(
    new.id,
    new.address,
    new.city,
    new.postal_code,
    new.property_type,
    new.latitude,
    new.longitude,
    new.app_surface_m2,
    new.habitable_surface_m2,
    new.carrez_surface_m2,
    new.land_surface_m2,
    new.app_surface_kind,
    new.surface_scope,
    new.rooms_count,
    new.bedrooms_count
  )::text);
  queued_priority := case when tg_op = 'INSERT' then 80 else 60 end;
  queued_reason := case when tg_op = 'INSERT' then 'new_sale' else 'valuation_input_changed' end;

  insert into public.auction_sale_market_estimates (
    auction_sale_id,
    status,
    input_fingerprint,
    source_updated_at,
    priority,
    refresh_reason,
    next_refresh_at
  )
  values (
    new.id,
    'pending',
    queued_fingerprint,
    new.updated_at,
    queued_priority,
    queued_reason,
    statement_timestamp()
  )
  on conflict (auction_sale_id) do update
  set status = 'pending',
      input_fingerprint = excluded.input_fingerprint,
      source_updated_at = excluded.source_updated_at,
      priority = greatest(public.auction_sale_market_estimates.priority, excluded.priority),
      refresh_reason = excluded.refresh_reason,
      error_message = null,
      last_error_code = null,
      next_refresh_at = statement_timestamp();

  return new;
end;
$$;

revoke all on function app_private.queue_auction_sale_market_estimate() from public;

create or replace function public.enqueue_auction_sale_market_estimate(
  p_auction_sale_id uuid,
  p_priority integer default 100,
  p_reason text default 'user_requested',
  p_now timestamptz default statement_timestamp()
)
returns public.auction_sale_market_estimates
language plpgsql
security invoker
set search_path = ''
as $$
declare
  sale_row public.auction_sales;
  queued_row public.auction_sale_market_estimates;
  normalized_priority integer := greatest(0, least(coalesce(p_priority, 100), 100));
begin
  select sale.* into sale_row
  from public.auction_sales sale
  where sale.id = p_auction_sale_id
    and sale.status in ('active', 'upcoming');

  if sale_row.id is null then
    raise exception 'auction sale is not active or does not exist';
  end if;

  insert into public.auction_sale_market_estimates (
    auction_sale_id,
    status,
    input_fingerprint,
    source_updated_at,
    priority,
    refresh_reason,
    requested_at,
    next_refresh_at
  ) values (
    sale_row.id,
    'pending',
    'queued:' || md5(jsonb_build_array(
      sale_row.id,
      sale_row.address,
      sale_row.city,
      sale_row.postal_code,
      sale_row.property_type,
      sale_row.latitude,
      sale_row.longitude,
      sale_row.app_surface_m2,
      sale_row.habitable_surface_m2,
      sale_row.carrez_surface_m2,
      sale_row.land_surface_m2,
      sale_row.app_surface_kind,
      sale_row.surface_scope,
      sale_row.rooms_count,
      sale_row.bedrooms_count
    )::text),
    sale_row.updated_at,
    normalized_priority,
    left(coalesce(nullif(trim(p_reason), ''), 'user_requested'), 80),
    p_now,
    p_now
  )
  on conflict (auction_sale_id) do update
  set priority = greatest(public.auction_sale_market_estimates.priority, excluded.priority),
      refresh_reason = excluded.refresh_reason,
      requested_at = p_now,
      next_refresh_at = case
        when public.auction_sale_market_estimates.status = 'processing'
          and public.auction_sale_market_estimates.next_refresh_at > p_now
          then public.auction_sale_market_estimates.next_refresh_at
        else least(public.auction_sale_market_estimates.next_refresh_at, p_now)
      end,
      status = case
        when public.auction_sale_market_estimates.status = 'processing'
          and public.auction_sale_market_estimates.next_refresh_at > p_now
          then 'processing'
        else 'pending'
      end,
      error_message = null,
      last_error_code = null
  returning * into queued_row;

  return queued_row;
end;
$$;

revoke all on function public.enqueue_auction_sale_market_estimate(uuid, integer, text, timestamptz)
from public, anon, authenticated;
grant execute on function public.enqueue_auction_sale_market_estimate(uuid, integer, text, timestamptz)
to service_role;

create or replace function public.claim_auction_sale_market_estimates(
  p_limit integer default 50,
  p_now timestamptz default statement_timestamp(),
  p_lease_seconds integer default 300
)
returns setof public.auction_sale_market_estimates
language sql
security invoker
set search_path = ''
as $$
  with candidates as (
    select queue.auction_sale_id
    from public.auction_sale_market_estimates queue
    where queue.next_refresh_at <= p_now
    order by queue.priority desc, queue.next_refresh_at, queue.auction_sale_id
    for update skip locked
    limit greatest(1, least(coalesce(p_limit, 50), 100))
  )
  update public.auction_sale_market_estimates queue
  set status = 'processing',
      attempt_count = queue.attempt_count + 1,
      last_started_at = p_now,
      next_refresh_at = p_now + make_interval(secs => greatest(60, least(coalesce(p_lease_seconds, 300), 1800))),
      error_message = null,
      last_error_code = null
  from candidates
  where queue.auction_sale_id = candidates.auction_sale_id
  returning queue.*;
$$;

revoke all on function public.claim_auction_sale_market_estimates(integer, timestamptz, integer)
from public, anon, authenticated;
grant execute on function public.claim_auction_sale_market_estimates(integer, timestamptz, integer)
to service_role;

create or replace function public.claim_auction_sale_market_estimate(
  p_auction_sale_id uuid,
  p_now timestamptz default statement_timestamp(),
  p_lease_seconds integer default 90
)
returns setof public.auction_sale_market_estimates
language sql
security invoker
set search_path = ''
as $$
  with candidate as (
    select queue.auction_sale_id
    from public.auction_sale_market_estimates queue
    where queue.auction_sale_id = p_auction_sale_id
      and queue.next_refresh_at <= p_now
    for update skip locked
  )
  update public.auction_sale_market_estimates queue
  set status = 'processing',
      attempt_count = queue.attempt_count + 1,
      last_started_at = p_now,
      next_refresh_at = p_now + make_interval(secs => greatest(30, least(coalesce(p_lease_seconds, 90), 300))),
      error_message = null,
      last_error_code = null
  from candidate
  where queue.auction_sale_id = candidate.auction_sale_id
  returning queue.*;
$$;

revoke all on function public.claim_auction_sale_market_estimate(uuid, timestamptz, integer)
from public, anon, authenticated;
grant execute on function public.claim_auction_sale_market_estimate(uuid, timestamptz, integer)
to service_role;

create or replace function public.search_dvf_market_comparables(
  p_latitude double precision,
  p_longitude double precision,
  p_radius_m integer,
  p_minimum_date date,
  p_segment text,
  p_limit integer default 2500
)
returns table (
  id uuid,
  source_mutation_id text,
  sale_date date,
  mutation_nature text,
  total_price_eur numeric,
  built_surface_m2 numeric,
  land_surface_m2 numeric,
  price_per_m2 numeric,
  property_type text,
  dvf_property_type_code text,
  parcel_id text,
  latitude double precision,
  longitude double precision,
  distance_m integer
)
language sql
stable
security invoker
set search_path = ''
as $$
  with subject as (
    select
      public.st_setsrid(public.st_makepoint(p_longitude, p_latitude), 4326)::public.geography as point,
      greatest(50, least(coalesce(p_radius_m, 1000), 20000))::double precision as radius_m,
      greatest(0.2, cos(radians(p_latitude))) as longitude_scale
  ), candidates as (
    select
      dvf.*,
      public.st_distance(
        public.st_setsrid(public.st_makepoint(dvf.longitude, dvf.latitude), 4326)::public.geography,
        subject.point
      ) as exact_distance_m
    from public.dvf_transactions dvf
    cross join subject
    where dvf.sale_date >= p_minimum_date
      and dvf.latitude between
        p_latitude - subject.radius_m / 111000.0
        and p_latitude + subject.radius_m / 111000.0
      and dvf.longitude between
        p_longitude - subject.radius_m / (111000.0 * subject.longitude_scale)
        and p_longitude + subject.radius_m / (111000.0 * subject.longitude_scale)
      and (
        (p_segment = 'apartment' and dvf.dvf_property_type_code = '121')
        or (p_segment = 'house' and dvf.dvf_property_type_code = '111')
        or (p_segment = 'building' and dvf.dvf_property_type_code in ('112', '122', '123', '151'))
        or (p_segment = 'commercial' and (
          dvf.dvf_property_type_code like '14%'
          or dvf.dvf_property_type_code = '152'
        ))
        or (p_segment = 'land' and dvf.dvf_property_type_code like '2%')
      )
      and public.st_dwithin(
        public.st_setsrid(public.st_makepoint(dvf.longitude, dvf.latitude), 4326)::public.geography,
        subject.point,
        subject.radius_m
      )
  )
  select
    candidates.id,
    candidates.source_mutation_id,
    candidates.sale_date,
    candidates.mutation_nature,
    candidates.total_price_eur,
    candidates.built_surface_m2,
    candidates.land_surface_m2,
    candidates.price_per_m2,
    candidates.property_type,
    candidates.dvf_property_type_code,
    candidates.parcel_id,
    candidates.latitude,
    candidates.longitude,
    round(candidates.exact_distance_m)::integer as distance_m
  from candidates
  order by candidates.exact_distance_m, candidates.sale_date desc
  limit greatest(100, least(coalesce(p_limit, 2500), 5000));
$$;

revoke all on function public.search_dvf_market_comparables(double precision, double precision, integer, date, text, integer)
from public, anon, authenticated;
grant execute on function public.search_dvf_market_comparables(double precision, double precision, integer, date, text, integer)
to service_role;

create or replace function public.evaluate_market_valuation_health(
  p_now timestamptz default statement_timestamp()
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  total_count integer;
  served_count integer;
  actionable_count integer;
  due_count integer;
  oldest_due_seconds integer;
  recent_failure_count integer;
  coverage_pct numeric;
  details jsonb;
begin
  select
    count(*)::integer,
    count(*) filter (where estimate is not null)::integer,
    count(*) filter (where estimate is not null and actionable)::integer,
    count(*) filter (where next_refresh_at <= p_now)::integer,
    coalesce(max(extract(epoch from (p_now - next_refresh_at))) filter (
      where next_refresh_at <= p_now
    ), 0)::integer
  into total_count, served_count, actionable_count, due_count, oldest_due_seconds
  from public.auction_sale_market_estimates;

  select count(*)::integer into recent_failure_count
  from public.valuation_estimate_attempts
  where outcome = 'failed'
    and created_at >= p_now - interval '1 hour';

  coverage_pct := case
    when total_count = 0 then 0
    else round((served_count::numeric / total_count::numeric) * 100, 1)
  end;
  details := jsonb_build_object(
    'total', total_count,
    'served', served_count,
    'without_estimate', total_count - served_count,
    'actionable', actionable_count,
    'coverage_pct', coverage_pct,
    'due', due_count,
    'oldest_due_seconds', oldest_due_seconds,
    'failed_last_hour', recent_failure_count
  );

  perform app_private.sync_operational_alert(
    'valuation.queue.degraded',
    'valuation',
    case
      when coverage_pct < 75 or oldest_due_seconds > 3600 then 'critical'
      else 'warning'
    end,
    details,
    total_count > 0 and (
      coverage_pct < 95
      or oldest_due_seconds > 900
      or recent_failure_count > 5
    ),
    p_now
  );

  return details;
end;
$$;

revoke all on function public.evaluate_market_valuation_health(timestamptz)
from public, anon, authenticated;
grant execute on function public.evaluate_market_valuation_health(timestamptz)
to service_role;

update public.auction_sale_market_estimates queue
set priority = case
      when queue.estimate is null then 80
      when queue.status in ('failed', 'insufficient_data') then 40
      else 10
    end,
    refresh_reason = case
      when queue.estimate is null then 'backlog_recovery'
      else 'scheduled_refresh'
    end,
    next_refresh_at = case
      when queue.estimate is null then statement_timestamp()
      else queue.next_refresh_at
    end;

create or replace function app_private.invoke_market_valuation_precompute_endpoint()
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  endpoint_url text;
  cron_secret text;
  request_id bigint;
begin
  select decrypted_secret into endpoint_url
  from vault.decrypted_secrets
  where name = 'immojudis_operational_health_url'
  order by updated_at desc
  limit 1;

  select decrypted_secret into cron_secret
  from vault.decrypted_secrets
  where name = 'immojudis_operational_health_secret'
  order by updated_at desc
  limit 1;

  if nullif(pg_catalog.btrim(endpoint_url), '') is null
    or nullif(pg_catalog.btrim(cron_secret), '') is null then
    raise warning 'ImmoJudis scheduler Vault secrets are not configured.';
    return null;
  end if;

  select net.http_get(
    url => pg_catalog.rtrim(endpoint_url, '/') || '/api/cron/precompute-valuations',
    headers => jsonb_build_object(
      'Authorization', 'Bearer ' || cron_secret,
      'Accept', 'application/json',
      'User-Agent', 'immojudis-supabase-cron/1.0'
    ),
    timeout_milliseconds => 10000
  ) into request_id;

  return request_id;
end;
$$;

revoke all on function app_private.invoke_market_valuation_precompute_endpoint()
from public, anon, authenticated, service_role;

select cron.unschedule(jobid)
from cron.job
where jobname = 'immojudis-market-valuations';

select cron.schedule(
  'immojudis-market-valuations',
  '*/5 * * * *',
  'select app_private.invoke_market_valuation_precompute_endpoint();'
);

notify pgrst, 'reload schema';

commit;
