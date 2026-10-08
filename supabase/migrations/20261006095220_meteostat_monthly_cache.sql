begin;

-- Server-only cache for the Meteostat monthly endpoint. The key is based on a
-- two-decimal coordinate grid and a calendar year so nearby listings share
-- their observations instead of calling the provider at every page view.
create table if not exists public.meteostat_monthly_cache (
  cache_key text primary key
    check (cache_key ~ '^meteostat:-?[0-9]+(\.[0-9]{2}):-?[0-9]+(\.[0-9]{2}):[0-9]{4}$'),
  grid_latitude numeric(5, 2) not null
    check (grid_latitude between -90 and 90),
  grid_longitude numeric(6, 2) not null
    check (grid_longitude between -180 and 180),
  period_start date not null,
  period_end date not null,
  payload jsonb,
  fetched_at timestamptz,
  expires_at timestamptz,
  last_error text,
  retry_after timestamptz,
  updated_at timestamptz not null default statement_timestamp(),
  check (period_end >= period_start),
  check (payload is null or pg_catalog.jsonb_typeof(payload) = 'object'),
  check (payload is not null or last_error is not null)
);

comment on table public.meteostat_monthly_cache is
  'Server-only Meteostat monthly observations keyed by a coarse coordinate grid and complete calendar year. Never expose upstream credentials or raw API errors to clients.';

alter table public.meteostat_monthly_cache enable row level security;
revoke all on table public.meteostat_monthly_cache from public, anon, authenticated;
grant select, insert, update on table public.meteostat_monthly_cache to service_role;

create index if not exists meteostat_monthly_cache_expires_idx
  on public.meteostat_monthly_cache(expires_at);

-- The RapidAPI free plan has a monthly ceiling. Incrementing this row is done
-- inside a row lock so concurrent Vercel instances cannot oversubscribe the
-- application budget. The table stays private; the server-only public RPC
-- below is needed because the Supabase client calls public functions by
-- default.
create table if not exists app_private.meteostat_monthly_quota (
  month_start date primary key
    check (month_start = date_trunc('month', month_start)::date),
  request_count integer not null default 0
    check (request_count >= 0),
  updated_at timestamptz not null default statement_timestamp()
);

comment on table app_private.meteostat_monthly_quota is
  'Private application-side Meteostat upstream request budget by UTC month.';

revoke all on table app_private.meteostat_monthly_quota
  from public, anon, authenticated, service_role;
grant usage on schema app_private to service_role;
grant select, insert, update on table app_private.meteostat_monthly_quota to service_role;

-- Keep the RPC in the exposed schema because the Supabase client calls public
-- functions by default. Its privileges remain server-only.
create or replace function public.consume_meteostat_monthly_quota(
  p_month_start date,
  p_limit integer default 500
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  consumed boolean := false;
begin
  if p_month_start is null
    or p_month_start <> pg_catalog.date_trunc('month', p_month_start)::date
    or p_limit is null
    or p_limit < 1
    or p_limit > 500 then
    raise exception using
      errcode = '22023',
      message = 'Invalid Meteostat quota arguments.';
  end if;

  insert into app_private.meteostat_monthly_quota(month_start)
  values (p_month_start)
  on conflict (month_start) do nothing;

  update app_private.meteostat_monthly_quota
  set request_count = request_count + 1,
      updated_at = pg_catalog.statement_timestamp()
  where month_start = p_month_start
    and request_count < p_limit
  returning true into consumed;

  return coalesce(consumed, false);
end;
$$;

revoke all on function public.consume_meteostat_monthly_quota(date, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.consume_meteostat_monthly_quota(date, integer)
  to service_role;

notify pgrst, 'reload schema';

commit;
