begin;

select plan(14);

select results_eq(
  $$select ordinal_position, column_name, data_type
      from information_schema.columns
     where table_schema = 'public'
       and table_name = 'v_auction_sales_app_preview'
     order by ordinal_position$$,
  $$values
      (1::integer, 'id'::text, 'uuid'::text),
      (2::integer, 'starting_price_eur'::text, 'numeric'::text),
      (3::integer, 'sale_venue_type'::text, 'text'::text),
      (4::integer, 'sale_verification_status'::text, 'text'::text)$$,
  'preview keeps its exact four-column contract'
);

insert into public.auction_sales (
  id,
  source_name,
  source_url,
  city,
  status,
  sale_date,
  latitude,
  longitude,
  starting_price_eur,
  sale_venue_type,
  sale_verification_status,
  raw_payload
)
values
  (
    'c3850000-0000-4000-8000-000000000001',
    'public-quarantine-test',
    'https://example.test/public-quarantine/visible',
    'PublicQuarantineC385',
    'upcoming',
    '2026-10-10T10:00:00Z',
    43.30,
    5.37,
    81000,
    'tribunal',
    'cross_checked',
    '{}'::jsonb
  ),
  (
    'c3850000-0000-4000-8000-000000000002',
    'public-quarantine-test',
    'https://example.test/public-quarantine/blocked',
    'PublicQuarantineC385',
    'upcoming',
    '2026-10-11T10:00:00Z',
    43.31,
    5.38,
    82000,
    'tribunal',
    'cross_checked',
    '{"publication_quarantine":"operator_hold"}'::jsonb
  ),
  (
    'c3850000-0000-4000-8000-000000000003',
    'public-quarantine-test',
    'https://example.test/public-quarantine/visible-2',
    'PublicQuarantineC385',
    'upcoming',
    '2026-10-12T10:00:00Z',
    43.32,
    5.39,
    83000,
    'tribunal',
    'cross_checked',
    '{}'::jsonb
  );

-- Exercise the authenticated policy with a real Analyse identity.  A bare
-- `set role authenticated` has no auth.uid() and would make every row vanish,
-- hiding regressions in the quarantine predicate behind an unrelated access
-- failure.
insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data
)
values (
  'c3850000-0000-4000-8000-000000000010',
  '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated', 'public-quarantine-premium@example.test', '',
  now(), now(), '{}'::jsonb, '{}'::jsonb
);
insert into public.user_subscriptions (user_id, plan_code, status, current_period_end)
values (
  'c3850000-0000-4000-8000-000000000010', 'analyse', 'active', now() + interval '30 days'
);

set local role anon;
select is(
  (select count(*) from public.v_auction_sales_app_preview
    where id in (
      'c3850000-0000-4000-8000-000000000001',
      'c3850000-0000-4000-8000-000000000002',
      'c3850000-0000-4000-8000-000000000003'
    )),
  2::bigint,
  'anonymous preview omits quarantined rows'
);
select results_eq(
  $$select id, total_count
      from public.search_auction_sales_preview_v3(
        p_city => 'PublicQuarantineC385', p_limit => 1, p_offset => 1
      )$$,
  $$values ('c3850000-0000-4000-8000-000000000003'::uuid, 2::bigint)$$,
  'anonymous v3 filters before pagination and reports the filtered total'
);
select results_eq(
  $$select id, total_count
      from public.search_auction_sales_preview_v4(
        p_city => 'PublicQuarantineC385',
        p_min_sale_date => '2026-10-01',
        p_max_sale_date => '2026-10-31',
        p_limit => 1,
        p_offset => 1
      )$$,
  $$values ('c3850000-0000-4000-8000-000000000003'::uuid, 2::bigint)$$,
  'anonymous v4 filters quarantine before date pagination and reports the filtered total'
);
select results_eq(
  $$select id, total_count
      from public.search_auction_sales_preview(
        p_city => 'PublicQuarantineC385', p_limit => 1, p_offset => 1
      )$$,
  $$values ('c3850000-0000-4000-8000-000000000003'::uuid, 2::bigint)$$,
  'anonymous v1 filters before pagination and reports the filtered total'
);
select results_eq(
  $$select id, total_count
      from public.search_auction_sales_preview_v2(
        p_city => 'PublicQuarantineC385', p_limit => 1, p_offset => 1
      )$$,
  $$values ('c3850000-0000-4000-8000-000000000003'::uuid, 2::bigint)$$,
  'anonymous v2 filters before pagination and reports the filtered total'
);
reset role;

set local role authenticated;
set local "request.jwt.claim.role" = 'authenticated';
set local "request.jwt.claim.sub" = 'c3850000-0000-4000-8000-000000000010';
select is(
  (select count(*) from public.v_auction_sales_app_preview
    where id in (
      'c3850000-0000-4000-8000-000000000001',
      'c3850000-0000-4000-8000-000000000002',
      'c3850000-0000-4000-8000-000000000003'
    )),
  2::bigint,
  'authenticated preview omits quarantined rows'
);
select results_eq(
  $$select id, total_count
      from public.search_auction_sales_preview_v3(
        p_city => 'PublicQuarantineC385', p_limit => 1, p_offset => 1
      )$$,
  $$values ('c3850000-0000-4000-8000-000000000003'::uuid, 2::bigint)$$,
  'authenticated v3 filters before pagination and reports the filtered total'
);
select is(
  (select count(*) from public.v_auction_sales_app
    where id = 'c3850000-0000-4000-8000-000000000002'),
  0::bigint,
  'authenticated fiche view omits quarantined rows'
);
select is(
  (select count(*) from public.v_auction_sales_discovery
    where id = 'c3850000-0000-4000-8000-000000000002'),
  0::bigint,
  'authenticated discovery view omits quarantined rows'
);
reset role;

select is(
  (select count(*) from public.v_auction_sales_app_preview
    where id = 'c3850000-0000-4000-8000-000000000002'),
  0::bigint,
  'service-role preview also applies the quarantine predicate'
);

select ok(
  not exists (
    select 1
    from unnest(array[
      'app_private.search_auction_sales_preview(text[],text,text,text,text[],text[],numeric,numeric,numeric,numeric,integer,integer,text,numeric,text[],double precision,double precision,double precision,double precision,text,integer,integer)',
      'app_private.search_auction_sales_preview_v2(text[],text,text,text,text[],text[],numeric,numeric,numeric,numeric,integer,integer,text,numeric,text[],double precision,double precision,double precision,double precision,text,integer,integer,text)',
      'app_private.search_auction_sales_preview_v3(text[],text,text,text,text[],text[],numeric,numeric,numeric,numeric,integer,integer,text,numeric,text[],double precision,double precision,double precision,double precision,text,integer,integer,text)'
    ]::text[]) as signature
    where position(
      'publication_quarantine' in
      pg_catalog.pg_get_functiondef(signature::regprocedure)
    ) = 0
  ),
  'v1, v2 and v3 definitions retain the quarantine predicate after migration'
);

select ok(
  position(
    'publication_quarantine' in
    pg_catalog.pg_get_functiondef(
      'app_private.search_auction_sales_preview_v4(text[],text,text,text,text[],text[],numeric,numeric,numeric,numeric,integer,integer,text,numeric,text[],double precision,double precision,double precision,double precision,text,integer,integer,text,date,date)'::regprocedure
    )
  ) > 0,
  'v4 definition retains the quarantine predicate used by date-filtered public cards'
);

select ok(
  exists (
    select 1
    from pg_catalog.pg_policy policy
    where policy.polrelid = 'public.auction_sales'::regclass
      and policy.polname = 'auction_sales_authenticated_read'
      and pg_catalog.pg_get_expr(policy.polqual, policy.polrelid) like '%publication_quarantine%'
      and pg_catalog.pg_get_expr(policy.polqual, policy.polrelid) like '%is_admin%'
  ),
  'authenticated base-sale policy keeps the quarantine gate while preserving admin access'
);

select * from finish();

rollback;
