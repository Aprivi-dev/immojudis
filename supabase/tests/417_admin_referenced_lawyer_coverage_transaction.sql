begin;

select plan(12);

select has_function(
  'public',
  'save_referenced_lawyer_with_coverage',
  array['uuid', 'jsonb', 'jsonb'],
  'the admin lawyer save RPC keeps its expected signature'
);

select ok(
  (
    select function_row.prosecdef
      and function_row.proconfig @> array['search_path=""']::text[]
    from pg_proc function_row
    where function_row.oid =
      'public.save_referenced_lawyer_with_coverage(uuid,jsonb,jsonb)'::regprocedure
  ),
  'the lawyer save RPC is SECURITY DEFINER with an empty search_path'
);

select ok(
  has_function_privilege(
    'service_role',
    'public.save_referenced_lawyer_with_coverage(uuid,jsonb,jsonb)',
    'execute'
  )
  and not has_function_privilege(
    'anon',
    'public.save_referenced_lawyer_with_coverage(uuid,jsonb,jsonb)',
    'execute'
  )
  and not has_function_privilege(
    'authenticated',
    'public.save_referenced_lawyer_with_coverage(uuid,jsonb,jsonb)',
    'execute'
  ),
  'only the service role can execute the lawyer save RPC'
);

insert into public.referenced_lawyers (
  id,
  status,
  paid_placement_status,
  display_name,
  department
)
values (
  'f4170000-0000-4000-8000-000000000001',
  'active',
  'active',
  'Ancien cabinet',
  '33'
);

insert into public.referenced_lawyer_coverage (lawyer_id, department)
values ('f4170000-0000-4000-8000-000000000001', '33');

-- This constraint makes the coverage INSERT fail after the RPC has performed
-- its DELETE, proving that the lawyer and old coverage are rolled back too.
alter table public.referenced_lawyer_coverage
  add constraint pgtap_417_forced_coverage_failure
  check (department <> 'FAIL');

set local role service_role;

select throws_ok(
  $$select *
    from public.save_referenced_lawyer_with_coverage(
      'f4170000-0000-4000-8000-000000000001',
      '{"practice_tags":[]}'::jsonb,
      '[]'::jsonb
    )$$,
  '22023',
  null,
  'an incomplete lawyer payload is rejected before mutation'
);

select throws_ok(
  $$select *
    from public.save_referenced_lawyer_with_coverage(
      'f4170000-0000-4000-8000-000000000001',
      '{"display_name":"Valid name","practice_tags":[]}'::jsonb,
      '{}'::jsonb
    )$$,
  '22023',
  null,
  'a non-array coverage payload is rejected before mutation'
);

select throws_ok(
  $$select *
    from public.save_referenced_lawyer_with_coverage(
      'f4170000-0000-4000-8000-000000000001',
      '{"display_name":"Valid name","practice_tags":[]}'::jsonb,
      '[{}]'::jsonb
    )$$,
  '22023',
  null,
  'an empty coverage item is rejected before mutation'
);

select lives_ok(
  $$select *
    from public.save_referenced_lawyer_with_coverage(
      'f4170000-0000-4000-8000-000000000001',
      '{"status":"active","paid_placement_status":"active","display_name":"Nouveau cabinet","practice_tags":["adjudication"],"accepts_judicial_auctions":true,"accepts_remote_contact":true,"priority_weight":10}'::jsonb,
      '[{"department":"75"}]'::jsonb
    )$$,
  'a valid lawyer and coverage replacement succeeds'
);

select is(
  (
    select display_name
    from public.referenced_lawyers
    where id = 'f4170000-0000-4000-8000-000000000001'
  ),
  'Nouveau cabinet',
  'the successful RPC updates the lawyer row'
);

select is(
  (
    select array_agg(department order by department)
    from public.referenced_lawyer_coverage
    where lawyer_id = 'f4170000-0000-4000-8000-000000000001'
  ),
  array['75']::text[],
  'the successful RPC replaces old coverage rows'
);

select throws_ok(
  $$select *
    from public.save_referenced_lawyer_with_coverage(
      'f4170000-0000-4000-8000-000000000001',
      '{"status":"active","paid_placement_status":"active","display_name":"Should rollback","practice_tags":["adjudication"],"accepts_judicial_auctions":true,"accepts_remote_contact":true,"priority_weight":99}'::jsonb,
      '[{"department":"FAIL"}]'::jsonb
    )$$,
  '23514',
  null,
  'a coverage insert failure is surfaced'
);

select is(
  (
    select display_name
    from public.referenced_lawyers
    where id = 'f4170000-0000-4000-8000-000000000001'
  ),
  'Nouveau cabinet',
  'the lawyer update rolls back with a coverage failure'
);

select is(
  (
    select array_agg(department order by department)
    from public.referenced_lawyer_coverage
    where lawyer_id = 'f4170000-0000-4000-8000-000000000001'
  ),
  array['75']::text[],
  'the previous coverage survives a failed replacement'
);

reset role;

select * from finish();
rollback;
