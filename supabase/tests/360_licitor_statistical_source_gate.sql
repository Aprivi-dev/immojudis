begin;

set transaction isolation level repeatable read;

select plan(26);

select ok(
  to_regclass('licitor_ingestion.statistical_candidate_reviews') is not null,
  'the private candidate-review decision table exists'
);

select ok(
  exists (
    select 1
    from pg_class relation
    where relation.oid = 'licitor_ingestion.statistical_candidate_reviews'::regclass
      and relation.relrowsecurity
  ),
  'candidate-review decisions have RLS enabled'
);

select ok(
  not has_table_privilege(
    'licitor_collector',
    'licitor_ingestion.statistical_candidate_reviews',
    'SELECT'
  ),
  'the collector cannot read review decisions'
);

select ok(
  has_table_privilege(
    'service_role',
    'licitor_ingestion.statistical_candidate_reviews',
    'INSERT'
  ),
  'trusted server code can append review decisions'
);

select ok(
  exists (
    select 1
    from pg_constraint constraint_row
    where constraint_row.conrelid =
      'licitor_ingestion.statistical_candidate_reviews'::regclass
      and pg_get_constraintdef(constraint_row.oid) like '%jsonb_typeof(evidence)%'
  ),
  'review decisions require non-empty object evidence'
);

select ok(
  has_table_privilege(
    'licitor_collector',
    'licitor_ingestion.diagnostic_price_statistics',
    'SELECT'
  ),
  'the collector retains its raw diagnostic read path'
);

select ok(
  not has_table_privilege(
    'licitor_collector',
    'licitor_ingestion.reviewed_diagnostic_price_statistics',
    'SELECT'
  ),
  'the collector cannot read the reviewed staging projection'
);

select ok(
  position(
    'licitor_ingestion.statistics_candidates' in
      pg_catalog.pg_get_viewdef(
        'licitor_ingestion.diagnostic_price_statistics'::regclass,
        true
      )
  ) > 0
  and position(
    'licitor_ingestion.statistics_eligible_candidates' in
      pg_catalog.pg_get_viewdef(
        'licitor_ingestion.reviewed_diagnostic_price_statistics'::regclass,
        true
      )
  ) > 0
  and position(
    'licitor_ingestion.reviewed_diagnostic_price_statistics' in
      pg_catalog.pg_get_viewdef(
        'licitor_ingestion.diagnostic_court_mappings'::regclass,
        true
      )
  ) > 0
  and position(
    'licitor_ingestion.statistics_eligible_candidates' in
      pg_catalog.pg_get_viewdef(
        'licitor_ingestion.diagnostic_canonical_price_statistics'::regclass,
        true
      )
  ) > 0
  and position(
    'licitor_ingestion.statistics_eligible_candidates' in
      pg_catalog.pg_get_viewdef(
        'licitor_ingestion.diagnostic_price_enrichments'::regclass,
        true
      )
  ) > 0,
  'staging diagnostics use the reviewed chain while the raw diagnostic stays separate'
);

select ok(
  position('transaction_isolation' in
    pg_catalog.pg_get_functiondef(
      'licitor_ingestion.stage_adjudication_price_statistics_build(text[])'::regprocedure
    )) > 0
  and position('app_private.attest_licitor_statistics_build_source' in
    pg_catalog.pg_get_functiondef(
      'licitor_ingestion.stage_adjudication_price_statistics_build(text[])'::regprocedure
    )) > 0
  and position('eligible_candidate_manifest_hash' in
    pg_catalog.pg_get_functiondef(
      'licitor_ingestion.stage_adjudication_price_statistics_build(text[])'::regprocedure
    )) > 0
  and (
    select procedure.prosecdef
    from pg_proc procedure
    where procedure.oid =
      'licitor_ingestion.stage_adjudication_price_statistics_build(text[])'::regprocedure
  ),
  'staging is a guarded SECURITY DEFINER path that binds the reviewed source manifest'
);

select ok(
  to_regclass('public.adjudication_price_statistics_source_attestations') is not null,
  'the per-build source-attestation table exists'
);

select ok(
  not has_table_privilege(
    'service_role',
    'public.adjudication_price_statistics_source_attestations',
    'INSERT'
  ),
  'service role cannot bypass the staging attestation helper with a direct insert'
);

select ok(
  not has_function_privilege(
    'service_role',
    'app_private.attest_licitor_statistics_build_source(uuid,integer,text)',
    'EXECUTE'
  ),
  'service role cannot invoke the private attestation helper directly'
);

select ok(
  not has_table_privilege(
    'service_role',
    'public.adjudication_price_statistics_builds',
    'INSERT'
  )
  and not has_table_privilege(
    'service_role',
    'public.adjudication_price_statistics_snapshots',
    'INSERT'
  ),
  'service role cannot append builds or snapshot cells outside staging'
);

select ok(
  exists (
    select 1
    from pg_trigger trigger_row
    where trigger_row.tgrelid =
      'licitor_ingestion.statistical_candidate_reviews'::regclass
      and trigger_row.tgname = 'statistical_candidate_reviews_append_only'
      and trigger_row.tgenabled = 'O'
      and not trigger_row.tgisinternal
  ),
  'candidate-review decisions are append-only'
);

-- A collector candidate starts as grade C/pending/non-publishable. It is not
-- in the eligible projection before an independent review decision exists.
insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data
) values (
  'f3600000-0000-4000-8000-000000000001',
  '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated', 'licitor-gate-reviewer@example.test', '',
  now(), now(), now(), '{}'::jsonb, '{}'::jsonb
)
on conflict (id) do nothing;

insert into licitor_ingestion.announcements(id, canonical_url)
values ('360000001', 'https://example.test/licitor/360000001.html')
on conflict (id) do nothing;

insert into licitor_ingestion.candidates(external_id, announcement_id, payload)
values (
  '360000001:lot:1',
  '360000001',
  jsonb_build_object(
    'publication_eligible', false,
    'training_eligible', false,
    'candidate_grade', 'C',
    'evidence_grade', 'C',
    'review_status', 'pending',
    'finality_status', 'unknown',
    'source_content_hash', repeat('a', 64),
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
where external_id = '360000001:lot:1'
on conflict do nothing;

select is(
  (
    select count(*)
    from licitor_ingestion.statistics_eligible_candidates
    where external_id = '360000001:lot:1'
  ),
  0::bigint,
  'an unreviewed collector candidate is excluded'
);

insert into licitor_ingestion.statistical_candidate_reviews (
  candidate_external_id,
  candidate_capture_sha256,
  candidate_version_hash,
  decision,
  candidate_grade,
  evidence_grade,
  finality_status,
  publication_eligible,
  reviewer_id,
  evidence
) values (
  '360000001:lot:1',
  repeat('a', 64),
  repeat('c', 64),
  'approved',
  'A',
  'B',
  'procedurally_definitive',
  true,
  'f3600000-0000-4000-8000-000000000001',
  '{"source":"pgtap","reason":"independent review"}'::jsonb
);

select is(
  (
    select count(*)
    from licitor_ingestion.statistics_eligible_candidates
    where external_id = '360000001:lot:1'
  ),
  1::bigint,
  'a reviewed A/B definitive candidate is included'
);

update licitor_ingestion.candidates
set payload = payload || jsonb_build_object('source_content_hash', repeat('b', 64))
where external_id = '360000001:lot:1';

select is(
  (
    select count(*)
    from licitor_ingestion.statistics_eligible_candidates
    where external_id = '360000001:lot:1'
  ),
  0::bigint,
  'a changed capture hash is excluded until it is reviewed again'
);

update licitor_ingestion.candidates
set payload = payload || jsonb_build_object('source_content_hash', repeat('a', 64))
where external_id = '360000001:lot:1';

-- Complete a ten-row reviewed sample so the real staging function can produce
-- a publishable national snapshot. Each source row remains a C/pending
-- collector candidate; eligibility exists only in the separate review table.
insert into licitor_ingestion.announcements(id, canonical_url)
select
  (360000000 + item)::text,
  'https://example.test/licitor/' || (360000000 + item)::text || '.html'
from generate_series(2, 10) item;

insert into licitor_ingestion.candidates(external_id, announcement_id, payload)
select
  (360000000 + item)::text || ':lot:1',
  (360000000 + item)::text,
  jsonb_build_object(
    'publication_eligible', false,
    'training_eligible', false,
    'candidate_grade', 'C',
    'evidence_grade', 'C',
    'review_status', 'pending',
    'finality_status', 'unknown',
    'source_content_hash', pg_catalog.encode(
      extensions.digest('licitor-gate-capture-' || item::text, 'sha256'),
      'hex'
    ),
    'sale_date', current_date::text,
    'sale_venue_type', 'tribunal',
    'tribunal', 'Tribunal judiciaire de test',
    'starting_price_eur', (100000 + item * 1000)::text,
    'adjudication_price_eur', (150000 + item * 1000)::text,
    'quality_flags', '[]'::jsonb,
    'property_type', 'apartment'
  )
from generate_series(2, 10) item;

insert into licitor_ingestion.candidate_versions(external_id, version_hash, payload)
select
  candidate.external_id,
  pg_catalog.encode(
    extensions.digest('licitor-gate-version-' || candidate.external_id, 'sha256'),
    'hex'
  ),
  candidate.payload
from licitor_ingestion.candidates candidate
where candidate.external_id ~ '^3600000(0[2-9]|10):lot:1$';

insert into licitor_ingestion.statistical_candidate_reviews (
  candidate_external_id,
  candidate_capture_sha256,
  candidate_version_hash,
  decision,
  candidate_grade,
  evidence_grade,
  finality_status,
  publication_eligible,
  reviewer_id,
  evidence
)
select
  version.external_id,
  version.payload->>'source_content_hash',
  version.version_hash,
  'approved',
  'A',
  'B',
  'procedurally_definitive',
  true,
  'f3600000-0000-4000-8000-000000000001',
  jsonb_build_object('source', 'pgtap', 'reason', 'independent review')
from licitor_ingestion.candidate_versions version
where version.external_id ~ '^3600000(0[2-9]|10):lot:1$';

select is(
  (select count(*) from licitor_ingestion.statistics_eligible_candidates),
  10::bigint,
  'the reviewed projection contains one row per current candidate'
);

insert into licitor_ingestion.runs (
  id, mode, status, max_requests, finished_at
) values (
  'licitor-gate-pgtap', 'backfill', 'completed', 100, now()
);

-- A legacy approved build has snapshots but no attestation and is therefore
-- retained for audit while hidden from the publication view.
set local role service_role;

select throws_ok(
  $$select app_private.attest_licitor_statistics_build_source(null, null, null)$$,
  '42501',
  'permission denied for function attest_licitor_statistics_build_source',
  'the source-attestation helper cannot be called outside staging'
);

select throws_ok(
  $$insert into public.adjudication_price_statistics_builds(source_name)
    values ('licitor')$$,
  '42501',
  'permission denied for table adjudication_price_statistics_builds',
  'service role cannot insert a build outside staging'
);

reset role;

insert into public.adjudication_price_statistics_builds (
  id, source_name, source_run_ids, period_start, period_end, window_months,
  minimum_sample, active_candidate_lots, national_sample_size,
  mapped_sample_size, unmatched_sample_size, canonical_court_count,
  methodology_version, source_manifest_hash
) values (
  'f3600000-0000-4000-8000-000000000010',
  'licitor', array['legacy-pgtap'], current_date - interval '3 years', current_date,
  36, 10, 10, 10, 0, 10, 0,
  'licitor_canonical_price_statistics_v1', repeat('d', 64)
);

insert into public.adjudication_price_statistics_snapshots (
  id, build_id, scope_type, scope_label, period_start, period_end,
  minimum_sample, sample_size, median_hammer_to_starting_ratio,
  above_starting_rate, at_least_double_rate, median_hammer_price_eur,
  median_starting_price_eur, quality_status, methodology_version,
  statistics_hash
) values (
  'f3600000-0000-4000-8000-000000000011',
  'f3600000-0000-4000-8000-000000000010', 'national', 'France entière',
  current_date - interval '3 years', current_date, 10, 10, 1.5,
  0.5, 0.1, 150000, 100000, 'sample_threshold_met_not_reviewed',
  'licitor_canonical_price_statistics_v1', repeat('e', 64)
);

insert into public.adjudication_price_statistics_build_reviews (
  build_id, decision, reviewer_id, rights_basis_confirmed,
  methodology_approved, court_mappings_approved, notes
) values (
  'f3600000-0000-4000-8000-000000000010', 'approved',
  'f3600000-0000-4000-8000-000000000001', true, true, true,
  'legacy fixture'
);

set local role service_role;

select is(
  (
    select count(*)
    from public.published_adjudication_price_statistics
    where build_id = 'f3600000-0000-4000-8000-000000000010'
  ),
  0::bigint,
  'an approved legacy build without source attestation is quarantined'
);

select lives_ok(
  $$select licitor_ingestion.stage_adjudication_price_statistics_build(
      array['licitor-gate-pgtap']::text[]
    )$$,
  'the real staging function creates a reviewed-source build'
);

select is(
  (
    select count(*)
    from public.adjudication_price_statistics_source_attestations
  ),
  1::bigint,
  'staging creates exactly one source attestation and does not bless the legacy build'
);

select lives_ok(
  $$select licitor_ingestion.stage_adjudication_price_statistics_build(
      array['licitor-gate-pgtap']::text[]
    )$$,
  'staging is idempotent for the same reviewed source manifest'
);

select is(
  (
    select count(*)
    from public.adjudication_price_statistics_source_attestations
  ),
  1::bigint,
  'an idempotent staging call does not duplicate the build or its attestation'
);

insert into public.adjudication_price_statistics_build_reviews (
  build_id, decision, reviewer_id, rights_basis_confirmed,
  methodology_approved, court_mappings_approved, notes
)
select
  attestation.build_id,
  'approved',
  'f3600000-0000-4000-8000-000000000001',
  true,
  true,
  true,
  'new attested fixture'
from public.adjudication_price_statistics_source_attestations attestation;

select is(
  (
    select count(*)
    from public.published_adjudication_price_statistics
    where build_id in (
      select build_id
      from public.adjudication_price_statistics_source_attestations
    )
  ),
  1::bigint,
  'a new attested build with an approved review is publishable'
);

select * from finish();

rollback;
