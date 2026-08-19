begin;

select plan(76);

-- 01
select has_table(
  'public',
  'outcome_model_evaluations',
  'the immutable Outcome model evaluation registry exists'
);

-- 02
select has_column(
  'public',
  'model_versions',
  'calibration',
  'model versions persist an explicit calibration summary'
);

select ok(
  (
    select count(*) = 2
    from information_schema.columns column_row
    where column_row.table_schema = 'public'
      and column_row.table_name = 'model_versions'
      and column_row.column_name in (
        'artifact_sha256', 'shadow_started_at'
      )
  ),
  'model versions bind an artifact hash and server shadow provenance'
);

-- 03
select ok(
  (
    select column_row.is_nullable = 'NO'
    from information_schema.columns column_row
    where column_row.table_schema = 'public'
      and column_row.table_name = 'model_versions'
      and column_row.column_name = 'calibration'
  ),
  'model calibration is mandatory'
);

-- 04
select ok(
  (
    select bool_and(column_row.column_default is null)
    from information_schema.columns column_row
    where column_row.table_schema = 'public'
      and column_row.table_name = 'model_versions'
      and column_row.column_name in ('metrics', 'calibration')
  ),
  'metrics and calibration have no silent empty defaults'
);

-- 05
select ok(
  (
    select relation_row.relrowsecurity
    from pg_class relation_row
    where relation_row.oid =
      'public.outcome_model_evaluations'::regclass
  ),
  'RLS is enabled on model evaluations'
);

-- 06
select ok(
  has_table_privilege(
    'service_role', 'public.outcome_model_evaluations', 'SELECT'
  )
  and has_table_privilege(
    'service_role', 'public.outcome_model_evaluations', 'INSERT'
  )
  and not has_table_privilege(
    'service_role', 'public.outcome_model_evaluations', 'UPDATE'
  )
  and not has_table_privilege(
    'service_role', 'public.outcome_model_evaluations', 'DELETE'
  )
  and not has_table_privilege(
    'service_role', 'public.outcome_model_evaluations', 'TRUNCATE'
  ),
  'the trusted worker can only append and read evaluations'
);

-- 07
select ok(
  not has_table_privilege(
    'anon', 'public.outcome_model_evaluations', 'SELECT'
  )
  and not has_table_privilege(
    'anon', 'public.outcome_model_evaluations', 'INSERT'
  )
  and not has_table_privilege(
    'anon', 'public.outcome_model_evaluations', 'UPDATE'
  )
  and not has_table_privilege(
    'anon', 'public.outcome_model_evaluations', 'DELETE'
  ),
  'anonymous clients have no model evaluation privilege'
);

-- 08
select ok(
  not has_table_privilege(
    'authenticated', 'public.outcome_model_evaluations', 'SELECT'
  )
  and not has_table_privilege(
    'authenticated', 'public.outcome_model_evaluations', 'INSERT'
  )
  and not has_table_privilege(
    'authenticated', 'public.outcome_model_evaluations', 'UPDATE'
  )
  and not has_table_privilege(
    'authenticated', 'public.outcome_model_evaluations', 'DELETE'
  ),
  'authenticated clients cannot bypass the service-only evaluation boundary'
);

-- 09
select ok(
  not exists (
    select 1
    from pg_policy policy_row
    where policy_row.polrelid =
      'public.outcome_model_evaluations'::regclass
  ),
  'no client-facing RLS policy exposes model evaluations'
);

-- 10
select ok(
  (
    select not procedure_row.prosecdef
      and procedure_row.provolatile = 'i'
      and procedure_row.proconfig @> array['search_path=""']::text[]
    from pg_proc procedure_row
    where procedure_row.oid =
      'app_private.outcome_model_evaluation_report_is_safe(jsonb,text,text)'
        ::regprocedure
  ),
  'the closed report validator is immutable, invoker-security, and search-path safe'
);

-- 11
select ok(
  (
    select bool_and(
      not procedure_row.prosecdef
      and procedure_row.proconfig @> array['search_path=""']::text[]
    )
    from pg_proc procedure_row
    where procedure_row.oid = any (array[
      'app_private.validate_outcome_model_evaluation_insert()'::regprocedure,
      'app_private.reject_outcome_model_evaluation_mutation()'::regprocedure,
      'app_private.reject_outcome_model_registry_truncate()'::regprocedure,
      'app_private.validate_outcome_model_version_insert()'::regprocedure,
      'app_private.guard_outcome_model_version_mutation()'::regprocedure
    ]::oid[])
  ),
  'all evaluation and promotion guards are invoker-security with empty search paths'
);

-- 12
select ok(
  has_function_privilege(
    'service_role',
    'app_private.outcome_model_evaluation_report_is_safe(jsonb,text,text)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'anon',
    'app_private.outcome_model_evaluation_report_is_safe(jsonb,text,text)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'app_private.outcome_model_evaluation_report_is_safe(jsonb,text,text)',
    'EXECUTE'
  ),
  'only trusted ingestion can invoke the report validator'
);

-- 13
select ok(
  (
    select bool_and(
      not has_function_privilege(
        'anon', procedure_row.oid, 'EXECUTE'
      )
      and not has_function_privilege(
        'authenticated', procedure_row.oid, 'EXECUTE'
      )
      and not has_function_privilege(
        'service_role', procedure_row.oid, 'EXECUTE'
      )
    )
    from pg_proc procedure_row
    where procedure_row.oid = any (array[
      'app_private.validate_outcome_model_evaluation_insert()'::regprocedure,
      'app_private.reject_outcome_model_evaluation_mutation()'::regprocedure,
      'app_private.reject_outcome_model_registry_truncate()'::regprocedure,
      'app_private.validate_outcome_model_version_insert()'::regprocedure,
      'app_private.guard_outcome_model_version_mutation()'::regprocedure
    ]::oid[])
  ),
  'trigger-only guards cannot be called directly by API roles'
);

-- 14
select ok(
  exists (
    select 1
    from pg_trigger trigger_row
    where trigger_row.tgrelid =
      'public.outcome_model_evaluations'::regclass
      and trigger_row.tgname =
        'validate_outcome_model_evaluation_before_insert'
      and trigger_row.tgtype = 7
      and trigger_row.tgfoid =
        'app_private.validate_outcome_model_evaluation_insert()'
          ::regprocedure
      and trigger_row.tgenabled = 'O'
      and not trigger_row.tgisinternal
  ),
  'the exact enabled BEFORE INSERT ROW evaluation guard is installed'
);

-- 15
select ok(
  exists (
    select 1
    from pg_trigger trigger_row
    where trigger_row.tgrelid =
      'public.outcome_model_evaluations'::regclass
      and trigger_row.tgname = 'outcome_model_evaluations_append_only'
      and trigger_row.tgtype = 27
      and trigger_row.tgfoid =
        'app_private.reject_outcome_model_evaluation_mutation()'
          ::regprocedure
  ),
  'evaluation UPDATE and DELETE operations are rejected by an exact row guard'
);

-- 16
select ok(
  exists (
    select 1
    from pg_trigger trigger_row
    where trigger_row.tgrelid =
      'public.outcome_model_evaluations'::regclass
      and trigger_row.tgname = 'outcome_model_evaluations_no_truncate'
      and trigger_row.tgtype = 34
  )
  and exists (
    select 1
    from pg_trigger trigger_row
    where trigger_row.tgrelid = 'public.model_versions'::regclass
      and trigger_row.tgname = 'model_versions_no_truncate'
      and trigger_row.tgtype = 34
  ),
  'both model registries reject statement-level truncation'
);

-- 17
select ok(
  (
    select index_row.indexdef like
      '%(model_version_id, evaluation_mode, created_at DESC, id DESC)%'
    from pg_indexes index_row
    where index_row.schemaname = 'public'
      and index_row.indexname =
        'outcome_model_evaluations_latest_idx'
  ),
  'latest-evaluation selection has a deterministic ordering index'
);

-- 18
select ok(
  (
    select count(*) = 13 and bool_and(attribute_row.attnotnull)
    from pg_attribute attribute_row
    where attribute_row.attrelid =
      'public.outcome_model_evaluations'::regclass
      and attribute_row.attname in (
        'evaluation_mode', 'evaluation_status', 'evaluation_rule_version',
        'model_status_at_evaluation', 'evaluation_period_start',
        'evaluation_period_end', 'feature_cutoff_at', 'outcome_cutoff_at',
        'knowledge_cutoff_at', 'required_observation_count',
        'observation_count', 'report_hash', 'evaluation_hash'
      )
      and not attribute_row.attisdropped
  ),
  'modes, statuses, cutoffs, minimum counts, and hashes are mandatory'
);

-- 19
select ok(
  (
    select count(*) = 9
    from pg_constraint constraint_row
    where constraint_row.conrelid =
      'public.outcome_model_evaluations'::regclass
      and constraint_row.conname in (
        'outcome_model_evaluations_period_check',
        'outcome_model_evaluations_cutoff_check',
        'outcome_model_evaluations_counter_check',
        'outcome_model_evaluations_status_count_check',
        'outcome_model_evaluations_required_count_check',
        'outcome_model_evaluations_report_check',
        'outcome_model_evaluations_mode_status_check',
        'outcome_model_evaluations_evaluation_mode_check',
        'outcome_model_evaluations_evaluation_status_check'
      )
  ),
  'the evaluation registry installs its closed integrity constraints'
);

select ok(
  app_private.outcome_model_evaluation_is_fresh(
    '2026-07-31 12:00:00+00',
    '2026-07-30 12:00:00+00',
    '2026-07-30',
    '2026-08-01 12:00:00+00'
  )
  and not app_private.outcome_model_evaluation_is_fresh(
    '2026-06-30 12:00:00+00',
    '2026-06-30 12:00:00+00',
    '2026-06-30',
    '2026-08-01 12:00:00+00'
  )
  and position(
    'outcome_model_evaluation_is_fresh' in pg_get_functiondef(
      'app_private.guard_outcome_model_version_mutation()'::regprocedure
    )
  ) > 0,
  'activation invokes the exact 30-day prospective freshness gate'
);

create function pg_temp.evaluation_report(
  p_status text,
  p_mode text default 'historical_replay'
)
returns jsonb
language sql
immutable
as $$
  select jsonb_build_object(
    'schemaVersion', 'outcome_model_evaluation_report_v1',
    'thresholdVersion', 'outcome-commercial-v1',
    'evaluationMode', p_mode,
    'aggregateOnly', true,
    'containsPersonalData', false,
    'metrics', jsonb_build_object(
      'brierScore', 0.14,
      'logLoss', 0.41,
      'meanAbsoluteError', 12450,
      'intervalCoverage80', 0.79
    ),
    'calibration', jsonb_build_object(
      'expectedCalibrationError', 0.04,
      'maximumCalibrationError', 0.09,
      'binCount', 10
    ),
    'gates', jsonb_build_object(
      'inputContractPassed', p_status <> 'invalid_input',
      'temporalLeakageCheckPassed', true,
      'performanceThresholdPassed', p_status = 'passed',
      'calibrationThresholdPassed', p_status in ('failed', 'passed')
    )
  );
$$;

create function pg_temp.append_evaluation(
  p_id uuid,
  p_model_version_id uuid,
  p_mode text,
  p_status text,
  p_knowledge_cutoff_at timestamptz,
  p_scored_observation_count integer,
  p_required_observation_count integer default 200,
  p_observation_count integer default null,
  p_report jsonb default null,
  p_known_outcome_count integer default null,
  p_evaluation_period_end date default null,
  p_feature_cutoff_at timestamptz default null,
  p_outcome_cutoff_at timestamptz default null
)
returns void
language sql
volatile
as $$
  insert into public.outcome_model_evaluations (
    id,
    model_version_id,
    evaluation_mode,
    evaluation_status,
    evaluation_rule_version,
    model_status_at_evaluation,
    evaluation_period_start,
    evaluation_period_end,
    feature_cutoff_at,
    outcome_cutoff_at,
    knowledge_cutoff_at,
    required_observation_count,
    observation_count,
    eligible_observation_count,
    scored_observation_count,
    known_outcome_count,
    excluded_observation_count,
    invalid_observation_count,
    source_manifest_hash,
    prediction_manifest_hash,
    outcome_manifest_hash,
    report,
    report_hash,
    evaluation_hash,
    created_at
  ) values (
    p_id,
    p_model_version_id,
    p_mode,
    p_status,
    'outcome_evaluation_gate_v1',
    'active',
    case
      when p_mode = 'prospective_shadow'
        then (p_knowledge_cutoff_at at time zone 'UTC')::date
      else (p_knowledge_cutoff_at at time zone 'UTC')::date - 10
    end,
    coalesce(
      p_evaluation_period_end,
      case
        when p_mode = 'prospective_shadow'
          then (p_knowledge_cutoff_at at time zone 'UTC')::date
        else (p_knowledge_cutoff_at at time zone 'UTC')::date - 3
      end
    ),
    coalesce(
      p_feature_cutoff_at,
      case
        when p_mode = 'prospective_shadow' then p_knowledge_cutoff_at
        else p_knowledge_cutoff_at - interval '4 days'
      end
    ),
    coalesce(
      p_outcome_cutoff_at,
      case
        when p_mode = 'prospective_shadow' then p_knowledge_cutoff_at
        else p_knowledge_cutoff_at - interval '2 days'
      end
    ),
    p_knowledge_cutoff_at,
    p_required_observation_count,
    coalesce(
      p_observation_count,
      greatest(
        p_scored_observation_count,
        coalesce(
          p_known_outcome_count,
          case
            when p_mode = 'historical_replay'
              and p_status in ('failed', 'passed') then 1000
            else p_scored_observation_count
          end
        )
      )
    ),
    greatest(
      p_scored_observation_count,
      coalesce(
        p_known_outcome_count,
        case
          when p_mode = 'historical_replay'
            and p_status in ('failed', 'passed') then 1000
          else p_scored_observation_count
        end
      )
    ),
    p_scored_observation_count,
    coalesce(
      p_known_outcome_count,
      case
        when p_mode = 'historical_replay'
          and p_status in ('failed', 'passed') then 1000
        else p_scored_observation_count
      end
    ),
    0,
    0,
    repeat('1', 64),
    repeat('2', 64),
    repeat('3', 64),
    coalesce(p_report, pg_temp.evaluation_report(p_status, p_mode)),
    repeat('0', 64),
    repeat('0', 64),
    '2100-01-01 00:00:00+00'
  );
$$;

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
) values (
  'c1590000-0000-4000-8000-000000000001',
  '00000000-0000-0000-0000-000000000000',
  'authenticated',
  'authenticated',
  'evaluation-admin@example.test',
  '',
  now(),
  now(),
  now(),
  '{}'::jsonb,
  '{}'::jsonb
);

update public.user_profiles
set user_role = 'admin'
where user_id = 'c1590000-0000-4000-8000-000000000001';

set local role service_role;

-- 20
select throws_ok(
  $$insert into public.model_versions (
      id, model_key, version, model_kind, segment,
      feature_schema_version, training_cutoff_at, training_sample_size,
      metrics, calibration, artifact_sha256, created_at
    ) values (
      'c1500000-0000-4000-8000-000000000098',
      'evaluation-empty-metrics', '1.0.0', 'cohort_baseline', 'national',
      'outcome-v1', '2025-01-01 00:00:00+00', 500,
      '{}'::jsonb, '{"ece":0.04}'::jsonb, repeat('8', 64),
      '2025-01-02 00:00:00+00'
    )$$,
  '23514',
  'Outcome model versions require non-empty metrics and calibration.',
  'empty model metrics fail closed'
);

-- 21
select throws_ok(
  $$insert into public.model_versions (
      id, model_key, version, model_kind, segment,
      feature_schema_version, training_cutoff_at, training_sample_size,
      metrics, calibration, artifact_sha256, created_at
    ) values (
      'c1500000-0000-4000-8000-000000000099',
      'evaluation-empty-calibration', '1.0.0', 'cohort_baseline', 'national',
      'outcome-v1', '2025-01-01 00:00:00+00', 500,
      '{"brierScore":0.14}'::jsonb, '{}'::jsonb, repeat('9', 64),
      '2025-01-02 00:00:00+00'
    )$$,
  '23514',
  'Outcome model versions require non-empty metrics and calibration.',
  'empty model calibration fails closed'
);

select throws_ok(
  $$insert into public.model_versions (
      id, model_key, version, model_kind, segment,
      feature_schema_version, training_cutoff_at, training_sample_size,
      metrics, calibration, artifact_sha256, created_at
    ) values (
      'c1500000-0000-4000-8000-000000000097',
      'evaluation-invalid-artifact', '1.0.0', 'cohort_baseline', 'national',
      'outcome-v1', '2025-01-01 00:00:00+00', 500,
      '{"brierScore":0.14}'::jsonb, '{"ece":0.04}'::jsonb,
      'NOT-A-SHA256', '2025-01-02 00:00:00+00'
    )$$,
  '23514',
  'Outcome model versions require a lowercase SHA-256 artifact identity.',
  'the exact model artifact requires a lowercase SHA-256 identity'
);

insert into public.model_versions (
  id, model_key, version, model_kind, segment,
  feature_schema_version, training_cutoff_at, training_sample_size,
  metrics, calibration, artifact_sha256, created_at
) values
  (
    'c1500000-0000-4000-8000-000000000001',
    'evaluation-gated-model', '1.0.0', 'cohort_baseline', 'national',
    'outcome-v1', '2025-01-01 00:00:00+00', 500,
    '{"brierScore":0.14}'::jsonb, '{"ece":0.04}'::jsonb,
    repeat('a', 64),
    '2025-01-02 00:00:00+00'
  ),
  (
    'c1500000-0000-4000-8000-000000000002',
    'evaluation-status-model', '1.0.0', 'cohort_baseline', 'national',
    'outcome-v1', '2025-01-01 00:00:00+00', 500,
    '{"brierScore":0.15}'::jsonb, '{"ece":0.05}'::jsonb,
    repeat('b', 64),
    '2025-01-02 00:00:00+00'
  ),
  (
    'c1500000-0000-4000-8000-000000000003',
    'evaluation-draft-model', '1.0.0', 'cohort_baseline', 'national',
    'outcome-v1', '2025-01-01 00:00:00+00', 500,
    '{"brierScore":0.16}'::jsonb, '{"ece":0.06}'::jsonb,
    repeat('c', 64),
    '2025-01-02 00:00:00+00'
  );

update public.model_versions
set
  status = 'validated',
  approved_at = '2025-01-03 00:00:00+00',
  approved_by = 'c1590000-0000-4000-8000-000000000001'
where id in (
  'c1500000-0000-4000-8000-000000000001',
  'c1500000-0000-4000-8000-000000000002'
);

-- 22
select throws_ok(
  $$update public.model_versions
    set status = 'active'
    where id = 'c1500000-0000-4000-8000-000000000001'$$,
  '23514',
  'Outcome model activation cannot bypass shadow mode.',
  'validated models cannot jump directly to active'
);

-- 23
select throws_ok(
  $$select pg_temp.append_evaluation(
      'c1510000-0000-4000-8000-000000000090',
      'c1500000-0000-4000-8000-000000000001',
      'prospective_shadow', 'passed', '2026-07-01 00:00:00+00', 300
    )$$,
  '23514',
  'Prospective shadow evaluation requires a shadow model.',
  'a prospective evaluation cannot be backfilled while the model is only validated'
);

-- 24
select throws_ok(
  $$update public.model_versions
    set status = 'shadow'
    where id = 'c1500000-0000-4000-8000-000000000001'$$,
  '23514',
  'Outcome model shadow transition requires the latest historical replay evaluation to pass.',
  'a model cannot enter shadow mode without historical evidence'
);

-- 25
select throws_ok(
  $$select pg_temp.append_evaluation(
      'c1510000-0000-4000-8000-000000000091',
      'c1500000-0000-4000-8000-000000000003',
      'historical_replay', 'passed', '2025-03-01 00:00:00+00', 300
    )$$,
  '23514',
  'Historical replay evaluation requires a validated model.',
  'draft models cannot receive historical promotion evidence'
);

-- 26
select ok(
  app_private.outcome_model_evaluation_report_is_safe(
    pg_temp.evaluation_report('invalid_input'),
    'invalid_input', 'historical_replay'
  ),
  'the closed report contract represents invalid input explicitly'
);

-- 27
select ok(
  app_private.outcome_model_evaluation_report_is_safe(
    pg_temp.evaluation_report('insufficient_data'),
    'insufficient_data', 'historical_replay'
  ),
  'the closed report contract represents insufficient data explicitly'
);

-- 28
select ok(
  app_private.outcome_model_evaluation_report_is_safe(
    pg_temp.evaluation_report('failed'), 'failed', 'historical_replay'
  ),
  'the closed report contract represents a failed gate explicitly'
);

-- 29
select ok(
  app_private.outcome_model_evaluation_report_is_safe(
    pg_temp.evaluation_report('passed'), 'passed', 'historical_replay'
  ),
  'the closed report contract represents a passed gate explicitly'
);

-- 29a
select ok(
  app_private.outcome_model_evaluation_report_is_safe(
    jsonb_set(
      pg_temp.evaluation_report('passed'),
      '{metrics,brierScore}',
      '1'::jsonb
    ),
    'passed',
    'historical_replay'
  ),
  'the normalized multiclass Brier boundary of 1 is accepted'
);

-- 29b
select ok(
  not app_private.outcome_model_evaluation_report_is_safe(
    jsonb_set(
      pg_temp.evaluation_report('passed'),
      '{metrics,brierScore}',
      '1.0001'::jsonb
    ),
    'passed',
    'historical_replay'
  ),
  'a normalized multiclass Brier score above 1 is rejected'
);

select ok(
  app_private.outcome_model_evaluation_report_is_safe(
    jsonb_set(
      jsonb_set(
        pg_temp.evaluation_report('passed'),
        '{calibration,expectedCalibrationError}',
        '0.05'::jsonb
      ),
      '{metrics,intervalCoverage80}',
      '0.75'::jsonb
    ),
    'passed',
    'historical_replay'
  )
  and app_private.outcome_model_evaluation_report_is_safe(
    jsonb_set(
      pg_temp.evaluation_report('passed'),
      '{metrics,intervalCoverage80}',
      '0.85'::jsonb
    ),
    'passed',
    'historical_replay'
  ),
  'the commercial ECE and interval-coverage boundaries are accepted'
);

select ok(
  not app_private.outcome_model_evaluation_report_is_safe(
    jsonb_set(
      pg_temp.evaluation_report('passed'),
      '{calibration,expectedCalibrationError}',
      '0.0501'::jsonb
    ),
    'passed',
    'historical_replay'
  ),
  'a passed report above the commercial ECE threshold is rejected'
);

select ok(
  not app_private.outcome_model_evaluation_report_is_safe(
    jsonb_set(
      pg_temp.evaluation_report('passed'),
      '{metrics,intervalCoverage80}',
      '0.7499'::jsonb
    ),
    'passed',
    'historical_replay'
  )
  and not app_private.outcome_model_evaluation_report_is_safe(
    jsonb_set(
      pg_temp.evaluation_report('passed'),
      '{metrics,intervalCoverage80}',
      '0.8501'::jsonb
    ),
    'passed',
    'historical_replay'
  ),
  'passed reports outside the commercial 80-percent interval band are rejected'
);

select ok(
  not app_private.outcome_model_evaluation_report_is_safe(
    jsonb_set(
      pg_temp.evaluation_report('passed'),
      '{thresholdVersion}',
      '"unapproved-thresholds"'::jsonb
    ),
    'passed',
    'historical_replay'
  ),
  'unversioned or unapproved evaluator thresholds cannot promote a model'
);

select ok(
  not app_private.outcome_model_evaluation_report_is_safe(
    pg_temp.evaluation_report('passed', 'historical_replay'),
    'passed',
    'prospective_shadow'
  ),
  'a historical summary cannot be relabelled as prospective evidence'
);

-- 30
select lives_ok(
  $$select pg_temp.append_evaluation(
      'c1510000-0000-4000-8000-000000000001',
      'c1500000-0000-4000-8000-000000000002',
      'historical_replay', 'invalid_input',
      '2025-02-01 00:00:00+00', 0, 200
    )$$,
  'invalid inputs are recorded as immutable aggregate evidence'
);

-- 31
select lives_ok(
  $$select pg_temp.append_evaluation(
      'c1510000-0000-4000-8000-000000000002',
      'c1500000-0000-4000-8000-000000000002',
      'historical_replay', 'insufficient_data',
      '2025-02-02 00:00:00+00', 99, 200
    )$$,
  'underpowered evaluations are recorded as insufficient data'
);

-- 32
select lives_ok(
  $$select pg_temp.append_evaluation(
      'c1510000-0000-4000-8000-000000000003',
      'c1500000-0000-4000-8000-000000000002',
      'historical_replay', 'failed',
      '2025-02-03 00:00:00+00', 300, 200, null, null, 1000
    )$$,
  'statistically powered failed evaluations are retained'
);

select lives_ok(
  $$select pg_temp.append_evaluation(
      'c1510000-0000-4000-8000-000000000004',
      'c1500000-0000-4000-8000-000000000002',
      'historical_replay', 'insufficient_data',
      '2025-02-04 00:00:00+00', 300, 1, null, null, 1000
    )$$,
  'non-count gates may keep a fully sized evaluation insufficient'
);

-- 33
select ok(
  (
    select count(*) = 4
      and count(*) filter (
        where evaluation_status = 'invalid_input'
      ) = 1
      and count(*) filter (
        where evaluation_status = 'insufficient_data'
      ) = 2
      and count(*) filter (where evaluation_status = 'failed') = 1
      and bool_or(
        known_outcome_count > scored_observation_count
      )
    from public.outcome_model_evaluations
    where model_version_id = 'c1500000-0000-4000-8000-000000000002'
  ),
  'all non-passing evaluation statuses remain auditable'
);

-- 34
select throws_ok(
  $$select pg_temp.append_evaluation(
      'c1510000-0000-4000-8000-000000000092',
      'c1500000-0000-4000-8000-000000000001',
      'historical_replay', 'passed', '2025-03-01 00:00:00+00', 300,
      200, null,
      pg_temp.evaluation_report('passed') ||
        '{"email":"person@example.test"}'::jsonb
    )$$,
  '23514',
  'Outcome model evaluation report violates the aggregate-only v1 contract.',
  'free-form personal data cannot enter the closed aggregate report'
);

-- 35
select throws_ok(
  $$select pg_temp.append_evaluation(
      'c1510000-0000-4000-8000-000000000093',
      'c1500000-0000-4000-8000-000000000001',
      'historical_replay', 'passed', '2025-03-01 00:00:00+00', 300,
      200, null, pg_temp.evaluation_report('failed')
    )$$,
  '23514',
  'Outcome model evaluation report violates the aggregate-only v1 contract.',
  'report gates cannot contradict the persisted evaluation status'
);

-- 36
select throws_ok(
  $$select pg_temp.append_evaluation(
      'c1510000-0000-4000-8000-000000000094',
      'c1500000-0000-4000-8000-000000000001',
      'historical_replay', 'passed', '2025-03-01 00:00:00+00', 300,
      200, 301
    )$$,
  '23514',
  'new row for relation "outcome_model_evaluations" violates check constraint "outcome_model_evaluations_counter_check"',
  'observation counters must reconcile exactly'
);

-- 37
select throws_ok(
  $$select pg_temp.append_evaluation(
      'c1510000-0000-4000-8000-000000000095',
      'c1500000-0000-4000-8000-000000000001',
      'historical_replay', 'passed', '2100-03-01 00:00:00+00', 300
    )$$,
  '23514',
  'Outcome model evaluation chronology is incoherent.',
  'future knowledge cannot be presented as evaluation evidence'
);

select throws_ok(
  $$select pg_temp.append_evaluation(
      'c1510000-0000-4000-8000-000000000097',
      'c1500000-0000-4000-8000-000000000001',
      'historical_replay', 'passed', '2025-03-01 00:00:00+00', 300,
      1, null, null, 999
    )$$,
  '23514',
  'new row for relation "outcome_model_evaluations" violates check constraint "outcome_model_evaluations_status_count_check"',
  '999 historical labels cannot produce a passing commercial gate'
);

select throws_ok(
  $$select pg_temp.append_evaluation(
      'c1510000-0000-4000-8000-000000000098',
      'c1500000-0000-4000-8000-000000000001',
      'historical_replay', 'passed', '2025-03-01 00:00:00+00', 300,
      1, null, null, null, '2025-02-28', null,
      '2025-02-27 00:00:00+00'
    )$$,
  '23514',
  'new row for relation "outcome_model_evaluations" violates check constraint "outcome_model_evaluations_cutoff_check"',
  'the evaluation period cannot end after its outcome cutoff'
);

-- 38
select lives_ok(
  $$select pg_temp.append_evaluation(
      'c1510000-0000-4000-8000-000000000010',
      'c1500000-0000-4000-8000-000000000001',
      'historical_replay', 'passed', '2025-03-01 00:00:00+00', 300
    )$$,
  'a powered passing historical replay is accepted'
);

-- 39
select ok(
  (
    select model_status_at_evaluation = 'validated'
      and required_observation_count = 1000
      and known_outcome_count = 1000
      and scored_observation_count = 300
      and created_at < clock_timestamp() + interval '1 minute'
      and created_at > clock_timestamp() - interval '1 minute'
    from public.outcome_model_evaluations
    where id = 'c1510000-0000-4000-8000-000000000010'
  ),
  'model status and creation time are server-stamped'
);

-- 40
select ok(
  (
    select report_hash <> repeat('0', 64)
      and evaluation_hash <> repeat('0', 64)
      and report_hash ~ '^[0-9a-f]{64}$'
      and evaluation_hash ~ '^[0-9a-f]{64}$'
    from public.outcome_model_evaluations
    where id = 'c1510000-0000-4000-8000-000000000010'
  ),
  'caller-supplied hashes are replaced by canonical server hashes'
);

-- 41
select ok(
  (
    select evaluation_row.report_hash = pg_catalog.encode(
      extensions.digest(
        pg_catalog.convert_to(evaluation_row.report::text, 'UTF8'),
        'sha256'
      ),
      'hex'
    )
    from public.outcome_model_evaluations evaluation_row
    where evaluation_row.id = 'c1510000-0000-4000-8000-000000000010'
  ),
  'the persisted report hash matches the canonical aggregate report'
);

-- 42
select lives_ok(
  $$select pg_temp.append_evaluation(
      'c1510000-0000-4000-8000-000000000011',
      'c1500000-0000-4000-8000-000000000001',
      'historical_replay', 'failed', '2025-02-28 00:00:00+00', 300
    )$$,
  'a later-ingested failed replay with an older knowledge cutoff remains auditable'
);

-- 43
select throws_ok(
  $$update public.model_versions
    set status = 'shadow'
    where id = 'c1500000-0000-4000-8000-000000000001'$$,
  '23514',
  'Outcome model shadow transition requires the latest historical replay evaluation to pass.',
  'a later-ingested failure wins even when its knowledge cutoff is older'
);

-- 44
select lives_ok(
  $$select pg_temp.append_evaluation(
      'c1510000-0000-4000-8000-000000000012',
      'c1500000-0000-4000-8000-000000000001',
      'historical_replay', 'passed', '2025-02-27 00:00:00+00', 300
    )$$,
  'a newer passing historical replay supersedes the failed gate'
);

-- 45
select lives_ok(
  $$update public.model_versions
    set status = 'shadow'
    where id = 'c1500000-0000-4000-8000-000000000001'$$,
  'the latest historical pass permits shadow mode'
);

select ok(
  (
    select shadow_started_at is not null
      and shadow_started_at <= clock_timestamp()
      and shadow_started_at > clock_timestamp() - interval '1 minute'
    from public.model_versions
    where id = 'c1500000-0000-4000-8000-000000000001'
  ),
  'shadow provenance is stamped by the database transition'
);

select throws_ok(
  $$update public.model_versions
    set shadow_started_at = shadow_started_at - interval '1 day'
    where id = 'c1500000-0000-4000-8000-000000000001'$$,
  '55000',
  'Outcome model shadow provenance is server-managed and immutable.',
  'shadow provenance cannot be rewritten'
);

-- 46
select throws_ok(
  $$select pg_temp.append_evaluation(
      'c1510000-0000-4000-8000-000000000096',
      'c1500000-0000-4000-8000-000000000001',
      'historical_replay', 'passed', '2025-03-04 00:00:00+00', 300
    )$$,
  '23514',
  'Historical replay evaluation requires a validated model.',
  'historical promotion evidence cannot be appended after shadow begins'
);

select throws_ok(
  $$select pg_temp.append_evaluation(
      'c1510000-0000-4000-8000-000000000099',
      'c1500000-0000-4000-8000-000000000001',
      'prospective_shadow', 'passed', '2026-07-01 00:00:00+00', 300
    )$$,
  '23514',
  'Outcome model evaluation chronology is incoherent.',
  'a pre-shadow period cannot be relabelled as prospective evidence'
);

-- 47
select throws_ok(
  $$update public.model_versions
    set status = 'active'
    where id = 'c1500000-0000-4000-8000-000000000001'$$,
  '23514',
  'Outcome model activation requires the latest prospective shadow evaluation to pass.',
  'a shadow model cannot activate without prospective evidence'
);

-- 48
select throws_ok(
  $$select pg_temp.append_evaluation(
      'c1510000-0000-4000-8000-000000000020',
      'c1500000-0000-4000-8000-000000000001',
      'prospective_shadow', 'passed', clock_timestamp(), 299, 1
    )$$,
  '23514',
  'new row for relation "outcome_model_evaluations" violates check constraint "outcome_model_evaluations_status_count_check"',
  '299 prospective scores cannot be labelled passed'
);

-- 49
select lives_ok(
  $$select pg_temp.append_evaluation(
      'c1510000-0000-4000-8000-000000000023',
      'c1500000-0000-4000-8000-000000000001',
      'prospective_shadow', 'insufficient_data', clock_timestamp(), 299, 1
    )$$,
  'an under-300 prospective run is retained as insufficient data'
);

select throws_ok(
  $$update public.model_versions
    set status = 'active'
    where id = 'c1500000-0000-4000-8000-000000000001'$$,
  '23514',
  'Outcome model activation requires the latest prospective shadow evaluation to pass.',
  'an insufficient 299-score run cannot activate a model'
);

-- 50
select lives_ok(
  $$select pg_temp.append_evaluation(
      'c1510000-0000-4000-8000-000000000021',
      'c1500000-0000-4000-8000-000000000001',
      'prospective_shadow', 'failed',
      (select shadow_started_at + interval '1 microsecond'
       from public.model_versions
       where id = 'c1500000-0000-4000-8000-000000000001'),
      500
    )$$,
  'a later-ingested powered failure with an older cutoff remains auditable'
);

-- 51
select throws_ok(
  $$update public.model_versions
    set status = 'active'
    where id = 'c1500000-0000-4000-8000-000000000001'$$,
  '23514',
  'Outcome model activation requires the latest prospective shadow evaluation to pass.',
  'a stale prospective pass cannot hide the latest failure'
);

-- 52
select lives_ok(
  $$select pg_temp.append_evaluation(
      'c1510000-0000-4000-8000-000000000022',
      'c1500000-0000-4000-8000-000000000001',
      'prospective_shadow', 'passed',
      (select shadow_started_at + interval '2 microseconds'
       from public.model_versions
       where id = 'c1500000-0000-4000-8000-000000000001'),
      300
    )$$,
  'the threshold-sized latest prospective pass is accepted'
);

select ok(
  (
    select required_observation_count = 300
      and scored_observation_count = 300
      and knowledge_cutoff_at < (
        select prior_row.knowledge_cutoff_at
        from public.outcome_model_evaluations prior_row
        where prior_row.id = 'c1510000-0000-4000-8000-000000000023'
      )
    from public.outcome_model_evaluations evaluation_row
    where evaluation_row.id = 'c1510000-0000-4000-8000-000000000022'
  ),
  'the server threshold is 300 and ingestion time outranks an older cutoff'
);

-- 53
select lives_ok(
  $$update public.model_versions
    set status = 'active'
    where id = 'c1500000-0000-4000-8000-000000000001'$$,
  '300 scored predictions on the latest passed shadow run permit activation'
);

-- 54
select ok(
  (
    select status = 'active'
    from public.model_versions
    where id = 'c1500000-0000-4000-8000-000000000001'
  ),
  'the fully gated model is active'
);

reset role;

-- 55
select throws_ok(
  $$update public.outcome_model_evaluations
    set evaluation_status = 'failed'
    where id = 'c1510000-0000-4000-8000-000000000010'$$,
  '55000',
  'Outcome model evaluations are append-only.',
  'even the relation owner cannot rewrite evaluation evidence'
);

-- 56
select throws_ok(
  $$delete from public.outcome_model_evaluations
    where id = 'c1510000-0000-4000-8000-000000000010'$$,
  '55000',
  'Outcome model evaluations are append-only.',
  'even the relation owner cannot delete evaluation evidence'
);

-- 57
select throws_ok(
  $$truncate table public.outcome_model_evaluations$$,
  '55000',
  'Outcome model evaluations cannot be truncated.',
  'the evaluation audit log cannot be truncated'
);

-- 58
select throws_ok(
  $$truncate table public.model_versions cascade$$,
  '55000',
  'Outcome model versions cannot be truncated.',
  'the model registry cannot be truncated through CASCADE'
);

select * from finish();

rollback;
