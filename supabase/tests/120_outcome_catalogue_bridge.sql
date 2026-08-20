begin;

select plan(35);

select has_table(
  'public',
  'auction_sale_outcome_bridges',
  'the mutable catalogue has a durable Outcome Graph bridge registry'
);

select ok(
  (
    select relrowsecurity
    from pg_class
    join pg_namespace on pg_namespace.oid = pg_class.relnamespace
    where pg_namespace.nspname = 'public'
      and pg_class.relname = 'auction_sale_outcome_bridges'
  ),
  'RLS is enabled on the bridge registry'
);

select ok(
  not has_table_privilege('anon', 'public.auction_sale_outcome_bridges', 'SELECT'),
  'anonymous callers cannot read catalogue bridge provenance'
);

select ok(
  not has_table_privilege('authenticated', 'public.auction_sale_outcome_bridges', 'SELECT'),
  'authenticated callers cannot read catalogue bridge provenance directly'
);

select ok(
  has_table_privilege('service_role', 'public.auction_sale_outcome_bridges', 'SELECT')
  and has_table_privilege('service_role', 'public.auction_sale_outcome_bridges', 'INSERT')
  and has_table_privilege('service_role', 'public.auction_sale_outcome_bridges', 'UPDATE')
  and not has_table_privilege('service_role', 'public.auction_sale_outcome_bridges', 'DELETE'),
  'the trusted worker may link and detach catalogue rows but cannot delete provenance'
);

select ok(
  not has_function_privilege(
    'authenticated',
    'public.bridge_auction_sales_to_outcome_graph()',
    'EXECUTE'
  ),
  'authenticated callers cannot invoke the bridge RPC'
);

select ok(
  has_function_privilege(
    'service_role',
    'public.bridge_auction_sales_to_outcome_graph()',
    'EXECUTE'
  ),
  'service role can invoke the bridge RPC'
);

insert into public.tribunals (
  code, canonical_name, department, city, aliases
) values (
  'bridge_bordeaux',
  'TJ Bordeaux Bridge',
  '33',
  'Bordeaux',
  '[]'::jsonb
);

insert into public.auction_sales (
  id,
  source_name,
  source_url,
  external_id,
  tribunal,
  tribunal_code,
  department,
  city,
  address,
  postal_code,
  property_type,
  habitable_surface_m2,
  starting_price_eur,
  sale_date,
  status,
  adjudication_price_eur,
  first_seen_at
) values
  (
    'a1000000-0000-4000-8000-000000000001',
    'bridge-test',
    'https://example.test/catalogue/annonce-1',
    'ANNONCE-1',
    'TJ Bordeaux Bridge',
    'bridge_bordeaux',
    '33',
    'Bordeaux',
    '12 rue du Test',
    '33000',
    'apartment',
    61.25,
    90000.10,
    statement_timestamp() + interval '30 days',
    'upcoming',
    null,
    statement_timestamp() - interval '2 days'
  ),
  (
    'a1000000-0000-4000-8000-000000000002',
    'bridge-test',
    'https://example.test/catalogue/annonce-past',
    'ANNONCE-PAST',
    null,
    null,
    null,
    null,
    null,
    null,
    'unknown',
    null,
    125000.20,
    statement_timestamp() - interval '30 days',
    'past',
    166000.40,
    statement_timestamp() - interval '60 days'
  ),
  (
    'a1000000-0000-4000-8000-000000000003',
    'bridge-test',
    'https://example.test/catalogue/annonce-adjudicated',
    'ANNONCE-ADJUDICATED',
    null,
    null,
    '64',
    'Pau',
    null,
    '64000',
    'house',
    88.50,
    140000.30,
    statement_timestamp() - interval '10 days',
    'adjudicated',
    201000.90,
    statement_timestamp() - interval '40 days'
  );

select results_eq(
  $$select scanned_count, created_count, reused_count, linked_count, complete
    from public.bridge_auction_sales_to_outcome_graph()$$,
  $$values (3::bigint, 3::bigint, 0::bigint, 3::bigint, true)$$,
  'the first bridge call links every catalogue status atomically'
);

select is(
  (select count(*) from public.auction_sale_outcome_bridges),
  3::bigint,
  'one immutable bridge origin is recorded per source URL'
);

select is(
  (select count(*) from public.auction_cases where case_status = 'announced'),
  3::bigint,
  'catalogue rows only assert that a case was announced'
);

select is(
  (select count(*) from public.auction_lots where auction_sale_id is not null),
  3::bigint,
  'each announcement has one linked lot'
);

select is(
  (select count(*) from public.auction_rounds),
  3::bigint,
  'each announcement has one initial round'
);

select is(
  (
    select count(*)
    from public.auction_events event_row
    where event_row.event_type = 'announcement_observed'
  ),
  3::bigint,
  'each bridge records only an announcement event'
);

select ok(
  (
    select count(*) = 3
      and bool_and(outcome_status = 'unknown')
      and bool_and(initial_hammer_price_eur is null)
      and bool_and(final_hammer_price_eur is null)
      and bool_and(not training_eligible)
    from public.auction_outcomes
  ),
  'past and adjudicated catalogue labels never become a known or trainable outcome'
);

select is(
  (
    select court_mapping_method
    from public.auction_sale_outcome_bridges
    where source_url_snapshot = 'https://example.test/catalogue/annonce-1'
  ),
  'tribunal_code_exact',
  'a known tribunal is mapped only by its exact legacy code'
);

select is(
  (
    select court_mapping_input ->> 'tribunal_code'
    from public.auction_sale_outcome_bridges
    where source_url_snapshot = 'https://example.test/catalogue/annonce-1'
  ),
  'bridge_bordeaux',
  'the exact tribunal mapping input remains explainable'
);

select ok(
  (
    select count(*) = 2 and bool_and(court_mapping_method = 'unmapped')
    from public.auction_sale_outcome_bridges
    where source_url_snapshot in (
      'https://example.test/catalogue/annonce-past',
      'https://example.test/catalogue/annonce-adjudicated'
    )
  ),
  'missing tribunal codes use the explicit inactive sentinel without inference'
);

select ok(
  (
    select not active and court_type = 'unknown'
    from public.outcome_courts
    where code = 'legacy:unmapped'
  ),
  'the unmapped court sentinel cannot masquerade as an active tribunal'
);

select ok(
  (
    select bridge.address_mapping_method = 'catalogue_address_snapshot'
      and address_row.street = '12 rue du Test'
      and address_row.postal_code = '33000'
      and address_row.city = 'Bordeaux'
    from public.auction_sale_outcome_bridges bridge
    join public.auction_lots lot_row on lot_row.id = bridge.lot_id
    join public.outcome_addresses address_row on address_row.id = lot_row.address_id
    where bridge.source_url_snapshot = 'https://example.test/catalogue/annonce-1'
  ),
  'address mapping is an explainable exact catalogue snapshot'
);

select ok(
  (
    select bridge.address_mapping_method = 'not_available'
      and lot_row.address_id is null
    from public.auction_sale_outcome_bridges bridge
    join public.auction_lots lot_row on lot_row.id = bridge.lot_id
    where bridge.source_url_snapshot = 'https://example.test/catalogue/annonce-past'
  ),
  'an absent address remains explicitly unavailable'
);

select ok(
  (
    select lot_row.initial_starting_price_eur = 90000.10::numeric
      and round_row.initial_starting_price_eur = 90000.10::numeric
      and round_row.effective_starting_price_eur = 90000.10::numeric
    from public.auction_sale_outcome_bridges bridge
    join public.auction_lots lot_row on lot_row.id = bridge.lot_id
    join public.auction_rounds round_row on round_row.id = bridge.round_id
    where bridge.source_url_snapshot = 'https://example.test/catalogue/annonce-1'
  ),
  'monetary Decimal values stay exact through database numeric copies'
);

select ok(
  (
    select bool_and(
      not (source_snapshot ? 'adjudication_price_eur')
      and not (source_snapshot ? 'legacy_adjudication_price_eur')
      and not (source_snapshot ? 'initial_hammer_price_eur')
      and not (source_snapshot ? 'final_hammer_price_eur')
    )
    from public.auction_sale_outcome_bridges
  ),
  'unverified catalogue adjudication prices are never copied into bridge provenance'
);

select ok(
  (
    select bool_and(
      source_key ~ '^auction_sales:v1:sha256:[0-9a-f]{64}$'
      and source_key = app_private.auction_sale_catalogue_source_key(source_url_snapshot)
    )
    from public.auction_sale_outcome_bridges
  ),
  'the immutable key is a bounded SHA-256 of the preserved canonical URL'
);

select ok(
  (
    select bool_and(
      catalogue_status = 'announced'
      and outcome_status = 'unknown'
      and not training_eligible
    )
    from public.auction_sale_outcome_bridges
  ),
  'bridge rows are announcement-only, unknown-outcome, and never trainable'
);

select results_eq(
  $$select scanned_count, created_count, reused_count, linked_count, complete
    from public.bridge_auction_sales_to_outcome_graph()$$,
  $$values (3::bigint, 0::bigint, 3::bigint, 3::bigint, true)$$,
  'replaying the bridge reuses the same lineage'
);

select ok(
  (select count(*) = 3 from public.auction_sale_outcome_bridges)
  and (select count(*) = 3 from public.auction_cases where case_status = 'announced')
  and (select count(*) = 3 from public.auction_rounds)
  and (select count(*) = 3 from public.auction_outcomes),
  'idempotent replay creates no duplicate case, lot, round, or outcome'
);

select throws_ok(
  $$update public.auction_sale_outcome_bridges
    set source_key = source_key || '-changed'
    where source_url_snapshot = 'https://example.test/catalogue/annonce-1'$$,
  '55000',
  'Outcome catalogue bridge identity and mapping are immutable.',
  'the durable source key cannot be rewritten'
);

insert into public.auction_sales (
  id, source_name, source_url, property_type, status
) values (
  'a1000000-0000-4000-8000-000000000004',
  'bridge-test',
  'https://example.test/catalogue/unbridged',
  'unknown',
  'unknown'
);

select throws_ok(
  $$delete from public.auction_sales
    where id = 'a1000000-0000-4000-8000-000000000004'$$,
  '55000',
  'auction_sales rows must have a complete Outcome Graph bridge before deletion.',
  'database cleanup fails closed for an unbridged catalogue row'
);

select results_eq(
  $$select scanned_count, created_count, reused_count, linked_count, complete
    from public.bridge_auction_sales_to_outcome_graph()$$,
  $$values (4::bigint, 1::bigint, 3::bigint, 4::bigint, true)$$,
  'a later bridge call catches catalogue rows inserted after the first scan'
);

select lives_ok(
  $$delete from public.auction_sales
    where id = 'a1000000-0000-4000-8000-000000000002'$$,
  'a bridged past row may be removed by catalogue retention'
);

select ok(
  (
    select auction_sale_id is null
      and source_key = app_private.auction_sale_catalogue_source_key(source_url_snapshot)
    from public.auction_sale_outcome_bridges
    where source_url_snapshot = 'https://example.test/catalogue/annonce-past'
  ),
  'ON DELETE SET NULL leaves the immutable source key and graph lineage intact'
);

select ok(
  (
    select lot_row.auction_sale_id is null
      and bridge.case_id is not null
      and bridge.round_id is not null
      and bridge.unknown_outcome_id is not null
    from public.auction_sale_outcome_bridges bridge
    join public.auction_lots lot_row on lot_row.id = bridge.lot_id
    where bridge.source_url_snapshot = 'https://example.test/catalogue/annonce-past'
  ),
  'case, lot, round, and unknown outcome survive catalogue deletion'
);

insert into public.auction_sales (
  id, source_name, source_url, property_type, status
) values (
  'a1000000-0000-4000-8000-000000000005',
  'bridge-test',
  'https://example.test/catalogue/annonce-past',
  'unknown',
  'unknown'
);

select results_eq(
  $$select scanned_count, created_count, reused_count, linked_count, complete
    from public.bridge_auction_sales_to_outcome_graph()$$,
  $$values (4::bigint, 0::bigint, 4::bigint, 4::bigint, true)$$,
  'a returning source URL reattaches to its immutable lineage without ambiguity'
);

select ok(
  (
    select bridge.auction_sale_id = 'a1000000-0000-4000-8000-000000000005'
      and lot_row.auction_sale_id = 'a1000000-0000-4000-8000-000000000005'
    from public.auction_sale_outcome_bridges bridge
    join public.auction_lots lot_row on lot_row.id = bridge.lot_id
    where bridge.source_url_snapshot = 'https://example.test/catalogue/annonce-past'
  ),
  'reattachment updates both the bridge and its preserved lot'
);

select is(
  (select count(*) from public.auction_sale_outcome_bridges),
  4::bigint,
  'reattachment does not duplicate immutable bridge provenance'
);

select * from finish();

rollback;
