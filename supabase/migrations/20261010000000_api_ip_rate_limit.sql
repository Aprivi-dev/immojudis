-- P4-02: per-IP rate limiting for anonymous or public API routes.
--
-- api_rate_limit_buckets is keyed by an auth.users id and cannot hold anonymous
-- callers. This table stores a salted hash of the client IP (never the address
-- itself) with the same fixed-window counter semantics as consume_api_rate_limit.
-- Rows older than two days are purged opportunistically by the function itself.
begin;
set local lock_timeout = '5s';

create table if not exists public.api_ip_rate_limit_buckets (
  ip_hash text not null check (ip_hash ~ '^[0-9a-f]{64}$'),
  bucket_key text not null check (length(bucket_key) between 1 and 120),
  window_started_at timestamptz not null,
  request_count integer not null default 1 check (request_count > 0),
  updated_at timestamptz not null default now(),
  primary key (ip_hash, bucket_key, window_started_at)
);

create index if not exists api_ip_rate_limit_buckets_window_idx
  on public.api_ip_rate_limit_buckets (window_started_at);

alter table public.api_ip_rate_limit_buckets enable row level security;
revoke all on table public.api_ip_rate_limit_buckets from public, anon, authenticated;
grant select, insert, update, delete on table public.api_ip_rate_limit_buckets to service_role;

create or replace function public.consume_ip_rate_limit(
  p_ip_hash text,
  p_bucket_key text,
  p_window_seconds integer,
  p_limit integer
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  bucket_start timestamptz;
  next_count integer;
begin
  if p_ip_hash is null
    or p_ip_hash !~ '^[0-9a-f]{64}$'
    or nullif(pg_catalog.btrim(p_bucket_key), '') is null
    or p_window_seconds < 1
    or p_limit < 1 then
    raise exception using errcode = '22023', message = 'Invalid rate-limit parameters.';
  end if;

  bucket_start := pg_catalog.to_timestamp(
    pg_catalog.floor(extract(epoch from statement_timestamp()) / p_window_seconds)
      * p_window_seconds
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_ip_hash || ':' || p_bucket_key || ':' || bucket_start::text, 0)
  );

  insert into public.api_ip_rate_limit_buckets (
    ip_hash,
    bucket_key,
    window_started_at,
    request_count,
    updated_at
  ) values (
    p_ip_hash,
    p_bucket_key,
    bucket_start,
    1,
    statement_timestamp()
  )
  on conflict (ip_hash, bucket_key, window_started_at)
  do update set
    request_count = public.api_ip_rate_limit_buckets.request_count + 1,
    updated_at = statement_timestamp()
  returning request_count into next_count;

  if next_count > p_limit then
    raise exception using errcode = 'P0001', message = 'Rate limit exceeded.';
  end if;

  -- Bounded housekeeping: roughly one call in a hundred removes a small batch of
  -- expired windows so the table needs no dedicated cron job.
  if pg_catalog.random() < 0.01 then
    delete from public.api_ip_rate_limit_buckets
    where (ip_hash, bucket_key, window_started_at) in (
      select expired.ip_hash, expired.bucket_key, expired.window_started_at
      from public.api_ip_rate_limit_buckets as expired
      where expired.window_started_at < statement_timestamp() - interval '2 days'
      limit 500
    );
  end if;

  return next_count;
end;
$$;

revoke all on function public.consume_ip_rate_limit(text, text, integer, integer)
  from public, anon, authenticated;
grant execute on function public.consume_ip_rate_limit(text, text, integer, integer)
  to service_role;

commit;
