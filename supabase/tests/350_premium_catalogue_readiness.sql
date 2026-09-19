begin;

select plan(22);

select has_column(
  'public',
  'auction_sales',
  'premium_readiness_score',
  'auction sales expose the versioned Premium readiness score'
);
select has_column(
  'public',
  'auction_sales',
  'premium_readiness_status',
  'auction sales expose a separate editorial readiness status'
);
select has_column(
  'public',
  'auction_sales',
  'premium_readiness_override',
  'auction sales retain audited editorial overrides'
);
select has_table(
  'public',
  'auction_sale_readiness_history',
  'readiness decisions have an append-only audit table'
);
select has_table(
  'public',
  'catalogue_readiness_policy',
  'catalogue enforcement has a singleton policy table'
);
select is(
  (select enforcement_enabled from public.catalogue_readiness_policy where singleton),
  false,
  'catalogue enforcement is safe-off until the corpus is fully evaluated'
);
select ok(
  has_function_privilege(
    'authenticated',
    'public.catalogue_readiness_allows_premium(text,text,timestamptz)',
    'EXECUTE'
  ),
  'authenticated Premium reads can evaluate the readiness policy'
);
select ok(
  not has_table_privilege('authenticated', 'public.auction_sale_readiness_history', 'SELECT'),
  'readiness history remains private to trusted operators'
);
select has_function(
  'public',
  'approve_information_agent_mission_admin',
  array['uuid', 'uuid', 'text'],
  'admins have a transactional mission approval path without a customer quota'
);
select ok(
  has_function_privilege(
    'service_role',
    'public.approve_information_agent_mission_admin(uuid,uuid,text)',
    'EXECUTE'
  ),
  'trusted server code can approve an admin mission'
);
select ok(
  not has_function_privilege(
    'authenticated',
    'public.approve_information_agent_mission_admin(uuid,uuid,text)',
    'EXECUTE'
  ),
  'browser clients cannot approve admin missions directly'
);

set local role service_role;

insert into public.auction_sales (
  id, source_name, source_url, status, sale_date, sale_procedure,
  premium_readiness_score, premium_readiness_status,
  premium_readiness_policy_version, premium_readiness_factors
) values (
  'f3500000-0000-4000-8000-000000000001',
  'pgtap-readiness',
  'https://example.test/pgtap/readiness',
  'upcoming',
  '2027-01-15 10:00:00+00',
  '{}'::jsonb,
  72,
  'needs_enrichment',
  'premium_readiness_v1',
  '{"sale_and_provenance":26}'::jsonb
);

select is(
  (
    select count(*)
    from public.auction_sale_readiness_history
    where sale_id = 'f3500000-0000-4000-8000-000000000001'
  ),
  1::bigint,
  'the initial readiness assessment is audited'
);

select ok(
  public.catalogue_readiness_allows_premium('needs_enrichment', null, null),
  'shadow mode leaves an incomplete Premium row visible'
);

update public.catalogue_readiness_policy set enforcement_enabled = true where singleton;

select ok(
  not public.catalogue_readiness_allows_premium('needs_enrichment', null, null),
  'enforcement hides a row below the Premium threshold'
);
select ok(
  public.catalogue_readiness_allows_premium('premium_ready', null, null),
  'enforcement admits a Premium-ready row'
);
select ok(
  public.catalogue_readiness_allows_premium('internal_only', 'publish', null),
  'an audited publish override can admit a retained row'
);
select ok(
  not public.catalogue_readiness_allows_premium('premium_ready', 'hold', null),
  'an audited hold override can retain an otherwise ready row internally'
);

update public.auction_sales
set premium_readiness_score = 78,
    premium_readiness_status = 'premium_ready',
    premium_readiness_evaluated_at = now()
where id = 'f3500000-0000-4000-8000-000000000001';

select is(
  (
    select count(*)
    from public.auction_sale_readiness_history
    where sale_id = 'f3500000-0000-4000-8000-000000000001'
  ),
  2::bigint,
  'a changed assessment appends history instead of replacing evidence'
);

insert into public.auction_sales (
  id, source_name, source_url, status, sale_procedure,
  premium_readiness_score, premium_readiness_status,
  premium_readiness_policy_version, premium_readiness_evaluated_at
) values (
  'f3500000-0000-4000-8000-000000000002',
  'pgtap-readiness',
  'https://example.test/pgtap/readiness-incomplete',
  'upcoming',
  '{}'::jsonb,
  62,
  'needs_enrichment',
  'premium_readiness_v1',
  now()
);

-- auth.users is intentionally not writable by service_role. Create the RLS
-- fixtures as the local database owner, then switch to application roles for
-- the access assertions below.
reset role;

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data
) values
  (
    'f3500000-0000-4000-8000-000000000010',
    '00000000-0000-0000-0000-000000000000',
    'authenticated', 'authenticated', 'readiness-premium@example.test', '',
    now(), now(), now(), '{}'::jsonb, '{}'::jsonb
  ),
  (
    'f3500000-0000-4000-8000-000000000011',
    '00000000-0000-0000-0000-000000000000',
    'authenticated', 'authenticated', 'readiness-discovery@example.test', '',
    now(), now(), now(), '{}'::jsonb, '{}'::jsonb
  ),
  (
    'f3500000-0000-4000-8000-000000000012',
    '00000000-0000-0000-0000-000000000000',
    'authenticated', 'authenticated', 'readiness-admin@example.test', '',
    now(), now(), now(), '{}'::jsonb, '{}'::jsonb
  );

insert into public.user_subscriptions (user_id, plan_code, status, current_period_end)
values
  ('f3500000-0000-4000-8000-000000000010', 'analyse', 'active', now() + interval '30 days'),
  ('f3500000-0000-4000-8000-000000000011', 'decouverte', 'active', null);
update public.user_profiles
set user_role = 'admin'
where user_id = 'f3500000-0000-4000-8000-000000000012';

reset role;
set local role authenticated;
set local "request.jwt.claim.role" = 'authenticated';
set local "request.jwt.claim.sub" = 'f3500000-0000-4000-8000-000000000010';
select is(
  (select count(*) from public.auction_sales where source_name = 'pgtap-readiness'),
  1::bigint,
  'an Analyse account reads only the Premium-ready row when enforcement is active'
);
set local "request.jwt.claim.sub" = 'f3500000-0000-4000-8000-000000000011';
select is(
  (select count(*) from public.auction_sales where source_name = 'pgtap-readiness'),
  0::bigint,
  'a Discovery account cannot read protected auction_sales rows'
);
select throws_ok(
  $$select public.set_auction_sale_readiness_override(
    'f3500000-0000-4000-8000-000000000002', 'publish', 'unauthorized publication'
  )$$,
  '42501',
  'Admin access required.',
  'a non-admin cannot create a readiness override'
);
set local "request.jwt.claim.sub" = 'f3500000-0000-4000-8000-000000000012';
select is(
  (select count(*) from public.auction_sales where source_name = 'pgtap-readiness'),
  2::bigint,
  'an administrator retains access to ready and incomplete rows'
);

select * from finish();
rollback;
