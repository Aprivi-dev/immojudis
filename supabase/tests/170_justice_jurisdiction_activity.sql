begin;

select plan(26);

select has_table(
  'public',
  'justice_jurisdiction_activity_imports',
  'StatJur imports have an immutable evidence registry'
);
select has_table(
  'public',
  'justice_jurisdiction_activity',
  'historical jurisdiction activity has a private evidence table'
);
select ok(
  (select relrowsecurity from pg_class where oid = 'public.justice_jurisdiction_activity_imports'::regclass),
  'StatJur imports have RLS enabled'
);
select ok(
  (select relrowsecurity from pg_class where oid = 'public.justice_jurisdiction_activity'::regclass),
  'jurisdiction activity has RLS enabled'
);
select ok(
  not has_table_privilege('anon', 'public.justice_jurisdiction_activity_imports', 'SELECT'),
  'anonymous users cannot read StatJur import evidence'
);
select ok(
  not has_table_privilege('authenticated', 'public.justice_jurisdiction_activity', 'SELECT'),
  'authenticated browsers cannot read raw jurisdiction activity'
);
select ok(
  has_table_privilege('service_role', 'public.justice_jurisdiction_activity_imports', 'SELECT')
    and has_table_privilege('service_role', 'public.justice_jurisdiction_activity_imports', 'INSERT')
    and not has_table_privilege('service_role', 'public.justice_jurisdiction_activity_imports', 'UPDATE')
    and not has_table_privilege('service_role', 'public.justice_jurisdiction_activity_imports', 'DELETE'),
  'service role can append but not mutate StatJur imports'
);
select ok(
  has_table_privilege('service_role', 'public.justice_jurisdiction_activity', 'SELECT')
    and has_table_privilege('service_role', 'public.justice_jurisdiction_activity', 'INSERT')
    and not has_table_privilege('service_role', 'public.justice_jurisdiction_activity', 'UPDATE')
    and not has_table_privilege('service_role', 'public.justice_jurisdiction_activity', 'DELETE'),
  'service role can append but not mutate jurisdiction activity'
);
select results_eq(
  $$select official, legal_review_status, ingestion_policy, active
    from public.data_sources
    where name = 'justice_jurisdiction_statistics'$$,
  $$values (true, 'pending'::text, 'disabled'::text, false)$$,
  'StatJur starts official but disabled pending legal review'
);
select ok(
  exists (
    select 1
    from pg_trigger
    where tgrelid = 'public.justice_jurisdiction_activity_imports'::regclass
      and tgname = 'justice_jurisdiction_activity_import_policy'
      and not tgisinternal
  ),
  'every StatJur import passes the source-policy trigger'
);

set local role service_role;

select throws_ok(
  $$insert into public.justice_jurisdiction_activity_imports (
      source_id, source_url, source_version, parser_version,
      period_start_year, period_end_year, fetched_at, content_hash,
      source_row_count, matched_row_count, unmatched_row_count,
      national_new_cases_status, national_new_cases_value,
      national_terminated_cases_status, national_terminated_cases_value
    ) values (
      (select id from public.data_sources where name = 'justice_jurisdiction_statistics'),
      'https://www.stats.justice.gouv.fr/statjur/html/ajaxService.php',
      'v26.02.2', 'test-v1', 2019, 2019, '2026-08-24T12:00:00Z', repeat('a', 64),
      0, 0, 0, 'observed', 186, 'observed', 205
    )$$,
  '23514',
  'Justice jurisdiction activity imports require the approved active automated source policy.',
  'pending StatJur policy rejects persistence'
);

reset role;

update public.data_sources
set legal_review_status = 'approved', ingestion_policy = 'allowed_automated', active = true
where name = 'justice_jurisdiction_statistics';

insert into public.outcome_courts (id, code, name, judicial_region)
values (
  'd1000000-0000-4000-8000-000000000001',
  'TJ33063',
  'Tribunal judiciaire de Bordeaux',
  'Bordeaux'
);

select lives_ok(
  $$insert into public.justice_jurisdiction_activity_imports (
      id, source_id, source_url, source_version, parser_version,
      period_start_year, period_end_year, fetched_at, content_hash,
      source_row_count, matched_row_count, unmatched_row_count,
      national_new_cases_status, national_new_cases_value,
      national_terminated_cases_status, national_terminated_cases_value
    ) values (
      'd2000000-0000-4000-8000-000000000001',
      (select id from public.data_sources where name = 'justice_jurisdiction_statistics'),
      'https://www.stats.justice.gouv.fr/statjur/html/ajaxService.php',
      'v26.02.2', 'test-v1', 2019, 2019, '2026-08-24T12:00:00Z', repeat('b', 64),
      2, 1, 1, 'observed', 186, 'observed', 205
    )$$,
  'an approved active policy accepts a validated StatJur import'
);

select lives_ok(
  $$insert into public.justice_jurisdiction_activity (
      id, import_id, court_id, source_court_code, source_court_name,
      activity_year, match_status, new_cases_status, new_cases_value,
      terminated_cases_status, terminated_cases_value, canonical_hash
    ) values (
      'd3000000-0000-4000-8000-000000000001',
      'd2000000-0000-4000-8000-000000000001',
      'd1000000-0000-4000-8000-000000000001',
      '33000001', 'BORDEAUX', 2019, 'exact_name',
      'observed', 9, 'observed', 8, repeat('c', 64)
    )$$,
  'an exact court match can be appended'
);

select lives_ok(
  $$insert into public.justice_jurisdiction_activity (
      id, import_id, court_id, source_court_code, source_court_name,
      activity_year, match_status, match_details, new_cases_status, new_cases_value,
      terminated_cases_status, terminated_cases_value, canonical_hash
    ) values (
      'd3000000-0000-4000-8000-000000000002',
      'd2000000-0000-4000-8000-000000000001', null,
      '99000001', 'VILLE HISTORIQUE', 2019, 'unmatched', '{"reason":"no exact match"}',
      'suppressed', null, 'missing', null, repeat('d', 64)
    )$$,
  'unmatched history and NC remain preserved without entering a court profile'
);

select throws_ok(
  $$insert into public.justice_jurisdiction_activity (
      import_id, court_id, source_court_code, source_court_name,
      activity_year, match_status, new_cases_status, new_cases_value,
      terminated_cases_status, terminated_cases_value, canonical_hash
    ) values (
      'd2000000-0000-4000-8000-000000000001', null,
      '99000002', 'OBSERVATION INCOMPLÈTE', 2019, 'unmatched',
      'observed', null, 'missing', null, repeat('a', 64)
    )$$,
  '23514',
  'new row for relation "justice_jurisdiction_activity" violates check constraint "justice_jurisdiction_activity_new_metric_check"',
  'an observed metric always requires its numeric value'
);

select throws_ok(
  $$insert into public.justice_jurisdiction_activity (
      import_id, court_id, source_court_code, source_court_name,
      activity_year, match_status, new_cases_status, new_cases_value,
      terminated_cases_status, terminated_cases_value, canonical_hash
    ) values (
      'd2000000-0000-4000-8000-000000000001', null,
      '99000003', 'SECRET INCOHÉRENT', 2019, 'unmatched',
      'suppressed', 3, 'missing', null, repeat('a', 64)
    )$$,
  '23514',
  'new row for relation "justice_jurisdiction_activity" violates check constraint "justice_jurisdiction_activity_new_metric_check"',
  'a suppressed metric never leaks a hidden value'
);

select throws_ok(
  $$insert into public.justice_jurisdiction_activity (
      import_id, court_id, source_court_code, source_court_name,
      activity_year, match_status, new_cases_status, new_cases_value,
      terminated_cases_status, terminated_cases_value, canonical_hash
    ) values (
      'd2000000-0000-4000-8000-000000000001',
      'd1000000-0000-4000-8000-000000000001',
      '33000002', 'BORDEAUX BIS', 2018, 'exact_name',
      'observed', 1, 'observed', 1, repeat('e', 64)
    )$$,
  '23514',
  'Justice jurisdiction activity year must match its immutable import period.',
  'activity rows cannot escape their import year'
);

select throws_ok(
  $$update public.justice_jurisdiction_activity
    set source_court_name = 'BORDEAUX MODIFIÉ'
    where id = 'd3000000-0000-4000-8000-000000000001'$$,
  '55000',
  'Justice jurisdiction activity evidence is append-only.',
  'activity evidence cannot be updated'
);

select throws_ok(
  $$delete from public.justice_jurisdiction_activity_imports
    where id = 'd2000000-0000-4000-8000-000000000001'$$,
  '55000',
  'Justice jurisdiction activity evidence is append-only.',
  'import evidence cannot be deleted'
);

select throws_ok(
  $$insert into public.justice_jurisdiction_activity_imports (
      source_id, source_url, source_version, parser_version,
      period_start_year, period_end_year, fetched_at, content_hash,
      source_row_count, matched_row_count, unmatched_row_count,
      national_new_cases_status, national_new_cases_value,
      national_terminated_cases_status, national_terminated_cases_value
    ) values (
      (select id from public.data_sources where name = 'justice_jurisdiction_statistics'),
      'https://example.test/statjur', 'v26.02.2', 'test-v1',
      2019, 2019, '2026-08-24T12:00:00Z', repeat('f', 64),
      0, 0, 0, 'observed', 186, 'observed', 205
    )$$,
  '23514',
  'Justice jurisdiction activity imports require the reviewed StatJur endpoint.',
  'imports cannot substitute another endpoint'
);

select is(
  (select count(*) from public.justice_jurisdiction_activity),
  2::bigint,
  'both matched and unmatched source rows remain auditable'
);
select is(
  (select national_new_cases_value from public.justice_jurisdiction_activity_imports
   where id = 'd2000000-0000-4000-8000-000000000001'),
  186,
  'the national France layer is retained on the import'
);
select is(
  (select match_status from public.justice_jurisdiction_activity
   where id = 'd3000000-0000-4000-8000-000000000001'),
  'exact_name',
  'the reviewed matching method is explicit'
);
select is(
  (select new_cases_status from public.justice_jurisdiction_activity
   where id = 'd3000000-0000-4000-8000-000000000002'),
  'suppressed',
  'official NC remains distinct from a missing value'
);
select is(
  (select terminated_cases_status from public.justice_jurisdiction_activity
   where id = 'd3000000-0000-4000-8000-000000000002'),
  'missing',
  'an empty official cell remains explicitly missing'
);
select is(
  (select license from public.data_sources where name = 'justice_jurisdiction_statistics'),
  null,
  'no reuse licence is claimed before legal review'
);

select * from finish();
rollback;
