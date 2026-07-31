begin;

create schema if not exists app_private;

create table public.outcome_addresses (
  id uuid primary key default gen_random_uuid(),
  label text,
  street text,
  postal_code text,
  city text,
  insee_code text,
  latitude double precision,
  longitude double precision,
  geocoding_source text,
  geocoding_score numeric(5,4),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint outcome_addresses_geocoding_score_check check (
    geocoding_score is null or geocoding_score between 0 and 1
  )
);

create table public.outcome_courts (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  court_type text not null default 'tribunal_judiciaire',
  address_id uuid references public.outcome_addresses(id) on delete set null,
  judicial_region text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.data_sources (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  publisher text,
  official boolean not null default false,
  base_url text,
  license text,
  terms_url text,
  terms_version text,
  legal_review_status text not null default 'pending' check (
    legal_review_status in ('pending', 'approved', 'rejected', 'expired')
  ),
  ingestion_policy text not null default 'disabled' check (
    ingestion_policy in (
      'allowed_automated',
      'allowed_manual',
      'partner_only',
      'disabled',
      'prohibited'
    )
  ),
  rate_limit jsonb not null default '{}'::jsonb,
  personal_data_possible boolean not null default false,
  active boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint data_sources_automation_review_check check (
    ingestion_policy <> 'allowed_automated' or legal_review_status = 'approved'
  )
);

create table public.raw_artifacts (
  id uuid primary key default gen_random_uuid(),
  source_id uuid not null references public.data_sources(id),
  external_record_id text,
  canonical_url text,
  storage_object_path text not null,
  mime_type text not null,
  byte_size bigint not null check (byte_size >= 0),
  content_hash text not null,
  published_at timestamptz,
  captured_at timestamptz not null,
  connector_version text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (source_id, content_hash),
  unique (id, source_id)
);

create table public.auction_cases (
  id uuid primary key default gen_random_uuid(),
  court_id uuid not null references public.outcome_courts(id),
  court_case_number text,
  portalis_number text,
  procedure_type text not null default 'unknown',
  case_status text not null default 'unknown',
  pursuing_law_firm_label text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index auction_cases_court_idx on public.auction_cases(court_id);
create index auction_cases_court_case_number_idx
  on public.auction_cases(court_id, court_case_number);
create index auction_cases_portalis_idx
  on public.auction_cases(portalis_number)
  where portalis_number is not null;

create table public.auction_lots (
  id uuid primary key default gen_random_uuid(),
  auction_case_id uuid not null references public.auction_cases(id),
  auction_sale_id uuid unique references public.auction_sales(id) on delete set null,
  lot_number text,
  lot_label text,
  property_type text not null default 'unknown',
  address_id uuid references public.outcome_addresses(id) on delete set null,
  occupation_status text not null default 'unknown' check (
    occupation_status in ('vacant', 'owner_occupied', 'tenant_occupied', 'occupied_other', 'unknown')
  ),
  occupation_confidence numeric(5,4),
  living_area_m2 numeric(10,2),
  carrez_area_m2 numeric(10,2),
  land_area_m2 numeric(12,2),
  room_count integer,
  bedroom_count integer,
  parking_count integer,
  initial_starting_price_eur numeric(14,2),
  price_reduction_rules jsonb not null default '{}'::jsonb,
  document_completeness_score numeric(5,2),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, auction_case_id),
  constraint auction_lots_occupation_confidence_check check (
    occupation_confidence is null or occupation_confidence between 0 and 1
  ),
  constraint auction_lots_areas_check check (
    (living_area_m2 is null or living_area_m2 >= 0)
    and (carrez_area_m2 is null or carrez_area_m2 >= 0)
    and (land_area_m2 is null or land_area_m2 >= 0)
  ),
  constraint auction_lots_counts_check check (
    (room_count is null or room_count >= 0)
    and (bedroom_count is null or bedroom_count >= 0)
    and (parking_count is null or parking_count >= 0)
  ),
  constraint auction_lots_starting_price_check check (
    initial_starting_price_eur is null or initial_starting_price_eur >= 0
  ),
  constraint auction_lots_document_score_check check (
    document_completeness_score is null or document_completeness_score between 0 and 100
  )
);

create index auction_lots_case_idx on public.auction_lots(auction_case_id);
create index auction_lots_auction_sale_idx on public.auction_lots(auction_sale_id);

create table public.auction_rounds (
  id uuid primary key default gen_random_uuid(),
  lot_id uuid not null references public.auction_lots(id),
  round_kind text not null check (
    round_kind in ('initial', 'postponed', 'surenchere', 'reiteration')
  ),
  sequence_number integer not null check (sequence_number >= 1),
  scheduled_at timestamptz,
  local_timezone text not null default 'Europe/Paris',
  actual_started_at timestamptz,
  actual_ended_at timestamptz,
  court_id uuid not null references public.outcome_courts(id),
  hearing_room text,
  initial_starting_price_eur numeric(14,2),
  effective_starting_price_eur numeric(14,2),
  price_steps_eur numeric(14,2)[],
  first_bid_level_eur numeric(14,2),
  current_status text not null default 'draft' check (
    current_status in (
      'draft', 'scheduled', 'confirmed', 'postponed', 'cancelled', 'not_requested',
      'held_no_bid', 'held_adjudicated_initial', 'surenchere_window_open',
      'surenchere_filed', 'surenchere_round_scheduled',
      'held_adjudicated_after_surenchere', 'surenchere_deadline_expired',
      'procedurally_definitive', 'settlement_pending', 'payment_confirmed',
      'payment_default_detected', 'reiteration_requested',
      'reiteration_round_scheduled', 'reiterated', 'unknown_outcome', 'closed'
    )
  ),
  previous_round_id uuid references public.auction_rounds(id),
  publication_first_seen_at timestamptz,
  result_first_seen_at timestamptz,
  status_confidence numeric(5,4),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (lot_id, sequence_number),
  unique (id, lot_id),
  constraint auction_rounds_previous_round_lot_fk foreign key (previous_round_id, lot_id)
    references public.auction_rounds(id, lot_id),
  constraint auction_rounds_prices_check check (
    (initial_starting_price_eur is null or initial_starting_price_eur >= 0)
    and (effective_starting_price_eur is null or effective_starting_price_eur >= 0)
    and (first_bid_level_eur is null or first_bid_level_eur >= 0)
  ),
  constraint auction_rounds_status_confidence_check check (
    status_confidence is null or status_confidence between 0 and 1
  ),
  constraint auction_rounds_actual_dates_check check (
    actual_ended_at is null or actual_started_at is null or actual_ended_at >= actual_started_at
  )
);

create index auction_rounds_lot_schedule_idx
  on public.auction_rounds(lot_id, scheduled_at desc, sequence_number desc);

create table public.auction_events (
  id uuid primary key default gen_random_uuid(),
  case_id uuid references public.auction_cases(id),
  lot_id uuid references public.auction_lots(id),
  round_id uuid references public.auction_rounds(id),
  event_type text not null,
  event_at timestamptz,
  observed_at timestamptz not null default now(),
  source_id uuid references public.data_sources(id),
  raw_artifact_id uuid references public.raw_artifacts(id),
  actor_user_id uuid,
  actor_organization_id uuid,
  payload jsonb not null default '{}'::jsonb,
  confidence_score numeric(5,4),
  supersedes_event_id uuid references public.auction_events(id),
  correction_reason text,
  created_at timestamptz not null default now(),
  constraint auction_events_entity_check check (
    case_id is not null
    and (lot_id is not null or round_id is null)
    and (round_id is null or lot_id is not null)
  ),
  constraint auction_events_lot_case_fk foreign key (lot_id, case_id)
    references public.auction_lots(id, auction_case_id),
  constraint auction_events_round_lot_fk foreign key (round_id, lot_id)
    references public.auction_rounds(id, lot_id),
  constraint auction_events_artifact_source_fk foreign key (raw_artifact_id, source_id)
    references public.raw_artifacts(id, source_id),
  constraint auction_events_provenance_check check (
    source_id is not null or actor_user_id is not null or actor_organization_id is not null
  ),
  constraint auction_events_artifact_source_required_check check (
    raw_artifact_id is null or source_id is not null
  ),
  constraint auction_events_confidence_check check (
    confidence_score is null or confidence_score between 0 and 1
  ),
  constraint auction_events_correction_check check (
    supersedes_event_id is null or nullif(btrim(correction_reason), '') is not null
  )
);

create index auction_events_round_observed_idx
  on public.auction_events(round_id, observed_at desc);

create unique index auction_events_one_successor_idx
  on public.auction_events(supersedes_event_id)
  where supersedes_event_id is not null;

create table public.auction_outcomes (
  id uuid primary key default gen_random_uuid(),
  round_id uuid not null references public.auction_rounds(id),
  version integer not null check (version >= 1),
  outcome_status text not null check (
    outcome_status in (
      'unknown', 'cancelled', 'not_requested', 'postponed', 'held_no_bid', 'held_adjudicated'
    )
  ),
  initial_hammer_price_eur numeric(14,2),
  final_hammer_price_eur numeric(14,2),
  taxed_costs_eur numeric(14,2),
  bidder_count_bucket text not null default 'unknown' check (
    bidder_count_bucket in ('0', '1', '2-3', '4-6', '7-10', '11+', 'unknown')
  ),
  surenchere_status text not null default 'unknown' check (
    surenchere_status in ('unknown', 'window_open', 'filed', 'not_filed', 'deadline_expired')
  ),
  surenchere_filed_at timestamptz,
  surenchere_amount_eur numeric(14,2),
  finality_status text not null default 'unknown' check (
    finality_status in ('unknown', 'provisional', 'procedurally_definitive')
  ),
  payment_status text not null default 'unknown' check (
    payment_status in ('unknown', 'pending', 'confirmed', 'default_detected')
  ),
  result_observed_at timestamptz,
  canonical_confidence numeric(5,4),
  training_eligible boolean not null default false,
  valid_from timestamptz not null default now(),
  valid_to timestamptz,
  supersedes_outcome_id uuid references public.auction_outcomes(id),
  created_by uuid,
  created_at timestamptz not null default now(),
  unique (round_id, version),
  unique (id, round_id),
  constraint auction_outcomes_superseded_round_fk foreign key (supersedes_outcome_id, round_id)
    references public.auction_outcomes(id, round_id),
  constraint auction_outcomes_prices_check check (
    (initial_hammer_price_eur is null or initial_hammer_price_eur >= 0)
    and (final_hammer_price_eur is null or final_hammer_price_eur >= 0)
    and (taxed_costs_eur is null or taxed_costs_eur >= 0)
    and (surenchere_amount_eur is null or surenchere_amount_eur >= 0)
  ),
  constraint auction_outcomes_confidence_check check (
    canonical_confidence is null or canonical_confidence between 0 and 1
  ),
  constraint auction_outcomes_validity_check check (
    valid_to is null or valid_to > valid_from
  ),
  constraint auction_outcomes_adjudication_price_check check (
    outcome_status <> 'held_adjudicated'
    or coalesce(final_hammer_price_eur, initial_hammer_price_eur) is not null
  ),
  constraint auction_outcomes_training_review_gate_check check (
    not training_eligible
  )
);

create index auction_outcomes_round_version_idx
  on public.auction_outcomes(round_id, version desc);

create unique index auction_outcomes_one_root_idx
  on public.auction_outcomes(round_id)
  where supersedes_outcome_id is null;

create unique index auction_outcomes_one_successor_idx
  on public.auction_outcomes(supersedes_outcome_id)
  where supersedes_outcome_id is not null;

create table public.auction_outcome_evidence (
  id uuid primary key default gen_random_uuid(),
  outcome_id uuid not null references public.auction_outcomes(id),
  raw_artifact_id uuid references public.raw_artifacts(id),
  source_id uuid not null references public.data_sources(id),
  evidence_type text not null,
  evidence_grade text not null check (evidence_grade in ('A', 'B', 'C', 'rejected')),
  claim_types text[] not null default '{}',
  lot_matching_confidence numeric(5,4),
  round_matching_confidence numeric(5,4),
  price_extraction_confidence numeric(5,4),
  finality_confidence numeric(5,4),
  review_status text not null default 'pending' check (
    review_status in ('pending', 'in_review', 'approved', 'rejected', 'conflicted')
  ),
  created_at timestamptz not null default now(),
  constraint auction_outcome_evidence_artifact_source_fk
    foreign key (raw_artifact_id, source_id)
    references public.raw_artifacts(id, source_id),
  constraint auction_outcome_evidence_confidences_check check (
    (lot_matching_confidence is null or lot_matching_confidence between 0 and 1)
    and (round_matching_confidence is null or round_matching_confidence between 0 and 1)
    and (price_extraction_confidence is null or price_extraction_confidence between 0 and 1)
    and (finality_confidence is null or finality_confidence between 0 and 1)
  )
);

create index auction_outcome_evidence_outcome_idx
  on public.auction_outcome_evidence(outcome_id);

create table public.evidence_reviews (
  id uuid primary key default gen_random_uuid(),
  evidence_id uuid not null references public.auction_outcome_evidence(id),
  reviewer_user_id uuid not null,
  review_type text not null,
  decision text not null check (
    decision in ('approved', 'rejected', 'needs_correction', 'needs_second_review')
  ),
  field_decisions jsonb not null default '{}'::jsonb,
  notes text,
  independent_review boolean not null default false,
  reviewed_at timestamptz not null default now(),
  unique (evidence_id, reviewer_user_id, review_type)
);

create table public.auction_feature_snapshots (
  id uuid primary key default gen_random_uuid(),
  lot_id uuid not null references public.auction_lots(id),
  round_id uuid not null references public.auction_rounds(id),
  prediction_horizon text not null check (
    prediction_horizon in ('T-30', 'T-14', 'T-7', 'T-1', 'T-2h')
  ),
  feature_cutoff_at timestamptz not null,
  built_at timestamptz not null default now(),
  feature_schema_version text not null,
  feature_builder_version text not null,
  features jsonb not null,
  source_manifest jsonb not null,
  source_manifest_hash text not null,
  snapshot_hash text not null unique,
  market_estimate_version text,
  dvf_release text,
  bdnb_release text,
  rnic_release text,
  dpe_release text,
  data_completeness_score numeric(5,2),
  data_freshness_score numeric(5,2),
  leakage_check_status text not null default 'pending' check (
    leakage_check_status in ('pending', 'passed', 'failed')
  ),
  retrospective boolean not null default false,
  training_eligible boolean not null default false,
  created_at timestamptz not null default now(),
  unique (id, round_id),
  constraint auction_feature_snapshots_round_lot_fk foreign key (round_id, lot_id)
    references public.auction_rounds(id, lot_id),
  constraint auction_feature_snapshots_scores_check check (
    (data_completeness_score is null or data_completeness_score between 0 and 100)
    and (data_freshness_score is null or data_freshness_score between 0 and 100)
  ),
  constraint auction_feature_snapshots_build_cutoff_check check (built_at >= feature_cutoff_at),
  constraint auction_feature_snapshots_created_after_build_check check (created_at >= built_at),
  constraint auction_feature_snapshots_retrospective_training_check check (
    not retrospective or not training_eligible
  )
);

create index auction_feature_snapshots_round_horizon_idx
  on public.auction_feature_snapshots(round_id, prediction_horizon, built_at desc);

create table public.cohort_definitions (
  id uuid primary key default gen_random_uuid(),
  cohort_key text not null,
  definition_version integer not null check (definition_version >= 1),
  cohort_level text not null check (
    cohort_level in (
      'tribunal_procedure_type_occupation_discount', 'tribunal_procedure_type',
      'region_procedure_type', 'national_procedure_type',
      'national_property_type', 'national'
    )
  ),
  label text not null,
  filters jsonb not null default '{}'::jsonb,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (cohort_key, definition_version)
);

create table public.cohort_statistics (
  id uuid primary key default gen_random_uuid(),
  cohort_definition_id uuid not null references public.cohort_definitions(id),
  prediction_horizon text not null check (
    prediction_horizon in ('T-30', 'T-14', 'T-7', 'T-1', 'T-2h')
  ),
  period_start date not null,
  period_end date not null,
  sample_size integer not null check (sample_size >= 0),
  tribunal_sample_size integer not null default 0 check (tribunal_sample_size >= 0),
  training_eligible boolean not null default false,
  has_blocking_conflict boolean not null default false,
  flow_probabilities jsonb not null default '{}'::jsonb,
  initial_price_ratios jsonb not null default '{}'::jsonb,
  final_price_ratios jsonb not null default '{}'::jsonb,
  surenchere_probability numeric(5,4),
  pressure_components jsonb not null default '{}'::jsonb,
  delay_probabilities jsonb not null default '{}'::jsonb,
  statistics_hash text not null unique,
  created_at timestamptz not null default now(),
  constraint cohort_statistics_period_check check (period_end >= period_start),
  constraint cohort_statistics_surenchere_check check (
    surenchere_probability is null or surenchere_probability between 0 and 1
  ),
  constraint cohort_statistics_autonomous_check check (
    not training_eligible or (sample_size >= 10 and not has_blocking_conflict)
  )
);

create index cohort_statistics_definition_period_idx
  on public.cohort_statistics(cohort_definition_id, period_end desc, created_at desc);

create table public.model_versions (
  id uuid primary key default gen_random_uuid(),
  model_key text not null,
  version text not null,
  model_kind text not null check (model_kind in ('cohort_baseline', 'statistical', 'machine_learning')),
  segment text not null default 'national',
  status text not null default 'draft' check (
    status in ('draft', 'validated', 'shadow', 'active', 'retired', 'rejected')
  ),
  feature_schema_version text not null,
  training_cutoff_at timestamptz,
  training_sample_size integer check (training_sample_size is null or training_sample_size >= 0),
  artifact_uri text,
  metrics jsonb not null default '{}'::jsonb,
  approved_at timestamptz,
  approved_by uuid,
  created_at timestamptz not null default now(),
  unique (model_key, version),
  constraint model_versions_approval_check check (
    status not in ('validated', 'shadow', 'active')
    or (approved_at is not null and approved_by is not null)
  ),
  constraint model_versions_approval_time_check check (
    approved_at is null or approved_at >= created_at
  ),
  constraint model_versions_complexity_threshold_check check (
    model_kind = 'cohort_baseline'
    or (model_kind = 'statistical' and coalesce(training_sample_size, 0) >= 300)
    or (model_kind = 'machine_learning' and coalesce(training_sample_size, 0) >= 1000)
  )
);

create unique index model_versions_one_active_segment_idx
  on public.model_versions(model_key, segment)
  where status = 'active';

create table public.auction_predictions (
  id uuid primary key default gen_random_uuid(),
  round_id uuid not null references public.auction_rounds(id),
  snapshot_id uuid not null references public.auction_feature_snapshots(id),
  model_version_id uuid not null references public.model_versions(id),
  cohort_statistics_id uuid references public.cohort_statistics(id),
  prediction_kind text not null default 'outcome_graph' check (
    prediction_kind in ('outcome_graph', 'shadow')
  ),
  prediction_status text not null default 'ready' check (
    prediction_status in ('ready', 'insufficient_data')
  ),
  generated_at timestamptz not null default now(),
  horizon text not null check (horizon in ('T-30', 'T-14', 'T-7', 'T-1', 'T-2h')),
  conditional_on jsonb not null default '{}'::jsonb,
  probabilities jsonb not null default '{}'::jsonb,
  quantiles jsonb not null default '{}'::jsonb,
  expected_value_eur numeric(14,2),
  confidence_level numeric(5,4),
  confidence_label text check (confidence_label in ('faible', 'moyen', 'élevé')),
  sample_size integer check (sample_size is null or sample_size >= 0),
  explanation_factors jsonb not null default '[]'::jsonb,
  limitations jsonb not null default '[]'::jsonb,
  refusal_reason text,
  prediction_hash text not null unique,
  supersedes_prediction_id uuid references public.auction_predictions(id),
  superseded_by uuid references public.auction_predictions(id),
  created_at timestamptz not null default now(),
  unique (round_id, prediction_kind, generated_at),
  constraint auction_predictions_snapshot_round_fk foreign key (snapshot_id, round_id)
    references public.auction_feature_snapshots(id, round_id),
  constraint auction_predictions_expected_value_check check (
    expected_value_eur is null or expected_value_eur >= 0
  ),
  constraint auction_predictions_confidence_check check (
    confidence_level is null or confidence_level between 0 and 1
  ),
  constraint auction_predictions_ready_sample_check check (
    prediction_status <> 'ready' or coalesce(sample_size, 0) >= 10
  ),
  constraint auction_predictions_refusal_check check (
    prediction_status <> 'insufficient_data' or nullif(btrim(refusal_reason), '') is not null
  ),
  constraint auction_predictions_created_after_generated_check check (
    created_at >= generated_at
  ),
  constraint auction_predictions_superseded_by_reserved_check check (
    superseded_by is null
  )
);

create index auction_predictions_round_latest_idx
  on public.auction_predictions(round_id, prediction_kind, generated_at desc, created_at desc);

create unique index auction_predictions_one_successor_idx
  on public.auction_predictions(supersedes_prediction_id)
  where supersedes_prediction_id is not null;

create unique index auction_predictions_one_root_idx
  on public.auction_predictions(round_id, prediction_kind, horizon)
  where supersedes_prediction_id is null;

create or replace function app_private.reject_outcome_graph_mutation()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  raise exception using
    errcode = '55000',
    message = format('%I.%I is append-only; insert a correcting version instead.', tg_table_schema, tg_table_name);
end;
$$;

create or replace function app_private.validate_outcome_round_lineage()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  linked_previous_round public.auction_rounds%rowtype;
begin
  if new.previous_round_id is null then
    if new.round_kind <> 'initial' or new.sequence_number <> 1 then
      raise exception using
        errcode = '23514',
        message = 'Only the first initial round may omit previous_round_id.';
    end if;
    return new;
  end if;

  select previous_round.* into linked_previous_round
  from public.auction_rounds previous_round
  where previous_round.id = new.previous_round_id
  for share;

  if linked_previous_round.id is null
    or linked_previous_round.id = new.id
    or linked_previous_round.lot_id <> new.lot_id
    or linked_previous_round.sequence_number >= new.sequence_number then
    raise exception using
      errcode = '23514',
      message = 'Outcome round lineage must stay on one lot and move to a higher sequence.';
  end if;
  if new.round_kind = 'initial' then
    raise exception using
      errcode = '23514',
      message = 'A successor round must be postponed, surenchere, or reiteration.';
  end if;

  return new;
end;
$$;

create or replace function app_private.validate_outcome_event()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  linked_prior_event public.auction_events%rowtype;
begin
  if new.supersedes_event_id is null then
    return new;
  end if;

  select prior_event.* into linked_prior_event
  from public.auction_events prior_event
  where prior_event.id = new.supersedes_event_id;

  if linked_prior_event.id is null
    or linked_prior_event.id = new.id
    or linked_prior_event.case_id is distinct from new.case_id
    or linked_prior_event.lot_id is distinct from new.lot_id
    or linked_prior_event.round_id is distinct from new.round_id
    or new.observed_at < linked_prior_event.observed_at
    or new.created_at < linked_prior_event.created_at then
    raise exception using
      errcode = '23514',
      message = 'Event supersession must preserve its entity lineage and move forward in time.';
  end if;
  if exists (
    select 1
    from public.auction_events successor_event
    where successor_event.supersedes_event_id = linked_prior_event.id
  ) then
    raise exception using errcode = '23514', message = 'Event supersession cannot branch.';
  end if;

  return new;
end;
$$;

create or replace function app_private.validate_outcome_version()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  linked_prior_outcome public.auction_outcomes%rowtype;
begin
  if new.supersedes_outcome_id is null then
    if new.version <> 1 then
      raise exception using
        errcode = '23514',
        message = 'An Outcome Graph outcome chain must start at version 1.';
    end if;
    return new;
  end if;

  select prior_outcome.* into linked_prior_outcome
  from public.auction_outcomes prior_outcome
  where prior_outcome.id = new.supersedes_outcome_id;

  if linked_prior_outcome.id is null
    or linked_prior_outcome.id = new.id
    or linked_prior_outcome.round_id <> new.round_id
    or new.version <> linked_prior_outcome.version + 1
    or new.valid_from <= linked_prior_outcome.valid_from
    or (
      linked_prior_outcome.valid_to is not null
      and new.valid_from < linked_prior_outcome.valid_to
    ) then
    raise exception using
      errcode = '23514',
      message = 'Outcome supersession must stay on one round and advance version and validity.';
  end if;
  if exists (
    select 1
    from public.auction_outcomes successor_outcome
    where successor_outcome.supersedes_outcome_id = linked_prior_outcome.id
  ) then
    raise exception using errcode = '23514', message = 'Outcome supersession cannot branch.';
  end if;

  return new;
end;
$$;

create or replace function app_private.validate_outcome_cohort_statistics()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  linked_definition public.cohort_definitions%rowtype;
  held_probability numeric;
  postponed_probability numeric;
  cancelled_probability numeric;
  adjudicated_probability numeric;
  no_bid_probability numeric;
  initial_p10 numeric;
  initial_p50 numeric;
  initial_p90 numeric;
  final_p10 numeric;
  final_p50 numeric;
  final_p90 numeric;
begin
  if new.tribunal_sample_size > new.sample_size then
    raise exception using
      errcode = '23514',
      message = 'Tribunal sample size cannot exceed the cohort sample size.';
  end if;
  if new.period_end > (new.created_at at time zone 'UTC')::date then
    raise exception using
      errcode = '23514',
      message = 'Cohort statistics cannot include a period after their computation.';
  end if;
  if not new.training_eligible then
    return new;
  end if;

  select definition_row.* into linked_definition
  from public.cohort_definitions definition_row
  where definition_row.id = new.cohort_definition_id;
  if linked_definition.id is null or not linked_definition.active then
    raise exception using
      errcode = '23514',
      message = 'Training-eligible statistics require an active cohort definition.';
  end if;
  if jsonb_typeof(new.flow_probabilities) <> 'object'
    or jsonb_typeof(new.initial_price_ratios) <> 'object'
    or jsonb_typeof(new.final_price_ratios) <> 'object'
    or new.surenchere_probability is null then
    raise exception using
      errcode = '23514',
      message = 'Training-eligible cohort statistics require complete aggregate payloads.';
  end if;

  begin
    held_probability := (new.flow_probabilities ->> 'held_probability')::numeric;
    postponed_probability := (new.flow_probabilities ->> 'postponed_probability')::numeric;
    cancelled_probability :=
      (new.flow_probabilities ->> 'cancelled_or_not_requested_probability')::numeric;
    adjudicated_probability :=
      (new.flow_probabilities ->> 'adjudicated_if_held_probability')::numeric;
    no_bid_probability := (new.flow_probabilities ->> 'no_bid_if_held_probability')::numeric;
    initial_p10 := (new.initial_price_ratios ->> 'p10')::numeric;
    initial_p50 := (new.initial_price_ratios ->> 'p50')::numeric;
    initial_p90 := (new.initial_price_ratios ->> 'p90')::numeric;
    final_p10 := (new.final_price_ratios ->> 'p10')::numeric;
    final_p50 := (new.final_price_ratios ->> 'p50')::numeric;
    final_p90 := (new.final_price_ratios ->> 'p90')::numeric;
  exception when others then
    raise exception using
      errcode = '23514',
      message = 'Training-eligible cohort statistics contain invalid aggregate values.';
  end;

  if held_probability is null or held_probability not between 0 and 1
    or postponed_probability is null or postponed_probability not between 0 and 1
    or cancelled_probability is null or cancelled_probability not between 0 and 1
    or adjudicated_probability is null or adjudicated_probability not between 0 and 1
    or no_bid_probability is null or no_bid_probability not between 0 and 1
    or abs(held_probability + postponed_probability + cancelled_probability - 1) > 0.02
    or abs(adjudicated_probability + no_bid_probability - 1) > 0.02
    or initial_p10 is null or initial_p10 <= 0
    or initial_p50 is null or initial_p10 > initial_p50
    or initial_p90 is null or initial_p50 > initial_p90
    or final_p10 is null or final_p10 <= 0
    or final_p50 is null or final_p10 > final_p50
    or final_p90 is null or final_p50 > final_p90 then
    raise exception using
      errcode = '23514',
      message = 'Training-eligible cohort aggregates must be valid and monotone.';
  end if;

  return new;
end;
$$;

create or replace function app_private.validate_outcome_snapshot()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  linked_round public.auction_rounds%rowtype;
  manifest_entry jsonb;
  entry_published_at timestamptz;
  entry_captured_at timestamptz;
begin
  select round_row.* into linked_round
  from public.auction_rounds round_row
  where round_row.id = new.round_id
  for share;

  if linked_round.id is null or linked_round.lot_id <> new.lot_id then
    raise exception using errcode = '23514', message = 'Snapshot lot and round do not match.';
  end if;
  if linked_round.scheduled_at is not null and new.feature_cutoff_at >= linked_round.scheduled_at then
    raise exception using errcode = '23514', message = 'Snapshot cutoff must precede the hearing.';
  end if;
  if linked_round.scheduled_at is not null
    and new.built_at >= linked_round.scheduled_at
    and not new.retrospective then
    raise exception using errcode = '23514', message = 'A post-hearing snapshot must be marked retrospective.';
  end if;
  if new.training_eligible and (new.retrospective or new.leakage_check_status <> 'passed') then
    raise exception using errcode = '23514', message = 'Training snapshots must be prospective and pass leakage checks.';
  end if;

  if new.leakage_check_status = 'passed' then
    if jsonb_typeof(new.source_manifest) <> 'array'
      or jsonb_array_length(new.source_manifest) = 0 then
      raise exception using errcode = '23514', message = 'A passed snapshot requires a non-empty source manifest.';
    end if;

    for manifest_entry in select value from jsonb_array_elements(new.source_manifest)
    loop
      begin
        entry_published_at := nullif(manifest_entry ->> 'published_at', '')::timestamptz;
        entry_captured_at := nullif(manifest_entry ->> 'captured_at', '')::timestamptz;
      exception when others then
        raise exception using errcode = '23514', message = 'Source manifest timestamps are invalid.';
      end;
      if entry_published_at is null or entry_captured_at is null
        or entry_published_at > new.feature_cutoff_at
        or entry_captured_at > new.feature_cutoff_at then
        raise exception using errcode = '23514', message = 'Source manifest leaks post-cutoff information.';
      end if;
    end loop;
  end if;

  return new;
end;
$$;

create or replace function app_private.validate_outcome_prediction()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  linked_snapshot public.auction_feature_snapshots%rowtype;
  linked_round public.auction_rounds%rowtype;
  linked_lot public.auction_lots%rowtype;
  linked_model public.model_versions%rowtype;
  linked_cohort public.cohort_statistics%rowtype;
  linked_cohort_definition public.cohort_definitions%rowtype;
  linked_prior_prediction public.auction_predictions%rowtype;
  probability_key text;
  probability_value numeric;
  held_probability numeric;
  postponed_probability numeric;
  cancelled_probability numeric;
  adjudicated_probability numeric;
  no_bid_probability numeric;
  initial_p10 numeric;
  initial_p50 numeric;
  initial_p90 numeric;
  final_p10 numeric;
  final_p50 numeric;
  final_p90 numeric;
begin
  select snapshot_row.* into linked_snapshot
  from public.auction_feature_snapshots snapshot_row
  where snapshot_row.id = new.snapshot_id;
  select round_row.* into linked_round
  from public.auction_rounds round_row
  where round_row.id = new.round_id
  for share;
  select lot_row.* into linked_lot
  from public.auction_lots lot_row
  where lot_row.id = linked_round.lot_id;
  select model_row.* into linked_model
  from public.model_versions model_row
  where model_row.id = new.model_version_id;
  if new.cohort_statistics_id is not null then
    select cohort_row.* into linked_cohort
    from public.cohort_statistics cohort_row
    where cohort_row.id = new.cohort_statistics_id;
    if linked_cohort.id is not null then
      select definition_row.* into linked_cohort_definition
      from public.cohort_definitions definition_row
      where definition_row.id = linked_cohort.cohort_definition_id;
    end if;
  end if;
  if new.supersedes_prediction_id is not null then
    select prediction_row.* into linked_prior_prediction
    from public.auction_predictions prediction_row
    where prediction_row.id = new.supersedes_prediction_id;
  end if;

  if linked_snapshot.id is null or linked_snapshot.round_id <> new.round_id then
    raise exception using errcode = '23514', message = 'Prediction snapshot and round do not match.';
  end if;
  if linked_model.id is null then
    raise exception using errcode = '23514', message = 'Prediction model is missing.';
  end if;
  if new.supersedes_prediction_id is not null then
    if linked_prior_prediction.id is null
      or linked_prior_prediction.id = new.id
      or linked_prior_prediction.round_id <> new.round_id
      or linked_prior_prediction.prediction_kind <> new.prediction_kind
      or linked_prior_prediction.horizon <> new.horizon
      or new.generated_at <= linked_prior_prediction.generated_at then
      raise exception using errcode = '23514', message = 'Prediction supersession chain is incoherent.';
    end if;
    if exists (
      select 1
      from public.auction_predictions child_prediction
      where child_prediction.supersedes_prediction_id = linked_prior_prediction.id
    ) then
      raise exception using errcode = '23514', message = 'Prediction supersession cannot branch.';
    end if;
  elsif exists (
    select 1
    from public.auction_predictions prior_root
    where prior_root.round_id = new.round_id
      and prior_root.prediction_kind = new.prediction_kind
      and prior_root.horizon = new.horizon
  ) then
    raise exception using
      errcode = '23514',
      message = 'A later prediction must supersede the current prediction chain.';
  end if;
  if new.prediction_kind = 'outcome_graph' and linked_model.status <> 'active' then
    raise exception using errcode = '23514', message = 'Published Outcome Graph prediction requires an active model.';
  end if;
  if new.prediction_kind = 'shadow' and linked_model.status <> 'shadow' then
    raise exception using errcode = '23514', message = 'Shadow prediction requires a shadow model.';
  end if;
  if new.horizon <> linked_snapshot.prediction_horizon then
    raise exception using errcode = '23514', message = 'Prediction and snapshot horizons do not match.';
  end if;
  if linked_snapshot.feature_schema_version <> linked_model.feature_schema_version then
    raise exception using errcode = '23514', message = 'Prediction model and snapshot feature schemas do not match.';
  end if;
  if linked_model.created_at > new.generated_at
    or linked_model.approved_at is null
    or linked_model.approved_at > new.generated_at then
    raise exception using errcode = '23514', message = 'Prediction cannot predate model creation and approval.';
  end if;
  if linked_model.training_cutoff_at is not null
    and linked_model.training_cutoff_at > linked_snapshot.feature_cutoff_at then
    raise exception using errcode = '23514', message = 'Prediction model training cutoff exceeds the feature cutoff.';
  end if;
  if new.generated_at < linked_snapshot.built_at then
    raise exception using errcode = '23514', message = 'Prediction cannot predate its snapshot build.';
  end if;
  if linked_round.scheduled_at is not null and new.generated_at >= linked_round.scheduled_at then
    raise exception using errcode = '23514', message = 'Published prediction must precede the hearing.';
  end if;

  if new.prediction_status = 'ready' then
    if linked_lot.id is null
      or not linked_lot.active
      or linked_round.current_status not in (
        'scheduled', 'confirmed', 'surenchere_round_scheduled', 'reiteration_round_scheduled'
      ) then
      raise exception using errcode = '23514', message = 'Ready prediction requires an active pre-hearing round.';
    end if;
    if linked_round.scheduled_at is null then
      raise exception using errcode = '23514', message = 'Ready prediction requires a scheduled hearing.';
    end if;
    if linked_snapshot.retrospective or linked_snapshot.leakage_check_status <> 'passed' then
      raise exception using errcode = '23514', message = 'Ready prediction requires a prospective leakage-safe snapshot.';
    end if;
    if linked_cohort.id is null
      or not linked_cohort.training_eligible
      or linked_cohort.has_blocking_conflict
      or linked_cohort.sample_size < 10
      or linked_cohort.prediction_horizon <> new.horizon then
      raise exception using errcode = '23514', message = 'Ready prediction requires an eligible conflict-free cohort.';
    end if;
    if linked_cohort_definition.id is null or not linked_cohort_definition.active then
      raise exception using
        errcode = '23514',
        message = 'Ready prediction requires an active cohort definition.';
    end if;
    if new.sample_size <> linked_cohort.sample_size then
      raise exception using errcode = '23514', message = 'Ready prediction sample size must match its cohort.';
    end if;
    if linked_model.training_cutoff_at is null then
      raise exception using
        errcode = '23514',
        message = 'Ready prediction requires a model training cutoff.';
    end if;
    if linked_cohort.created_at > linked_snapshot.feature_cutoff_at
      or linked_cohort.period_end > (linked_snapshot.feature_cutoff_at at time zone 'UTC')::date then
      raise exception using errcode = '23514', message = 'Ready prediction cohort exceeds the feature cutoff.';
    end if;
    if jsonb_typeof(new.probabilities) <> 'object' or jsonb_typeof(new.quantiles) <> 'object' then
      raise exception using errcode = '23514', message = 'Prediction payloads must be JSON objects.';
    end if;

    foreach probability_key in array array[
      'held_probability',
      'postponed_probability',
      'cancelled_or_not_requested_probability',
      'adjudicated_if_held_probability',
      'no_bid_if_held_probability',
      'surenchere_probability'
    ] loop
      begin
        probability_value := (new.probabilities ->> probability_key)::numeric;
      exception when others then
        raise exception using errcode = '23514', message = 'Prediction probability is missing or invalid.';
      end;
      if probability_value is null or probability_value < 0 or probability_value > 1 then
        raise exception using errcode = '23514', message = 'Prediction probability is outside [0,1].';
      end if;
    end loop;

    held_probability := (new.probabilities ->> 'held_probability')::numeric;
    postponed_probability := (new.probabilities ->> 'postponed_probability')::numeric;
    cancelled_probability := (new.probabilities ->> 'cancelled_or_not_requested_probability')::numeric;
    adjudicated_probability := (new.probabilities ->> 'adjudicated_if_held_probability')::numeric;
    no_bid_probability := (new.probabilities ->> 'no_bid_if_held_probability')::numeric;
    if abs(held_probability + postponed_probability + cancelled_probability - 1) > 0.02
      or abs(adjudicated_probability + no_bid_probability - 1) > 0.02 then
      raise exception using errcode = '23514', message = 'Prediction conditional probabilities are incoherent.';
    end if;

    begin
      initial_p10 := (new.quantiles #>> '{initial_price_eur,p10}')::numeric;
      initial_p50 := (new.quantiles #>> '{initial_price_eur,p50}')::numeric;
      initial_p90 := (new.quantiles #>> '{initial_price_eur,p90}')::numeric;
      final_p10 := (new.quantiles #>> '{final_price_eur,p10}')::numeric;
      final_p50 := (new.quantiles #>> '{final_price_eur,p50}')::numeric;
      final_p90 := (new.quantiles #>> '{final_price_eur,p90}')::numeric;
    exception when others then
      raise exception using errcode = '23514', message = 'Prediction quantiles are missing or invalid.';
    end;
    if initial_p10 is null or initial_p50 is null or initial_p90 is null
      or final_p10 is null or final_p50 is null or final_p90 is null
      or initial_p10 <= 0 or initial_p10 > initial_p50 or initial_p50 > initial_p90
      or final_p10 <= 0 or final_p10 > final_p50 or final_p50 > final_p90 then
      raise exception using errcode = '23514', message = 'Prediction quantiles must be positive and monotone.';
    end if;
  end if;

  return new;
end;
$$;

create or replace function app_private.guard_outcome_round_forecast_inputs()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if exists (
    select 1
    from public.auction_feature_snapshots snapshot_row
    where snapshot_row.round_id = old.id
  ) and (
    new.lot_id is distinct from old.lot_id
    or new.round_kind is distinct from old.round_kind
    or new.sequence_number is distinct from old.sequence_number
    or new.scheduled_at is distinct from old.scheduled_at
    or new.local_timezone is distinct from old.local_timezone
    or new.court_id is distinct from old.court_id
    or new.initial_starting_price_eur is distinct from old.initial_starting_price_eur
    or new.effective_starting_price_eur is distinct from old.effective_starting_price_eur
    or new.price_steps_eur is distinct from old.price_steps_eur
    or new.first_bid_level_eur is distinct from old.first_bid_level_eur
    or new.previous_round_id is distinct from old.previous_round_id
  ) then
    raise exception using
      errcode = '55000',
      message = 'Outcome round forecast inputs are immutable once a feature snapshot exists; create a new round.';
  end if;
  return new;
end;
$$;

create or replace function app_private.validate_outcome_model_version_insert()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.status <> 'draft' or new.approved_at is not null or new.approved_by is not null then
    raise exception using
      errcode = '23514',
      message = 'Outcome model versions must be inserted as unapproved drafts.';
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
begin
  if tg_op = 'DELETE' then
    raise exception using errcode = '55000', message = 'Outcome model versions cannot be deleted.';
  end if;
  if (to_jsonb(new) - array['status', 'approved_at', 'approved_by'])
    <> (to_jsonb(old) - array['status', 'approved_at', 'approved_by']) then
    raise exception using errcode = '55000', message = 'Outcome model version contents are immutable.';
  end if;
  if not (old.status = 'draft' and new.status = 'validated')
    and (
      new.approved_at is distinct from old.approved_at
      or new.approved_by is distinct from old.approved_by
    ) then
    raise exception using errcode = '55000', message = 'Outcome model approval metadata is immutable after validation.';
  end if;
  if not (
    (old.status = 'draft' and new.status in ('validated', 'rejected'))
    or (old.status = 'validated' and new.status in ('shadow', 'active', 'rejected'))
    or (old.status = 'shadow' and new.status in ('active', 'retired', 'rejected'))
    or (old.status = 'active' and new.status = 'retired')
    or old.status = new.status
  ) then
    raise exception using errcode = '23514', message = 'Invalid Outcome model status transition.';
  end if;
  if new.status in ('validated', 'shadow', 'active')
    and (new.approved_at is null or new.approved_by is null) then
    raise exception using errcode = '23514', message = 'Validated Outcome models require complete approval metadata.';
  end if;
  if old.status = 'draft' and new.status = 'validated' then
    if new.approved_at > statement_timestamp() then
      raise exception using errcode = '23514', message = 'Outcome model approval cannot be future-dated.';
    end if;
    if not exists (
      select 1
      from public.user_profiles approving_profile
      where approving_profile.user_id = new.approved_by
        and approving_profile.user_role = 'admin'
    ) then
      raise exception using errcode = '23514', message = 'Only an administrator may approve an Outcome model.';
    end if;
    if new.training_cutoff_at is not null and new.training_cutoff_at > new.approved_at then
      raise exception using
        errcode = '23514',
        message = 'Outcome model training cutoff cannot follow its approval.';
    end if;
  end if;
  return new;
end;
$$;

create trigger validate_outcome_round_lineage_before_write
before insert or update on public.auction_rounds
for each row execute function app_private.validate_outcome_round_lineage();

create trigger validate_outcome_event_before_insert
before insert on public.auction_events
for each row execute function app_private.validate_outcome_event();

create trigger validate_outcome_version_before_insert
before insert on public.auction_outcomes
for each row execute function app_private.validate_outcome_version();

create trigger validate_outcome_cohort_statistics_before_insert
before insert on public.cohort_statistics
for each row execute function app_private.validate_outcome_cohort_statistics();

create trigger validate_outcome_snapshot_before_insert
before insert on public.auction_feature_snapshots
for each row execute function app_private.validate_outcome_snapshot();

create trigger validate_outcome_prediction_before_insert
before insert on public.auction_predictions
for each row execute function app_private.validate_outcome_prediction();

create trigger guard_outcome_round_forecast_inputs_before_update
before update on public.auction_rounds
for each row execute function app_private.guard_outcome_round_forecast_inputs();

create trigger validate_outcome_model_version_before_insert
before insert on public.model_versions
for each row execute function app_private.validate_outcome_model_version_insert();

create trigger raw_artifacts_append_only
before update or delete on public.raw_artifacts
for each row execute function app_private.reject_outcome_graph_mutation();
create trigger auction_events_append_only
before update or delete on public.auction_events
for each row execute function app_private.reject_outcome_graph_mutation();
create trigger auction_outcomes_append_only
before update or delete on public.auction_outcomes
for each row execute function app_private.reject_outcome_graph_mutation();
create trigger auction_outcome_evidence_append_only
before update or delete on public.auction_outcome_evidence
for each row execute function app_private.reject_outcome_graph_mutation();
create trigger evidence_reviews_append_only
before update or delete on public.evidence_reviews
for each row execute function app_private.reject_outcome_graph_mutation();
create trigger auction_feature_snapshots_append_only
before update or delete on public.auction_feature_snapshots
for each row execute function app_private.reject_outcome_graph_mutation();
create trigger cohort_statistics_append_only
before update or delete on public.cohort_statistics
for each row execute function app_private.reject_outcome_graph_mutation();
create trigger model_versions_guard_mutation
before update or delete on public.model_versions
for each row execute function app_private.guard_outcome_model_version_mutation();
create trigger auction_predictions_append_only
before update or delete on public.auction_predictions
for each row execute function app_private.reject_outcome_graph_mutation();

alter table public.outcome_addresses enable row level security;
alter table public.outcome_courts enable row level security;
alter table public.data_sources enable row level security;
alter table public.raw_artifacts enable row level security;
alter table public.auction_cases enable row level security;
alter table public.auction_lots enable row level security;
alter table public.auction_rounds enable row level security;
alter table public.auction_events enable row level security;
alter table public.auction_outcomes enable row level security;
alter table public.auction_outcome_evidence enable row level security;
alter table public.evidence_reviews enable row level security;
alter table public.auction_feature_snapshots enable row level security;
alter table public.cohort_definitions enable row level security;
alter table public.cohort_statistics enable row level security;
alter table public.model_versions enable row level security;
alter table public.auction_predictions enable row level security;

revoke all on table
  public.outcome_addresses,
  public.outcome_courts,
  public.data_sources,
  public.raw_artifacts,
  public.auction_cases,
  public.auction_lots,
  public.auction_rounds,
  public.auction_events,
  public.auction_outcomes,
  public.auction_outcome_evidence,
  public.evidence_reviews,
  public.auction_feature_snapshots,
  public.cohort_definitions,
  public.cohort_statistics,
  public.model_versions,
  public.auction_predictions
from public, anon, authenticated;

grant select, insert, update on table
  public.outcome_addresses,
  public.outcome_courts,
  public.data_sources,
  public.auction_cases,
  public.auction_lots,
  public.auction_rounds
to service_role;

grant select, insert on table
  public.raw_artifacts,
  public.auction_events,
  public.auction_outcomes,
  public.auction_outcome_evidence,
  public.evidence_reviews,
  public.auction_feature_snapshots,
  public.cohort_definitions,
  public.cohort_statistics,
  public.auction_predictions
to service_role;

grant select, insert, update on table public.model_versions to service_role;

revoke all on function app_private.reject_outcome_graph_mutation()
from public, anon, authenticated;
revoke all on function app_private.validate_outcome_round_lineage()
from public, anon, authenticated;
revoke all on function app_private.validate_outcome_event()
from public, anon, authenticated;
revoke all on function app_private.validate_outcome_version()
from public, anon, authenticated;
revoke all on function app_private.validate_outcome_cohort_statistics()
from public, anon, authenticated;
revoke all on function app_private.validate_outcome_snapshot()
from public, anon, authenticated;
revoke all on function app_private.validate_outcome_prediction()
from public, anon, authenticated;
revoke all on function app_private.guard_outcome_round_forecast_inputs()
from public, anon, authenticated;
revoke all on function app_private.validate_outcome_model_version_insert()
from public, anon, authenticated;
revoke all on function app_private.guard_outcome_model_version_mutation()
from public, anon, authenticated;

alter table public.feature_usage_events
  drop constraint if exists feature_usage_events_event_key_check;

alter table public.feature_usage_events
  add constraint feature_usage_events_event_key_check check (
    event_key in (
      'property_report.created',
      'property_report.pdf_exported',
      'sales.csv_exported',
      'sales.api_feed_requested',
      'sale_history.viewed',
      'market.analytics_viewed',
      'dpe.explorer_viewed',
      'sales.favorite_added',
      'sales.favorite_removed',
      'sales.statistics_viewed',
      'bid_ceiling.calculated',
      'dvf.comparables_viewed',
      'valuation.backtest_viewed',
      'valuation.estimated',
      'outcome_graph.viewed',
      'workspace.audience_tracking_viewed',
      'sale_changes.monitored',
      'lawyer.referral_requested',
      'data_refresh.requested'
    )
  );

comment on table public.auction_lots is
  'Outcome Graph lot registry. auction_sale_id is a nullable bridge and is set null when catalogue rows expire.';
comment on table public.auction_events is
  'Append-only judicial auction event log; corrections insert a superseding event.';
comment on table public.auction_feature_snapshots is
  'Immutable pre-hearing feature snapshots with source-time manifest and leakage verdict.';
comment on table public.auction_predictions is
  'Immutable Outcome Graph predictions; personal bid ceilings are never stored here.';

notify pgrst, 'reload schema';

commit;
