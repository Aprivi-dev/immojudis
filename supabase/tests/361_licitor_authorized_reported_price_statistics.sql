begin;

select plan(20);

select ok(
  to_regclass('licitor_ingestion.statistical_source_authorizations') is not null,
  'the statistical source-authorization table exists'
);

select ok(
  to_regclass('licitor_ingestion.statistical_reported_candidate_attestations') is not null,
  'the aggregate-only reported-price attestation table exists'
);

select ok(
  (
    select relation.relrowsecurity
    from pg_class relation
    where relation.oid =
      'licitor_ingestion.statistical_source_authorizations'::regclass
  )
  and (
    select relation.relrowsecurity
    from pg_class relation
    where relation.oid =
      'licitor_ingestion.statistical_reported_candidate_attestations'::regclass
  ),
  'both authorization tables have RLS enabled'
);

select ok(
  not has_table_privilege(
    'anon',
    'licitor_ingestion.statistical_source_authorizations',
    'SELECT'
  ),
  'anonymous clients cannot read source authorizations'
);

select ok(
  not has_table_privilege(
    'licitor_collector',
    'licitor_ingestion.statistical_reported_candidate_attestations',
    'SELECT'
  ),
  'the collector cannot read aggregate publication attestations'
);

select ok(
  has_table_privilege(
    'service_role',
    'licitor_ingestion.statistical_source_authorizations',
    'INSERT'
  )
  and has_table_privilege(
    'service_role',
    'licitor_ingestion.statistical_reported_candidate_attestations',
    'INSERT'
  ),
  'trusted server code can append authorization evidence'
);

select ok(
  exists (
    select 1
    from pg_trigger trigger_row
    where trigger_row.tgrelid =
      'licitor_ingestion.statistical_source_authorizations'::regclass
      and trigger_row.tgname = 'statistical_source_authorizations_append_only'
      and trigger_row.tgenabled = 'O'
      and not trigger_row.tgisinternal
  ),
  'source authorizations are append-only'
);

select ok(
  exists (
    select 1
    from pg_trigger trigger_row
    where trigger_row.tgrelid =
      'licitor_ingestion.statistical_reported_candidate_attestations'::regclass
      and trigger_row.tgname =
        'statistical_reported_candidate_attestations_append_only'
      and trigger_row.tgenabled = 'O'
      and not trigger_row.tgisinternal
  ),
  'reported-price candidate attestations are append-only'
);

select ok(
  position(
    'licitor_authorized_reported_price_v2' in
    pg_catalog.pg_get_functiondef(
      'licitor_ingestion.stage_adjudication_price_statistics_build(text[])'::regprocedure
    )
  ) > 0,
  'staging binds new manifests to the authorized reported-price gate'
);

select ok(
  exists (
    select 1
    from pg_constraint constraint_row
    where constraint_row.conrelid =
      'public.adjudication_price_statistics_source_attestations'::regclass
      and pg_get_constraintdef(constraint_row.oid) like
        '%licitor_authorized_reported_price_v2%'
  ),
  'build attestations accept the versioned authorized-price gate'
);

select ok(
  position(
    'licitor_authorized_reported_price_v2' in
    pg_catalog.pg_get_viewdef(
      'public.published_adjudication_price_statistics'::regclass,
      true
    )
  ) > 0,
  'publication requires the authorized reported-price gate'
);

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data
) values (
  'f3610000-0000-4000-8000-000000000001',
  '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated', 'licitor-authorizer@example.test', '',
  now(), now(), now(), '{}'::jsonb, '{}'::jsonb
)
on conflict (id) do nothing;

insert into licitor_ingestion.announcements(id, canonical_url)
values ('361000001', 'https://example.test/licitor/361000001.html')
on conflict (id) do nothing;

insert into licitor_ingestion.candidates(external_id, announcement_id, payload)
values (
  '361000001:lot:1',
  '361000001',
  jsonb_build_object(
    'publication_eligible', false,
    'training_eligible', false,
    'candidate_grade', 'C',
    'evidence_grade', 'C',
    'review_status', 'pending',
    'finality_status', 'unknown',
    'source_is_official', false,
    'source_name', 'licitor',
    'status', 'adjudicated',
    'authorization_basis', 'operator_reported_verbal_consent',
    'authorization_reference', 'licitor-phone-consent-pgtap',
    'source_content_hash', repeat('a', 64),
    'source_page_url', 'https://example.test/licitor/361000001.html',
    'source_capture_evidence', jsonb_build_array(
      jsonb_build_object('capture_sha256', repeat('a', 64))
    ),
    'sale_date', current_date::text,
    'sale_venue_type', 'tribunal',
    'tribunal', 'Tribunal judiciaire de test',
    'starting_price_eur', '100000',
    'adjudication_price_eur', '150000',
    'quality_flags', '[]'::jsonb,
    'property_type', 'apartment'
  )
)
on conflict (external_id) do update set payload = excluded.payload;

insert into licitor_ingestion.candidate_versions(external_id, version_hash, payload)
select external_id, repeat('c', 64), payload
from licitor_ingestion.candidates
where external_id = '361000001:lot:1'
on conflict do nothing;

select is(
  (
    select count(*)
    from licitor_ingestion.statistics_eligible_candidates
    where external_id = '361000001:lot:1'
  ),
  0::bigint,
  'a grade-C candidate is excluded before permission and attestation'
);

insert into licitor_ingestion.statistical_source_authorizations (
  id,
  source_name,
  authorization_basis,
  authorization_reference,
  statistical_scope,
  granted_by_role,
  attested_by,
  evidence,
  authorized_at
) values (
  'f3610000-0000-4000-8000-000000000002',
  'licitor',
  'operator_confirmed_verbal_consent',
  'licitor-phone-consent-pgtap',
  'aggregate_reported_adjudication_prices',
  'responsable web Licitor',
  'f3610000-0000-4000-8000-000000000001',
  '{"channel":"telephone","fixture":"pgtap"}'::jsonb,
  now()
);

select is(
  (
    select count(*)
    from licitor_ingestion.statistics_eligible_candidates
    where external_id = '361000001:lot:1'
  ),
  0::bigint,
  'permission alone does not publish a candidate'
);

insert into licitor_ingestion.statistical_reported_candidate_attestations (
  candidate_external_id,
  candidate_capture_sha256,
  candidate_version_hash,
  decision,
  candidate_grade,
  evidence_grade,
  finality_status,
  publication_scope,
  source_authorization_id,
  evidence
) values (
  '361000001:lot:1',
  repeat('a', 64),
  repeat('c', 64),
  'approved_for_aggregate_reported_statistics',
  'C',
  'C',
  'source_reported_not_officially_verified',
  'aggregate_reported_adjudication_prices_only',
  'f3610000-0000-4000-8000-000000000002',
  '{"fixture":"pgtap","use":"aggregate-only"}'::jsonb
);

select is(
  (
    select count(*)
    from licitor_ingestion.statistics_eligible_candidates
    where external_id = '361000001:lot:1'
  ),
  1::bigint,
  'an exact authorized grade-C price is eligible for aggregate statistics'
);

select is(
  (
    select statistical_reviewer_id
    from licitor_ingestion.statistics_eligible_candidates
    where external_id = '361000001:lot:1'
  ),
  'f3610000-0000-4000-8000-000000000001'::uuid,
  'the eligible row remains attributable to the operator attestation'
);

update licitor_ingestion.candidates
set payload = payload || jsonb_build_object('source_content_hash', repeat('b', 64))
where external_id = '361000001:lot:1';

select is(
  (
    select count(*)
    from licitor_ingestion.statistics_eligible_candidates
    where external_id = '361000001:lot:1'
  ),
  0::bigint,
  'a changed source capture is excluded until separately attested'
);

update licitor_ingestion.candidates
set payload = payload
  || jsonb_build_object('source_content_hash', repeat('a', 64))
  || jsonb_build_object('quality_flags', jsonb_build_array('cached_reparse_failed'))
where external_id = '361000001:lot:1';

select is(
  (
    select count(*)
    from licitor_ingestion.statistics_eligible_candidates
    where external_id = '361000001:lot:1'
  ),
  0::bigint,
  'critical quality flags override an otherwise matching attestation'
);

select throws_ok(
  $$update licitor_ingestion.statistical_reported_candidate_attestations
    set evidence = '{"changed":true}'::jsonb
    where candidate_external_id = '361000001:lot:1'$$,
  'P0001',
  'Licitor statistical authorizations and reported-price attestations are append-only',
  'reported-price attestations cannot be rewritten'
);

select throws_ok(
  $$delete from licitor_ingestion.statistical_source_authorizations
    where id = 'f3610000-0000-4000-8000-000000000002'$$,
  'P0001',
  'Licitor statistical authorizations and reported-price attestations are append-only',
  'source permission evidence cannot be deleted'
);

select ok(
  position('source_is_official' in pg_catalog.pg_get_viewdef(
    'licitor_ingestion.statistics_eligible_candidates'::regclass,
    true
  )) > 0
  and position('aggregate_reported_adjudication_prices_only' in
    pg_catalog.pg_get_viewdef(
      'licitor_ingestion.statistics_eligible_candidates'::regclass,
      true
    )
  ) > 0,
  'the eligibility view encodes non-official, aggregate-only semantics'
);

select * from finish();

rollback;
