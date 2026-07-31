begin;

select plan(58);

select has_table('public', 'auction_lots', 'Outcome Graph has a lot registry');
select has_table('public', 'auction_rounds', 'Outcome Graph versions hearings');
select has_table('public', 'auction_events', 'Outcome Graph has an event log');
select has_table('public', 'auction_outcomes', 'Outcome Graph versions outcomes');
select has_table('public', 'auction_outcome_evidence', 'Outcome Graph records evidence');
select has_table('public', 'evidence_reviews', 'Outcome Graph records independent reviews');
select has_table('public', 'auction_feature_snapshots', 'Outcome Graph freezes pre-hearing features');
select has_table('public', 'cohort_statistics', 'Outcome Graph stores versioned cohorts');
select has_table('public', 'model_versions', 'Outcome Graph has a model registry');
select has_table('public', 'auction_predictions', 'Outcome Graph stores immutable predictions');
select has_column('public', 'auction_lots', 'auction_sale_id', 'lot registry bridges to the catalogue');
select hasnt_column(
  'public',
  'auction_predictions',
  'ceiling_eur',
  'personal bid ceilings are not persisted in shared predictions'
);

select ok(
  (
    select count(*) = 16 and bool_and(relrowsecurity)
    from pg_class
    join pg_namespace on pg_namespace.oid = pg_class.relnamespace
    where pg_namespace.nspname = 'public'
      and pg_class.relname in (
        'outcome_addresses', 'outcome_courts', 'data_sources', 'raw_artifacts',
        'auction_cases', 'auction_lots', 'auction_rounds', 'auction_events',
        'auction_outcomes', 'auction_outcome_evidence', 'evidence_reviews',
        'auction_feature_snapshots', 'cohort_definitions', 'cohort_statistics',
        'model_versions', 'auction_predictions'
      )
  ),
  'RLS is enabled on every Outcome Graph table'
);
select ok(
  not has_table_privilege('anon', 'public.auction_predictions', 'SELECT'),
  'anonymous users cannot read predictions'
);
select ok(
  (
    select bool_and(
      not has_table_privilege(
        'authenticated',
        format('public.%I', relation_name),
        'SELECT'
      )
    )
    from unnest(array[
      'outcome_addresses', 'outcome_courts', 'data_sources', 'raw_artifacts',
      'auction_cases', 'auction_lots', 'auction_rounds', 'auction_events',
      'auction_outcomes', 'auction_outcome_evidence', 'evidence_reviews',
      'auction_feature_snapshots', 'cohort_definitions', 'cohort_statistics',
      'model_versions', 'auction_predictions'
    ]::text[]) as outcome_table(relation_name)
  ),
  'authenticated users cannot bypass the premium API through registry table grants'
);
select ok(
  not has_table_privilege('authenticated', 'public.auction_predictions', 'INSERT'),
  'authenticated users cannot write predictions'
);
select ok(
  has_table_privilege('service_role', 'public.auction_predictions', 'INSERT'),
  'the trusted worker may insert predictions'
);

select throws_ok(
  $$insert into public.data_sources (
      name, legal_review_status, ingestion_policy, active
    ) values (
      'unreviewed-automation', 'pending', 'allowed_automated', true
    )$$,
  '23514',
  'new row for relation "data_sources" violates check constraint "data_sources_automation_review_check"',
  'automation is denied until its source policy is approved'
);

insert into auth.users (
  id,
  instance_id,
  aud,
  role,
  email,
  encrypted_password,
  email_confirmed_at,
  created_at,
  updated_at,
  raw_app_meta_data,
  raw_user_meta_data
) values
  (
    '91000000-0000-4000-8000-000000000001',
    '00000000-0000-0000-0000-000000000000',
    'authenticated',
    'authenticated',
    'outcome-free@example.test',
    '',
    now(),
    now(),
    now(),
    '{}'::jsonb,
    '{}'::jsonb
  ),
  (
    '92000000-0000-4000-8000-000000000001',
    '00000000-0000-0000-0000-000000000000',
    'authenticated',
    'authenticated',
    'outcome-premium@example.test',
    '',
    now(),
    now(),
    now(),
    '{}'::jsonb,
    '{}'::jsonb
  ),
  (
    '92500000-0000-4000-8000-000000000001',
    '00000000-0000-0000-0000-000000000000',
    'authenticated',
    'authenticated',
    'outcome-admin@example.test',
    '',
    now(),
    now(),
    now(),
    '{}'::jsonb,
    '{}'::jsonb
  );

update public.user_profiles
set account_tier = 'premium'
where user_id = '92000000-0000-4000-8000-000000000001';

update public.user_profiles
set user_role = 'admin'
where user_id = '92500000-0000-4000-8000-000000000001';

set local role service_role;

insert into public.data_sources (
  id, name, publisher, legal_review_status, ingestion_policy, active
) values
  (
    '92600000-0000-4000-8000-000000000001',
    'outcome-source-one',
    'Source test 1',
    'approved',
    'allowed_automated',
    true
  ),
  (
    '92600000-0000-4000-8000-000000000002',
    'outcome-source-two',
    'Source test 2',
    'approved',
    'allowed_automated',
    true
  );

insert into public.raw_artifacts (
  id, source_id, external_record_id, storage_object_path, mime_type, byte_size,
  content_hash, captured_at, connector_version
) values
  (
    '92700000-0000-4000-8000-000000000001',
    '92600000-0000-4000-8000-000000000001',
    'artifact-one',
    'outcome-tests/artifact-one.pdf',
    'application/pdf',
    128,
    repeat('1', 64),
    '2026-07-21T09:00:00Z',
    'test-v1'
  ),
  (
    '92700000-0000-4000-8000-000000000002',
    '92600000-0000-4000-8000-000000000002',
    'artifact-two',
    'outcome-tests/artifact-two.pdf',
    'application/pdf',
    128,
    repeat('2', 64),
    '2026-07-21T09:00:00Z',
    'test-v1'
  );

insert into public.auction_sales (id, source_name, source_url, starting_price_eur)
values (
  '93000000-0000-4000-8000-000000000001',
  'outcome-test',
  'https://example.test/outcome-sale',
  90000
);

insert into public.outcome_courts (id, code, name)
values (
  '94000000-0000-4000-8000-000000000001',
  'TJ-TEST',
  'Tribunal judiciaire de test'
);

insert into public.auction_cases (id, court_id, court_case_number, procedure_type)
values (
  '95000000-0000-4000-8000-000000000001',
  '94000000-0000-4000-8000-000000000001',
  'RG-TEST-1',
  'saisie_immobiliere'
);

insert into public.auction_lots (
  id,
  auction_case_id,
  auction_sale_id,
  property_type,
  initial_starting_price_eur
) values (
  '96000000-0000-4000-8000-000000000001',
  '95000000-0000-4000-8000-000000000001',
  '93000000-0000-4000-8000-000000000001',
  'apartment',
  90000
);

insert into public.auction_cases (id, court_id, court_case_number, procedure_type)
values (
  '95000000-0000-4000-8000-000000000002',
  '94000000-0000-4000-8000-000000000001',
  'RG-TEST-2',
  'saisie_immobiliere'
);

insert into public.auction_lots (
  id, auction_case_id, property_type, initial_starting_price_eur
) values (
  '96000000-0000-4000-8000-000000000002',
  '95000000-0000-4000-8000-000000000002',
  'house',
  110000
);

insert into public.auction_rounds (
  id,
  lot_id,
  round_kind,
  sequence_number,
  scheduled_at,
  court_id,
  initial_starting_price_eur,
  effective_starting_price_eur,
  current_status
) values (
  '97000000-0000-4000-8000-000000000001',
  '96000000-0000-4000-8000-000000000001',
  'initial',
  1,
  '2026-08-01T09:00:00Z',
  '94000000-0000-4000-8000-000000000001',
  90000,
  90000,
  'confirmed'
);

insert into public.auction_rounds (
  id,
  lot_id,
  round_kind,
  sequence_number,
  scheduled_at,
  court_id,
  initial_starting_price_eur,
  effective_starting_price_eur,
  current_status
) values (
  '97000000-0000-4000-8000-000000000003',
  '96000000-0000-4000-8000-000000000002',
  'initial',
  1,
  '2026-08-03T09:00:00Z',
  '94000000-0000-4000-8000-000000000001',
  110000,
  110000,
  'confirmed'
);

select throws_ok(
  $$insert into public.auction_rounds (
      id, lot_id, round_kind, sequence_number, court_id, previous_round_id,
      current_status
    ) values (
      '97000000-0000-4000-8000-000000000004',
      '96000000-0000-4000-8000-000000000002',
      'postponed',
      2,
      '94000000-0000-4000-8000-000000000001',
      '97000000-0000-4000-8000-000000000001',
      'scheduled'
    )$$,
  '23514',
  'Outcome round lineage must stay on one lot and move to a higher sequence.',
  'a successor round cannot jump to another lot'
);

insert into public.auction_rounds (
  id,
  lot_id,
  round_kind,
  sequence_number,
  court_id,
  initial_starting_price_eur,
  effective_starting_price_eur,
  previous_round_id,
  current_status
) values (
  '97000000-0000-4000-8000-000000000002',
  '96000000-0000-4000-8000-000000000001',
  'postponed',
  2,
  '94000000-0000-4000-8000-000000000001',
  90000,
  90000,
  '97000000-0000-4000-8000-000000000001',
  'confirmed'
);

insert into public.cohort_definitions (
  id, cohort_key, definition_version, cohort_level, label
) values
  (
    '98000000-0000-4000-8000-000000000001',
    'national-apartment',
    1,
    'national_property_type',
    'National · appartement'
  ),
  (
    '98000000-0000-4000-8000-000000000002',
    'national-apartment-small',
    1,
    'national_property_type',
    'National · appartement · insuffisant'
  );

select throws_ok(
  $$insert into public.cohort_statistics (
      id, cohort_definition_id, prediction_horizon, period_start, period_end,
      sample_size, tribunal_sample_size, training_eligible, statistics_hash,
      created_at
    ) values (
      '98100000-0000-4000-8000-000000000099',
      '98000000-0000-4000-8000-000000000001',
      'T-7',
      '2024-01-01',
      '2026-06-30',
      47,
      19,
      true,
      repeat('z', 64),
      '2026-07-23T09:00:00Z'
    )$$,
  '23514',
  'Training-eligible cohort statistics require complete aggregate payloads.',
  'an empty aggregate cannot be marked eligible for training or prediction'
);

insert into public.cohort_statistics (
  id,
  cohort_definition_id,
  prediction_horizon,
  period_start,
  period_end,
  sample_size,
  tribunal_sample_size,
  training_eligible,
  has_blocking_conflict,
  flow_probabilities,
  initial_price_ratios,
  final_price_ratios,
  surenchere_probability,
  statistics_hash,
  created_at
) values
  (
    '98100000-0000-4000-8000-000000000001',
    '98000000-0000-4000-8000-000000000001',
    'T-7',
    '2024-01-01',
    '2026-06-30',
    47,
    19,
    true,
    false,
    '{"held_probability":0.88,"postponed_probability":0.08,"cancelled_or_not_requested_probability":0.04,"adjudicated_if_held_probability":0.91,"no_bid_if_held_probability":0.09}'::jsonb,
    '{"p10":1.3667,"p50":1.6222,"p90":1.9889}'::jsonb,
    '{"p10":1.4000,"p50":1.6778,"p90":2.0889}'::jsonb,
    0.10,
    repeat('a', 64),
    '2026-07-23T09:00:00Z'
  ),
  (
    '98100000-0000-4000-8000-000000000002',
    '98000000-0000-4000-8000-000000000002',
    'T-7',
    '2024-01-01',
    '2026-06-30',
    9,
    2,
    false,
    false,
    '{}'::jsonb,
    '{}'::jsonb,
    '{}'::jsonb,
    null,
    repeat('b', 64),
    '2026-07-23T09:00:00Z'
  );

select throws_ok(
  $$insert into public.model_versions (
      id, model_key, version, model_kind, segment, status,
      feature_schema_version, training_sample_size, approved_at, approved_by, created_at
    ) values (
      '98200000-0000-4000-8000-000000000099',
      'outcome-cohort-bypass',
      '1.0.0',
      'cohort_baseline',
      'national',
      'active',
      'outcome-v1',
      47,
      '2026-07-20T09:00:00Z',
      '92000000-0000-4000-8000-000000000001',
      '2026-07-19T09:00:00Z'
    )$$,
  '23514',
  'Outcome model versions must be inserted as unapproved drafts.',
  'a model cannot bypass the reviewed promotion workflow on insert'
);

insert into public.model_versions (
  id,
  model_key,
  version,
  model_kind,
  segment,
  feature_schema_version,
  training_cutoff_at,
  training_sample_size,
  created_at
) values (
  '98200000-0000-4000-8000-000000000001',
  'outcome-cohort',
  '1.0.0',
  'cohort_baseline',
  'national',
  'outcome-v1',
  '2026-06-30T23:59:59Z',
  47,
  '2026-07-19T09:00:00Z'
);

select throws_ok(
  $$update public.model_versions
    set
      status = 'validated',
      approved_at = '2026-07-20T09:00:00Z',
      approved_by = '92000000-0000-4000-8000-000000000001'
    where id = '98200000-0000-4000-8000-000000000001'$$,
  '23514',
  'Only an administrator may approve an Outcome model.',
  'a premium subscriber cannot approve a model version'
);

update public.model_versions
set
  status = 'validated',
  approved_at = '2026-07-20T09:00:00Z',
  approved_by = '92500000-0000-4000-8000-000000000001'
where id = '98200000-0000-4000-8000-000000000001';

update public.model_versions
set status = 'active'
where id = '98200000-0000-4000-8000-000000000001';

insert into public.model_versions (
  id, model_key, version, model_kind, segment, feature_schema_version,
  training_cutoff_at, training_sample_size, created_at
) values (
  '98200000-0000-4000-8000-000000000002',
  'outcome-cohort',
  '1.1.0',
  'cohort_baseline',
  'national',
  'outcome-v1',
  '2026-06-30T23:59:59Z',
  47,
  '2026-07-19T09:00:00Z'
);

update public.model_versions
set
  status = 'validated',
  approved_at = '2026-07-21T09:00:00Z',
  approved_by = '92500000-0000-4000-8000-000000000001'
where id = '98200000-0000-4000-8000-000000000002';

update public.model_versions
set status = 'shadow'
where id = '98200000-0000-4000-8000-000000000002';

insert into public.model_versions (
  id, model_key, version, model_kind, segment, feature_schema_version,
  training_sample_size, created_at
) values (
  '98200000-0000-4000-8000-000000000003',
  'outcome-cohort-no-cutoff',
  '1.0.0',
  'cohort_baseline',
  'national',
  'outcome-v1',
  47,
  '2026-07-19T09:00:00Z'
);

update public.model_versions
set
  status = 'validated',
  approved_at = '2026-07-21T09:00:00Z',
  approved_by = '92500000-0000-4000-8000-000000000001'
where id = '98200000-0000-4000-8000-000000000003';

update public.model_versions
set status = 'active'
where id = '98200000-0000-4000-8000-000000000003';

select throws_ok(
  $$insert into public.auction_feature_snapshots (
      id, lot_id, round_id, prediction_horizon, feature_cutoff_at, built_at,
      feature_schema_version, feature_builder_version, features, source_manifest,
      source_manifest_hash, snapshot_hash, leakage_check_status
    ) values (
      '98300000-0000-4000-8000-000000000001',
      '96000000-0000-4000-8000-000000000001',
      '97000000-0000-4000-8000-000000000001',
      'T-7',
      '2026-08-01T09:00:00Z',
      '2026-08-01T09:00:01Z',
      'outcome-v1',
      'builder-v1',
      '{}'::jsonb,
      '[]'::jsonb,
      repeat('1', 64),
      repeat('2', 64),
      'pending'
    )$$,
  '23514',
  'Snapshot cutoff must precede the hearing.',
  'a snapshot cutoff cannot include the hearing itself'
);

select throws_ok(
  $$insert into public.auction_feature_snapshots (
      id, lot_id, round_id, prediction_horizon, feature_cutoff_at, built_at,
      feature_schema_version, feature_builder_version, features, source_manifest,
      source_manifest_hash, snapshot_hash, leakage_check_status
    ) values (
      '98300000-0000-4000-8000-000000000002',
      '96000000-0000-4000-8000-000000000001',
      '97000000-0000-4000-8000-000000000001',
      'T-7',
      '2026-07-24T09:00:00Z',
      '2026-08-01T10:00:00Z',
      'outcome-v1',
      'builder-v1',
      '{}'::jsonb,
      '[]'::jsonb,
      repeat('3', 64),
      repeat('4', 64),
      'pending'
    )$$,
  '23514',
  'A post-hearing snapshot must be marked retrospective.',
  'a post-hearing reconstruction cannot masquerade as prospective'
);

select throws_ok(
  $$insert into public.auction_feature_snapshots (
      id, lot_id, round_id, prediction_horizon, feature_cutoff_at, built_at,
      feature_schema_version, feature_builder_version, features, source_manifest,
      source_manifest_hash, snapshot_hash, leakage_check_status
    ) values (
      '98300000-0000-4000-8000-000000000003',
      '96000000-0000-4000-8000-000000000001',
      '97000000-0000-4000-8000-000000000001',
      'T-7',
      '2026-07-24T09:00:00Z',
      '2026-07-25T10:00:00Z',
      'outcome-v1',
      'builder-v1',
      '{}'::jsonb,
      '[{"published_at":"2026-07-20T09:00:00Z","captured_at":"2026-07-24T10:00:00Z"}]'::jsonb,
      repeat('5', 64),
      repeat('6', 64),
      'passed'
    )$$,
  '23514',
  'Source manifest leaks post-cutoff information.',
  'a source captured after cutoff fails the leakage check'
);

select lives_ok(
  $$insert into public.auction_feature_snapshots (
      id, lot_id, round_id, prediction_horizon, feature_cutoff_at, built_at,
      feature_schema_version, feature_builder_version, features, source_manifest,
      source_manifest_hash, snapshot_hash, leakage_check_status, training_eligible
    ) values (
      '98300000-0000-4000-8000-000000000004',
      '96000000-0000-4000-8000-000000000001',
      '97000000-0000-4000-8000-000000000001',
      'T-7',
      '2026-07-24T09:00:00Z',
      '2026-07-25T10:00:00Z',
      'outcome-v1',
      'builder-v1',
      '{"market_value_eur":"172000.00"}'::jsonb,
      '[{"published_at":"2026-07-20T09:00:00Z","captured_at":"2026-07-21T09:00:00Z"}]'::jsonb,
      repeat('7', 64),
      repeat('8', 64),
      'passed',
      true
    )$$,
  'a prospective snapshot with a pre-cutoff manifest is accepted'
);

insert into public.auction_feature_snapshots (
  id, lot_id, round_id, prediction_horizon, feature_cutoff_at, built_at,
  feature_schema_version, feature_builder_version, features, source_manifest,
  source_manifest_hash, snapshot_hash, leakage_check_status, training_eligible
) values (
  '98300000-0000-4000-8000-000000000006',
  '96000000-0000-4000-8000-000000000001',
  '97000000-0000-4000-8000-000000000002',
  'T-7',
  '2026-07-26T09:00:00Z',
  '2026-07-26T10:00:00Z',
  'outcome-v1',
  'builder-v1',
  '{"market_value_eur":"172000.00"}'::jsonb,
  '[{"published_at":"2026-07-20T09:00:00Z","captured_at":"2026-07-21T09:00:00Z"}]'::jsonb,
  repeat('f', 64),
  repeat('g', 64),
  'passed',
  true
);

select throws_ok(
  $$update public.auction_rounds
    set scheduled_at = '2026-08-02T09:00:00Z'
    where id = '97000000-0000-4000-8000-000000000001'$$,
  '55000',
  'Outcome round forecast inputs are immutable once a feature snapshot exists; create a new round.',
  'rescheduling after a feature snapshot creates a new round instead of rewriting chronology'
);

select lives_ok(
  $$insert into public.auction_feature_snapshots (
      id, lot_id, round_id, prediction_horizon, feature_cutoff_at, built_at,
      feature_schema_version, feature_builder_version, features, source_manifest,
      source_manifest_hash, snapshot_hash, leakage_check_status, retrospective,
      training_eligible, created_at
    ) values (
      '98300000-0000-4000-8000-000000000005',
      '96000000-0000-4000-8000-000000000001',
      '97000000-0000-4000-8000-000000000001',
      'T-7',
      '2026-07-24T09:00:00Z',
      '2026-08-02T10:00:00Z',
      'outcome-v1',
      'builder-v1',
      '{}'::jsonb,
      '[]'::jsonb,
      repeat('9', 64),
      repeat('0', 64),
      'pending',
      true,
      false,
      '2026-08-02T10:00:01Z'
    )$$,
  'a post-hearing reconstruction is admitted only as retrospective and non-training'
);

select throws_ok(
  $$insert into public.auction_events (
      id, case_id, lot_id, round_id, event_type, source_id, raw_artifact_id
    ) values (
      '98400000-0000-4000-8000-000000000090',
      '95000000-0000-4000-8000-000000000002',
      '96000000-0000-4000-8000-000000000001',
      '97000000-0000-4000-8000-000000000001',
      'scheduled',
      '92600000-0000-4000-8000-000000000001',
      '92700000-0000-4000-8000-000000000001'
    )$$,
  '23503',
  null,
  'an event cannot combine a case, lot, and round from different lineages'
);

select throws_ok(
  $$insert into public.auction_events (
      id, case_id, lot_id, round_id, event_type, source_id, raw_artifact_id
    ) values (
      '98400000-0000-4000-8000-000000000091',
      '95000000-0000-4000-8000-000000000001',
      '96000000-0000-4000-8000-000000000001',
      '97000000-0000-4000-8000-000000000001',
      'scheduled',
      '92600000-0000-4000-8000-000000000001',
      '92700000-0000-4000-8000-000000000002'
    )$$,
  '23503',
  null,
  'an event raw artifact must belong to its declared source'
);

insert into public.auction_events (
  id, case_id, lot_id, round_id, event_type, source_id, raw_artifact_id,
  observed_at
)
values (
  '98400000-0000-4000-8000-000000000001',
  '95000000-0000-4000-8000-000000000001',
  '96000000-0000-4000-8000-000000000001',
  '97000000-0000-4000-8000-000000000001',
  'scheduled',
  '92600000-0000-4000-8000-000000000001',
  '92700000-0000-4000-8000-000000000001',
  '2026-07-21T10:00:00Z'
);

select throws_ok(
  $$insert into public.auction_events (
      id, case_id, lot_id, round_id, event_type, source_id, raw_artifact_id,
      observed_at, supersedes_event_id, correction_reason
    ) values (
      '98400000-0000-4000-8000-000000000092',
      '95000000-0000-4000-8000-000000000002',
      '96000000-0000-4000-8000-000000000002',
      '97000000-0000-4000-8000-000000000003',
      'scheduled',
      '92600000-0000-4000-8000-000000000002',
      '92700000-0000-4000-8000-000000000002',
      '2026-07-22T10:00:00Z',
      '98400000-0000-4000-8000-000000000001',
      'Mauvais rattachement initial'
    )$$,
  '23514',
  'Event supersession must preserve its entity lineage and move forward in time.',
  'an event correction cannot jump to another case, lot, or round'
);

select lives_ok(
  $$insert into public.auction_events (
      id, case_id, lot_id, round_id, event_type, source_id, raw_artifact_id,
      observed_at, supersedes_event_id, correction_reason
    ) values (
      '98400000-0000-4000-8000-000000000002',
      '95000000-0000-4000-8000-000000000001',
      '96000000-0000-4000-8000-000000000001',
      '97000000-0000-4000-8000-000000000001',
      'confirmed',
      '92600000-0000-4000-8000-000000000001',
      '92700000-0000-4000-8000-000000000001',
      '2026-07-22T10:00:00Z',
      '98400000-0000-4000-8000-000000000001',
      'Confirmation par nouvelle observation'
    )$$,
  'an event correction appends one coherent successor'
);

-- Exercise the trigger itself as the migration owner. The service role has no
-- UPDATE privilege on append-only registries, which is an additional guard.
reset role;

select throws_ok(
  $$update public.auction_events
    set event_type = 'cancelled'
    where id = '98400000-0000-4000-8000-000000000001'$$,
  '55000',
  'public.auction_events is append-only; insert a correcting version instead.',
  'an event cannot be rewritten'
);

set local role service_role;

select throws_ok(
  $$insert into public.auction_predictions (
      id, round_id, snapshot_id, model_version_id, cohort_statistics_id,
      prediction_status, generated_at, horizon, probabilities, quantiles,
      sample_size, prediction_hash
    ) values (
      '98500000-0000-4000-8000-000000000009',
      '97000000-0000-4000-8000-000000000001',
      '98300000-0000-4000-8000-000000000004',
      '98200000-0000-4000-8000-000000000003',
      '98100000-0000-4000-8000-000000000001',
      'ready',
      '2026-07-25T11:00:00Z',
      'T-7',
      '{"held_probability":0.88,"postponed_probability":0.08,"cancelled_or_not_requested_probability":0.04,"adjudicated_if_held_probability":0.91,"no_bid_if_held_probability":0.09,"surenchere_probability":0.10}'::jsonb,
      '{"initial_price_eur":{"p10":"123000","p50":"146000","p90":"179000"},"final_price_eur":{"p10":"126000","p50":"151000","p90":"188000"}}'::jsonb,
      47,
      repeat('m', 64)
    )$$,
  '23514',
  'Ready prediction requires a model training cutoff.',
  'a ready prediction cannot use a model without a training cutoff'
);

select throws_ok(
  $$insert into public.auction_predictions (
      id, round_id, snapshot_id, model_version_id, cohort_statistics_id,
      prediction_status, generated_at, horizon, probabilities, quantiles,
      sample_size, prediction_hash
    ) values (
      '98500000-0000-4000-8000-000000000004',
      '97000000-0000-4000-8000-000000000002',
      '98300000-0000-4000-8000-000000000006',
      '98200000-0000-4000-8000-000000000001',
      '98100000-0000-4000-8000-000000000001',
      'ready',
      '2026-07-27T11:00:00Z',
      'T-7',
      '{"held_probability":0.88,"postponed_probability":0.08,"cancelled_or_not_requested_probability":0.04,"adjudicated_if_held_probability":0.91,"no_bid_if_held_probability":0.09,"surenchere_probability":0.10}'::jsonb,
      '{"initial_price_eur":{"p10":"123000","p50":"146000","p90":"179000"},"final_price_eur":{"p10":"126000","p50":"151000","p90":"188000"}}'::jsonb,
      47,
      repeat('h', 64)
    )$$,
  '23514',
  'Ready prediction requires a scheduled hearing.',
  'a ready prediction requires a known hearing date for anti-leak chronology'
);

select throws_ok(
  $$insert into public.auction_predictions (
      id, round_id, snapshot_id, model_version_id, cohort_statistics_id,
      prediction_kind, prediction_status, generated_at, horizon, probabilities,
      quantiles, sample_size, prediction_hash
    ) values (
      '98500000-0000-4000-8000-000000000005',
      '97000000-0000-4000-8000-000000000001',
      '98300000-0000-4000-8000-000000000004',
      '98200000-0000-4000-8000-000000000002',
      '98100000-0000-4000-8000-000000000001',
      'outcome_graph',
      'ready',
      '2026-07-25T11:00:00Z',
      'T-7',
      '{"held_probability":0.88,"postponed_probability":0.08,"cancelled_or_not_requested_probability":0.04,"adjudicated_if_held_probability":0.91,"no_bid_if_held_probability":0.09,"surenchere_probability":0.10}'::jsonb,
      '{"initial_price_eur":{"p10":"123000","p50":"146000","p90":"179000"},"final_price_eur":{"p10":"126000","p50":"151000","p90":"188000"}}'::jsonb,
      47,
      repeat('i', 64)
    )$$,
  '23514',
  'Published Outcome Graph prediction requires an active model.',
  'a shadow model cannot publish a customer-facing prediction'
);

select throws_ok(
  $$insert into public.auction_predictions (
      id, round_id, snapshot_id, model_version_id, cohort_statistics_id,
      prediction_status, generated_at, horizon, probabilities, quantiles,
      sample_size, prediction_hash
    ) values (
      '98500000-0000-4000-8000-000000000001',
      '97000000-0000-4000-8000-000000000001',
      '98300000-0000-4000-8000-000000000004',
      '98200000-0000-4000-8000-000000000001',
      '98100000-0000-4000-8000-000000000002',
      'ready',
      '2026-07-25T11:00:00Z',
      'T-7',
      '{"held_probability":0.88,"postponed_probability":0.08,"cancelled_or_not_requested_probability":0.04,"adjudicated_if_held_probability":0.91,"no_bid_if_held_probability":0.09,"surenchere_probability":0.10}'::jsonb,
      '{"initial_price_eur":{"p10":"123000","p50":"146000","p90":"179000"},"final_price_eur":{"p10":"126000","p50":"151000","p90":"188000"}}'::jsonb,
      10,
      repeat('c', 64)
    )$$,
  '23514',
  'Ready prediction requires an eligible conflict-free cohort.',
  'a cohort below ten verified results cannot publish a ready prediction'
);

select throws_ok(
  $$insert into public.auction_predictions (
      id, round_id, snapshot_id, model_version_id, cohort_statistics_id,
      prediction_status, generated_at, horizon, probabilities, quantiles,
      sample_size, prediction_hash
    ) values (
      '98500000-0000-4000-8000-000000000003',
      '97000000-0000-4000-8000-000000000001',
      '98300000-0000-4000-8000-000000000004',
      '98200000-0000-4000-8000-000000000001',
      '98100000-0000-4000-8000-000000000001',
      'ready',
      '2026-07-25T11:00:00Z',
      'T-7',
      '{"held_probability":0.88,"postponed_probability":0.08,"cancelled_or_not_requested_probability":0.04,"adjudicated_if_held_probability":0.91,"no_bid_if_held_probability":0.09,"surenchere_probability":0.10}'::jsonb,
      '{}'::jsonb,
      47,
      repeat('e', 64)
    )$$,
  '23514',
  'Prediction quantiles must be positive and monotone.',
  'a ready prediction cannot omit its price quantiles'
);

select throws_ok(
  $$insert into public.auction_predictions (
      id, round_id, snapshot_id, model_version_id, cohort_statistics_id,
      prediction_status, generated_at, horizon, probabilities, quantiles,
      sample_size, prediction_hash
    ) values (
      '98500000-0000-4000-8000-000000000006',
      '97000000-0000-4000-8000-000000000001',
      '98300000-0000-4000-8000-000000000004',
      '98200000-0000-4000-8000-000000000001',
      '98100000-0000-4000-8000-000000000001',
      'ready',
      '2026-07-25T11:00:00Z',
      'T-7',
      '{"held_probability":0.88,"postponed_probability":0.08,"cancelled_or_not_requested_probability":0.04,"adjudicated_if_held_probability":0.91,"no_bid_if_held_probability":0.09,"surenchere_probability":0.10}'::jsonb,
      '{"initial_price_eur":{"p10":"123000","p50":"146000","p90":"179000"},"final_price_eur":{"p10":"126000","p50":"151000","p90":"188000"}}'::jsonb,
      48,
      repeat('j', 64)
    )$$,
  '23514',
  'Ready prediction sample size must match its cohort.',
  'a prediction cannot inflate or shrink its versioned cohort sample size'
);

select lives_ok(
  $$insert into public.auction_predictions (
      id, round_id, snapshot_id, model_version_id, cohort_statistics_id,
      prediction_status, generated_at, horizon, probabilities, quantiles,
      confidence_level, confidence_label, sample_size, explanation_factors,
      limitations, prediction_hash
    ) values (
      '98500000-0000-4000-8000-000000000002',
      '97000000-0000-4000-8000-000000000001',
      '98300000-0000-4000-8000-000000000004',
      '98200000-0000-4000-8000-000000000001',
      '98100000-0000-4000-8000-000000000001',
      'ready',
      '2026-07-25T11:00:00Z',
      'T-7',
      '{"held_probability":0.88,"postponed_probability":0.08,"cancelled_or_not_requested_probability":0.04,"adjudicated_if_held_probability":0.91,"no_bid_if_held_probability":0.09,"surenchere_probability":0.10}'::jsonb,
      '{"initial_price_eur":{"p10":"123000","p50":"146000","p90":"179000"},"final_price_eur":{"p10":"126000","p50":"151000","p90":"188000"}}'::jsonb,
      0.66,
      'moyen',
      47,
      '[{"label":"Cohorte","detail":"47 résultats A/B","direction":"neutral"}]'::jsonb,
      '["Prévision statistique."]'::jsonb,
      repeat('d', 64)
    )$$,
  'a ready prediction with full immutable provenance is accepted'
);

select lives_ok(
  $$insert into public.auction_predictions (
      id, round_id, snapshot_id, model_version_id, cohort_statistics_id,
      prediction_status, generated_at, horizon, probabilities, quantiles,
      confidence_level, confidence_label, sample_size, explanation_factors,
      limitations, prediction_hash, supersedes_prediction_id
    ) values (
      '98500000-0000-4000-8000-000000000007',
      '97000000-0000-4000-8000-000000000001',
      '98300000-0000-4000-8000-000000000004',
      '98200000-0000-4000-8000-000000000001',
      '98100000-0000-4000-8000-000000000001',
      'ready',
      '2026-07-25T12:00:00Z',
      'T-7',
      '{"held_probability":0.87,"postponed_probability":0.09,"cancelled_or_not_requested_probability":0.04,"adjudicated_if_held_probability":0.90,"no_bid_if_held_probability":0.10,"surenchere_probability":0.11}'::jsonb,
      '{"initial_price_eur":{"p10":"124000","p50":"147000","p90":"180000"},"final_price_eur":{"p10":"127000","p50":"152000","p90":"189000"}}'::jsonb,
      0.66,
      'moyen',
      47,
      '[]'::jsonb,
      '["Correction versionnée."]'::jsonb,
      repeat('k', 64),
      '98500000-0000-4000-8000-000000000002'
    )$$,
  'a correcting prediction appends a later single-successor version'
);

select throws_ok(
  $$insert into public.auction_predictions (
      id, round_id, snapshot_id, model_version_id, cohort_statistics_id,
      prediction_status, generated_at, horizon, probabilities, quantiles,
      sample_size, prediction_hash, supersedes_prediction_id
    ) values (
      '98500000-0000-4000-8000-000000000008',
      '97000000-0000-4000-8000-000000000001',
      '98300000-0000-4000-8000-000000000004',
      '98200000-0000-4000-8000-000000000001',
      '98100000-0000-4000-8000-000000000001',
      'ready',
      '2026-07-25T13:00:00Z',
      'T-7',
      '{"held_probability":0.86,"postponed_probability":0.10,"cancelled_or_not_requested_probability":0.04,"adjudicated_if_held_probability":0.90,"no_bid_if_held_probability":0.10,"surenchere_probability":0.11}'::jsonb,
      '{"initial_price_eur":{"p10":"124000","p50":"147000","p90":"180000"},"final_price_eur":{"p10":"127000","p50":"152000","p90":"189000"}}'::jsonb,
      47,
      repeat('l', 64),
      '98500000-0000-4000-8000-000000000002'
    )$$,
  '23514',
  'Prediction supersession cannot branch.',
  'a prediction version cannot have two competing successors'
);

reset role;

select throws_ok(
  $$update public.auction_predictions
    set sample_size = 48
    where id = '98500000-0000-4000-8000-000000000002'$$,
  '55000',
  'public.auction_predictions is append-only; insert a correcting version instead.',
  'a prediction cannot be rewritten'
);

set local role service_role;
reset role;
set local role authenticated;
set local "request.jwt.claim.sub" = '91000000-0000-4000-8000-000000000001';
set local "request.jwt.claim.role" = 'authenticated';

select throws_ok(
  $$select count(*)::bigint from public.auction_predictions$$,
  '42501',
  'permission denied for table auction_predictions',
  'a free user cannot query the internal prediction registry'
);

set local "request.jwt.claim.sub" = '92000000-0000-4000-8000-000000000001';

select throws_ok(
  $$select count(*)::bigint from public.auction_predictions$$,
  '42501',
  'permission denied for table auction_predictions',
  'a premium user must use the entitlement-checked API instead of raw tables'
);

select throws_ok(
  $$select * from public.auction_feature_snapshots$$,
  '42501',
  'permission denied for table auction_feature_snapshots',
  'premium does not expose source manifests or raw features directly'
);

reset role;
set local role service_role;

select lives_ok(
  $$insert into public.feature_usage_events (user_id, event_key, subject_type, subject_id)
    values (
      '92000000-0000-4000-8000-000000000001',
      'outcome_graph.viewed',
      'auction_sale',
      '93000000-0000-4000-8000-000000000001'
    )$$,
  'Outcome Graph views use the constrained feature usage vocabulary'
);

select lives_ok(
  $$insert into public.auction_outcomes (
      id, round_id, version, outcome_status, valid_from
    ) values (
      '98600000-0000-4000-8000-000000000001',
      '97000000-0000-4000-8000-000000000001',
      1,
      'unknown',
      '2026-07-20T09:00:00Z'
    )$$,
  'unknown remains a first-class outcome state'
);

select throws_ok(
  $$insert into public.auction_outcomes (
      id, round_id, version, outcome_status, training_eligible
    ) values (
      '98600000-0000-4000-8000-000000000003',
      '97000000-0000-4000-8000-000000000003',
      1,
      'unknown',
      true
    )$$,
  '23514',
  'new row for relation "auction_outcomes" violates check constraint "auction_outcomes_training_review_gate_check"',
  'canonical outcomes remain non-training until evidence and review promotion exists'
);

select throws_ok(
  $$insert into public.auction_outcomes (
      id, round_id, version, outcome_status
    ) values (
      '98600000-0000-4000-8000-000000000002',
      '97000000-0000-4000-8000-000000000003',
      1,
      'held_adjudicated'
    )$$,
  '23514',
  'new row for relation "auction_outcomes" violates check constraint "auction_outcomes_adjudication_price_check"',
  'an adjudication cannot be asserted without a price'
);

select throws_ok(
  $$insert into public.auction_outcomes (
      id, round_id, version, outcome_status, valid_from
    ) values (
      '98600000-0000-4000-8000-000000000004',
      '97000000-0000-4000-8000-000000000003',
      2,
      'unknown',
      '2026-07-21T09:00:00Z'
    )$$,
  '23514',
  'An Outcome Graph outcome chain must start at version 1.',
  'an outcome version cannot skip its predecessor'
);

insert into public.auction_outcomes (
  id, round_id, version, outcome_status, valid_from
) values (
  '98600000-0000-4000-8000-000000000005',
  '97000000-0000-4000-8000-000000000003',
  1,
  'unknown',
  '2026-07-20T09:00:00Z'
);

select throws_ok(
  $$insert into public.auction_outcomes (
      id, round_id, version, outcome_status, valid_from, supersedes_outcome_id
    ) values (
      '98600000-0000-4000-8000-000000000006',
      '97000000-0000-4000-8000-000000000003',
      2,
      'unknown',
      '2026-07-21T09:00:00Z',
      '98600000-0000-4000-8000-000000000001'
    )$$,
  '23514',
  'Outcome supersession must stay on one round and advance version and validity.',
  'an outcome correction cannot supersede another round'
);

select lives_ok(
  $$insert into public.auction_outcomes (
      id, round_id, version, outcome_status, valid_from, supersedes_outcome_id
    ) values (
      '98600000-0000-4000-8000-000000000007',
      '97000000-0000-4000-8000-000000000001',
      2,
      'postponed',
      '2026-07-21T09:00:00Z',
      '98600000-0000-4000-8000-000000000001'
    )$$,
  'an outcome correction advances one immutable round-local version chain'
);

select throws_ok(
  $$insert into public.auction_outcomes (
      id, round_id, version, outcome_status, valid_from, supersedes_outcome_id
    ) values (
      '98600000-0000-4000-8000-000000000008',
      '97000000-0000-4000-8000-000000000001',
      2,
      'cancelled',
      '2026-07-22T09:00:00Z',
      '98600000-0000-4000-8000-000000000001'
    )$$,
  '23514',
  'Outcome supersession cannot branch.',
  'an outcome version cannot have two competing successors'
);

insert into public.model_versions (
  model_key, version, model_kind, segment, feature_schema_version,
  training_cutoff_at, training_sample_size, created_at
) values (
  'outcome-cohort', '2.0.0', 'cohort_baseline', 'national',
  'outcome-v1', '2026-06-30T23:59:59Z', 47, '2026-07-19T09:00:00Z'
);

update public.model_versions
set
  status = 'validated',
  approved_at = '2026-07-21T09:00:00Z',
  approved_by = '92500000-0000-4000-8000-000000000001'
where model_key = 'outcome-cohort' and version = '2.0.0';

select throws_ok(
  $$update public.model_versions
    set status = 'active'
    where model_key = 'outcome-cohort' and version = '2.0.0'$$,
  '23505',
  'duplicate key value violates unique constraint "model_versions_one_active_segment_idx"',
  'only one model version may be active per key and segment'
);

select throws_ok(
  $$update public.model_versions
    set feature_schema_version = 'tampered'
    where id = '98200000-0000-4000-8000-000000000001'$$,
  '55000',
  'Outcome model version contents are immutable.',
  'model artifacts and feature schemas cannot be changed in place'
);

select throws_ok(
  $$update public.model_versions
    set approved_at = '2026-07-22T09:00:00Z'
    where id = '98200000-0000-4000-8000-000000000001'$$,
  '55000',
  'Outcome model approval metadata is immutable after validation.',
  'model approval provenance cannot be rewritten after validation'
);

select ok(
  (
    select probabilities ? 'postponed_probability'
      and probabilities ? 'cancelled_or_not_requested_probability'
      and not probabilities ? 'postponed_or_cancelled_probability'
    from public.auction_predictions
    where id = '98500000-0000-4000-8000-000000000002'
  ),
  'report and cancellation or not-requested remain distinct forecast states'
);

select * from finish();

rollback;
