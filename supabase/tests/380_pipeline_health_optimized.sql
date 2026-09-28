begin;
select plan(6);

insert into public.auction_sales (
  source_name, source_url, status, sale_date, raw_payload
) values (
  'health_a', 'https://example.test/health/1', 'upcoming',
  '2026-09-30 12:00:00Z',
  '{"source_checks":{"https://example.test/health/1":{"source_name":"health_a","checked_at":"2026-09-28T08:00:00Z"},"https://example.test/health/alias":{"source_name":"health_b","checked_at":"2026-09-28T07:00:00Z"}}}'::jsonb
);

insert into public.auction_observations (
  source_url, source_name, canonical_source_url
) values
  ('https://example.test/health/alias', 'health_b', 'https://example.test/health/1'),
  ('https://example.test/health/unread', 'health_c', 'https://example.test/health/1');

select is(
  (select active_listings from public.auction_all_source_freshness('2026-09-28 12:00:00Z') where source_name = 'health_a'),
  1::bigint,
  'canonical source counts the active sale once'
);
select is(
  (select fresh_listings from public.auction_all_source_freshness('2026-09-28 12:00:00Z') where source_name = 'health_a'),
  1::bigint,
  'canonical source uses its check timestamp'
);
select is(
  (select active_listings from public.auction_all_source_freshness('2026-09-28 12:00:00Z') where source_name = 'health_b'),
  1::bigint,
  'observation and source check do not duplicate an alias'
);
select is(
  (select fresh_listings from public.auction_all_source_freshness('2026-09-28 12:00:00Z') where source_name = 'health_b'),
  1::bigint,
  'alias check timestamp contributes to freshness'
);
select is(
  (select active_listings from public.auction_all_source_freshness('2026-09-28 12:00:00Z') where source_name = 'health_c'),
  1::bigint,
  'linked observation without a check remains in the denominator'
);
select is(
  (select fresh_listings from public.auction_all_source_freshness('2026-09-28 12:00:00Z') where source_name = 'health_c'),
  0::bigint,
  'unread alias is not counted as fresh'
);

select * from finish();
rollback;
