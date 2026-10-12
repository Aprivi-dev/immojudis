begin;

select plan(27);

select ok(
  exists (
    select 1
      from pg_catalog.pg_attribute
     where attrelid = 'app_private.auction_sale_source_presence'::regclass
       and attname = 'extras'
       and not attisdropped
       and atttypid = 'jsonb'::regtype
  ),
  'the compact projection has a JSONB extras column'
);

select ok(
  exists (
    select 1
      from pg_catalog.pg_attribute
     where attrelid = 'app_private.auction_sale_source_presence'::regclass
       and attname = 'legacy_raw'
       and not attisdropped
       and atttypid = 'boolean'::regtype
       and attnotnull
  ),
  'the compact projection records legacy raw provenance'
);

select ok(
  not (
    select attnotnull
      from pg_catalog.pg_attribute
     where attrelid = 'app_private.auction_sale_source_presence'::regclass
       and attname = 'attempted_at'
  )
  and not exists (
    select 1
      from pg_catalog.pg_attrdef
     where adrelid = 'app_private.auction_sale_source_presence'::regclass
       and adnum = (
         select attnum
           from pg_catalog.pg_attribute
          where attrelid = 'app_private.auction_sale_source_presence'::regclass
            and attname = 'attempted_at'
       )
  ),
  'legacy timestamps remain nullable without a default timestamp'
);

select ok(
  exists (
    select 1
      from pg_catalog.pg_trigger
     where tgrelid = 'public.auction_sales'::regclass
       and not tgisinternal
       and tgname = 'auction_sales_sync_source_presence_raw'
       and lower(pg_catalog.pg_get_triggerdef(oid)) like '%update of raw_payload%'
  ),
  'the compatibility trigger listens only to raw_payload writes'
);

select ok(
  not exists (
    select 1
      from pg_catalog.pg_trigger
     where tgrelid = 'app_private.auction_sale_source_presence'::regclass
       and not tgisinternal
  ),
  'there is no compact-to-raw reverse trigger'
);

select lives_ok($fixture$
  insert into public.auction_sales (
    id, source_name, source_url, title, status, sale_date, raw_payload
  ) values (
    'f4220000-0000-4000-8000-000000000001',
    'legacy-compat',
    'https://example.test/source-presence-422/raw-only',
    'raw-only source presence',
    'upcoming',
    now() + interval '30 days',
    jsonb_build_object(
      'source_presence', jsonb_build_object(
        'legacy-worker', jsonb_build_object(
          'availability', 'audit_error',
          'audit_error', jsonb_build_object('code', 'timeout', 'attempt', 2),
          'attempted_at', null,
          'checked_at', null,
          'state', null,
          'run_id', null
        )
      )
    )
  )
$fixture$, 'a legacy raw-only write is accepted');

select is(
  (
    select availability
      from app_private.auction_sale_source_presence
     where sale_id = 'f4220000-0000-4000-8000-000000000001'
       and source_name = 'legacy-worker'
  ),
  'unchecked',
  'unknown availability is normalized to unchecked'
);

select is(
  (
    select attempted_at
      from app_private.auction_sale_source_presence
     where sale_id = 'f4220000-0000-4000-8000-000000000001'
       and source_name = 'legacy-worker'
  ),
  null::timestamptz,
  'an absent legacy attempted_at remains null'
);

select is(
  (
    select extras->'audit_error'->>'code'
      from app_private.auction_sale_source_presence
     where sale_id = 'f4220000-0000-4000-8000-000000000001'
       and source_name = 'legacy-worker'
  ),
  'timeout',
  'unknown audit metadata is preserved in extras'
);

select is(
  (
    select extras->'_raw_availability'
      from app_private.auction_sale_source_presence
     where sale_id = 'f4220000-0000-4000-8000-000000000001'
       and source_name = 'legacy-worker'
  ),
  '"audit_error"'::jsonb,
  'the original unknown availability is preserved in extras'
);

select is(
  (
    select legacy_raw
      from app_private.auction_sale_source_presence
     where sale_id = 'f4220000-0000-4000-8000-000000000001'
       and source_name = 'legacy-worker'
  ),
  true,
  'raw compatibility rows retain legacy provenance'
);

select is(
  (
    select app_private.auction_sale_source_presence_json(
      'f4220000-0000-4000-8000-000000000001'
    )->'legacy-worker'->'audit_error'->>'code'
  ),
  'timeout',
  'the caller-safe JSON projection retains unknown metadata'
);

select ok(
  not (
    select app_private.auction_sale_source_presence_json(
      'f4220000-0000-4000-8000-000000000001'
    )->'legacy-worker' ? 'attempted_at'
  ),
  'the JSON projection does not invent an absent attempted_at'
);

select lives_ok($fixture$
  update public.auction_sales
     set raw_payload = jsonb_build_object(
       'source_presence', jsonb_build_object(
         'legacy-worker-v2', jsonb_build_object(
           'availability', 'available',
           'state', 'present',
           'attempted_at', '2026-10-08T10:00:00Z',
           'checked_at', 'not-a-timestamp',
           'run_id', 'legacy-run-422'
         )
       )
     )
   where id = 'f4220000-0000-4000-8000-000000000001'
$fixture$, 'a changed raw source_presence object is resynchronized');

select is(
  (
    select count(*)
      from app_private.auction_sale_source_presence
     where sale_id = 'f4220000-0000-4000-8000-000000000001'
  ),
  1::bigint,
  'a changed raw object removes stale compact source entries'
);

select is(
  (
    select state
      from app_private.auction_sale_source_presence
     where sale_id = 'f4220000-0000-4000-8000-000000000001'
       and source_name = 'legacy-worker-v2'
  ),
  'present',
  'the raw compatibility trigger keeps canonical state in parity'
);

select is(
  (
    select attempted_at
      from app_private.auction_sale_source_presence
     where sale_id = 'f4220000-0000-4000-8000-000000000001'
       and source_name = 'legacy-worker-v2'
  ),
  '2026-10-08T10:00:00Z'::timestamptz,
  'a valid legacy attempted_at is retained exactly'
);

select is(
  (
    select extras->'_raw_checked_at'
      from app_private.auction_sale_source_presence
     where sale_id = 'f4220000-0000-4000-8000-000000000001'
       and source_name = 'legacy-worker-v2'
  ),
  '"not-a-timestamp"'::jsonb,
  'an invalid legacy timestamp is preserved without inventing a value'
);

select lives_ok($fixture$
  insert into public.auction_sales (
    id, source_name, source_url, title, status, sale_date, raw_payload
  ) values (
    'f4220000-0000-4000-8000-000000000002',
    'compact-only',
    'https://example.test/source-presence-422/compact-only',
    'compact-only source presence',
    'upcoming',
    now() + interval '30 days',
    '{}'::jsonb
  )
$fixture$, 'a compact-only sale can be inserted without raw source state');

select lives_ok($fixture$
  insert into app_private.auction_sale_source_presence (
    sale_id, source_name, availability, state, attempted_at, extras
  ) values (
    'f4220000-0000-4000-8000-000000000002',
    'compact-worker',
    'partial',
    null,
    null,
    jsonb_build_object('audit_error', jsonb_build_object('code', 'partial'))
  )
$fixture$, 'a new compact writer can preserve extras and null timestamps');

select is(
  (
    select raw_payload
      from public.auction_sales
     where id = 'f4220000-0000-4000-8000-000000000002'
  ),
  '{}'::jsonb,
  'compact writes do not double-write raw_payload'
);

select is(
  (
    select legacy_raw
      from app_private.auction_sale_source_presence
     where sale_id = 'f4220000-0000-4000-8000-000000000002'
       and source_name = 'compact-worker'
  ),
  false,
  'compact-only rows are marked as non-legacy'
);

select is(
  (
    select app_private.auction_sale_source_presence_json(
      'f4220000-0000-4000-8000-000000000002'
    )->'compact-worker'->'audit_error'->>'code'
  ),
  'partial',
  'compact-only extras remain visible through the compatibility projection'
);

select lives_ok($fixture$
  update public.auction_sales
     set raw_payload = jsonb_build_object(
       'source_presence', jsonb_build_object(
         'legacy-worker', jsonb_build_object(
           'availability', 'available',
           'state', 'present'
         )
       )
     )
   where id = 'f4220000-0000-4000-8000-000000000002'
$fixture$, 'an old raw worker can write beside a newer compact source');

select is(
  (
    select count(*)
      from app_private.auction_sale_source_presence
     where sale_id = 'f4220000-0000-4000-8000-000000000002'
  ),
  2::bigint,
  'an old raw write does not delete an unknown compact-only source'
);

select is(
  (
    select state
      from app_private.auction_sale_source_presence
     where sale_id = 'f4220000-0000-4000-8000-000000000002'
       and source_name = 'compact-worker'
  ),
  null::text,
  'the compact-only source remains intact when its state is null'
);

select ok(
  position('app_private.auction_sale_source_presence_json(' in lower(
    pg_catalog.pg_get_viewdef('public.v_auction_sales_app'::regclass, true)
  )) > 0
  and position('app_private.auction_sale_source_presence_json(' in lower(
    pg_catalog.pg_get_viewdef('public.v_auction_sales_discovery'::regclass, true)
  )) > 0,
  'the idempotent view marker remains installed after the compatibility migration'
);

select * from finish();
rollback;
