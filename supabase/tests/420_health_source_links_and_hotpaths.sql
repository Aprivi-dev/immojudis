begin;

select plan(19);

select has_table(
  'app_private',
  'auction_sale_source_check_links',
  'the normalized source-check link table exists'
);

select ok(
  (
    select relrowsecurity
      from pg_catalog.pg_class
     where oid = 'app_private.auction_sale_source_check_links'::regclass
  ),
  'the normalized link table keeps row-level security enabled'
);

select ok(
  has_table_privilege(
    'service_role',
    'app_private.auction_sale_source_check_links',
    'SELECT'
  )
  and not has_table_privilege(
    'anon',
    'app_private.auction_sale_source_check_links',
    'SELECT'
  )
  and not has_table_privilege(
    'authenticated',
    'app_private.auction_sale_source_check_links',
    'SELECT'
  ),
  'the normalized link table is readable only by the service role'
);

select ok(
  exists (
    select 1
      from pg_catalog.pg_indexes
     where schemaname = 'app_private'
       and tablename = 'auction_sale_source_check_links'
       and indexname = 'auction_sale_source_check_links_pkey'
  )
  and exists (
    select 1
      from pg_catalog.pg_indexes
     where schemaname = 'app_private'
       and tablename = 'auction_sale_source_check_links'
       and indexname = 'auction_sale_source_check_links_sale_source_idx'
  ),
  'the normalized link table has its identity and observer lookup indexes'
);

select ok(
  exists (
    select 1
      from pg_catalog.pg_trigger trigger_row
     where trigger_row.tgrelid = 'public.auction_sales'::regclass
       and trigger_row.tgname = 'auction_sales_sync_source_checks'
       and not trigger_row.tgisinternal
  )
  and position(
    'auction_sale_source_check_links'
    in pg_catalog.pg_get_functiondef(
      'app_private.sync_auction_sale_source_checks()'::regprocedure
    )
  ) > 0,
  'the source-check trigger keeps the normalized aliases in sync'
);

select ok(
  (
    select procedure_row.prosecdef
       and procedure_row.proconfig @> array['search_path=""']::text[]
       and has_function_privilege(
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
      from pg_catalog.pg_proc procedure_row
     where procedure_row.oid =
       'public.auction_all_source_freshness(timestamptz)'::regprocedure
  ),
  'freshness keeps its SECURITY DEFINER service-only boundary'
);

select ok(
  position(
    'auction_sale_source_check_links'
    in pg_catalog.pg_get_functiondef(
      'public.auction_all_source_freshness(timestamptz)'::regprocedure
    )
  ) > 0
  and position(
    'auction_observations'
    in pg_catalog.pg_get_functiondef(
      'public.auction_all_source_freshness(timestamptz)'::regprocedure
    )
  ) > 0
  and position(
    'jsonb_each'
    in pg_catalog.pg_get_functiondef(
      'public.auction_all_source_freshness(timestamptz)'::regprocedure
    )
  ) = 0,
  'freshness reads normalized aliases without expanding source-check JSON'
);

select ok(
  position(
    'due_candidates as materialized'
    in lower(pg_catalog.pg_get_functiondef(
      'public.observe_autonomous_pipeline(timestamptz)'::regprocedure
    ))
  ) > 0
  and position(
    'revision_ranked as materialized'
    in lower(pg_catalog.pg_get_functiondef(
      'public.observe_autonomous_pipeline(timestamptz)'::regprocedure
    ))
  ) > 0
  and position(
    'select distinct source_url'
    in lower(pg_catalog.pg_get_functiondef(
      'public.observe_autonomous_pipeline(timestamptz)'::regprocedure
    ))
  ) > 0
  and position(
    'revision.revision_rank = 1'
    in lower(pg_catalog.pg_get_functiondef(
      'public.observe_autonomous_pipeline(timestamptz)'::regprocedure
    ))
  ) > 0,
  'the observer ranks only groups represented by due candidates'
);

select ok(
  has_function_privilege(
    'service_role',
    'app_private.catalogue_bridge_court_is_reconcilable(uuid,uuid)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'anon',
    'app_private.catalogue_bridge_court_is_reconcilable(uuid,uuid)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'app_private.catalogue_bridge_court_is_reconcilable(uuid,uuid)',
    'EXECUTE'
  ),
  'the private reconciliation helper is no longer executable by PUBLIC roles'
);

select ok(
  exists (
    select 1
      from pg_catalog.pg_proc procedure_row
     where procedure_row.oid =
       'app_private.catalogue_bridge_court_is_reconcilable(uuid,uuid)'::regprocedure
       and procedure_row.prosecdef
       and procedure_row.proconfig @> array['search_path=""']::text[]
  ),
  'the private reconciliation helper keeps its definer and empty search path'
);

select ok(
  has_table_privilege(
    'service_role',
    'app_private.concurrent_index_operations',
    'SELECT'
  )
  and not has_table_privilege(
    'anon',
    'app_private.concurrent_index_operations',
    'SELECT'
  )
  and (
    select relrowsecurity
      from pg_catalog.pg_class
     where oid = 'app_private.concurrent_index_operations'::regclass
  ),
  'large index builds are registered in a private RLS-protected operation table'
);

select is(
  (
    select count(*)
      from app_private.concurrent_index_operations
     where operation_key like '20261008102334:%'
  ),
  4::bigint,
  'all four hot-path indexes have explicit deferred operations'
);

select ok(
  not exists (
    select 1
      from app_private.concurrent_index_operations
     where operation_key like '20261008102334:%'
       and lower(create_sql) not like 'create index concurrently%'
  )
  and not exists (
    select 1
      from app_private.concurrent_index_operations
     where operation_key like '20261008102334:%'
       and status not in ('pending', 'applied')
  ),
  'hot-path operations are allowlisted and never silently left failed'
);

select ok(
  not exists (
    select 1
      from app_private.concurrent_index_operations
     where operation_key like '20261008102334:%'
       and (
         schema_name <> 'public'
         or table_name not in ('auction_sales', 'auction_collection_items')
         or index_name not like '%_idx'
       )
  ),
  'hot-path operations target only the reviewed public tables and index names'
);

select ok(
  not exists (
    select 1
      from app_private.concurrent_index_operations operation_row
     where operation_key like '20261008102334:%'
       and status = 'applied'
       and not exists (
         select 1
           from pg_catalog.pg_class relation_row
           join pg_catalog.pg_namespace namespace_row
             on namespace_row.oid = relation_row.relnamespace
           join pg_catalog.pg_index index_row
             on index_row.indexrelid = relation_row.oid
          where namespace_row.nspname = operation_row.schema_name
            and relation_row.relname = operation_row.index_name
            and index_row.indisvalid
       )
  ),
  'applied hot-path operations have valid catalog indexes'
);

select ok(
  not exists (
    select 1
      from app_private.auction_sale_source_check_links
     group by sale_id, checked_url, source_name
    having count(*) > 1
  ),
  'the normalized link table keeps one row per sale, URL and source'
);

select is(
  (
    select count(*)
      from pg_catalog.pg_policies
     where schemaname = 'app_private'
       and tablename = 'auction_sale_source_check_links'
       and policyname = 'auction_sale_source_check_links_service_role'
  ),
  1::bigint,
  'the normalized link table has one explicit service-role policy'
);

select ok(
  (
    select position(
      'older_than_24h'
      in pg_catalog.pg_get_functiondef(
        'public.observe_autonomous_pipeline(timestamptz)'::regprocedure
      )
    ) > 0
  ),
  'the observer retains the operational age evidence contract'
);

select ok(
  (
    select position(
      'claimable_due'
      in pg_catalog.pg_get_functiondef(
        'public.observe_autonomous_pipeline(timestamptz)'::regprocedure
      )
    ) > 0
    and position(
      'excluded_due'
      in pg_catalog.pg_get_functiondef(
        'public.observe_autonomous_pipeline(timestamptz)'::regprocedure
      )
    ) > 0
  ),
  'the observer retains the due/excluded queue metrics contract'
);

select * from finish();
rollback;
