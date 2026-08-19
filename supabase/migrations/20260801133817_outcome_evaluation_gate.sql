-- Closed evaluation gate for Outcome Graph model promotion. Evaluation rows
-- contain aggregate scalars only: no auction, person, address, case, or bid
-- identifiers are accepted in the report contract. The detailed Python report
-- (`outcome_evaluation_report_v1`) must be projected into this deliberately
-- smaller promotion summary (`outcome_model_evaluation_report_v1`); the raw
-- detailed payload is not persisted in this registry.

begin;

-- Prevent a legacy-write race while the registry is audited and the new
-- immutable calibration column is installed.
lock table public.model_versions in share row exclusive mode;

do $$
begin
  if exists (select 1 from public.model_versions) then
    raise exception using
      errcode = '23514',
      message = 'Existing Outcome model versions require an explicit audited calibration and evaluation backfill.';
  end if;
end;
$$;

create or replace function app_private.outcome_model_evaluation_report_is_safe(
  p_report jsonb,
  p_status text,
  p_evaluation_mode text
)
returns boolean
language plpgsql
immutable
security invoker
set search_path = ''
as $$
declare
  metric_key text;
  calibration_key text;
  value_type text;
  numeric_value numeric;
  input_contract_passed boolean;
  temporal_leakage_check_passed boolean;
  performance_threshold_passed boolean;
  calibration_threshold_passed boolean;
begin
  if pg_catalog.jsonb_typeof(p_report) <> 'object'
    or not p_report ?& array[
      'schemaVersion', 'aggregateOnly', 'containsPersonalData',
      'thresholdVersion', 'evaluationMode', 'metrics', 'calibration', 'gates'
    ]::text[]
    or p_report - array[
      'schemaVersion', 'aggregateOnly', 'containsPersonalData',
      'thresholdVersion', 'evaluationMode', 'metrics', 'calibration', 'gates'
    ]::text[] <> '{}'::jsonb
    or p_report ->> 'schemaVersion' <> 'outcome_model_evaluation_report_v1'
    or p_report ->> 'thresholdVersion' <> 'outcome-commercial-v1'
    or p_report ->> 'evaluationMode' <> p_evaluation_mode
    or p_evaluation_mode not in ('historical_replay', 'prospective_shadow')
    or not p_report @> '{
      "aggregateOnly": true,
      "containsPersonalData": false
    }'::jsonb
    or pg_catalog.jsonb_typeof(p_report -> 'metrics') <> 'object'
    or not (p_report -> 'metrics') ?& array[
      'brierScore', 'logLoss', 'meanAbsoluteError', 'intervalCoverage80'
    ]::text[]
    or (p_report -> 'metrics') - array[
      'brierScore', 'logLoss', 'meanAbsoluteError', 'intervalCoverage80'
    ]::text[] <> '{}'::jsonb
    or pg_catalog.jsonb_typeof(p_report -> 'calibration') <> 'object'
    or not (p_report -> 'calibration') ?& array[
      'expectedCalibrationError', 'maximumCalibrationError', 'binCount'
    ]::text[]
    or (p_report -> 'calibration') - array[
      'expectedCalibrationError', 'maximumCalibrationError', 'binCount'
    ]::text[] <> '{}'::jsonb
    or pg_catalog.jsonb_typeof(p_report -> 'gates') <> 'object'
    or not (p_report -> 'gates') ?& array[
      'inputContractPassed', 'temporalLeakageCheckPassed',
      'performanceThresholdPassed', 'calibrationThresholdPassed'
    ]::text[]
    or (p_report -> 'gates') - array[
      'inputContractPassed', 'temporalLeakageCheckPassed',
      'performanceThresholdPassed', 'calibrationThresholdPassed'
    ]::text[] <> '{}'::jsonb then
    return false;
  end if;

  foreach metric_key in array array[
    'brierScore', 'logLoss', 'meanAbsoluteError', 'intervalCoverage80'
  ] loop
    value_type := pg_catalog.jsonb_typeof(
      p_report #> array['metrics', metric_key]
    );
    if coalesce(value_type, '') not in ('number', 'null') then
      return false;
    end if;
    if value_type = 'number' then
      numeric_value := (p_report #>> array['metrics', metric_key])::numeric;
      if numeric_value < 0
        or (metric_key = 'brierScore' and numeric_value > 1)
        or (metric_key = 'intervalCoverage80' and numeric_value > 1) then
        return false;
      end if;
    end if;
  end loop;

  foreach calibration_key in array array[
    'expectedCalibrationError', 'maximumCalibrationError'
  ] loop
    value_type := pg_catalog.jsonb_typeof(
      p_report #> array['calibration', calibration_key]
    );
    if coalesce(value_type, '') not in ('number', 'null') then
      return false;
    end if;
    if value_type = 'number' then
      numeric_value := (
        p_report #>> array['calibration', calibration_key]
      )::numeric;
      if numeric_value < 0 or numeric_value > 1 then
        return false;
      end if;
    end if;
  end loop;

  value_type := pg_catalog.jsonb_typeof(
    p_report #> array['calibration', 'binCount']
  );
  if coalesce(value_type, '') not in ('number', 'null')
    or (
      value_type = 'number'
      and (
        coalesce(p_report #>> array['calibration', 'binCount'], '')
          !~ '^[0-9]+$'
        or (p_report #>> array['calibration', 'binCount'])::integer
          not between 1 and 1000
      )
    ) then
    return false;
  end if;

  foreach metric_key in array array[
    'inputContractPassed', 'temporalLeakageCheckPassed',
    'performanceThresholdPassed', 'calibrationThresholdPassed'
  ] loop
    if pg_catalog.jsonb_typeof(p_report #> array['gates', metric_key])
      <> 'boolean' then
      return false;
    end if;
  end loop;

  input_contract_passed :=
    (p_report #>> array['gates', 'inputContractPassed'])::boolean;
  temporal_leakage_check_passed :=
    (p_report #>> array['gates', 'temporalLeakageCheckPassed'])::boolean;
  performance_threshold_passed :=
    (p_report #>> array['gates', 'performanceThresholdPassed'])::boolean;
  calibration_threshold_passed :=
    (p_report #>> array['gates', 'calibrationThresholdPassed'])::boolean;

  if p_status in ('failed', 'passed') and (
    pg_catalog.jsonb_typeof(p_report #> array['metrics', 'brierScore'])
      <> 'number'
    or pg_catalog.jsonb_typeof(p_report #> array['metrics', 'logLoss'])
      <> 'number'
    or pg_catalog.jsonb_typeof(
      p_report #> array['metrics', 'meanAbsoluteError']
    ) <> 'number'
    or pg_catalog.jsonb_typeof(
      p_report #> array['metrics', 'intervalCoverage80']
    ) <> 'number'
    or pg_catalog.jsonb_typeof(
      p_report #> array['calibration', 'expectedCalibrationError']
    ) <> 'number'
    or pg_catalog.jsonb_typeof(
      p_report #> array['calibration', 'maximumCalibrationError']
    ) <> 'number'
    or pg_catalog.jsonb_typeof(
      p_report #> array['calibration', 'binCount']
    ) <> 'number'
  ) then
    return false;
  end if;

  -- These promotion thresholds are independently recomputed from the closed
  -- summary. Performance/baseline families that are absent from this compact
  -- projection remain inside the trusted evaluator boundary.
  if p_status = 'passed' and (
    (p_report #>> array['metrics', 'intervalCoverage80'])::numeric
      not between 0.75 and 0.85
    or (
      p_report #>> array[
        'calibration', 'expectedCalibrationError'
      ]
    )::numeric > 0.05
  ) then
    return false;
  end if;

  return case p_status
    when 'invalid_input' then
      (not input_contract_passed or not temporal_leakage_check_passed)
      and not performance_threshold_passed
      and not calibration_threshold_passed
    when 'insufficient_data' then
      input_contract_passed
      and temporal_leakage_check_passed
      and not performance_threshold_passed
      and not calibration_threshold_passed
    when 'failed' then
      input_contract_passed
      and temporal_leakage_check_passed
      and (not performance_threshold_passed
        or not calibration_threshold_passed)
    when 'passed' then
      input_contract_passed
      and temporal_leakage_check_passed
      and performance_threshold_passed
      and calibration_threshold_passed
    else false
  end;
exception
  when others then
    return false;
end;
$$;

create or replace function app_private.outcome_model_evaluation_is_fresh(
  p_created_at timestamptz,
  p_knowledge_cutoff_at timestamptz,
  p_evaluation_period_end date,
  p_reference_at timestamptz
)
returns boolean
language sql
immutable
security invoker
set search_path = ''
as $$
  select
    p_created_at is not null
    and p_knowledge_cutoff_at is not null
    and p_evaluation_period_end is not null
    and p_reference_at is not null
    and p_created_at between p_reference_at - interval '30 days'
      and p_reference_at
    and p_knowledge_cutoff_at between p_reference_at - interval '30 days'
      and p_reference_at
    and p_evaluation_period_end >= pg_catalog.timezone(
      'UTC', p_reference_at - interval '30 days'
    )::date
    and p_evaluation_period_end <= pg_catalog.timezone(
      'UTC', p_knowledge_cutoff_at
    )::date;
$$;

alter table public.model_versions
  add column calibration jsonb not null,
  add column artifact_sha256 text not null,
  add column shadow_started_at timestamptz,
  alter column metrics drop default,
  add constraint model_versions_metrics_calibration_check check (
    pg_catalog.jsonb_typeof(metrics) = 'object'
    and metrics <> '{}'::jsonb
    and pg_catalog.jsonb_typeof(calibration) = 'object'
    and calibration <> '{}'::jsonb
  ),
  add constraint model_versions_shadow_started_at_check check (
    (status in ('draft', 'validated') and shadow_started_at is null)
    or (status in ('shadow', 'active', 'retired')
      and shadow_started_at is not null)
    or status = 'rejected'
  ),
  add constraint model_versions_artifact_sha256_check check (
    artifact_sha256 ~ '^[0-9a-f]{64}$'
  );

create table public.outcome_model_evaluations (
  id uuid primary key default gen_random_uuid(),
  model_version_id uuid not null
    references public.model_versions(id) on delete restrict,
  evaluation_mode text not null check (
    evaluation_mode in ('historical_replay', 'prospective_shadow')
  ),
  evaluation_status text not null check (
    evaluation_status in (
      'invalid_input', 'insufficient_data', 'failed', 'passed'
    )
  ),
  evaluation_rule_version text not null check (
    evaluation_rule_version = 'outcome_evaluation_gate_v1'
  ),
  model_status_at_evaluation text not null check (
    model_status_at_evaluation in ('validated', 'shadow')
  ),
  evaluation_period_start date not null,
  evaluation_period_end date not null,
  feature_cutoff_at timestamptz not null,
  outcome_cutoff_at timestamptz not null,
  knowledge_cutoff_at timestamptz not null,
  required_observation_count integer not null,
  observation_count integer not null check (observation_count >= 0),
  eligible_observation_count integer not null check (
    eligible_observation_count >= 0
  ),
  scored_observation_count integer not null check (
    scored_observation_count >= 0
  ),
  known_outcome_count integer not null check (known_outcome_count >= 0),
  excluded_observation_count integer not null check (
    excluded_observation_count >= 0
  ),
  invalid_observation_count integer not null check (
    invalid_observation_count >= 0
  ),
  source_manifest_hash text not null check (
    source_manifest_hash ~ '^[0-9a-f]{64}$'
  ),
  prediction_manifest_hash text not null check (
    prediction_manifest_hash ~ '^[0-9a-f]{64}$'
  ),
  outcome_manifest_hash text not null check (
    outcome_manifest_hash ~ '^[0-9a-f]{64}$'
  ),
  report jsonb not null,
  report_hash text not null check (report_hash ~ '^[0-9a-f]{64}$'),
  evaluation_hash text not null unique check (
    evaluation_hash ~ '^[0-9a-f]{64}$'
  ),
  created_at timestamptz not null,
  constraint outcome_model_evaluations_period_check check (
    evaluation_period_start <= evaluation_period_end
  ),
  constraint outcome_model_evaluations_cutoff_check check (
    feature_cutoff_at <= outcome_cutoff_at
    and outcome_cutoff_at <= knowledge_cutoff_at
    and evaluation_period_end <=
      pg_catalog.timezone('UTC', outcome_cutoff_at)::date
  ),
  constraint outcome_model_evaluations_counter_check check (
    observation_count = eligible_observation_count
      + excluded_observation_count + invalid_observation_count
    and scored_observation_count <= known_outcome_count
    and known_outcome_count <= eligible_observation_count
    and scored_observation_count <= eligible_observation_count
  ),
  constraint outcome_model_evaluations_status_count_check check (
    evaluation_status = 'invalid_input'
    or evaluation_status = 'insufficient_data'
    or (
      evaluation_status in ('failed', 'passed')
      and (
        (evaluation_mode = 'historical_replay'
          and known_outcome_count >= 1000
          and scored_observation_count >= 300)
        or (evaluation_mode = 'prospective_shadow'
          and known_outcome_count >= 300
          and scored_observation_count >= 300)
      )
    )
  ),
  constraint outcome_model_evaluations_required_count_check check (
    (evaluation_mode = 'historical_replay'
      and required_observation_count = 1000)
    or (evaluation_mode = 'prospective_shadow'
      and required_observation_count = 300)
  ),
  constraint outcome_model_evaluations_report_check check (
    app_private.outcome_model_evaluation_report_is_safe(
      report, evaluation_status, evaluation_mode
    )
  ),
  constraint outcome_model_evaluations_mode_status_check check (
    (evaluation_mode = 'historical_replay'
      and model_status_at_evaluation = 'validated')
    or (evaluation_mode = 'prospective_shadow'
      and model_status_at_evaluation = 'shadow')
  )
);

create index outcome_model_evaluations_latest_idx
  on public.outcome_model_evaluations (
    model_version_id,
    evaluation_mode,
    created_at desc,
    id desc
  );

create or replace function app_private.validate_outcome_model_evaluation_insert()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  linked_model public.model_versions%rowtype;
begin
  new.created_at := pg_catalog.clock_timestamp();

  if new.evaluation_mode = 'historical_replay' then
    new.required_observation_count := 1000;
  elsif new.evaluation_mode = 'prospective_shadow' then
    new.required_observation_count := 300;
  end if;

  select model_row.* into linked_model
  from public.model_versions model_row
  where model_row.id = new.model_version_id
  for share;

  if linked_model.id is null then
    raise exception using
      errcode = '23503',
      message = 'Outcome model evaluation requires an existing model version.';
  end if;

  new.model_status_at_evaluation := linked_model.status;

  if new.evaluation_mode = 'historical_replay'
    and linked_model.status <> 'validated' then
    raise exception using
      errcode = '23514',
      message = 'Historical replay evaluation requires a validated model.';
  end if;
  if new.evaluation_mode = 'prospective_shadow'
    and linked_model.status <> 'shadow' then
    raise exception using
      errcode = '23514',
      message = 'Prospective shadow evaluation requires a shadow model.';
  end if;

  if linked_model.training_cutoff_at is null
    or new.evaluation_period_start <=
      pg_catalog.timezone('UTC', linked_model.training_cutoff_at)::date
    or new.feature_cutoff_at <= linked_model.training_cutoff_at
    or (
      new.evaluation_mode = 'prospective_shadow'
      and (
        linked_model.approved_at is null
        or linked_model.shadow_started_at is null
        or new.evaluation_period_start <
          pg_catalog.timezone(
            'UTC', linked_model.shadow_started_at
          )::date
        or new.feature_cutoff_at < linked_model.shadow_started_at
        or new.feature_cutoff_at < linked_model.approved_at
      )
    )
    or new.knowledge_cutoff_at > new.created_at then
    raise exception using
      errcode = '23514',
      message = 'Outcome model evaluation chronology is incoherent.';
  end if;

  if not app_private.outcome_model_evaluation_report_is_safe(
    new.report, new.evaluation_status, new.evaluation_mode
  ) then
    raise exception using
      errcode = '23514',
      message = 'Outcome model evaluation report violates the aggregate-only v1 contract.';
  end if;

  new.report_hash := pg_catalog.encode(
    extensions.digest(
      pg_catalog.convert_to(new.report::text, 'UTF8'),
      'sha256'
    ),
    'hex'
  );
  new.evaluation_hash := pg_catalog.encode(
    extensions.digest(
      pg_catalog.convert_to(
        pg_catalog.jsonb_build_object(
          'modelVersionId', new.model_version_id,
          'modelArtifactSha256', linked_model.artifact_sha256,
          'evaluationMode', new.evaluation_mode,
          'evaluationStatus', new.evaluation_status,
          'evaluationRuleVersion', new.evaluation_rule_version,
          'modelStatusAtEvaluation', new.model_status_at_evaluation,
          'evaluationPeriodStart', new.evaluation_period_start,
          'evaluationPeriodEnd', new.evaluation_period_end,
          'featureCutoffEpoch', extract(epoch from new.feature_cutoff_at),
          'outcomeCutoffEpoch', extract(epoch from new.outcome_cutoff_at),
          'knowledgeCutoffEpoch', extract(epoch from new.knowledge_cutoff_at),
          'requiredObservationCount', new.required_observation_count,
          'observationCount', new.observation_count,
          'eligibleObservationCount', new.eligible_observation_count,
          'scoredObservationCount', new.scored_observation_count,
          'knownOutcomeCount', new.known_outcome_count,
          'excludedObservationCount', new.excluded_observation_count,
          'invalidObservationCount', new.invalid_observation_count,
          'sourceManifestHash', new.source_manifest_hash,
          'predictionManifestHash', new.prediction_manifest_hash,
          'outcomeManifestHash', new.outcome_manifest_hash,
          'reportHash', new.report_hash
        )::text,
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  );

  return new;
end;
$$;

create or replace function app_private.reject_outcome_model_evaluation_mutation()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if tg_op = 'TRUNCATE' then
    raise exception using
      errcode = '55000',
      message = 'Outcome model evaluations cannot be truncated.';
  end if;
  raise exception using
    errcode = '55000',
    message = 'Outcome model evaluations are append-only.';
end;
$$;

create or replace function app_private.reject_outcome_model_registry_truncate()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  raise exception using
    errcode = '55000',
    message = 'Outcome model versions cannot be truncated.';
end;
$$;

create or replace function app_private.validate_outcome_model_version_insert()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.status <> 'draft'
    or new.approved_at is not null
    or new.approved_by is not null
    or new.shadow_started_at is not null then
    raise exception using
      errcode = '23514',
      message = 'Outcome model versions must be inserted as unapproved drafts.';
  end if;
  if pg_catalog.jsonb_typeof(new.metrics) <> 'object'
    or new.metrics = '{}'::jsonb
    or pg_catalog.jsonb_typeof(new.calibration) <> 'object'
    or new.calibration = '{}'::jsonb then
    raise exception using
      errcode = '23514',
      message = 'Outcome model versions require non-empty metrics and calibration.';
  end if;
  if new.artifact_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception using
      errcode = '23514',
      message = 'Outcome model versions require a lowercase SHA-256 artifact identity.';
  end if;
  return new;
end;
$$;

create or replace function app_private.guard_outcome_model_version_mutation()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  latest_evaluation public.outcome_model_evaluations%rowtype;
begin
  if tg_op = 'DELETE' then
    raise exception using
      errcode = '55000',
      message = 'Outcome model versions cannot be deleted.';
  end if;
  if (pg_catalog.to_jsonb(new) - array[
      'status', 'approved_at', 'approved_by', 'shadow_started_at'
    ]) <> (pg_catalog.to_jsonb(old) - array[
      'status', 'approved_at', 'approved_by', 'shadow_started_at'
    ]) then
    raise exception using
      errcode = '55000',
      message = 'Outcome model version contents are immutable.';
  end if;
  if old.status = 'validated' and new.status = 'shadow' then
    new.shadow_started_at := pg_catalog.clock_timestamp();
  elsif new.shadow_started_at is distinct from old.shadow_started_at then
    raise exception using
      errcode = '55000',
      message = 'Outcome model shadow provenance is server-managed and immutable.';
  end if;
  if not (old.status = 'draft' and new.status = 'validated')
    and (
      new.approved_at is distinct from old.approved_at
      or new.approved_by is distinct from old.approved_by
    ) then
    raise exception using
      errcode = '55000',
      message = 'Outcome model approval metadata is immutable after validation.';
  end if;

  if old.status = 'validated' and new.status = 'active' then
    raise exception using
      errcode = '23514',
      message = 'Outcome model activation cannot bypass shadow mode.';
  end if;
  if not (
    (old.status = 'draft' and new.status in ('validated', 'rejected'))
    or (old.status = 'validated' and new.status in ('shadow', 'rejected'))
    or (old.status = 'shadow' and new.status in ('active', 'retired', 'rejected'))
    or (old.status = 'active' and new.status = 'retired')
    or old.status = new.status
  ) then
    raise exception using
      errcode = '23514',
      message = 'Invalid Outcome model status transition.';
  end if;
  if new.status in ('validated', 'shadow', 'active')
    and (new.approved_at is null or new.approved_by is null) then
    raise exception using
      errcode = '23514',
      message = 'Validated Outcome models require complete approval metadata.';
  end if;
  if old.status = 'draft' and new.status = 'validated' then
    if new.approved_at > pg_catalog.statement_timestamp() then
      raise exception using
        errcode = '23514',
        message = 'Outcome model approval cannot be future-dated.';
    end if;
    if not exists (
      select 1
      from public.user_profiles approving_profile
      where approving_profile.user_id = new.approved_by
        and approving_profile.user_role = 'admin'
    ) then
      raise exception using
        errcode = '23514',
        message = 'Only an administrator may approve an Outcome model.';
    end if;
    if new.training_cutoff_at is not null
      and new.training_cutoff_at > new.approved_at then
      raise exception using
        errcode = '23514',
        message = 'Outcome model training cutoff cannot follow its approval.';
    end if;
  end if;

  if old.status = 'validated' and new.status = 'shadow' then
    select evaluation_row.* into latest_evaluation
    from public.outcome_model_evaluations evaluation_row
    where evaluation_row.model_version_id = old.id
      and evaluation_row.evaluation_mode = 'historical_replay'
    order by
      evaluation_row.created_at desc,
      evaluation_row.id desc
    limit 1;
    if not found or latest_evaluation.evaluation_status <> 'passed' then
      raise exception using
        errcode = '23514',
        message = 'Outcome model shadow transition requires the latest historical replay evaluation to pass.';
    end if;
  end if;

  if old.status = 'shadow' and new.status = 'active' then
    select evaluation_row.* into latest_evaluation
    from public.outcome_model_evaluations evaluation_row
    where evaluation_row.model_version_id = old.id
      and evaluation_row.evaluation_mode = 'prospective_shadow'
    order by
      evaluation_row.created_at desc,
      evaluation_row.id desc
    limit 1;
    if not found or latest_evaluation.evaluation_status <> 'passed' then
      raise exception using
        errcode = '23514',
        message = 'Outcome model activation requires the latest prospective shadow evaluation to pass.';
    end if;
    if latest_evaluation.scored_observation_count < 300 then
      raise exception using
        errcode = '23514',
        message = 'Outcome model activation requires at least 300 scored prospective predictions.';
    end if;
    if not app_private.outcome_model_evaluation_is_fresh(
      latest_evaluation.created_at,
      latest_evaluation.knowledge_cutoff_at,
      latest_evaluation.evaluation_period_end,
      pg_catalog.statement_timestamp()
    ) then
      raise exception using
        errcode = '23514',
        message = 'Outcome model activation requires prospective evidence from the last 30 days.';
    end if;
  end if;

  return new;
end;
$$;

create trigger validate_outcome_model_evaluation_before_insert
before insert on public.outcome_model_evaluations
for each row execute function
  app_private.validate_outcome_model_evaluation_insert();

create trigger outcome_model_evaluations_append_only
before update or delete on public.outcome_model_evaluations
for each row execute function
  app_private.reject_outcome_model_evaluation_mutation();

create trigger outcome_model_evaluations_no_truncate
before truncate on public.outcome_model_evaluations
for each statement execute function
  app_private.reject_outcome_model_evaluation_mutation();

create trigger model_versions_no_truncate
before truncate on public.model_versions
for each statement execute function
  app_private.reject_outcome_model_registry_truncate();

alter table public.outcome_model_evaluations enable row level security;

revoke all on table public.outcome_model_evaluations
from public, anon, authenticated, service_role;
grant select, insert on table public.outcome_model_evaluations
to service_role;

revoke all on function
  app_private.outcome_model_evaluation_report_is_safe(jsonb, text, text)
from public, anon, authenticated, service_role;
grant execute on function
  app_private.outcome_model_evaluation_report_is_safe(jsonb, text, text)
to service_role;
revoke all on function
  app_private.outcome_model_evaluation_is_fresh(
    timestamptz, timestamptz, date, timestamptz
  )
from public, anon, authenticated, service_role;
grant execute on function
  app_private.outcome_model_evaluation_is_fresh(
    timestamptz, timestamptz, date, timestamptz
  )
to service_role;
revoke all on function
  app_private.validate_outcome_model_evaluation_insert()
from public, anon, authenticated, service_role;
revoke all on function
  app_private.reject_outcome_model_evaluation_mutation()
from public, anon, authenticated, service_role;
revoke all on function
  app_private.reject_outcome_model_registry_truncate()
from public, anon, authenticated, service_role;
revoke all on function app_private.validate_outcome_model_version_insert()
from public, anon, authenticated, service_role;
revoke all on function app_private.guard_outcome_model_version_mutation()
from public, anon, authenticated, service_role;

comment on table public.outcome_model_evaluations is
  'Immutable aggregate-only evidence used to gate Outcome model shadowing and activation; individual auction or personal data is forbidden. The service-role evaluator remains the trust boundary for baseline and performance families absent from the closed summary.';
comment on column public.model_versions.calibration is
  'Non-empty immutable calibration summary for the exact model artifact version.';
comment on column public.model_versions.artifact_sha256 is
  'Immutable lowercase SHA-256 identity of the exact executable model artifact.';
comment on column public.model_versions.shadow_started_at is
  'Server-stamped start of prospective shadow operation; immutable after the validated-to-shadow transition.';
comment on function
  app_private.outcome_model_evaluation_report_is_safe(jsonb, text, text) is
  'Validates the closed promotion-summary contract outcome_model_evaluation_report_v1 without free text or individual identifiers; detailed outcome_evaluation_report_v1 payloads must be projected before insertion.';
comment on function
  app_private.outcome_model_evaluation_is_fresh(
    timestamptz, timestamptz, date, timestamptz
  ) is
  'Applies the versioned 30-day freshness window to prospective activation evidence.';

commit;
