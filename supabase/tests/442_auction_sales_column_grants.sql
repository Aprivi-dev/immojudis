begin;

select plan(15);

select ok(
  not has_table_privilege('authenticated', 'public.auction_sales', 'select'),
  'authenticated no longer holds a table-wide SELECT grant on auction_sales'
);

select ok(
  has_column_privilege('authenticated', 'public.auction_sales', 'id', 'select')
  and has_column_privilege('authenticated', 'public.auction_sales', 'title', 'select')
  and has_column_privilege('authenticated', 'public.auction_sales', 'source_url', 'select'),
  'the columns read by the catalogue views and the app stay selectable'
);

select ok(
  not has_column_privilege('authenticated', 'public.auction_sales', 'raw_text', 'select')
  and not has_column_privilege('authenticated', 'public.auction_sales', 'content_hash', 'select')
  and not has_column_privilege('authenticated', 'public.auction_sales', 'last_run_id', 'select')
  and not has_column_privilege('authenticated', 'public.auction_sales', 'external_id', 'select')
  and not has_column_privilege('authenticated', 'public.auction_sales', 'location', 'select'),
  'internal pipeline columns are not readable through the Data API'
);

select ok(
  not has_column_privilege('authenticated', 'public.auction_sales', 'premium_readiness_status', 'select')
  and not has_column_privilege('authenticated', 'public.auction_sales', 'premium_readiness_override_reason', 'select')
  and not has_column_privilege('authenticated', 'public.auction_sales', 'retention_deadline', 'select'),
  'readiness and retention internals are not readable through the Data API'
);

select ok(
  has_column_privilege('anon', 'public.auction_sales', 'id', 'select')
  and has_column_privilege('anon', 'public.auction_sales', 'starting_price_eur', 'select')
  and not has_column_privilege('anon', 'public.auction_sales', 'raw_payload', 'select'),
  'anon keeps its narrow preview grant'
);

select ok(
  (
    select count(*) = 4
    from pg_class view_row
    where view_row.oid in (
      'public.v_auction_sales_app'::regclass,
      'public.v_auction_sales_discovery'::regclass,
      'public.v_auction_sales_discovery_search'::regclass,
      'public.v_auction_sales_unlocked'::regclass
    )
      and view_row.reloptions @> array['security_invoker=false']
      and view_row.reloptions @> array['security_barrier=true']
  ),
  'the only definer views are the guarded catalogue view, the two documented discovery projections and the unlocked-sale projection'
);

select is(
  (
    select coalesce(array_agg(view_row.relname order by view_row.relname), array[]::name[])
    from pg_class view_row
    where view_row.relnamespace = 'public'::regnamespace
      and view_row.relkind = 'v'
      and view_row.reloptions @> array['security_invoker=false']
  ),
  array[
    'v_auction_sales_app', 'v_auction_sales_discovery', 'v_auction_sales_discovery_search',
    'v_auction_sales_unlocked'
  ]::name[],
  'no other public view is SECURITY DEFINER (allowlist for the security_definer_view advisor)'
);

-- Stage 2 (20261110120000) is applied: the raw columns are hidden and the catalogue view is guarded.
select ok(
  not has_column_privilege('authenticated', 'public.auction_sales', 'raw_payload', 'select')
  and not has_column_privilege('authenticated', 'public.auction_sales', 'lawyer_contact', 'select')
  and not has_column_privilege('authenticated', 'public.auction_sales', 'observations', 'select')
  and has_column_privilege('authenticated', 'public.auction_sales', 'lawyer_name', 'select'),
  'raw_payload, lawyer_contact and observations are no longer selectable by authenticated'
);

select ok(
  (
    select view_row.reloptions @> array['security_invoker=false', 'security_barrier=true']
    from pg_class view_row
    where view_row.oid = 'public.v_auction_sales_app'::regclass
  )
  and has_table_privilege('authenticated', 'public.v_auction_sales_app', 'select')
  and not has_table_privilege('anon', 'public.v_auction_sales_app', 'select'),
  'the catalogue view is a guarded definer view and keeps its grants'
);

select ok(
  pg_get_viewdef('public.v_auction_sales_app'::regclass) ~ 'is_admin\(\)'
  and pg_get_viewdef('public.v_auction_sales_app'::regclass) ~ 'has_analysis_access\(\)'
  and pg_get_viewdef('public.v_auction_sales_app'::regclass) ~ 'catalogue_readiness_allows_premium\('
  and pg_get_viewdef('public.v_auction_sales_app'::regclass) ~ 'catalogue_quarantined'
  and pg_get_viewdef('public.v_auction_sales_app'::regclass) ~ 'rolbypassrls',
  'the catalogue view carries the predicate of the authenticated read policy and the clause of the roles that bypass row security'
);

select is(
  app_private.set_catalogue_raw_columns_hidden(true),
  'already hidden',
  'running stage 2 again changes nothing'
);

-- The revert is kept, and the hide can be played again from it.
select is(
  app_private.set_catalogue_raw_columns_hidden(false),
  'visible',
  'stage 2 can be reverted'
);

select ok(
  has_column_privilege('authenticated', 'public.auction_sales', 'raw_payload', 'select')
  and has_column_privilege('authenticated', 'public.auction_sales', 'lawyer_contact', 'select')
  and has_column_privilege('authenticated', 'public.auction_sales', 'observations', 'select')
  and (
    select view_row.reloptions @> array['security_invoker=true']
    from pg_class view_row
    where view_row.oid = 'public.v_auction_sales_app'::regclass
  ),
  'the revert restores the invoker view and the column grants'
);

select is(
  app_private.set_catalogue_raw_columns_hidden(true),
  'hidden',
  'stage 2 can be applied again after a revert'
);

select ok(
  not has_column_privilege('authenticated', 'public.auction_sales', 'raw_payload', 'select')
  and not has_column_privilege('authenticated', 'public.auction_sales', 'lawyer_contact', 'select')
  and not has_column_privilege('authenticated', 'public.auction_sales', 'observations', 'select')
  and (
    select view_row.reloptions @> array['security_invoker=false', 'security_barrier=true']
    from pg_class view_row
    where view_row.oid = 'public.v_auction_sales_app'::regclass
  ),
  'after the second hide the columns are closed and the view is guarded again'
);

select * from finish();
rollback;
