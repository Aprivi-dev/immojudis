begin;

select plan(25);

select has_function(
  'app_private',
  'ai_review_compare_field',
  array['text', 'jsonb', 'uuid'],
  'the existing comparison function keeps its signature'
);

select has_function(
  'app_private',
  'ai_review_normalize_property_type',
  array['text'],
  'the exact property type helper exists privately'
);

select ok(
  (
    select procedure_row.prosecdef
      and procedure_row.provolatile = 's'
      and procedure_row.proconfig @> array['search_path=""']::text[]
    from pg_proc procedure_row
    where procedure_row.oid =
      'app_private.ai_review_compare_field(text,jsonb,uuid)'::regprocedure
  )
  and has_function_privilege(
    'service_role',
    'app_private.ai_review_compare_field(text,jsonb,uuid)',
    'execute'
  )
  and not has_function_privilege(
    'anon',
    'app_private.ai_review_compare_field(text,jsonb,uuid)',
    'execute'
  )
  and not has_function_privilege(
    'authenticated',
    'app_private.ai_review_compare_field(text,jsonb,uuid)',
    'execute'
  ),
  'the comparison remains SECURITY DEFINER, stable and service-role-only'
);

select ok(
  (
    select not procedure_row.prosecdef
      and procedure_row.provolatile = 'i'
      and procedure_row.proconfig @> array['search_path=""']::text[]
    from pg_proc procedure_row
    where procedure_row.oid =
      'app_private.ai_review_normalize_property_type(text)'::regprocedure
  )
  and not has_function_privilege(
    'anon',
    'app_private.ai_review_normalize_property_type(text)',
    'execute'
  )
  and not has_function_privilege(
    'authenticated',
    'app_private.ai_review_normalize_property_type(text)',
    'execute'
  )
  and not has_function_privilege(
    'service_role',
    'app_private.ai_review_normalize_property_type(text)',
    'execute'
  )
  and not exists (
    select 1
    from pg_proc procedure_row
    cross join lateral aclexplode(procedure_row.proacl) privilege
    where procedure_row.oid =
      'app_private.ai_review_normalize_property_type(text)'::regprocedure
      and privilege.grantee = 0
      and privilege.privilege_type = 'EXECUTE'
  ),
  'the exact helper is immutable, search-path empty and private'
);

select ok(
  (
    select procedure_row.proretset
    from pg_proc procedure_row
    where procedure_row.oid =
      'app_private.ai_review_compare_field(text,jsonb,uuid)'::regprocedure
  ),
  'the comparison remains set-returning'
);

set local role postgres;

insert into public.auction_sales(
  id, source_name, source_url, title, city, property_type,
  starting_price_eur, status, content_hash, raw_payload
)
values (
  '40800000-1000-4000-8000-000000000001',
  'ai-review-property-type-pgtap',
  'https://example.test/ai-review/property-type-1',
  'AI review property type test sale',
  'Bordeaux',
  'apartment',
  120000,
  'upcoming',
  repeat('a', 64),
  '{}'::jsonb
);

set local role service_role;

select results_eq(
  $$select comparison_status, normalized_ai_value, normalized_canonical_value
    from app_private.ai_review_compare_field(
      'property.property_type', '"appartement"'::jsonb,
      '40800000-1000-4000-8000-000000000001'
    )$$,
  $$values ('match'::text, 'apartment'::text, 'apartment'::text)$$,
  'appartement maps exactly to apartment'
);

set local role postgres;
update public.auction_sales
set property_type = 'house'
where id = '40800000-1000-4000-8000-000000000001';
set local role service_role;

select results_eq(
  $$select comparison_status, normalized_ai_value, normalized_canonical_value
    from app_private.ai_review_compare_field(
      'property.property_type', '"maison"'::jsonb,
      '40800000-1000-4000-8000-000000000001'
    )$$,
  $$values ('match'::text, 'house'::text, 'house'::text)$$,
  'maison maps exactly to house'
);

set local role postgres;
update public.auction_sales
set property_type = 'building'
where id = '40800000-1000-4000-8000-000000000001';
set local role service_role;

select results_eq(
  $$select comparison_status, normalized_ai_value, normalized_canonical_value
    from app_private.ai_review_compare_field(
      'property.property_type', '"immeuble"'::jsonb,
      '40800000-1000-4000-8000-000000000001'
    )$$,
  $$values ('match'::text, 'building'::text, 'building'::text)$$,
  'immeuble maps exactly to building'
);

set local role postgres;
update public.auction_sales
set property_type = 'land'
where id = '40800000-1000-4000-8000-000000000001';
set local role service_role;

select results_eq(
  $$select comparison_status, normalized_ai_value, normalized_canonical_value
    from app_private.ai_review_compare_field(
      'property.property_type', '"terrain"'::jsonb,
      '40800000-1000-4000-8000-000000000001'
    )$$,
  $$values ('match'::text, 'land'::text, 'land'::text)$$,
  'terrain maps exactly to land'
);

set local role postgres;
update public.auction_sales
set property_type = 'mixed'
where id = '40800000-1000-4000-8000-000000000001';
set local role service_role;

select results_eq(
  $$select comparison_status, normalized_ai_value, normalized_canonical_value
    from app_private.ai_review_compare_field(
      'property.property_type', '"ensemble immobilier"'::jsonb,
      '40800000-1000-4000-8000-000000000001'
    )$$,
  $$values ('match'::text, 'mixed'::text, 'mixed'::text)$$,
  'ensemble immobilier maps exactly to mixed'
);

set local role postgres;
select results_eq(
  $$select app_private.ai_review_normalize_property_type(code)
    from (values
      ('apartment'::text), ('building'::text), ('commercial'::text),
      ('house'::text), ('land'::text), ('mixed'::text),
      ('other'::text), ('parking'::text)
    ) as model(code)
    order by code$$,
  $$select code
    from (values
      ('apartment'::text), ('building'::text), ('commercial'::text),
      ('house'::text), ('land'::text), ('mixed'::text),
      ('other'::text), ('parking'::text)
    ) as model(code)
    order by code$$,
  'canonical model property type codes map to themselves'
);

set local role service_role;

set local role postgres;
update public.auction_sales
set property_type = 'land'
where id = '40800000-1000-4000-8000-000000000001';
set local role service_role;
select is(
  (
    select comparison_status
    from app_private.ai_review_compare_field(
      'property.property_type', '"appartement"'::jsonb,
      '40800000-1000-4000-8000-000000000001'
    )
  ),
  'conflict',
  'appartement versus land remains a true code conflict'
);

set local role postgres;
update public.auction_sales
set property_type = 'apartment'
where id = '40800000-1000-4000-8000-000000000001';
set local role service_role;
select is(
  (
    select comparison_status
    from app_private.ai_review_compare_field(
      'property.property_type', '"immeuble"'::jsonb,
      '40800000-1000-4000-8000-000000000001'
    )
  ),
  'conflict',
  'immeuble versus apartment remains a true code conflict'
);

set local role postgres;
update public.auction_sales
set property_type = 'mixed'
where id = '40800000-1000-4000-8000-000000000001';
set local role service_role;
select is(
  (
    select comparison_status
    from app_private.ai_review_compare_field(
      'property.property_type', '"maison"'::jsonb,
      '40800000-1000-4000-8000-000000000001'
    )
  ),
  'conflict',
  'maison versus mixed remains a true code conflict'
);

select is(
  (
    select comparison_status
    from app_private.ai_review_compare_field(
      'property.property_type', '"maison avec terrain"'::jsonb,
      '40800000-1000-4000-8000-000000000001'
    )
  ),
  'unsupported',
  'a composite property type is not accepted by substring'
);

select is(
  (
    select comparison_status
    from app_private.ai_review_compare_field(
      'property.property_type', '"unknown"'::jsonb,
      '40800000-1000-4000-8000-000000000001'
    )
  ),
  'unsupported',
  'unknown remains unsupported against a known canonical property type'
);

set local role postgres;
update public.auction_sales
set property_type = 'unknown'
where id = '40800000-1000-4000-8000-000000000001';
set local role service_role;
select is(
  (
    select comparison_status
    from app_private.ai_review_compare_field(
      'property.property_type', '"unknown"'::jsonb,
      '40800000-1000-4000-8000-000000000001'
    )
  ),
  'unsupported',
  'unknown versus unknown remains unsupported rather than matching'
);
select is(
  (
    select comparison_status
    from app_private.ai_review_compare_field(
      'property.property_type', '"house"'::jsonb,
      '40800000-1000-4000-8000-000000000001'
    )
  ),
  'unsupported',
  'a known AI code cannot match an unknown canonical property type'
);

set local role postgres;
select is(
  (
    select app_private.ai_review_normalize_property_type('villa')
  ),
  null::text,
  'villa remains outside the exact property type helper map'
);
set local role service_role;

set local role postgres;
update public.auction_sales
set city = 'house', property_type = 'house'
where id = '40800000-1000-4000-8000-000000000001';
set local role service_role;
select is(
  (
    select comparison_status
    from app_private.ai_review_compare_field(
      'property.city', '"maison"'::jsonb,
      '40800000-1000-4000-8000-000000000001'
    )
  ),
  'conflict',
  'city keeps the generic text normalizer and is not translated as property type'
);

set local role postgres;
update public.auction_sales
set property_type = null
where id = '40800000-1000-4000-8000-000000000001';
set local role service_role;
select is(
  (
    select count(*)
    from app_private.ai_review_compare_field(
      'property.property_type', '"maison"'::jsonb,
      '40800000-1000-4000-8000-000000000001'
    )
  ),
  1::bigint,
  'a NULL canonical property type emits one comparison row'
);
select is(
  (
    select comparison_status
    from app_private.ai_review_compare_field(
      'property.property_type', '"maison"'::jsonb,
      '40800000-1000-4000-8000-000000000001'
    )
  ),
  'missing',
  'a NULL canonical property type remains missing rather than falling through'
);

set local role postgres;
insert into public.auction_sales(
  id, source_name, source_url, title, city, property_type,
  starting_price_eur, status, content_hash, raw_payload
)
values (
  '40800000-1000-4000-8000-000000000002',
  'ai-review-property-type-pgtap',
  'https://example.test/ai-review/property-type-2',
  'AI review property type hash test sale',
  'Bordeaux',
  'house',
  120000,
  'upcoming',
  repeat('h', 64),
  '{}'::jsonb
);

insert into public.auction_ai_review_case_status(
  schema_version, sample_sha256, case_id, source_name, source_url,
  access_state, capture_sha256, canonical_content_hash_at_import,
  auction_sale_id, mapping_status
)
values (
  'immojudis.real-extraction-review.v2', repeat('b', 64), 'case-hash',
  'ai-review-property-type-pgtap', 'https://example.test/ai-review/property-type-2',
  'captured', repeat('c', 64), repeat('d', 64),
  '40800000-1000-4000-8000-000000000002', 'exact'
);

insert into public.auction_ai_review_projections(
  id, schema_version, sample_sha256, case_id, source_name, source_url,
  capture_sha256, canonical_content_hash_at_import, auction_sale_id,
  mapping_status, field_key, review_state, citation_status, value_jsonb,
  evidence_locator, block_reason
)
values (
  '40800000-2000-4000-8000-000000000001',
  'immojudis.real-extraction-review.v2', repeat('b', 64), 'case-hash',
  'ai-review-property-type-pgtap', 'https://example.test/ai-review/property-type-2',
  repeat('c', 64), repeat('d', 64),
  '40800000-1000-4000-8000-000000000002', 'exact',
  'property.property_type', 'resolved', 'verified', '"house"'::jsonb,
  '{}'::jsonb, null
);

set local role service_role;
select is(
  (
    select comparison_status
    from public.v_auction_ai_review_projection_reconciliation
    where projection_id = '40800000-2000-4000-8000-000000000001'
  ),
  'not_publishable',
  'a stale canonical hash remains outside the reconciliation match set'
);
select is(
  (
    select comparison_reason
    from public.v_auction_ai_review_projection_reconciliation
    where projection_id = '40800000-2000-4000-8000-000000000001'
  ),
  'canonical content hash is missing or stale',
  'the hash guard keeps its explicit stale reason'
);
select is(
  (
    select raw_payload->>'publication_quarantine'
    from public.auction_sales
    where id = '40800000-1000-4000-8000-000000000002'
  ),
  'ai_review_projection_blocked',
  'a stale hash preserves the sale-level publication quarantine'
);

select * from finish();

rollback;
