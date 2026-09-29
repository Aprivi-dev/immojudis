begin;

select plan(25);

select has_table(
  'app_private',
  'auction_sale_source_checks',
  'source checks have a compact private projection'
);

select ok(
  (select relrowsecurity
     from pg_class
    where oid = 'app_private.auction_sale_source_checks'::regclass)
  and has_table_privilege(
    'service_role',
    'app_private.auction_sale_source_checks',
    'SELECT'
  )
  and not has_table_privilege(
    'service_role',
    'app_private.auction_sale_source_checks',
    'INSERT'
  )
  and not has_table_privilege(
    'service_role',
    'app_private.auction_sale_source_checks',
    'UPDATE'
  )
  and not has_table_privilege(
    'service_role',
    'app_private.auction_sale_source_checks',
    'DELETE'
  )
  and not has_table_privilege(
    'anon',
    'app_private.auction_sale_source_checks',
    'SELECT'
  )
  and not has_table_privilege(
    'authenticated',
    'app_private.auction_sale_source_checks',
    'SELECT'
  ),
  'the source checks cache is RLS-protected and readable only by the service role'
);

select col_is_fk(
  'app_private',
  'auction_sale_source_checks',
  'sale_id',
  'source checks retain their sale with a cascading foreign key'
);

select ok(
  exists (
    select 1
      from pg_constraint constraint_row
     where constraint_row.conrelid =
       'app_private.auction_sale_source_checks'::regclass
       and constraint_row.contype = 'f'
       and position(
         'ON DELETE CASCADE' in upper(pg_get_constraintdef(constraint_row.oid))
       ) > 0
  )
  and exists (
    select 1
      from pg_constraint constraint_row
     where constraint_row.conrelid =
       'app_private.auction_sale_source_checks'::regclass
       and constraint_row.contype = 'c'
       and position(
         'jsonb_typeof(checks)' in lower(pg_get_constraintdef(constraint_row.oid))
       ) > 0
  ),
  'the cache rejects non-object checks and cascades sale deletion'
);

select ok(
  exists (
    select 1
      from pg_trigger trigger_row
     where trigger_row.tgrelid = 'public.auction_sales'::regclass
       and trigger_row.tgname = 'auction_sales_sync_source_checks'
       and not trigger_row.tgisinternal
  ),
  'sale insert/update/delete writes are synchronized into the cache'
);

select ok(
  position('security definer' in lower(pg_get_functiondef(
    'app_private.sync_auction_sale_source_checks()'::regprocedure
  ))) > 0
  and position('set search_path to ''' in lower(pg_get_functiondef(
    'app_private.sync_auction_sale_source_checks()'::regprocedure
  ))) > 0,
  'the cache trigger is a locked-down SECURITY DEFINER function'
);

select ok(
  has_function_privilege(
    'service_role',
    'public.auction_all_source_freshness(timestamptz)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'anon',
    'public.auction_all_source_freshness(timestamptz)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.auction_all_source_freshness(timestamptz)',
    'EXECUTE'
  )
  and position('security definer' in lower(pg_get_functiondef(
    'public.auction_all_source_freshness(timestamptz)'::regprocedure
  ))) > 0
  and position('set search_path to ''' in lower(pg_get_functiondef(
    'public.auction_all_source_freshness(timestamptz)'::regprocedure
  ))) > 0,
  'only the service role can execute the freshness aggregate'
);

select ok(
  has_function_privilege(
    'service_role',
    'app_private.assert_auction_sale_source_checks_complete()',
    'EXECUTE'
  )
  and not has_function_privilege(
    'anon',
    'app_private.assert_auction_sale_source_checks_complete()',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'app_private.assert_auction_sale_source_checks_complete()',
    'EXECUTE'
  ),
  'the projection completeness guard is service-only'
);

select ok(
  position(
    'join app_private.auction_sale_source_checks cache'
    in lower(pg_get_functiondef(
      'public.enqueue_due_source_details_unlocked(timestamptz,integer)'::regprocedure
    ))
  ) > 0
  and position(
    'on cache.sale_id = s.id'
    in lower(pg_get_functiondef(
      'public.enqueue_due_source_details_unlocked(timestamptz,integer)'::regprocedure
    ))
  ) > 0
  and position(
    's.raw_payload->''source_checks'''
    in lower(pg_get_functiondef(
      'public.enqueue_due_source_details_unlocked(timestamptz,integer)'::regprocedure
    ))
  ) = 0,
  'source-detail admission reads the compact checks cache without detoasting raw_payload'
);

select ok(
  not exists (
    select 1
      from information_schema.columns
     where table_schema = 'app_private'
       and table_name = 'auction_sale_source_checks'
       and column_name in ('raw_payload', 'observations')
  ),
  'the cache stores no wide sale payloads'
);

set local role service_role;

select ok(
  not exists (
    select 1
      from public.auction_sales sale
      full join app_private.auction_sale_source_checks cache
        on cache.sale_id = sale.id
     where sale.id is null
        or cache.sale_id is null
        or cache.source_url is distinct from sale.source_url
        or cache.source_name is distinct from sale.source_name
        or cache.sale_date is distinct from sale.sale_date
        or cache.status is distinct from sale.status
        or cache.checks is distinct from case
          when pg_catalog.jsonb_typeof(sale.raw_payload->'source_checks') = 'object'
            then sale.raw_payload->'source_checks'
          else '{}'::jsonb
        end
  ),
  'the migration backfill matches every existing sale without updating auction_sales'
);

create temporary table pgtap_source_checks_403_context (
  p_now timestamptz not null,
  canonical_id uuid not null,
  invalid_id uuid not null,
  canonical_url text not null,
  observed_url text not null,
  json_alias_url text not null,
  unread_url text not null,
  invalid_url text not null,
  future_url text not null
) on commit drop;

insert into pgtap_source_checks_403_context (
  p_now,
  canonical_id,
  invalid_id,
  canonical_url,
  observed_url,
  json_alias_url,
  unread_url,
  invalid_url,
  future_url
)
values (
  '2026-09-29 12:00:00+00',
  'f4030000-0000-4000-8000-000000000001',
  'f4030000-0000-4000-8000-000000000002',
  'https://example.test/source-checks-403/canonical',
  'https://example.test/source-checks-403/observed',
  'https://example.test/source-checks-403/json-alias',
  'https://example.test/source-checks-403/unread',
  'https://example.test/source-checks-403/malformed',
  'https://example.test/source-checks-403/future'
);

insert into public.auction_sales (
  id,
  source_name,
  source_url,
  status,
  sale_date,
  raw_payload
)
select
  context.canonical_id,
  'pgtap-source-checks-403',
  context.canonical_url,
  'upcoming',
  context.p_now + interval '2 days',
  jsonb_build_object(
    'source_checks',
    jsonb_build_object(
      context.canonical_url,
      jsonb_build_object(
        'source_name', 'pgtap-source-checks-403',
        'checked_at', context.p_now - interval '1 hour'
      ),
      context.observed_url,
      jsonb_build_object(
        'source_name', 'pgtap-source-checks-403-observed',
        'checked_at', context.p_now - interval '2 hours'
      ),
      context.json_alias_url,
      jsonb_build_object(
        'source_name', 'pgtap-source-checks-403-json',
        'checked_at', context.p_now - interval '3 hours'
      ),
      context.invalid_url,
      jsonb_build_object(
        'source_name', 'pgtap-source-checks-403-invalid',
        'checked_at', 'not-a-timestamp'
      ),
      context.future_url,
      jsonb_build_object(
        'source_name', 'pgtap-source-checks-403-future',
        'checked_at', context.p_now + interval '1 hour'
      )
    )
  )
from pgtap_source_checks_403_context context;

insert into public.auction_sales (
  id,
  source_name,
  source_url,
  status,
  sale_date,
  raw_payload
)
select
  context.invalid_id,
  'pgtap-source-checks-403-invalid-shape',
  context.invalid_url,
  'upcoming',
  context.p_now + interval '2 days',
  jsonb_build_object('source_checks', 'not-an-object')
from pgtap_source_checks_403_context context;

insert into public.auction_observations (
  source_url,
  source_name,
  canonical_source_url,
  observed_at
)
select context.observed_url,
       'pgtap-source-checks-403-observed',
       context.canonical_url,
       context.p_now - interval '1 hour'
  from pgtap_source_checks_403_context context
union all
select context.json_alias_url,
       'pgtap-source-checks-403-json',
       context.canonical_url,
       context.p_now - interval '1 hour'
  from pgtap_source_checks_403_context context
union all
select context.unread_url,
       'pgtap-source-checks-403-unread',
       context.canonical_url,
       context.p_now - interval '1 hour'
  from pgtap_source_checks_403_context context;

select ok(
  exists (
    select 1
      from app_private.auction_sale_source_checks cache
      join pgtap_source_checks_403_context context
        on context.canonical_id = cache.sale_id
     where cache.source_url = context.canonical_url
       and cache.source_name = 'pgtap-source-checks-403'
       and cache.sale_date = context.p_now + interval '2 days'
       and cache.status = 'upcoming'
       and cache.checks->context.canonical_url->>'source_name' =
         'pgtap-source-checks-403'
  ),
  'an inserted sale is materialized with its canonical metadata and checks'
);

select is(
  (
    select cache.checks
      from app_private.auction_sale_source_checks cache
      join pgtap_source_checks_403_context context
        on context.invalid_id = cache.sale_id
  ),
  '{}'::jsonb,
  'a non-object source_checks payload is normalized to an empty object'
);

select is(
  coalesce(
    (
      select freshness.active_listings
        from public.auction_all_source_freshness(
          (select p_now from pgtap_source_checks_403_context)
        ) freshness
       where freshness.source_name = 'pgtap-source-checks-403'
    ),
    0::bigint
  ),
  1::bigint,
  'the canonical branch contributes one active listing'
);

select is(
  coalesce(
    (
      select freshness.fresh_listings
        from public.auction_all_source_freshness(
          (select p_now from pgtap_source_checks_403_context)
        ) freshness
       where freshness.source_name = 'pgtap-source-checks-403'
    ),
    0::bigint
  ),
  1::bigint,
  'the canonical checked_at remains fresh under the six-hour future cadence'
);

select is(
  (
    select freshness.active_listings
      from public.auction_all_source_freshness(
        (select p_now from pgtap_source_checks_403_context)
      ) freshness
     where freshness.source_name = 'pgtap-source-checks-403-observed'
  ),
  1::bigint,
  'the normalized observation alias contributes once'
);

select is(
  (
    select freshness.fresh_listings
      from public.auction_all_source_freshness(
        (select p_now from pgtap_source_checks_403_context)
      ) freshness
     where freshness.source_name = 'pgtap-source-checks-403-json'
  ),
  1::bigint,
  'the JSON alias and duplicate normalized observation are deduplicated'
);

select is(
  (
    select freshness.fresh_listings
      from public.auction_all_source_freshness(
        (select p_now from pgtap_source_checks_403_context)
      ) freshness
     where freshness.source_name = 'pgtap-source-checks-403-unread'
  ),
  0::bigint,
  'an observation without a source check remains in the denominator but is stale'
);

select is(
  (
    select freshness.fresh_listings
      from public.auction_all_source_freshness(
        (select p_now from pgtap_source_checks_403_context)
      ) freshness
     where freshness.source_name = 'pgtap-source-checks-403-invalid'
  ),
  0::bigint,
  'a malformed checked_at is safely treated as stale'
);

select is(
  (
    select freshness.fresh_listings
      from public.auction_all_source_freshness(
        (select p_now from pgtap_source_checks_403_context)
      ) freshness
     where freshness.source_name = 'pgtap-source-checks-403-future'
  ),
  0::bigint,
  'a future checked_at is excluded from the fresh count'
);

update public.auction_sales sale
   set sale_date = context.p_now - interval '2 days',
       status = 'unknown',
       raw_payload = jsonb_build_object(
         'source_checks',
         jsonb_build_object(
           context.canonical_url,
           jsonb_build_object(
             'source_name', 'pgtap-source-checks-403',
             'checked_at', context.p_now - interval '30 hours'
           ),
           context.observed_url,
           jsonb_build_object(
             'source_name', 'pgtap-source-checks-403-observed',
             'checked_at', context.p_now - interval '2 hours'
           ),
           context.json_alias_url,
           jsonb_build_object(
             'source_name', 'pgtap-source-checks-403-json',
             'checked_at', context.p_now - interval '3 hours'
           ),
           context.invalid_url,
           jsonb_build_object(
             'source_name', 'pgtap-source-checks-403-invalid',
             'checked_at', 'not-a-timestamp'
           ),
           context.future_url,
           jsonb_build_object(
             'source_name', 'pgtap-source-checks-403-future',
             'checked_at', context.p_now + interval '1 hour'
           )
         )
       )
  from pgtap_source_checks_403_context context
 where sale.id = context.canonical_id;

select ok(
  exists (
    select 1
      from app_private.auction_sale_source_checks cache
      join pgtap_source_checks_403_context context
        on context.canonical_id = cache.sale_id
     where cache.status = 'unknown'
       and cache.sale_date = context.p_now - interval '2 days'
       and (
         cache.checks->context.canonical_url->>'checked_at'
       )::timestamptz = context.p_now - interval '30 hours'
  ),
  'an update of sale metadata and raw_payload refreshes the compact projection'
);

select is(
  (
    select freshness.fresh_listings
      from public.auction_all_source_freshness(
        (select p_now from pgtap_source_checks_403_context)
      ) freshness
     where freshness.source_name = 'pgtap-source-checks-403'
  ),
  0::bigint,
  'the updated canonical check uses the past-sale 24-hour cadence'
);

set local role postgres;
delete from app_private.auction_sale_source_checks cache
 using pgtap_source_checks_403_context context
 where cache.sale_id = context.canonical_id;
set local role service_role;

select throws_ok(
  $$select public.auction_all_source_freshness(
      (select p_now from pgtap_source_checks_403_context)
    )$$,
  '55000',
  'Source-checks projection is incomplete',
  'freshness fails closed when an active sale has no cache row'
);

update public.auction_pipeline_control
   set enabled = true,
       source_details_enabled = true
 where id;

select throws_ok(
  $$select public.enqueue_due_source_details_unlocked(now(), 20)$$,
  '55000',
  'Source-checks projection is incomplete',
  'source-detail admission fails closed when an active sale has no cache row'
);

delete from public.auction_sales sale
 using pgtap_source_checks_403_context context
 where sale.id in (context.canonical_id, context.invalid_id);

select is(
  (
    select count(*)
      from app_private.auction_sale_source_checks cache
     where cache.sale_id in (
       select canonical_id from pgtap_source_checks_403_context
       union all
       select invalid_id from pgtap_source_checks_403_context
     )
  ),
  0::bigint,
  'deleting sales removes their compact rows through the trigger and FK cascade'
);

select * from finish();
rollback;
