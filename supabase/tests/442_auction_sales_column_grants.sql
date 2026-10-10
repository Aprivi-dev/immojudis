begin;

select plan(11);

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
    select count(*) = 2
    from pg_class view_row
    where view_row.oid in (
      'public.v_auction_sales_discovery'::regclass,
      'public.v_auction_sales_discovery_search'::regclass
    )
      and view_row.reloptions @> array['security_invoker=false']
      and view_row.reloptions @> array['security_barrier=true']
  ),
  'the only definer views are the two documented discovery projections'
);

select is(
  (
    select coalesce(array_agg(view_row.relname order by view_row.relname), array[]::name[])
    from pg_class view_row
    where view_row.relnamespace = 'public'::regnamespace
      and view_row.relkind = 'v'
      and view_row.reloptions @> array['security_invoker=false']
  ),
  array['v_auction_sales_discovery', 'v_auction_sales_discovery_search']::name[],
  'no other public view is SECURITY DEFINER (allowlist for the security_definer_view advisor)'
);

-- Stage 2 (opt-in): hide the raw columns, then restore.
select is(
  app_private.set_catalogue_raw_columns_hidden(true),
  'hidden',
  'stage 2 hides the raw columns'
);

select ok(
  not has_column_privilege('authenticated', 'public.auction_sales', 'raw_payload', 'select')
  and not has_column_privilege('authenticated', 'public.auction_sales', 'lawyer_contact', 'select')
  and not has_column_privilege('authenticated', 'public.auction_sales', 'observations', 'select')
  and (
    select view_row.reloptions @> array['security_invoker=false']
    from pg_class view_row
    where view_row.oid = 'public.v_auction_sales_app'::regclass
  ),
  'raw_payload, lawyer_contact and observations are no longer selectable and the view is guarded'
);

select is(
  app_private.set_catalogue_raw_columns_hidden(false),
  'visible',
  'stage 2 can be reverted'
);

select ok(
  has_column_privilege('authenticated', 'public.auction_sales', 'raw_payload', 'select')
  and (
    select view_row.reloptions @> array['security_invoker=true']
    from pg_class view_row
    where view_row.oid = 'public.v_auction_sales_app'::regclass
  ),
  'the revert restores the invoker view and the column grants'
);

select * from finish();
rollback;
