begin;

select plan(21);

select has_table(
  'public',
  'outcome_court_official_references',
  'active courts can retain append-only official appellate references'
);
select has_table(
  'public',
  'auction_sale_court_label_assignments',
  'catalogue label assignments have an immutable audit registry'
);
select ok(
  (
    select relrowsecurity
    from pg_class
    where oid = 'public.outcome_court_official_references'::regclass
  ),
  'official court references have RLS enabled'
);
select ok(
  (
    select relrowsecurity
    from pg_class
    where oid = 'public.auction_sale_court_label_assignments'::regclass
  ),
  'label assignment evidence has RLS enabled'
);
select ok(
  not has_table_privilege(
    'anon',
    'public.outcome_court_official_references',
    'SELECT'
  ),
  'anonymous users cannot read official reference evidence'
);
select ok(
  not has_table_privilege(
    'authenticated',
    'public.auction_sale_court_label_assignments',
    'SELECT'
  ),
  'authenticated browsers cannot read label assignment evidence'
);
select ok(
  has_table_privilege(
    'service_role',
    'public.outcome_court_official_references',
    'SELECT'
  )
    and has_table_privilege(
      'service_role',
      'public.outcome_court_official_references',
      'INSERT'
    )
    and not has_table_privilege(
      'service_role',
      'public.outcome_court_official_references',
      'UPDATE'
    )
    and not has_table_privilege(
      'service_role',
      'public.outcome_court_official_references',
      'DELETE'
    ),
  'service role can append but not mutate official court references'
);
select ok(
  has_table_privilege(
    'service_role',
    'public.auction_sale_court_label_assignments',
    'SELECT'
  )
    and has_table_privilege(
      'service_role',
      'public.auction_sale_court_label_assignments',
      'INSERT'
    )
    and not has_table_privilege(
      'service_role',
      'public.auction_sale_court_label_assignments',
      'UPDATE'
    )
    and not has_table_privilege(
      'service_role',
      'public.auction_sale_court_label_assignments',
      'DELETE'
    ),
  'service role can append but not mutate label evidence'
);
select ok(
  not has_function_privilege(
    'authenticated',
    'public.reconcile_catalogue_court_labels(date,date)',
    'EXECUTE'
  ),
  'authenticated users cannot run catalogue label reconciliation'
);
select ok(
  has_function_privilege(
    'service_role',
    'public.reconcile_catalogue_court_labels(date,date)',
    'EXECUTE'
  ),
  'service role can run catalogue label reconciliation'
);

insert into public.tribunals(code, canonical_name, department, city, aliases)
values
  (
    'label_testville',
    'TJ Testville',
    '99',
    'Testville',
    '["Tribunal judiciaire de Testville"]'::jsonb
  ),
  (
    'label_other',
    'TJ Autreville',
    '98',
    'Autreville',
    '[]'::jsonb
  );

insert into public.outcome_courts(id, code, name, judicial_region)
values
  (
    'e1000000-0000-4000-8000-000000000001',
    'label_testville',
    'TJ Testville',
    'Cour d''Appel de Testville'
  ),
  (
    'e1000000-0000-4000-8000-000000000002',
    'label_other',
    'TJ Autreville',
    'Cour d''Appel d''Autreville'
  );

insert into public.outcome_court_official_references (
  id,
  court_id,
  court_code,
  official_origin_code,
  official_srj_code,
  official_name,
  judicial_region_origin_code,
  judicial_region_srj_code,
  judicial_region,
  source_name,
  source_url,
  observed_on,
  reference_sha256
) values (
  'e1100000-0000-4000-8000-000000000001',
  'e1000000-0000-4000-8000-000000000001',
  'label_testville',
  '99',
  '99001',
  'Tribunal judiciaire de Testville',
  '99',
  '99002',
  'Cour d''Appel de Testville',
  'justice_open_data',
  'https://www.data.gouv.fr/datasets/liste-des-juridictions-competentes-pour-les-communes-de-france',
  date '2026-07-28',
  repeat('a', 64)
);

insert into public.auction_sales (
  id,
  source_name,
  source_url,
  tribunal,
  sale_venue_type,
  sale_verification_status,
  property_type,
  sale_date,
  status
) values
  (
    'e2000000-0000-4000-8000-000000000001',
    'label-test',
    'https://example.test/label/exact',
    'TJ Testville',
    'tribunal',
    'verified',
    'house',
    '2026-08-01T10:00:00Z',
    'upcoming'
  ),
  (
    'e2000000-0000-4000-8000-000000000002',
    'label-test',
    'https://example.test/label/prefix',
    'TJ Testville siégeant au palais de justice',
    'tribunal',
    'cross_checked',
    'house',
    '2026-08-02T10:00:00Z',
    'upcoming'
  ),
  (
    'e2000000-0000-4000-8000-000000000003',
    'label-test',
    'https://example.test/label/not-leading',
    'Vente au TJ Testville',
    'tribunal',
    'verified',
    'house',
    '2026-08-03T10:00:00Z',
    'upcoming'
  ),
  (
    'e2000000-0000-4000-8000-000000000004',
    'label-test',
    'https://example.test/label/pending',
    'TJ Testville',
    'tribunal',
    'pending',
    'house',
    '2026-08-04T10:00:00Z',
    'upcoming'
  );

select results_eq(
  $$select
      scanned_count,
      assigned_count,
      exact_label_count,
      prefix_label_count,
      unresolved_count,
      complete
    from public.reconcile_catalogue_court_labels(
      date '2026-08-01',
      date '2026-08-31'
    )$$,
  $$values (
      3::bigint,
      2::bigint,
      1::bigint,
      1::bigint,
      1::bigint,
      false
    )$$,
  'only exact and unique leading labels are assigned'
);
select is(
  (
    select tribunal_code
    from public.auction_sales
    where id = 'e2000000-0000-4000-8000-000000000001'
  ),
  'label_testville',
  'an exact normalized label is assigned'
);
select is(
  (
    select tribunal_code
    from public.auction_sales
    where id = 'e2000000-0000-4000-8000-000000000002'
  ),
  'label_testville',
  'a unique court label followed by descriptive text is assigned'
);
select is(
  (
    select tribunal_code
    from public.auction_sales
    where id = 'e2000000-0000-4000-8000-000000000003'
  ),
  null,
  'a court mention that is not the leading tribunal label fails closed'
);
select is(
  (
    select tribunal_code
    from public.auction_sales
    where id = 'e2000000-0000-4000-8000-000000000004'
  ),
  null,
  'pending sales are outside the Premium reconciliation corpus'
);
select results_eq(
  $$select mapping_method
    from public.auction_sale_court_label_assignments
    order by mapping_method$$,
  $$values
      ('source_tribunal_label_exact'::text),
      ('source_tribunal_label_unique_prefix'::text)$$,
  'audit evidence distinguishes exact and unique-prefix assignments'
);
select is(
  (
    select source_label_snapshot
    from public.auction_sale_court_label_assignments
    where mapping_method = 'source_tribunal_label_unique_prefix'
  ),
  'TJ Testville siégeant au palais de justice',
  'the original source label is preserved in the audit evidence'
);
select throws_ok(
  $$update public.auction_sale_court_label_assignments
    set court_name = 'TJ Modifié'$$,
  '55000',
  'Court enrichment audit rows are immutable.',
  'label assignment evidence cannot be updated'
);
select throws_ok(
  $$delete from public.outcome_court_official_references
    where id = 'e1100000-0000-4000-8000-000000000001'$$,
  '55000',
  'Court enrichment audit rows are immutable.',
  'official court references cannot be deleted'
);
select throws_ok(
  $$select *
    from public.reconcile_catalogue_court_labels(
      date '2026-09-01',
      date '2026-08-01'
    )$$,
  '22023',
  'A valid inclusive sale-date range is required.',
  'an invalid reconciliation window is rejected'
);
select is(
  (
    select count(*)
    from app_private.resolve_unique_active_court_label(
      'Vente au TJ Testville'
    )
  ),
  0::bigint,
  'the private resolver never searches for a court mention in free text'
);

select * from finish();
rollback;
