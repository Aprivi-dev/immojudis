begin;

select plan(14);

-- These rows are rolled back at the end of the test.  The fixtures exercise
-- the policy at the base table, where the anon column grant is intentionally
-- narrow, and through the public preview view.
insert into public.auction_sales (
  id,
  source_name,
  source_url,
  status,
  starting_price_eur,
  latitude,
  longitude,
  raw_payload
)
values
  (
    'c4120000-0000-4000-8000-000000000001'::uuid,
    'anon-policy-pgtap',
    'https://example.test/anon-policy-marker',
    'upcoming',
    81000,
    48.8566,
    2.3522,
    jsonb_build_object('publication_quarantine', 'operator_hold')
  ),
  (
    'c4120000-0000-4000-8000-000000000002'::uuid,
    'anon-policy-pgtap',
    'https://example.test/anon-policy-status',
    'quarantined',
    82000,
    48.8566,
    2.3522,
    '{}'::jsonb
  ),
  (
    'c4120000-0000-4000-8000-000000000003'::uuid,
    'anon-policy-pgtap',
    'https://example.test/anon-policy-visible',
    'upcoming',
    83000,
    48.8566,
    2.3522,
    '{}'::jsonb
  ),
  (
    'c4120000-0000-4000-8000-000000000004'::uuid,
    'anon-policy-pgtap',
    'https://example.test/anon-policy-no-coordinates',
    'upcoming',
    84000,
    null,
    null,
    '{}'::jsonb
  ),
  (
    'c4120000-0000-4000-8000-000000000005'::uuid,
    'anon-policy-pgtap',
    'https://example.test/anon-policy-null-payload',
    'upcoming',
    85000,
    48.8566,
    2.3522,
    null
  ),
  (
    'c4120000-0000-4000-8000-000000000006'::uuid,
    'anon-policy-pgtap',
    'https://example.test/anon-policy-json-null-marker',
    'upcoming',
    86000,
    48.8566,
    2.3522,
    '{"publication_quarantine": null}'::jsonb
  );

set local role anon;

select ok(
  has_column_privilege(
    'anon',
    'public.auction_sales',
    'id',
    'select'
  ),
  'anon retains the id column grant on auction_sales'
);

select ok(
  has_column_privilege(
    'anon',
    'public.auction_sales',
    'starting_price_eur',
    'select'
  ),
  'anon retains the starting price column grant on auction_sales'
);

select is(
  (
    select count(*)
    from public.auction_sales
    where id = 'c4120000-0000-4000-8000-000000000001'::uuid
  ),
  0::bigint,
  'anon cannot see a sale with a non-empty publication quarantine marker'
);

select is(
  (
    select count(*)
    from public.auction_sales
    where id = 'c4120000-0000-4000-8000-000000000002'::uuid
  ),
  0::bigint,
  'anon cannot see a quarantined sale through the existing status allow-list'
);

select is(
  (
    select count(*)
    from public.auction_sales
    where id = 'c4120000-0000-4000-8000-000000000004'::uuid
  ),
  0::bigint,
  'anon cannot see a sale without coordinates'
);

select is(
  (
    select count(*)
    from public.auction_sales
    where id = 'c4120000-0000-4000-8000-000000000003'::uuid
  ),
  1::bigint,
  'anon can still see an ordinary upcoming sale'
);

select is(
  (
    select starting_price_eur
    from public.auction_sales
    where id = 'c4120000-0000-4000-8000-000000000003'::uuid
  ),
  83000::numeric,
  'anon can read the explicitly granted starting price column'
);

select is(
  (
    select count(*)
    from public.auction_sales
    where id = 'c4120000-0000-4000-8000-000000000005'::uuid
  ),
  1::bigint,
  'anon treats a SQL NULL raw payload as having no publication marker'
);

select is(
  (
    select count(*)
    from public.auction_sales
    where id = 'c4120000-0000-4000-8000-000000000006'::uuid
  ),
  1::bigint,
  'anon treats a JSON null publication marker as empty'
);

select is(
  (
    select count(*)
    from public.v_auction_sales_app_preview
    where id = 'c4120000-0000-4000-8000-000000000001'::uuid
  ),
  0::bigint,
  'preview view excludes a sale with a publication quarantine marker'
);

select is(
  (
    select count(*)
    from public.v_auction_sales_app_preview
    where id = 'c4120000-0000-4000-8000-000000000002'::uuid
  ),
  0::bigint,
  'preview view excludes a quarantined sale'
);

select is(
  (
    select count(*)
    from public.v_auction_sales_app_preview
    where id = 'c4120000-0000-4000-8000-000000000003'::uuid
  ),
  1::bigint,
  'preview view retains an ordinary upcoming sale'
);

reset role;

select ok(
  exists (
    select 1
    from pg_policy
    where polrelid = 'public.auction_sales'::regclass
      and polname = 'auction_sales_public_preview_read'
      and pg_get_expr(polqual, polrelid) like '%upcoming%'
      and pg_get_expr(polqual, polrelid) like '%latitude%'
      and pg_get_expr(polqual, polrelid) like '%longitude%'
      and pg_get_expr(polqual, polrelid) like '%publication_quarantine%'
  ),
  'anon policy retains the allow-list and coordinate guards and adds the marker guard'
);

select ok(
  exists (
    select 1
    from pg_policy
    where polrelid = 'public.auction_sales'::regclass
      and polname = 'auction_sales_authenticated_read'
      and pg_get_expr(polqual, polrelid) like '%is_admin%'
      and pg_get_expr(polqual, polrelid) like '%publication_quarantine%'
  ),
  'authenticated premium policy retains its admin bypass and quarantine guard'
);

select * from finish();
rollback;
