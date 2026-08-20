begin;

select plan(13);

select has_column('public', 'auction_sales', 'sale_venue_type', 'sale venue is persisted');
select has_column('public', 'auction_sales', 'sale_legal_framework', 'legal framework is persisted');
select has_column(
  'public',
  'auction_sales',
  'sale_verification_status',
  'procedure verification status is persisted'
);
select has_column('public', 'auction_sales', 'sale_procedure', 'versioned procedure is persisted');

select ok(
  (
    select column_default = '''unknown''::text'
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'auction_sales'
      and column_name = 'sale_venue_type'
  ),
  'new sales default to an explicitly unknown venue'
);

select throws_ok(
  $$insert into public.auction_sales (source_name, source_url, sale_venue_type)
    values ('procedure-test', 'https://example.test/procedure/bad-venue', 'court')$$,
  '23514',
  null,
  'unsupported venue values are rejected'
);

select throws_ok(
  $$insert into public.auction_sales (source_name, source_url, sale_verification_status)
    values ('procedure-test', 'https://example.test/procedure/bad-status', 'assumed')$$,
  '23514',
  null,
  'unsupported verification statuses are rejected'
);

select throws_ok(
  $$insert into public.auction_sales (source_name, source_url, sale_procedure)
    values ('procedure-test', 'https://example.test/procedure/bad-json', '[]'::jsonb)$$,
  '23514',
  null,
  'the procedure payload must remain a JSON object'
);

insert into public.auction_sales (
  id,
  source_name,
  source_url,
  status,
  latitude,
  longitude,
  sale_venue_type,
  sale_verification_status,
  sale_procedure
) values (
  'c2000000-0000-4000-8000-000000000001',
  'procedure-test',
  'https://example.test/procedure/verified',
  'upcoming',
  44.84,
  -0.58,
  'tribunal',
  'cross_checked',
  '{"schema_version":"sale_procedure_v1","venue_type":"tribunal"}'::jsonb
);

select is(
  (
    select source_blocks->'sale_procedure'->>'venue_type'
    from public.v_auction_sales_discovery
    where id = 'c2000000-0000-4000-8000-000000000001'
  ),
  'tribunal',
  'Discovery receives the procedure needed by the free participation guide'
);

select is(
  (
    select source_url
    from public.v_auction_sales_discovery
    where id = 'c2000000-0000-4000-8000-000000000001'
  ),
  null,
  'Discovery keeps unrelated premium source fields redacted'
);

select results_eq(
  $$select sale_venue_type, sale_verification_status
    from public.v_auction_sales_app_preview
    where id = 'c2000000-0000-4000-8000-000000000001'$$,
  $$values ('tribunal'::text, 'cross_checked'::text)$$,
  'the anonymous teaser exposes only the venue and its verification state'
);

select ok(
  has_column_privilege('anon', 'public.auction_sales', 'sale_venue_type', 'SELECT')
    and has_column_privilege(
      'anon',
      'public.auction_sales',
      'sale_verification_status',
      'SELECT'
    )
    and not has_column_privilege('anon', 'public.auction_sales', 'sale_procedure', 'SELECT'),
  'anonymous base-table grants are limited to the two teaser fields'
);

select ok(
  has_table_privilege('anon', 'public.v_auction_sales_app_preview', 'SELECT'),
  'anonymous visitors can read the curated preview view'
);

select * from finish();

rollback;
