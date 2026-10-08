begin;

select plan(31);

select has_table(
  'app_private',
  'auction_sale_source_presence',
  'the compact source-presence table exists'
);

select ok(
  (
    select relrowsecurity
      from pg_catalog.pg_class
     where oid = 'app_private.auction_sale_source_presence'::regclass
  ),
  'the compact source-presence table keeps row-level security enabled'
);

select ok(
  has_table_privilege(
    'service_role',
    'app_private.auction_sale_source_presence',
    'SELECT'
  )
  and has_table_privilege(
    'service_role',
    'app_private.auction_sale_source_presence',
    'INSERT'
  )
  and has_table_privilege(
    'service_role',
    'app_private.auction_sale_source_presence',
    'UPDATE'
  )
  and not has_table_privilege(
    'anon',
    'app_private.auction_sale_source_presence',
    'SELECT'
  )
  and not has_table_privilege(
    'authenticated',
    'app_private.auction_sale_source_presence',
    'SELECT'
  ),
  'the compact table is writable only by the service role'
);

select ok(
  exists (
    select 1
      from pg_catalog.pg_indexes
     where schemaname = 'app_private'
       and tablename = 'auction_sale_source_presence'
       and indexname = 'auction_sale_source_presence_pkey'
  )
  and exists (
    select 1
      from pg_catalog.pg_indexes
     where schemaname = 'app_private'
       and tablename = 'auction_sale_source_presence'
       and indexname = 'auction_sale_source_presence_source_idx'
  ),
  'the compact table has identity and source lookup indexes'
);

select ok(
  exists (
    select 1
      from pg_catalog.pg_class relation_row
      join pg_catalog.pg_namespace schema_row
        on schema_row.oid = relation_row.relnamespace
     where schema_row.nspname = 'public'
       and relation_row.relname = 'auction_sale_source_presence'
       and relation_row.relkind = 'v'
  ),
  'the service-role compatibility view exists'
);

select ok(
  has_table_privilege(
    'service_role',
    'public.auction_sale_source_presence',
    'SELECT'
  )
  and not has_table_privilege(
    'anon',
    'public.auction_sale_source_presence',
    'SELECT'
  )
  and not has_table_privilege(
    'authenticated',
    'public.auction_sale_source_presence',
    'SELECT'
  ),
  'the compatibility view is not a Data API surface'
);

select is(
  (
    select count(*)
      from pg_catalog.pg_policies
     where schemaname = 'app_private'
       and tablename = 'auction_sale_source_presence'
       and policyname = 'auction_sale_source_presence_service_role'
  ),
  1::bigint,
  'the compact table has one explicit service-role policy'
);

select ok(
  exists (
    select 1
      from pg_catalog.pg_constraint constraint_row
     where constraint_row.conrelid =
       'app_private.auction_sale_source_presence'::regclass
       and constraint_row.contype = 'c'
       and pg_catalog.pg_get_constraintdef(constraint_row.oid)
         ilike '%availability%'
  ),
  'source presence availability stays within the operational state enum'
);

select ok(
  position(
    'app_private.auction_sale_source_presence'
    in pg_catalog.pg_get_viewdef(
      'public.auction_sale_source_presence'::regclass,
      true
    )
  ) > 0,
  'the compatibility view points only at the private projection'
);

select ok(
  exists (
    select 1
      from pg_catalog.pg_attribute attribute_row
     where attribute_row.attrelid =
       'app_private.auction_sale_source_presence'::regclass
       and attribute_row.attname = 'run_id'
       and attribute_row.atttypid = 'text'::regtype
  ),
  'run provenance is retained without forcing legacy JSON values through a UUID cast'
);

select ok(
  (
    select procedure_row.prosecdef
       and procedure_row.proconfig @> array['search_path=""']::text[]
      from pg_catalog.pg_proc procedure_row
     where procedure_row.oid =
       'app_private.auction_sale_source_presence_json(uuid)'::regprocedure
  )
  and position(
    'jsonb_strip_nulls'
    in lower(pg_catalog.pg_get_functiondef(
      'app_private.auction_sale_source_presence_json(uuid)'::regprocedure
    ))
  ) > 0,
  'the caller-safe projection is a locked-down SECURITY DEFINER function'
);

select ok(
  has_function_privilege(
    'authenticated',
    'app_private.auction_sale_source_presence_json(uuid)',
    'EXECUTE'
  )
  and has_function_privilege(
    'service_role',
    'app_private.auction_sale_source_presence_json(uuid)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'anon',
    'app_private.auction_sale_source_presence_json(uuid)',
    'EXECUTE'
  )
  and (
    not exists (
      select 1 from pg_catalog.pg_roles where rolname = 'lovable_readonly'
    )
    or has_function_privilege(
      'lovable_readonly',
      'app_private.auction_sale_source_presence_json(uuid)',
      'EXECUTE'
    )
  ),
  'the compact projection function preserves the catalogue role boundary'
);

select ok(
  position(
    'app_private.auction_sale_source_presence_json'
    in pg_catalog.pg_get_viewdef(
      'public.v_auction_sales_app'::regclass,
      true
    )
  ) > 0
  and position(
    'raw_payload -> ''source_presence'''
    in lower(pg_catalog.pg_get_viewdef(
      'public.v_auction_sales_app'::regclass,
      true
    ))
  ) = 0
  and position(
    'app_private.auction_sale_source_presence_json'
    in pg_catalog.pg_get_viewdef(
      'public.v_auction_sales_discovery'::regclass,
      true
    )
  ) > 0
  and position(
    'raw_payload -> ''source_presence'''
    in lower(pg_catalog.pg_get_viewdef(
      'public.v_auction_sales_discovery'::regclass,
      true
    ))
  ) = 0,
  'detail and discovery views read the compact projection instead of raw JSON'
);

select ok(
  position(
    'raw_payload -> ''source_presence'''
    in lower(pg_catalog.pg_get_viewdef(
      'public.v_auction_sales_app_search'::regclass,
      true
    ))
  ) = 0
  and position(
    'raw_payload -> ''source_presence'''
    in lower(pg_catalog.pg_get_viewdef(
      'public.v_auction_sales_discovery_search'::regclass,
      true
    ))
  ) = 0,
  'search projections inherit the compact source-presence column'
);

select ok(
  (
    select reloptions @> array['security_invoker=true']::text[]
      from pg_catalog.pg_class
     where oid = 'public.v_auction_sales_app'::regclass
  )
  and (
    select reloptions @> array['security_invoker=false','security_barrier=true']::text[]
      from pg_catalog.pg_class
     where oid = 'public.v_auction_sales_discovery'::regclass
  ),
  'the view security options remain unchanged'
);

select ok(
  has_table_privilege('authenticated', 'public.v_auction_sales_app', 'SELECT')
  and has_table_privilege('authenticated', 'public.v_auction_sales_discovery', 'SELECT')
  and not has_table_privilege('anon', 'public.v_auction_sales_app', 'SELECT')
  and not has_table_privilege('anon', 'public.v_auction_sales_discovery', 'SELECT'),
  'the existing authenticated-only catalogue visibility grants remain intact'
);

create temporary table pgtap_source_presence_421_context (
  case_name text primary key,
  sale_id uuid not null,
  source_name text not null
) on commit drop;

insert into pgtap_source_presence_421_context (case_name, sale_id, source_name)
values
  ('present', 'f4210000-0000-4000-8000-000000000001', 'pgtap-presence-present'),
  ('absent', 'f4210000-0000-4000-8000-000000000002', 'pgtap-presence-absent'),
  ('outage', 'f4210000-0000-4000-8000-000000000003', 'pgtap-presence-outage'),
  ('current', 'f4210000-0000-4000-8000-000000000004', 'pgtap-presence-current'),
  ('empty', 'f4210000-0000-4000-8000-000000000005', 'pgtap-presence-empty');

select lives_ok($fixture$
  insert into public.auction_sales (
    id, source_name, source_url, title, status, sale_date, raw_payload
  )
  select context.sale_id,
         context.source_name,
         'https://example.test/source-presence-421/' || context.case_name,
         'pgtap source presence ' || context.case_name,
         'upcoming',
         now() + interval '30 days',
         jsonb_build_object(
           'source_presence',
           case
             when context.case_name = 'empty' then '{}'::jsonb
             else jsonb_build_object(
               context.source_name,
               jsonb_build_object(
                 'availability', 'legacy-only',
                 'state', 'legacy'
               )
             )
           end
         )
    from pgtap_source_presence_421_context context
$fixture$, 'the source-presence view fixture sales can be inserted');

select lives_ok($fixture$
  insert into app_private.auction_sale_source_presence (
    sale_id, source_name, availability, state,
    attempted_at, checked_at, run_id
  )
  select context.sale_id,
         context.source_name,
         case context.case_name
           when 'outage' then 'unavailable'
           else 'available'
         end,
         case context.case_name
           when 'absent' then 'absent'
           when 'outage' then null
           else 'present'
         end,
         now(),
         case when context.case_name = 'outage' then null else now() end,
         'pgtap-run-421-' || context.case_name
    from pgtap_source_presence_421_context context
   where context.case_name <> 'empty'
  on conflict (sale_id, source_name) do update
    set availability = excluded.availability,
        state = excluded.state,
        attempted_at = excluded.attempted_at,
        checked_at = excluded.checked_at,
        run_id = excluded.run_id
$fixture$, 'the compact fixture records present absent outage and current states');

select is(
  (
    select app_private.auction_sale_source_presence_json(
      context.sale_id
    )->context.source_name->>'state'
      from pgtap_source_presence_421_context context
     where context.case_name = 'present'
  ),
  'present',
  'a present complete inventory is exposed as present'
);

select is(
  (
    select app_private.auction_sale_source_presence_json(
      context.sale_id
    )->context.source_name->>'state'
      from pgtap_source_presence_421_context context
     where context.case_name = 'absent'
  ),
  'absent',
  'a complete inventory with no matching item is exposed as absent'
);

select ok(
  (
    select not (
      app_private.auction_sale_source_presence_json(context.sale_id)
        ->context.source_name
        ? 'state'
    )
      and app_private.auction_sale_source_presence_json(context.sale_id)
        ->context.source_name->>'availability' = 'unavailable'
      and not (
        app_private.auction_sale_source_presence_json(context.sale_id)
          ->context.source_name
          ? 'checked_at'
      )
      from pgtap_source_presence_421_context context
     where context.case_name = 'outage'
  ),
  'an outage omits completion fields while retaining unavailable state'
);

select ok(
  (
    select (
      app_private.auction_sale_source_presence_json(context.sale_id)
        ->context.source_name->>'state' = 'present'
      and app_private.auction_sale_source_presence_json(context.sale_id)
        ->context.source_name->>'run_id' = 'pgtap-run-421-current'
      and app_private.auction_sale_source_presence_json(context.sale_id)
        ->context.source_name ? 'checked_at'
    )
      from pgtap_source_presence_421_context context
     where context.case_name = 'current'
  ),
  'the current complete observation retains checked_at and run provenance'
);

select is(
  (
    select app_private.auction_sale_source_presence_json(context.sale_id)
      from pgtap_source_presence_421_context context
     where context.case_name = 'empty'
  ),
  '{}'::jsonb,
  'a sale without compact state does not fall back to legacy raw JSON'
);

select is(
  (
    select source_presence->context.source_name->>'state'
      from public.v_auction_sales_app view_row
      join pgtap_source_presence_421_context context
        on context.sale_id = view_row.id
     where context.case_name = 'present'
  ),
  'present',
  'the detail view exposes the compact present state'
);

select is(
  (
    select source_presence->context.source_name->>'state'
      from public.v_auction_sales_app view_row
      join pgtap_source_presence_421_context context
        on context.sale_id = view_row.id
     where context.case_name = 'absent'
  ),
  'absent',
  'the detail view exposes the compact absent state'
);

select is(
  (
    select source_presence->context.source_name->>'availability'
      from public.v_auction_sales_app view_row
      join pgtap_source_presence_421_context context
        on context.sale_id = view_row.id
     where context.case_name = 'outage'
  ),
  'unavailable',
  'the detail view exposes the compact outage state'
);

select ok(
  (
    select source_presence->context.source_name->>'run_id' = 'pgtap-run-421-current'
      from public.v_auction_sales_app view_row
      join pgtap_source_presence_421_context context
        on context.sale_id = view_row.id
     where context.case_name = 'current'
  ),
  'the detail view exposes current run provenance'
);

select is(
  (
    select source_presence
      from public.v_auction_sales_app view_row
      join pgtap_source_presence_421_context context
        on context.sale_id = view_row.id
     where context.case_name = 'empty'
  ),
  '{}'::jsonb,
  'the detail view does not leak a legacy value when compact state is absent'
);

select is(
  (
    select source_presence->context.source_name->>'state'
      from public.v_auction_sales_discovery view_row
      join pgtap_source_presence_421_context context
        on context.sale_id = view_row.id
     where context.case_name = 'current'
  ),
  'present',
  'the discovery view exposes the compact current state'
);

select is(
  (
    select source_presence->context.source_name->>'state'
      from public.v_auction_sales_app_search view_row
      join pgtap_source_presence_421_context context
        on context.sale_id = view_row.id
     where context.case_name = 'absent'
  ),
  'absent',
  'the detail search projection inherits the compact state'
);

select is(
  (
    select source_presence->context.source_name->>'availability'
      from public.v_auction_sales_discovery_search view_row
      join pgtap_source_presence_421_context context
        on context.sale_id = view_row.id
     where context.case_name = 'outage'
  ),
  'unavailable',
  'the discovery search projection inherits the compact outage state'
);

select * from finish();
rollback;
