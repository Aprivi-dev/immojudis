begin;

select plan(28);

select is(
  app_private.sale_catalogue_expiry('2026-10-03 12:00Z', '{}'::jsonb),
  '2026-10-03 12:00Z'::timestamptz,
  'a timed sale leaves the catalogue at its observed instant'
);
select is(
  app_private.sale_catalogue_expiry(
    '2026-10-03 12:00Z',
    '{"sale_procedure":{"sale_window":{"opens_at":"2026-10-03T12:00:00Z","closes_at":"2026-10-03T14:00:00Z"}}}'::jsonb
  ),
  '2026-10-03 14:00Z'::timestamptz,
  'an online sale remains visible through its validated closing instant'
);
select is(
  app_private.sale_catalogue_expiry('2026-10-03 00:00Z', '{"sale_date":"2026-10-03"}'::jsonb),
  '2026-10-03 22:00Z'::timestamptz,
  'a date-only sale remains through the Paris civil day'
);
select is(
  app_private.sale_catalogue_expiry('2026-10-25 00:00Z', '{"sale_date":"2026-10-25","date_precision":"day"}'::jsonb),
  '2026-10-25 23:00Z'::timestamptz,
  'the autumn DST boundary still uses the next Paris midnight'
);
select is(
  app_private.sale_catalogue_expiry('2026-10-25 00:00Z', '{"sale_date":"2026-10-25","date_precision":"day"}'::jsonb, 'start_of_day'),
  '2026-10-24 22:00Z'::timestamptz,
  'the start-of-day policy is explicit when requested'
);
select is(
  app_private.sale_catalogue_expiry(null, '{}'::jsonb),
  null::timestamptz,
  'a missing sale date has no catalogue deadline'
);
select ok(
  app_private.sale_catalogue_entry_is_live('2099-01-01 12:00Z', '{}'::jsonb),
  'a future timed sale is live'
);
select ok(
  not app_private.sale_catalogue_entry_is_live('2000-01-01 12:00Z', '{}'::jsonb),
  'an elapsed timed sale is not live'
);
set local app.date_only_catalogue_policy = 'start_of_day';
select is(
  app_private.sale_catalogue_expiry('2026-10-25 00:00Z', '{"sale_date":"2026-10-25","date_precision":"day"}'::jsonb),
  '2026-10-24 22:00Z'::timestamptz,
  'the session policy is applied when no function argument is supplied'
);
reset app.date_only_catalogue_policy;

select has_column(
  'public',
  'auction_sales',
  'catalogue_expiry_deadline',
  'auction sales persist the exact catalogue expiry cutoff'
);
select has_column(
  'public',
  'auction_sales',
  'catalogue_expiry_materialized',
  'auction sales expose the exact expiry backfill fence'
);
select is(
  app_private.sale_catalogue_retention_deadline('2026-10-03 12:00Z', 'upcoming', '{}'::jsonb, '{}'::jsonb),
  '2026-10-03 12:00Z'::timestamptz,
  'the exact retention cutoff for a timed sale has no extra 24-hour grace'
);
select is(
  app_private.sale_catalogue_retention_deadline('2026-10-03 00:00Z', 'upcoming', '{}'::jsonb, '{"sale_date":"2026-10-03"}'::jsonb),
  '2026-10-03 22:00Z'::timestamptz,
  'the exact retention cutoff for a date-only sale is the next Paris midnight'
);
select is(
  app_private.sale_catalogue_retention_deadline(
    '2026-10-03 00:00Z',
    'upcoming',
    '{"sale_window":{"opens_at":"2026-10-03T10:00:00Z","closes_at":"2026-10-03T14:00:00Z"}}'::jsonb,
    '{}'::jsonb
  ),
  '2026-10-03 14:00Z'::timestamptz,
  'an online sale uses its exact closing instant'
);

select ok(
  to_regclass('public.auction_sale_retention_tombstones') is not null,
  'retention tombstone table exists'
);
select ok(
  has_table_privilege('service_role', 'public.auction_sale_retention_tombstones', 'insert'),
  'only the retention worker has the tombstone insert grant'
);
select ok(
  not has_table_privilege('anon', 'public.auction_sale_retention_tombstones', 'select'),
  'anonymous clients cannot read retention tombstones'
);
select ok(
  position('sale_catalogue_entry_is_live' in lower(pg_get_viewdef('public.v_auction_sales_app'::regclass, true))) > 0,
  'the authenticated catalogue view excludes elapsed and undated rows'
);
select ok(
  position('sale_catalogue_entry_is_live' in lower(pg_get_functiondef(
    'app_private.search_auction_sales_preview_v3(text[],text,text,text,text[],text[],numeric,numeric,numeric,numeric,integer,integer,text,numeric,text[],double precision,double precision,double precision,double precision,text,integer,integer,text)'::regprocedure
  ))) > 0,
  'the public preview filters before pagination'
);
select ok(
  position('counted.coordinates_rank' in lower(pg_get_functiondef(
    'app_private.search_auction_sales_preview_v3(text[],text,text,text,text[],text[],numeric,numeric,numeric,numeric,integer,integer,text,numeric,text[],double precision,double precision,double precision,double precision,text,integer,integer,text)'::regprocedure
  ))) > 0,
  'the public preview ranks coordinate-less rows after mapped rows'
);
select ok(
  position('coordinates_rank' in lower(pg_get_functiondef(
    'app_private.search_auction_sales_preview(text[],text,text,text,text[],text[],numeric,numeric,numeric,numeric,integer,integer,text,numeric,text[],double precision,double precision,double precision,double precision,text,integer,integer)'::regprocedure
  ))) > 0
  and position('coordinates_rank' in lower(pg_get_functiondef(
    'app_private.search_auction_sales_preview_v2(text[],text,text,text,text[],text[],numeric,numeric,numeric,numeric,integer,integer,text,numeric,text[],double precision,double precision,double precision,double precision,text,integer,integer,text)'::regprocedure
  ))) > 0
  and position('coordinates_rank' in lower(pg_get_functiondef(
    'app_private.search_auction_sales_preview_v3(text[],text,text,text,text[],text[],numeric,numeric,numeric,numeric,integer,integer,text,numeric,text[],double precision,double precision,double precision,double precision,text,integer,integer,text)'::regprocedure
  ))) > 0
  and position('coordinates_rank' in lower(pg_get_functiondef(
    'app_private.search_auction_sales_preview_v4(text[],text,text,text,text[],text[],numeric,numeric,numeric,numeric,integer,integer,text,numeric,text[],double precision,double precision,double precision,double precision,text,integer,integer,text,date,date)'::regprocedure
  ))) > 0
  and position('counted.latitude is null' in lower(pg_get_functiondef(
    'app_private.search_auction_sales_preview(text[],text,text,text,text[],text[],numeric,numeric,numeric,numeric,integer,integer,text,numeric,text[],double precision,double precision,double precision,double precision,text,integer,integer)'::regprocedure
  ))) = 0,
  'legacy preview contracts rank through an internal CTE column'
);
select ok(
  to_regclass('public.v_auction_sales_app_search') is not null
  and to_regclass('public.v_auction_sales_discovery_search') is not null,
  'authenticated search projections expose coordinate ranking without changing detail contracts'
);
select ok(
  'security_invoker=true' = any(coalesce((select reloptions from pg_class where oid = 'public.v_auction_sales_app'::regclass), '{}'))
  and 'security_invoker=false' = any(coalesce((select reloptions from pg_class where oid = 'public.v_auction_sales_discovery'::regclass), '{}'))
  and 'security_barrier=true' = any(coalesce((select reloptions from pg_class where oid = 'public.v_auction_sales_discovery'::regclass), '{}')),
  'app and discovery views preserve their existing RLS/security boundaries'
);
select ok(
  position('coordinates_rank' in lower(pg_get_viewdef('public.v_auction_sales_app_search'::regclass, true))) > 0,
  'the authenticated search projection puts coordinate-less rows after mapped rows'
);
select ok(
  position('catalogue_expiry_deadline' in lower(pg_get_functiondef(
    'public.purge_expired_auction_sales(timestamptz,integer)'::regprocedure
  ))) > 0
  and position('+ interval ''24 hours''' in lower(pg_get_functiondef(
    'public.purge_expired_auction_sales(timestamptz,integer)'::regprocedure
  ))) = 0,
  'destructive retention uses the exact catalogue cutoff'
);

set local role service_role;
select lives_ok(
  $$insert into public.auction_sale_retention_tombstones(source_url, sale_date)
    values ('https://example.test/414/retired', '2000-01-01 12:00Z')$$,
  'a retention worker can record a retired source URL'
);
select throws_ok(
  $$insert into public.auction_sales(id, source_name, source_url, status, starting_price_eur)
    values ('41400000-1000-4000-8000-000000000001', 'retention-test', 'https://example.test/414/retired', 'upcoming', 10000)$$,
  '23505',
  'This auction sale date was retired by retention.',
  'the tombstone trigger rejects a source replay'
);
select lives_ok(
  $$insert into public.auction_sales(id, source_name, source_url, status, starting_price_eur, sale_date)
    values ('41400000-1000-4000-8000-000000000002', 'retention-test', 'https://example.test/414/retired', 'upcoming', 10000, '2099-01-01 12:00Z')$$,
  'a later rescheduled hearing at the same source URL remains admissible'
);
reset role;

select * from finish();
-- The whole test is a dry-run transaction. No fixture or tombstone survives it.
rollback;
