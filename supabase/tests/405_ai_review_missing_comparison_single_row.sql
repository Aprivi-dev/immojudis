begin;

select plan(20);

select has_function(
  'app_private',
  'ai_review_compare_field',
  array['text', 'jsonb', 'uuid'],
  'the AI review comparison function keeps its existing signature'
);

select ok(
  (
    select procedure_row.prosecdef
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
  'the comparison remains SECURITY DEFINER and service-role-only'
);

select ok(
  (
    select procedure_row.provolatile = 's'
      and procedure_row.proconfig @> array['search_path=""']::text[]
    from pg_proc procedure_row
    where procedure_row.oid =
      'app_private.ai_review_compare_field(text,jsonb,uuid)'::regprocedure
  ),
  'the comparison remains STABLE with an empty search_path'
);

select ok(
  (
    select procedure_row.proretset
    from pg_proc procedure_row
    where procedure_row.oid =
      'app_private.ai_review_compare_field(text,jsonb,uuid)'::regprocedure
  ),
  'the comparison remains a set-returning function'
);

set local role postgres;

insert into public.auction_sales(
  id, source_name, source_url, title, city, property_type,
  starting_price_eur, status, content_hash, sale_date,
  habitable_surface_m2, carrez_surface_m2, land_surface_m2,
  occupancy_status, rooms_count, parking_count, raw_payload
)
values (
  '40500000-0000-4000-8000-000000000001',
  'ai-review-missing-single-row',
  'https://example.test/ai-review/missing-single-row',
  'AI review missing comparison test sale',
  null,
  'house',
  180000,
  'upcoming',
  repeat('4', 64),
  '2026-09-30 10:00:00+02'::timestamptz,
  100,
  95,
  500,
  null,
  3,
  1,
  '{}'::jsonb
);

set local role service_role;

select is(
  (
    select count(*)
    from app_private.ai_review_compare_field(
      'property.city', '"Paris"'::jsonb,
      '40500000-0000-4000-8000-000000000001'
    )
  ),
  1::bigint,
  'a NULL canonical city emits exactly one comparison row'
);
select is(
  (
    select comparison_status
    from app_private.ai_review_compare_field(
      'property.city', '"Paris"'::jsonb,
      '40500000-0000-4000-8000-000000000001'
    )
  ),
  'missing',
  'a NULL canonical city is missing rather than conflicting'
);

select is(
  (
    select count(*)
    from app_private.ai_review_compare_field(
      'property.occupancy_status', '"vacant"'::jsonb,
      '40500000-0000-4000-8000-000000000001'
    )
  ),
  1::bigint,
  'a NULL canonical occupancy emits exactly one comparison row'
);
select is(
  (
    select comparison_status
    from app_private.ai_review_compare_field(
      'property.occupancy_status', '"vacant"'::jsonb,
      '40500000-0000-4000-8000-000000000001'
    )
  ),
  'missing',
  'a NULL canonical occupancy is missing rather than conflicting'
);

set local role postgres;
update public.auction_sales
set occupancy_status = 'unknown'
where id = '40500000-0000-4000-8000-000000000001';
set local role service_role;

select is(
  (
    select count(*)
    from app_private.ai_review_compare_field(
      'property.occupancy_status', '"vacant"'::jsonb,
      '40500000-0000-4000-8000-000000000001'
    )
  ),
  1::bigint,
  'an unknown canonical occupancy emits exactly one comparison row'
);
select is(
  (
    select comparison_status
    from app_private.ai_review_compare_field(
      'property.occupancy_status', '"vacant"'::jsonb,
      '40500000-0000-4000-8000-000000000001'
    )
  ),
  'missing',
  'an unknown canonical occupancy is missing rather than conflicting'
);

select is(
  (
    select count(*)
    from app_private.ai_review_compare_field(
      'property.source_energy_dpe_class', '"D"'::jsonb,
      '40500000-0000-4000-8000-000000000001'
    )
  ),
  1::bigint,
  'an absent DPE canonical value emits exactly one comparison row'
);
select is(
  (
    select comparison_status
    from app_private.ai_review_compare_field(
      'property.source_energy_dpe_class', '"D"'::jsonb,
      '40500000-0000-4000-8000-000000000001'
    )
  ),
  'missing',
  'an absent DPE canonical value is missing rather than conflicting'
);

select is(
  (
    select count(*)
    from app_private.ai_review_compare_field(
      'property.source_energy_ges_class', '"E"'::jsonb,
      '40500000-0000-4000-8000-000000000001'
    )
  ),
  1::bigint,
  'an absent GES canonical value emits exactly one comparison row'
);
select is(
  (
    select comparison_status
    from app_private.ai_review_compare_field(
      'property.source_energy_ges_class', '"E"'::jsonb,
      '40500000-0000-4000-8000-000000000001'
    )
  ),
  'missing',
  'an absent GES canonical value is missing rather than conflicting'
);

select is(
  (
    select count(*)
    from app_private.ai_review_compare_field(
      'property.property_type', '" House "'::jsonb,
      '40500000-0000-4000-8000-000000000001'
    )
  ),
  1::bigint,
  'a matching canonical text value emits exactly one comparison row'
);
select is(
  (
    select comparison_status
    from app_private.ai_review_compare_field(
      'property.property_type', '" House "'::jsonb,
      '40500000-0000-4000-8000-000000000001'
    )
  ),
  'match',
  'a matching canonical text value remains a match'
);

select is(
  (
    select count(*)
    from app_private.ai_review_compare_field(
      'property.property_type', '"flat"'::jsonb,
      '40500000-0000-4000-8000-000000000001'
    )
  ),
  1::bigint,
  'a conflicting canonical text value emits exactly one comparison row'
);
select is(
  (
    select comparison_status
    from app_private.ai_review_compare_field(
      'property.property_type', '"flat"'::jsonb,
      '40500000-0000-4000-8000-000000000001'
    )
  ),
  'conflict',
  'a conflicting canonical text value remains a conflict'
);

set local role postgres;
update public.auction_sales
set raw_payload = '{"source_energy_diagnostics":{"dpe_class":"D","ges_class":"E"}}'::jsonb
where id = '40500000-0000-4000-8000-000000000001';
set local role service_role;

select is(
  (
    select count(*)
    from app_private.ai_review_compare_field(
      'property.source_energy_dpe_class', '"Z"'::jsonb,
      '40500000-0000-4000-8000-000000000001'
    )
  ),
  1::bigint,
  'an unsupported energy comparison emits exactly one comparison row'
);
select is(
  (
    select comparison_status
    from app_private.ai_review_compare_field(
      'property.source_energy_dpe_class', '"Z"'::jsonb,
      '40500000-0000-4000-8000-000000000001'
    )
  ),
  'unsupported',
  'an invalid DPE value remains unsupported'
);

select * from finish();

rollback;
