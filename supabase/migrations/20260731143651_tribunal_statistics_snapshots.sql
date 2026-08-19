begin;

alter table public.auction_outcome_evidence
  add constraint auction_outcome_evidence_id_outcome_unique unique (id, outcome_id);

alter table public.evidence_reviews
  add column recorded_at timestamptz not null default statement_timestamp(),
  add constraint evidence_reviews_recorded_time_check check (
    reviewed_at <= recorded_at
  );

alter table public.auction_feature_snapshots
  add column recorded_at timestamptz not null default statement_timestamp();

alter table public.auction_rounds
  add column recorded_at timestamptz not null default statement_timestamp();

alter table public.auction_outcomes
  add column recorded_at timestamptz not null default statement_timestamp();

do $$
begin
  if exists (
    select 1
    from public.evidence_reviews review_row
    left join public.user_profiles profile
      on profile.user_id = review_row.reviewer_user_id
     and profile.user_role = 'admin'
    where profile.user_id is null
      or review_row.review_type not in ('primary', 'independent')
      or review_row.independent_review is distinct from
        (review_row.review_type = 'independent')
      or (
        review_row.decision in ('rejected', 'needs_correction')
        and nullif(pg_catalog.btrim(review_row.notes), '') is null
      )
  ) then
    raise exception using
      errcode = '23514',
      message = 'Existing statistical review history violates the closed administrator workflow.';
  end if;
end;
$$;

alter table public.evidence_reviews
  add constraint evidence_reviews_closed_type_check check (
    review_type in ('primary', 'independent')
    and independent_review = (review_type = 'independent')
  ),
  add constraint evidence_reviews_negative_note_check check (
    decision not in ('rejected', 'needs_correction')
    or nullif(btrim(notes), '') is not null
  );

do $$
begin
  if exists (
    select 1
    from public.auction_rounds round_row
    where not exists (
      select 1
      from pg_catalog.pg_timezone_names timezone_row
      where timezone_row.name = round_row.local_timezone
    )
  ) then
    raise exception using
      errcode = '23514',
      message = 'Existing auction rounds contain an invalid IANA local timezone.';
  end if;
end;
$$;

create or replace function app_private.validate_auction_round_local_timezone()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if not exists (
    select 1
    from pg_catalog.pg_timezone_names timezone_row
    where timezone_row.name = new.local_timezone
  ) then
    raise exception using
      errcode = '23514',
      message = 'Auction rounds require a valid IANA local timezone.';
  end if;
  return new;
end;
$$;

create or replace function app_private.validate_auction_round_statistics_lineage()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  case_court_id uuid;
begin
  select case_row.court_id into case_court_id
  from public.auction_lots lot_row
  join public.auction_cases case_row on case_row.id = lot_row.auction_case_id
  where lot_row.id = new.lot_id;
  if case_court_id is null or case_court_id is distinct from new.court_id then
    raise exception using
      errcode = '23514',
      message = 'Auction round court must match its lot case court.';
  end if;
  return new;
end;
$$;

create or replace function app_private.lock_tribunal_statistics_source_write()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('immojudis:tribunal-statistics-source-v1', 0)
  );
  return null;
end;
$$;

create or replace function app_private.stamp_tribunal_statistics_source_recorded_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.recorded_at := clock_timestamp();
  return new;
end;
$$;

create trigger a_lock_outcome_courts_for_tribunal_statistics
before insert or update or delete on public.outcome_courts
for each statement execute function app_private.lock_tribunal_statistics_source_write();

create trigger a_lock_auction_cases_for_tribunal_statistics
before insert or update or delete on public.auction_cases
for each statement execute function app_private.lock_tribunal_statistics_source_write();

create trigger a_lock_auction_lots_for_tribunal_statistics
before insert or update or delete on public.auction_lots
for each statement execute function app_private.lock_tribunal_statistics_source_write();

create trigger a_lock_auction_rounds_for_tribunal_statistics
before insert or update or delete on public.auction_rounds
for each statement execute function app_private.lock_tribunal_statistics_source_write();

create trigger a_lock_auction_feature_snapshots_for_tribunal_statistics
before insert or update or delete on public.auction_feature_snapshots
for each statement execute function app_private.lock_tribunal_statistics_source_write();

create trigger a_lock_auction_outcomes_for_tribunal_statistics
before insert or update or delete on public.auction_outcomes
for each statement execute function app_private.lock_tribunal_statistics_source_write();

create trigger a_lock_auction_outcome_evidence_for_tribunal_statistics
before insert or update or delete on public.auction_outcome_evidence
for each statement execute function app_private.lock_tribunal_statistics_source_write();

create trigger a_lock_evidence_reviews_for_tribunal_statistics
before insert or update or delete on public.evidence_reviews
for each statement execute function app_private.lock_tribunal_statistics_source_write();

create trigger stamp_auction_round_recorded_at_before_insert
before insert on public.auction_rounds
for each row execute function app_private.stamp_tribunal_statistics_source_recorded_at();

create trigger validate_auction_round_local_timezone_before_write
before insert or update of local_timezone on public.auction_rounds
for each row execute function app_private.validate_auction_round_local_timezone();

create trigger validate_auction_round_statistics_lineage_before_write
before insert or update of lot_id, court_id on public.auction_rounds
for each row execute function app_private.validate_auction_round_statistics_lineage();

create trigger stamp_auction_outcome_recorded_at_before_insert
before insert on public.auction_outcomes
for each row execute function app_private.stamp_tribunal_statistics_source_recorded_at();

create or replace function app_private.stamp_feature_snapshot_recorded_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.recorded_at := clock_timestamp();
  return new;
end;
$$;

create trigger stamp_feature_snapshot_recorded_at_before_insert
before insert on public.auction_feature_snapshots
for each row execute function app_private.stamp_feature_snapshot_recorded_at();

create or replace function app_private.tribunal_statistics_published_metric_is_valid(
  p_metric jsonb
)
returns boolean
language plpgsql
immutable
security invoker
set search_path = ''
as $$
declare
  reason_key text;
  reason_value jsonb;
  exclusion_reason_total numeric := 0;
  numerator_value numeric;
  denominator_value numeric;
  universe_value numeric;
  unknown_value numeric;
  excluded_value numeric;
  raw_value numeric;
  adjusted_value numeric;
  interval_low numeric;
  interval_high numeric;
begin
  if pg_catalog.jsonb_typeof(p_metric) <> 'object'
    or pg_catalog.jsonb_typeof(p_metric -> 'rawValue') <> 'number'
    or pg_catalog.jsonb_typeof(p_metric -> 'adjustedValue') <> 'number'
    or pg_catalog.jsonb_typeof(p_metric -> 'numerator') <> 'number'
    or pg_catalog.jsonb_typeof(p_metric -> 'knownDenominator') <> 'number'
    or pg_catalog.jsonb_typeof(p_metric -> 'eligibleUniverse') <> 'number'
    or pg_catalog.jsonb_typeof(p_metric -> 'unknownCount') <> 'number'
    or pg_catalog.jsonb_typeof(p_metric -> 'excludedCount') <> 'number'
    or pg_catalog.jsonb_typeof(p_metric -> 'exclusionReasons') <> 'object'
    or pg_catalog.jsonb_typeof(p_metric -> 'confidenceInterval') <> 'object'
    or pg_catalog.jsonb_typeof(p_metric -> 'method') <> 'string' then
    return false;
  end if;

  if coalesce(p_metric ->> 'numerator', '') !~ '^[0-9]+$'
    or coalesce(p_metric ->> 'knownDenominator', '') !~ '^[0-9]+$'
    or coalesce(p_metric ->> 'eligibleUniverse', '') !~ '^[0-9]+$'
    or coalesce(p_metric ->> 'unknownCount', '') !~ '^[0-9]+$'
    or coalesce(p_metric ->> 'excludedCount', '') !~ '^[0-9]+$' then
    return false;
  end if;

  numerator_value := (p_metric ->> 'numerator')::numeric;
  denominator_value := (p_metric ->> 'knownDenominator')::numeric;
  universe_value := (p_metric ->> 'eligibleUniverse')::numeric;
  unknown_value := (p_metric ->> 'unknownCount')::numeric;
  excluded_value := (p_metric ->> 'excludedCount')::numeric;
  raw_value := (p_metric ->> 'rawValue')::numeric;
  adjusted_value := (p_metric ->> 'adjustedValue')::numeric;

  if denominator_value < 10 then
    return false;
  end if;
  if numerator_value > denominator_value
    or denominator_value + unknown_value + excluded_value <> universe_value
    or raw_value not between 0 and 1
    or adjusted_value not between 0 and 1
    or abs(raw_value - numerator_value / denominator_value) > 0.000001
    or p_metric ->> 'method' <> 'beta_binomial' then
    return false;
  end if;

  if not ((p_metric -> 'confidenceInterval') ?& array['low', 'high']::text[])
    or (p_metric -> 'confidenceInterval') - array['low', 'high']::text[] <> '{}'::jsonb
    or pg_catalog.jsonb_typeof(p_metric #> array['confidenceInterval', 'low']) <> 'number'
    or pg_catalog.jsonb_typeof(p_metric #> array['confidenceInterval', 'high']) <> 'number'
    then
    return false;
  end if;
  interval_low := (p_metric #>> array['confidenceInterval', 'low'])::numeric;
  interval_high := (p_metric #>> array['confidenceInterval', 'high'])::numeric;
  if interval_low not between 0 and 1
    or interval_high not between 0 and 1
    or interval_low > interval_high then
    return false;
  end if;

  for reason_key, reason_value in
    select reason.key, reason.value
    from pg_catalog.jsonb_each(p_metric -> 'exclusionReasons') reason(key, value)
  loop
    if nullif(pg_catalog.btrim(reason_key), '') is null
      or reason_key not in (
        'no_terminal_outcome_at_cutoff',
        'ambiguous_terminal_outcome',
        'outcome_status_claim_ineligible',
        'unsupported_outcome_status',
        'surenchere_status_claim_ineligible',
        'initial_starting_price_eur_claim_ineligible',
        'effective_starting_price_eur_claim_ineligible',
        'final_hammer_price_claim_ineligible',
        'finality_status_claim_ineligible',
        'non_positive_price',
        'result_observed_at_claim_ineligible',
        'result_observed_after_cutoff',
        'result_observed_before_hearing'
      )
      or pg_catalog.jsonb_typeof(reason_value) <> 'number'
      or coalesce(reason_value #>> '{}', '') !~ '^[0-9]+$' then
      return false;
    end if;
    exclusion_reason_total := exclusion_reason_total + (reason_value #>> '{}')::numeric;
  end loop;

  return exclusion_reason_total = excluded_value;
end;
$$;

create or replace function app_private.tribunal_statistics_published_distribution_is_valid(
  p_distribution jsonb
)
returns boolean
language plpgsql
immutable
security invoker
set search_path = ''
as $$
declare
  reason_key text;
  reason_value jsonb;
  exclusion_reason_total numeric := 0;
  sample_size_value numeric;
  universe_value numeric;
  unknown_value numeric;
  excluded_value numeric;
  parent_sample_size_value numeric;
  quantiles jsonb;
  quantile_path text;
begin
  if pg_catalog.jsonb_typeof(p_distribution) <> 'object'
    or pg_catalog.jsonb_typeof(p_distribution -> 'sampleSize') <> 'number'
    or pg_catalog.jsonb_typeof(p_distribution -> 'eligibleUniverse') <> 'number'
    or pg_catalog.jsonb_typeof(p_distribution -> 'unknownCount') <> 'number'
    or pg_catalog.jsonb_typeof(p_distribution -> 'excludedCount') <> 'number'
    or pg_catalog.jsonb_typeof(p_distribution -> 'parentSampleSize') <> 'number'
    or pg_catalog.jsonb_typeof(p_distribution -> 'raw') <> 'object'
    or pg_catalog.jsonb_typeof(p_distribution -> 'adjusted') <> 'object'
    or pg_catalog.jsonb_typeof(p_distribution -> 'exclusionReasons') <> 'object'
    or pg_catalog.jsonb_typeof(p_distribution -> 'method') <> 'string' then
    return false;
  end if;

  if coalesce(p_distribution ->> 'sampleSize', '') !~ '^[0-9]+$'
    or coalesce(p_distribution ->> 'eligibleUniverse', '') !~ '^[0-9]+$'
    or coalesce(p_distribution ->> 'unknownCount', '') !~ '^[0-9]+$'
    or coalesce(p_distribution ->> 'excludedCount', '') !~ '^[0-9]+$'
    or coalesce(p_distribution ->> 'parentSampleSize', '') !~ '^[0-9]+$' then
    return false;
  end if;

  sample_size_value := (p_distribution ->> 'sampleSize')::numeric;
  universe_value := (p_distribution ->> 'eligibleUniverse')::numeric;
  unknown_value := (p_distribution ->> 'unknownCount')::numeric;
  excluded_value := (p_distribution ->> 'excludedCount')::numeric;
  parent_sample_size_value := (p_distribution ->> 'parentSampleSize')::numeric;

  if sample_size_value < 10
    or sample_size_value + unknown_value + excluded_value <> universe_value
    or parent_sample_size_value < 0
    or p_distribution ->> 'method' not in ('raw', 'log_shrinkage') then
    return false;
  end if;

  foreach quantile_path in array array['raw', 'adjusted']::text[] loop
    quantiles := p_distribution -> quantile_path;
    if not (quantiles ?& array['p10', 'p50', 'p90']::text[])
      or quantiles - array['p10', 'p50', 'p90']::text[] <> '{}'::jsonb
      or pg_catalog.jsonb_typeof(quantiles -> 'p10') <> 'number'
      or pg_catalog.jsonb_typeof(quantiles -> 'p50') <> 'number'
      or pg_catalog.jsonb_typeof(quantiles -> 'p90') <> 'number'
      or (quantiles ->> 'p10')::numeric < 0
      or (quantiles ->> 'p10')::numeric > (quantiles ->> 'p50')::numeric
      or (quantiles ->> 'p50')::numeric > (quantiles ->> 'p90')::numeric then
      return false;
    end if;
  end loop;

  for reason_key, reason_value in
    select reason.key, reason.value
    from pg_catalog.jsonb_each(p_distribution -> 'exclusionReasons') reason(key, value)
  loop
    if nullif(pg_catalog.btrim(reason_key), '') is null
      or reason_key not in (
        'no_terminal_outcome_at_cutoff',
        'ambiguous_terminal_outcome',
        'outcome_status_claim_ineligible',
        'unsupported_outcome_status',
        'surenchere_status_claim_ineligible',
        'initial_starting_price_eur_claim_ineligible',
        'effective_starting_price_eur_claim_ineligible',
        'final_hammer_price_claim_ineligible',
        'finality_status_claim_ineligible',
        'non_positive_price',
        'result_observed_at_claim_ineligible',
        'result_observed_after_cutoff',
        'result_observed_before_hearing'
      )
      or pg_catalog.jsonb_typeof(reason_value) <> 'number'
      or coalesce(reason_value #>> '{}', '') !~ '^[0-9]+$' then
      return false;
    end if;
    exclusion_reason_total := exclusion_reason_total + (reason_value #>> '{}')::numeric;
  end loop;

  return exclusion_reason_total = excluded_value;
end;
$$;

create or replace function app_private.tribunal_statistics_suppression_is_safe(
  p_statistics jsonb,
  p_require_all boolean default false
)
returns boolean
language plpgsql
immutable
security invoker
set search_path = ''
as $$
declare
  metric_path text[];
  distribution_path text[];
  metric jsonb;
  distribution jsonb;
  fallback jsonb;
  warning_value jsonb;
  warning_text text;
  top_level_keys constant text[] := array[
    'flow', 'surenchere', 'priceRatios', 'delays', 'fallback', 'warnings'
  ];
  flow_keys constant text[] := array[
    'held', 'postponed', 'cancelled', 'notRequested',
    'noBidIfHeld', 'adjudicatedIfHeld'
  ];
  metric_keys constant text[] := array[
    'rawValue', 'adjustedValue', 'numerator', 'knownDenominator',
    'eligibleUniverse', 'unknownCount', 'excludedCount',
    'exclusionReasons', 'confidenceInterval', 'method'
  ];
  distribution_keys constant text[] := array[
    'sampleSize', 'eligibleUniverse', 'unknownCount', 'raw', 'adjusted',
    'method', 'parentSampleSize', 'excludedCount', 'exclusionReasons'
  ];
begin
  if pg_catalog.jsonb_typeof(p_statistics) <> 'object' then
    return false;
  end if;
  if not (p_statistics ?& top_level_keys)
    or p_statistics - top_level_keys <> '{}'::jsonb then
    return false;
  end if;

  if pg_catalog.jsonb_typeof(p_statistics -> 'flow') <> 'object'
    or not ((p_statistics -> 'flow') ?& flow_keys)
    or (p_statistics -> 'flow') - flow_keys <> '{}'::jsonb
    or pg_catalog.jsonb_typeof(p_statistics -> 'surenchere') <> 'object'
    or not ((p_statistics -> 'surenchere') ?& array['filed']::text[])
    or (p_statistics -> 'surenchere') - array['filed']::text[] <> '{}'::jsonb
    or pg_catalog.jsonb_typeof(p_statistics -> 'priceRatios') <> 'object'
    or not (
      (p_statistics -> 'priceRatios') ?&
        array['finalToInitial', 'finalToEffective', 'finalToMarket']::text[]
    )
    or (p_statistics -> 'priceRatios') -
      array['finalToInitial', 'finalToEffective', 'finalToMarket']::text[] <> '{}'::jsonb
    or pg_catalog.jsonb_typeof(p_statistics -> 'delays') <> 'object'
    or not (
      (p_statistics -> 'delays') ?&
        array['hearingToKnownResult', 'postponementToNextHearing']::text[]
    )
    or (p_statistics -> 'delays') -
      array['hearingToKnownResult', 'postponementToNextHearing']::text[] <> '{}'::jsonb
    then
    return false;
  end if;

  fallback := p_statistics -> 'fallback';
  if pg_catalog.jsonb_typeof(fallback) <> 'object' then
    return false;
  end if;
  if not (fallback ?& array['scope', 'parentLabel', 'localWeight']::text[])
    or fallback - array['scope', 'parentLabel', 'localWeight']::text[] <> '{}'::jsonb
    or pg_catalog.jsonb_typeof(fallback -> 'scope') <> 'string'
    or pg_catalog.jsonb_typeof(fallback -> 'localWeight') <> 'number' then
    return false;
  end if;
  if (fallback ->> 'localWeight')::numeric not between 0 and 1 then
    return false;
  end if;
  if fallback ->> 'scope' = 'none' then
    if pg_catalog.jsonb_typeof(fallback -> 'parentLabel') <> 'null'
      or (fallback ->> 'localWeight')::numeric <> 1 then
      return false;
    end if;
  elsif fallback ->> 'scope' = 'national' then
    if pg_catalog.jsonb_typeof(fallback -> 'parentLabel') <> 'string'
      or fallback ->> 'parentLabel' <> 'France entière' then
      return false;
    end if;
  else
    return false;
  end if;
  if p_require_all and (fallback ->> 'localWeight')::numeric not in (0, 1) then
    return false;
  end if;

  if pg_catalog.jsonb_typeof(p_statistics -> 'warnings') <> 'array' then
    return false;
  end if;
  for warning_value in
    select warning_element.value
    from pg_catalog.jsonb_array_elements(p_statistics -> 'warnings') warning_element(value)
  loop
    warning_text := warning_value #>> '{}';
    if pg_catalog.jsonb_typeof(warning_value) <> 'string'
      or warning_text not in (
        'Statistiques descriptives historiques, pas une prédiction individuelle.',
        'Seules les preuves A/B validées pour chaque champ sont comptées.',
        'Le ratio de prix exige un prix final procéduralement définitif; le prix initial d’adjudication ne le remplace jamais.',
        'Ratio au marché et délai vers la prochaine audience masqués faute de preuve canonique dédiée.',
        'Échantillon inférieur à 10: toutes les valeurs de la cellule sont masquées.',
        'Contrôle qualité non atteint: 20 % des 500 premiers résultats vérifiés doivent être relus indépendamment.',
        'Couverture des résultats inférieure à 80 %: niveau robuste interdit.',
        'Couverture du gel antérieur au cutoff inférieure à 80 %: publication supprimée.',
        'Référence nationale non publiable: toutes les valeurs locales sont masquées.',
        'Le poids local affiché concerne l’échantillon de statuts; chaque cellule conserve son propre dénominateur.',
        'round_not_frozen_at_cutoff'
      ) then
      return false;
    end if;
  end loop;

  foreach metric_path slice 1 in array array[
    array['flow', 'held'],
    array['flow', 'postponed'],
    array['flow', 'cancelled'],
    array['flow', 'notRequested'],
    array['flow', 'noBidIfHeld'],
    array['flow', 'adjudicatedIfHeld'],
    array['surenchere', 'filed']
  ]::text[][] loop
    metric := p_statistics #> metric_path;
    if pg_catalog.jsonb_typeof(metric) <> 'object' then
      return false;
    end if;
    if not (metric ?& metric_keys)
      or metric - metric_keys <> '{}'::jsonb then
      return false;
    end if;
    if p_require_all and coalesce(metric ->> 'method', '') <> 'suppressed' then
      return false;
    end if;
    if metric ->> 'method' = 'suppressed' and not (
      coalesce(pg_catalog.jsonb_typeof(metric -> 'rawValue') = 'null', false)
      and coalesce(pg_catalog.jsonb_typeof(metric -> 'adjustedValue') = 'null', false)
      and coalesce(pg_catalog.jsonb_typeof(metric -> 'numerator') = 'null', false)
      and coalesce(pg_catalog.jsonb_typeof(metric -> 'knownDenominator') = 'null', false)
      and coalesce(pg_catalog.jsonb_typeof(metric -> 'eligibleUniverse') = 'null', false)
      and coalesce(pg_catalog.jsonb_typeof(metric -> 'unknownCount') = 'null', false)
      and coalesce(pg_catalog.jsonb_typeof(metric -> 'excludedCount') = 'null', false)
      and coalesce(pg_catalog.jsonb_typeof(metric -> 'confidenceInterval') = 'null', false)
      and coalesce(metric -> 'exclusionReasons' = '{}'::jsonb, false)
    ) then
      return false;
    end if;
    if metric ->> 'method' <> 'suppressed'
      and not app_private.tribunal_statistics_published_metric_is_valid(metric) then
      return false;
    end if;
  end loop;

  foreach distribution_path slice 1 in array array[
    array['priceRatios', 'finalToInitial'],
    array['priceRatios', 'finalToEffective'],
    array['priceRatios', 'finalToMarket'],
    array['delays', 'hearingToKnownResult'],
    array['delays', 'postponementToNextHearing']
  ]::text[][] loop
    distribution := p_statistics #> distribution_path;
    if pg_catalog.jsonb_typeof(distribution) <> 'object' then
      return false;
    end if;
    if not (distribution ?& distribution_keys)
      or distribution - distribution_keys <> '{}'::jsonb then
      return false;
    end if;
    if p_require_all and coalesce(distribution ->> 'method', '') <> 'suppressed' then
      return false;
    end if;
    if distribution ->> 'method' = 'suppressed' and not (
      coalesce(pg_catalog.jsonb_typeof(distribution -> 'sampleSize') = 'null', false)
      and coalesce(pg_catalog.jsonb_typeof(distribution -> 'eligibleUniverse') = 'null', false)
      and coalesce(pg_catalog.jsonb_typeof(distribution -> 'unknownCount') = 'null', false)
      and coalesce(pg_catalog.jsonb_typeof(distribution -> 'raw') = 'null', false)
      and coalesce(pg_catalog.jsonb_typeof(distribution -> 'adjusted') = 'null', false)
      and coalesce(pg_catalog.jsonb_typeof(distribution -> 'parentSampleSize') = 'null', false)
      and coalesce(pg_catalog.jsonb_typeof(distribution -> 'excludedCount') = 'null', false)
      and coalesce(distribution -> 'exclusionReasons' = '{}'::jsonb, false)
    ) then
      return false;
    end if;
    if distribution ->> 'method' <> 'suppressed'
      and not app_private.tribunal_statistics_published_distribution_is_valid(
        distribution
      ) then
      return false;
    end if;
  end loop;

  return true;
end;
$$;

create or replace function app_private.tribunal_statistics_payload_counts_are_consistent(
  p_statistics jsonb,
  p_eligible_round_count integer,
  p_status_sample_size integer,
  p_initial_price_sample_size integer,
  p_effective_price_sample_size integer,
  p_market_price_sample_size integer,
  p_surenchere_sample_size integer,
  p_result_delay_sample_size integer,
  p_postponement_delay_sample_size integer
)
returns boolean
language plpgsql
immutable
security invoker
set search_path = ''
as $$
declare
  cell jsonb;
  cell_path text[];
  expected_sample_size integer;
begin
  foreach cell_path slice 1 in array array[
    array['flow', 'held'],
    array['flow', 'postponed'],
    array['flow', 'cancelled'],
    array['flow', 'notRequested']
  ]::text[][] loop
    cell := p_statistics #> cell_path;
    if coalesce(cell ->> 'method', '') not in (
      'suppressed', 'beta_binomial'
    ) then
      return false;
    end if;
    if cell ->> 'method' <> 'suppressed' and (
      coalesce(cell ->> 'eligibleUniverse', '') !~ '^[0-9]+$'
      or (cell ->> 'eligibleUniverse')::numeric <> p_eligible_round_count
      or coalesce(cell ->> 'knownDenominator', '') !~ '^[0-9]+$'
      or (cell ->> 'knownDenominator')::numeric <> p_status_sample_size
    ) then
      return false;
    end if;
  end loop;

  foreach cell_path slice 1 in array array[
    array['flow', 'noBidIfHeld'],
    array['flow', 'adjudicatedIfHeld']
  ]::text[][] loop
    cell := p_statistics #> cell_path;
    if coalesce(cell ->> 'method', '') not in (
      'suppressed', 'beta_binomial'
    ) then
      return false;
    end if;
    if cell ->> 'method' <> 'suppressed' and (
      coalesce(cell ->> 'eligibleUniverse', '') !~ '^[0-9]+$'
      or (cell ->> 'eligibleUniverse')::numeric > p_status_sample_size
      or coalesce(cell ->> 'knownDenominator', '') !~ '^[0-9]+$'
      or (cell ->> 'knownDenominator')::numeric > p_status_sample_size
      or (cell ->> 'knownDenominator')::numeric <>
        (cell ->> 'eligibleUniverse')::numeric
    ) then
      return false;
    end if;
  end loop;

  if (p_statistics #>> array['flow', 'noBidIfHeld', 'method']) <> 'suppressed'
    and (
      (p_statistics #>> array['flow', 'held', 'method']) = 'suppressed'
      or coalesce(p_statistics #>> array['flow', 'held', 'numerator'], '') !~ '^[0-9]+$'
      or (p_statistics #>> array['flow', 'noBidIfHeld', 'knownDenominator'])::numeric <>
        (p_statistics #>> array['flow', 'held', 'numerator'])::numeric
    ) then
    return false;
  end if;

  if (p_statistics #>> array['flow', 'adjudicatedIfHeld', 'method']) <> 'suppressed'
    and (
      (p_statistics #>> array['flow', 'held', 'method']) = 'suppressed'
      or coalesce(p_statistics #>> array['flow', 'held', 'numerator'], '') !~ '^[0-9]+$'
      or (p_statistics #>> array['flow', 'adjudicatedIfHeld', 'knownDenominator'])::numeric <>
        (p_statistics #>> array['flow', 'held', 'numerator'])::numeric
    ) then
    return false;
  end if;

  if (p_statistics #>> array['flow', 'noBidIfHeld', 'method']) <> 'suppressed'
    and (p_statistics #>> array['flow', 'adjudicatedIfHeld', 'method']) <> 'suppressed'
    and (p_statistics #>> array['flow', 'noBidIfHeld', 'knownDenominator'])::numeric <>
      (p_statistics #>> array['flow', 'adjudicatedIfHeld', 'knownDenominator'])::numeric then
    return false;
  end if;

  cell := p_statistics #> array['surenchere', 'filed'];
  if coalesce(cell ->> 'method', '') not in (
    'suppressed', 'beta_binomial'
  ) then
    return false;
  end if;
  if cell ->> 'method' <> 'suppressed' and (
    coalesce(cell ->> 'eligibleUniverse', '') !~ '^[0-9]+$'
    or (p_statistics #>> array['flow', 'adjudicatedIfHeld', 'method']) = 'suppressed'
    or coalesce(
      p_statistics #>> array['flow', 'adjudicatedIfHeld', 'numerator'],
      ''
    ) !~ '^[0-9]+$'
    or (cell ->> 'eligibleUniverse')::numeric <>
      (p_statistics #>> array['flow', 'adjudicatedIfHeld', 'numerator'])::numeric
    or coalesce(cell ->> 'knownDenominator', '') !~ '^[0-9]+$'
    or (cell ->> 'knownDenominator')::numeric <> p_surenchere_sample_size
  ) then
    return false;
  end if;

  foreach cell_path slice 1 in array array[
    array['priceRatios', 'finalToInitial'],
    array['priceRatios', 'finalToEffective'],
    array['priceRatios', 'finalToMarket'],
    array['delays', 'hearingToKnownResult'],
    array['delays', 'postponementToNextHearing']
  ]::text[][] loop
    cell := p_statistics #> cell_path;
    if coalesce(cell ->> 'method', '') not in (
      'suppressed', 'raw', 'log_shrinkage'
    ) then
      return false;
    end if;
    if cell ->> 'method' <> 'suppressed' and (
      coalesce(cell ->> 'eligibleUniverse', '') !~ '^[0-9]+$'
      or coalesce(cell ->> 'sampleSize', '') !~ '^[0-9]+$'
    ) then
      return false;
    end if;

    if cell ->> 'method' <> 'suppressed' and (
      (
        cell_path[1] = 'priceRatios'
        and (
          (p_statistics #>> array['flow', 'adjudicatedIfHeld', 'method']) = 'suppressed'
          or coalesce(
            p_statistics #>> array['flow', 'adjudicatedIfHeld', 'numerator'],
            ''
          ) !~ '^[0-9]+$'
          or (cell ->> 'eligibleUniverse')::numeric <>
            (p_statistics #>> array['flow', 'adjudicatedIfHeld', 'numerator'])::numeric
        )
      )
      or (
        cell_path = array['delays', 'hearingToKnownResult']::text[]
        and (cell ->> 'eligibleUniverse')::numeric <> p_status_sample_size
      )
    ) then
      return false;
    end if;

    expected_sample_size := case cell_path[2]
      when 'finalToInitial' then p_initial_price_sample_size
      when 'finalToEffective' then p_effective_price_sample_size
      when 'finalToMarket' then p_market_price_sample_size
      when 'hearingToKnownResult' then p_result_delay_sample_size
      when 'postponementToNextHearing' then p_postponement_delay_sample_size
    end;
    if cell ->> 'method' <> 'suppressed'
      and (cell ->> 'sampleSize')::numeric <> expected_sample_size then
      return false;
    end if;
  end loop;

  return true;
end;
$$;

create table public.outcome_claim_eligibility_decisions (
  id uuid primary key default gen_random_uuid(),
  outcome_id uuid not null references public.auction_outcomes(id) on delete restrict,
  claim_type text not null check (
    claim_type in (
      'outcome_status',
      'initial_starting_price_eur',
      'effective_starting_price_eur',
      'initial_hammer_price_eur',
      'final_hammer_price_eur',
      'finality_status',
      'surenchere_status',
      'result_observed_at'
    )
  ),
  version integer not null check (version >= 1),
  decision text not null check (decision in ('eligible', 'rejected', 'conflicted')),
  reviewer_user_id uuid not null references auth.users(id) on delete restrict,
  evidence_ids uuid[] not null default '{}',
  evidence_manifest_hash text not null check (evidence_manifest_hash ~ '^[0-9a-f]{64}$'),
  review_manifest_hash text not null check (review_manifest_hash ~ '^[0-9a-f]{64}$'),
  decision_reason text,
  decided_at timestamptz not null,
  supersedes_decision_id uuid references public.outcome_claim_eligibility_decisions(id)
    on delete restrict,
  created_at timestamptz not null default now(),
  unique (outcome_id, claim_type, version),
  unique (id, outcome_id),
  constraint outcome_claim_eligibility_root_check check (
    (version = 1 and supersedes_decision_id is null)
    or (version > 1 and supersedes_decision_id is not null)
  ),
  constraint outcome_claim_eligibility_reason_check check (
    decision = 'eligible' or nullif(btrim(decision_reason), '') is not null
  ),
  constraint outcome_claim_eligibility_evidence_ids_check check (
    array_position(evidence_ids, null) is null
    and (decision <> 'eligible' or cardinality(evidence_ids) > 0)
  ),
  constraint outcome_claim_eligibility_time_check check (
    decided_at <= created_at
  )
);

create unique index outcome_claim_eligibility_one_successor_idx
  on public.outcome_claim_eligibility_decisions(supersedes_decision_id)
  where supersedes_decision_id is not null;

create index outcome_claim_eligibility_outcome_claim_idx
  on public.outcome_claim_eligibility_decisions(outcome_id, claim_type, version desc);

create table public.outcome_claim_eligibility_evidence (
  eligibility_decision_id uuid not null,
  outcome_id uuid not null,
  evidence_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (eligibility_decision_id, evidence_id),
  constraint outcome_claim_eligibility_evidence_decision_fk
    foreign key (eligibility_decision_id, outcome_id)
    references public.outcome_claim_eligibility_decisions(id, outcome_id)
    on delete restrict,
  constraint outcome_claim_eligibility_evidence_evidence_fk
    foreign key (evidence_id, outcome_id)
    references public.auction_outcome_evidence(id, outcome_id)
    on delete restrict
);

create index outcome_claim_eligibility_evidence_outcome_idx
  on public.outcome_claim_eligibility_evidence(outcome_id, evidence_id);

create table public.tribunal_statistics_snapshots (
  id uuid primary key default gen_random_uuid(),
  scope_type text not null check (scope_type in ('national', 'tribunal')),
  court_id uuid references public.outcome_courts(id) on delete restrict,
  court_code text,
  court_name text,
  judicial_region text,
  parent_snapshot_id uuid references public.tribunal_statistics_snapshots(id) on delete restrict,
  round_kind text not null check (round_kind = 'initial'),
  window_months smallint not null check (window_months in (12, 24, 36)),
  period_start date not null,
  period_end date not null,
  knowledge_cutoff_at timestamptz not null,
  maturity_days smallint not null default 30 check (maturity_days between 1 and 365),
  builder_version text not null check (
    builder_version = 'tribunal_statistics_builder_v1'
  ),
  eligibility_rule_version text not null check (
    eligibility_rule_version = 'claim_ab_reviewed_frozen_round_as_of_v1'
  ),
  smoothing_rule_version text not null check (
    smoothing_rule_version = 'jeffreys_beta_log_shrinkage_v1'
  ),
  reliability_status text not null check (
    reliability_status in ('insufficient_data', 'smoothed', 'descriptive', 'robust')
  ),
  quality_gate_passed boolean not null default false,
  eligible_round_count integer not null check (eligible_round_count >= 0),
  unfrozen_round_count bigint not null default 0 check (unfrozen_round_count >= 0),
  freeze_coverage numeric(7,6) not null default 1 check (freeze_coverage between 0 and 1),
  status_sample_size integer not null check (status_sample_size >= 0),
  initial_price_sample_size integer not null check (initial_price_sample_size >= 0),
  effective_price_sample_size integer not null check (effective_price_sample_size >= 0),
  market_price_sample_size integer not null default 0 check (market_price_sample_size >= 0),
  surenchere_sample_size integer not null check (surenchere_sample_size >= 0),
  result_delay_sample_size integer not null check (result_delay_sample_size >= 0),
  postponement_delay_sample_size integer not null default 0 check (
    postponement_delay_sample_size >= 0
  ),
  double_reviewed_count integer not null check (double_reviewed_count >= 0),
  outcome_coverage numeric(7,6) not null check (outcome_coverage between 0 and 1),
  statistics jsonb not null check (jsonb_typeof(statistics) = 'object'),
  source_manifest_hash text not null check (source_manifest_hash ~ '^[0-9a-f]{64}$'),
  statistics_hash text not null unique check (statistics_hash ~ '^[0-9a-f]{64}$'),
  computed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint tribunal_statistics_scope_check check (
    (
      scope_type = 'national'
      and court_id is null
      and court_code is null
      and court_name is null
      and judicial_region is null
      and parent_snapshot_id is null
    )
    or (
      scope_type = 'tribunal'
      and court_id is not null
      and nullif(btrim(court_code), '') is not null
      and nullif(btrim(court_name), '') is not null
      and parent_snapshot_id is not null
    )
  ),
  constraint tribunal_statistics_period_check check (period_end >= period_start),
  constraint tribunal_statistics_window_check check (
    period_start = (
      period_end + 1 - make_interval(months => window_months)
    )::date
  ),
  constraint tribunal_statistics_cutoff_check check (
    period_end <= (knowledge_cutoff_at at time zone 'UTC')::date - maturity_days
    and computed_at >= knowledge_cutoff_at
    and created_at >= computed_at
  ),
  constraint tribunal_statistics_samples_check check (
    status_sample_size <= eligible_round_count
    and initial_price_sample_size <= status_sample_size
    and effective_price_sample_size <= status_sample_size
    and market_price_sample_size <= status_sample_size
    and surenchere_sample_size <= status_sample_size
    and result_delay_sample_size <= status_sample_size
    and postponement_delay_sample_size <= status_sample_size
    and double_reviewed_count <= status_sample_size
  ),
  constraint tribunal_statistics_coverage_check check (
    outcome_coverage = case
      when eligible_round_count = 0 then 0
      else round(status_sample_size::numeric / eligible_round_count, 6)
    end
  ),
  constraint tribunal_statistics_freeze_coverage_check check (
    freeze_coverage = case
      when eligible_round_count + unfrozen_round_count = 0 then 1
      else round(
        eligible_round_count::numeric / (eligible_round_count + unfrozen_round_count),
        6
      )
    end
  ),
  constraint tribunal_statistics_payload_check check (
    coalesce(jsonb_typeof(statistics -> 'flow') = 'object', false)
    and coalesce(
      (statistics -> 'flow') ?& array[
        'held', 'postponed', 'cancelled', 'notRequested',
        'noBidIfHeld', 'adjudicatedIfHeld'
      ],
      false
    )
    and coalesce(jsonb_typeof(statistics -> 'surenchere') = 'object', false)
    and coalesce((statistics -> 'surenchere') ? 'filed', false)
    and coalesce(jsonb_typeof(statistics -> 'priceRatios') = 'object', false)
    and coalesce(
      (statistics -> 'priceRatios') ?& array[
        'finalToInitial', 'finalToEffective', 'finalToMarket'
      ],
      false
    )
    and coalesce(jsonb_typeof(statistics -> 'delays') = 'object', false)
    and coalesce(
      (statistics -> 'delays') ?& array[
        'hearingToKnownResult', 'postponementToNextHearing'
      ],
      false
    )
    and coalesce(jsonb_typeof(statistics -> 'fallback') = 'object', false)
    and coalesce(jsonb_typeof(statistics -> 'warnings') = 'array', false)
  ),
  constraint tribunal_statistics_suppression_check check (
    app_private.tribunal_statistics_suppression_is_safe(
      statistics,
      not quality_gate_passed
    )
  ),
  constraint tribunal_statistics_payload_counts_check check (
    app_private.tribunal_statistics_payload_counts_are_consistent(
      statistics,
      eligible_round_count,
      status_sample_size,
      initial_price_sample_size,
      effective_price_sample_size,
      market_price_sample_size,
      surenchere_sample_size,
      result_delay_sample_size,
      postponement_delay_sample_size
    )
  ),
  constraint tribunal_statistics_quality_gate_check check (
    not quality_gate_passed
    or (
      status_sample_size >= 10
      and double_reviewed_count >= ceil(least(status_sample_size, 500) * 0.20)
      and eligible_round_count::bigint * 5 >=
        (eligible_round_count::bigint + unfrozen_round_count) * 4
    )
  ),
  constraint tribunal_statistics_reliability_check check (
    (
      reliability_status = 'insufficient_data'
      and (not quality_gate_passed or status_sample_size < 10)
    )
    or (
      reliability_status = 'smoothed'
      and status_sample_size between 10 and 29
      and quality_gate_passed
    )
    or (
      reliability_status = 'descriptive'
      and status_sample_size >= 30
      and (
        status_sample_size < 100
        or status_sample_size::bigint * 5 < eligible_round_count::bigint * 4
      )
      and quality_gate_passed
    )
    or (
      reliability_status = 'robust'
      and status_sample_size >= 100
      and status_sample_size::bigint * 5 >= eligible_round_count::bigint * 4
      and quality_gate_passed
    )
  ),
  constraint tribunal_statistics_logical_identity_unique unique nulls not distinct (
    scope_type,
    court_id,
    round_kind,
    window_months,
    period_start,
    period_end,
    knowledge_cutoff_at,
    maturity_days,
    builder_version,
    eligibility_rule_version,
    smoothing_rule_version
  )
);

create index tribunal_statistics_latest_national_idx
  on public.tribunal_statistics_snapshots(
    round_kind, window_months, knowledge_cutoff_at desc, computed_at desc
  )
  where scope_type = 'national';

create index tribunal_statistics_parent_idx
  on public.tribunal_statistics_snapshots(parent_snapshot_id, court_code)
  where scope_type = 'tribunal';

create index tribunal_statistics_court_period_idx
  on public.tribunal_statistics_snapshots(
    court_id, round_kind, window_months, knowledge_cutoff_at desc
  )
  where scope_type = 'tribunal';

create table public.tribunal_statistics_members (
  snapshot_id uuid not null references public.tribunal_statistics_snapshots(id) on delete restrict,
  round_id uuid not null references public.auction_rounds(id) on delete restrict,
  feature_snapshot_id uuid not null,
  outcome_id uuid references public.auction_outcomes(id) on delete restrict,
  court_id uuid not null references public.outcome_courts(id) on delete restrict,
  status_claim_eligible boolean not null default false,
  initial_starting_price_claim_eligible boolean not null default false,
  effective_starting_price_claim_eligible boolean not null default false,
  initial_hammer_price_claim_eligible boolean not null default false,
  final_hammer_price_claim_eligible boolean not null default false,
  finality_status_claim_eligible boolean not null default false,
  market_price_claim_eligible boolean not null default false,
  surenchere_claim_eligible boolean not null default false,
  result_observed_at_claim_eligible boolean not null default false,
  postponement_delay_eligible boolean not null default false,
  double_reviewed boolean not null default false,
  exclusion_reasons text[] not null default '{}',
  member_hash text not null check (member_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  primary key (snapshot_id, round_id),
  constraint tribunal_statistics_members_feature_snapshot_fk
    foreign key (feature_snapshot_id, round_id)
    references public.auction_feature_snapshots(id, round_id)
    on delete restrict,
  constraint tribunal_statistics_members_outcome_check check (
    outcome_id is not null
    or not (
      status_claim_eligible
      or initial_starting_price_claim_eligible
      or effective_starting_price_claim_eligible
      or initial_hammer_price_claim_eligible
      or final_hammer_price_claim_eligible
      or finality_status_claim_eligible
      or market_price_claim_eligible
      or surenchere_claim_eligible
      or result_observed_at_claim_eligible
      or postponement_delay_eligible
      or double_reviewed
    )
  ),
  constraint tribunal_statistics_members_status_dependency_check check (
    status_claim_eligible
    or not (
      initial_starting_price_claim_eligible
      or effective_starting_price_claim_eligible
      or initial_hammer_price_claim_eligible
      or final_hammer_price_claim_eligible
      or finality_status_claim_eligible
      or market_price_claim_eligible
      or surenchere_claim_eligible
      or result_observed_at_claim_eligible
      or postponement_delay_eligible
      or double_reviewed
    )
  ),
  constraint tribunal_statistics_members_final_price_check check (
    not final_hammer_price_claim_eligible
    or finality_status_claim_eligible
  ),
  constraint tribunal_statistics_members_market_price_check check (
    not market_price_claim_eligible
  ),
  constraint tribunal_statistics_members_reasons_check check (
    array_position(exclusion_reasons, null) is null
    and array_position(exclusion_reasons, '') is null
  )
);

create index tribunal_statistics_members_outcome_idx
  on public.tribunal_statistics_members(outcome_id)
  where outcome_id is not null;

create index auction_rounds_court_schedule_idx
  on public.auction_rounds(court_id, scheduled_at)
  where scheduled_at is not null;

create or replace function app_private.stamp_evidence_review_recorded_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.reviewed_at := clock_timestamp();
  new.recorded_at := new.reviewed_at;
  if auth.uid() is null
    or new.reviewer_user_id is distinct from auth.uid() then
    raise exception using
      errcode = '42501',
      message = 'Evidence reviews must be attributed to the authenticated reviewer.';
  end if;
  perform 1
  from public.user_profiles profile
  where profile.user_id = new.reviewer_user_id
    and profile.user_role = 'admin'
  for share;
  if not found then
    raise exception using
      errcode = '42501',
      message = 'Only an administrator may review statistical evidence.';
  end if;
  return new;
end;
$$;

create trigger stamp_evidence_review_recorded_at_before_insert
before insert on public.evidence_reviews
for each row execute function app_private.stamp_evidence_review_recorded_at();

create or replace function public.review_outcome_evidence(
  p_evidence_id uuid,
  p_review_type text,
  p_decision text,
  p_field_decisions jsonb default '{}'::jsonb,
  p_notes text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id uuid := auth.uid();
  inserted_id uuid;
begin
  if caller_id is null then
    raise exception using errcode = '28000', message = 'An authenticated administrator is required.';
  end if;
  perform 1
  from public.user_profiles profile
  where profile.user_id = caller_id
    and profile.user_role = 'admin'
  for share;
  if not found then
    raise exception using
      errcode = '42501',
      message = 'Only an administrator may review statistical evidence.';
  end if;
  if p_review_type not in ('primary', 'independent') then
    raise exception using
      errcode = '23514',
      message = 'Statistical evidence review type is outside the closed v1 workflow.';
  end if;
  if p_decision not in (
    'approved', 'rejected', 'needs_correction', 'needs_second_review'
  ) then
    raise exception using
      errcode = '23514',
      message = 'Statistical evidence review decision is invalid.';
  end if;
  if pg_catalog.jsonb_typeof(p_field_decisions) <> 'object' then
    raise exception using
      errcode = '23514',
      message = 'Statistical evidence field decisions must be an object.';
  end if;
  if p_decision in ('rejected', 'needs_correction')
    and nullif(pg_catalog.btrim(p_notes), '') is null then
    raise exception using
      errcode = '23514',
      message = 'Negative statistical evidence reviews require an audit note.';
  end if;

  insert into public.evidence_reviews (
    evidence_id,
    reviewer_user_id,
    review_type,
    decision,
    field_decisions,
    notes,
    independent_review,
    reviewed_at
  ) values (
    p_evidence_id,
    caller_id,
    p_review_type,
    p_decision,
    p_field_decisions,
    nullif(pg_catalog.btrim(p_notes), ''),
    p_review_type = 'independent',
    clock_timestamp()
  )
  returning id into inserted_id;

  return inserted_id;
end;
$$;

create or replace function app_private.outcome_claim_evidence_manifest_hash_for(
  p_evidence_ids uuid[]
)
returns text
language sql
stable
security invoker
set search_path = ''
as $$
  select pg_catalog.encode(
    extensions.digest(
      pg_catalog.convert_to(
        coalesce(
          pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
              'evidenceId', evidence.id,
              'outcomeId', evidence.outcome_id,
              'sourceId', evidence.source_id,
              'rawArtifactId', evidence.raw_artifact_id,
              'evidenceType', evidence.evidence_type,
              'evidenceGrade', evidence.evidence_grade,
              'claimTypes', (
                select coalesce(pg_catalog.jsonb_agg(claim_type order by claim_type), '[]'::jsonb)
                from pg_catalog.unnest(evidence.claim_types) claim_type
              ),
              'lotMatchingConfidence', evidence.lot_matching_confidence,
              'roundMatchingConfidence', evidence.round_matching_confidence,
              'priceExtractionConfidence', evidence.price_extraction_confidence,
              'finalityConfidence', evidence.finality_confidence,
              'createdAtEpoch', extract(epoch from evidence.created_at)
            ) order by evidence.id
          ),
          '[]'::jsonb
        )::text,
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  )
  from public.auction_outcome_evidence evidence
  where evidence.id = any(coalesce(p_evidence_ids, '{}'::uuid[]));
$$;

create or replace function app_private.outcome_claim_review_manifest_hash_for(
  p_evidence_ids uuid[],
  p_decided_at timestamptz,
  p_recorded_at timestamptz
)
returns text
language sql
stable
security invoker
set search_path = ''
as $$
  select pg_catalog.encode(
    extensions.digest(
      pg_catalog.convert_to(
        coalesce(
          pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
              'reviewId', review_row.id,
              'evidenceId', review_row.evidence_id,
              'reviewerUserId', review_row.reviewer_user_id,
              'reviewType', review_row.review_type,
              'decision', review_row.decision,
              'fieldDecisions', review_row.field_decisions,
              'notes', review_row.notes,
              'independentReview', review_row.independent_review,
              'reviewedAtEpoch', extract(epoch from review_row.reviewed_at),
              'recordedAtEpoch', extract(epoch from review_row.recorded_at)
            ) order by review_row.evidence_id, review_row.id
          ),
          '[]'::jsonb
        )::text,
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  )
  from public.evidence_reviews review_row
  where review_row.evidence_id = any(coalesce(p_evidence_ids, '{}'::uuid[]))
    and review_row.reviewed_at <= p_decided_at
    and review_row.recorded_at <= p_recorded_at;
$$;

create or replace function app_private.validate_outcome_claim_eligibility_decision()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  prior_decision public.outcome_claim_eligibility_decisions%rowtype;
  linked_outcome public.auction_outcomes%rowtype;
  normalized_evidence_ids uuid[];
begin
  new.created_at := clock_timestamp();
  new.decided_at := new.created_at;
  if auth.uid() is null
    or new.reviewer_user_id is distinct from auth.uid() then
    raise exception using
      errcode = '42501',
      message = 'Claim eligibility decisions must be attributed to the authenticated administrator.';
  end if;
  select coalesce(array_agg(distinct evidence_id order by evidence_id), '{}'::uuid[])
  into normalized_evidence_ids
  from unnest(new.evidence_ids) evidence_id;

  if cardinality(normalized_evidence_ids) <> cardinality(new.evidence_ids) then
    raise exception using errcode = '23514', message = 'Claim eligibility evidence ids must be unique.';
  end if;
  new.evidence_ids := normalized_evidence_ids;
  new.evidence_manifest_hash := app_private.outcome_claim_evidence_manifest_hash_for(
    new.evidence_ids
  );
  new.review_manifest_hash := app_private.outcome_claim_review_manifest_hash_for(
    new.evidence_ids,
    new.decided_at,
    new.created_at
  );
  perform 1
  from public.user_profiles profile
  where profile.user_id = new.reviewer_user_id
    and profile.user_role = 'admin'
  for share;
  if not found then
    raise exception using errcode = '42501', message = 'Only an administrator may decide claim eligibility.';
  end if;

  select outcome_row.* into linked_outcome
  from public.auction_outcomes outcome_row
  where outcome_row.id = new.outcome_id;

  if linked_outcome.id is null
    or linked_outcome.created_at > new.decided_at
    or linked_outcome.recorded_at > new.decided_at
    or linked_outcome.valid_from > new.decided_at then
    raise exception using
      errcode = '23514',
      message = 'Claim eligibility cannot predate its canonical outcome.';
  end if;
  if new.supersedes_decision_id is null then
    if new.version <> 1 then
      raise exception using errcode = '23514', message = 'Claim eligibility must start at version 1.';
    end if;
    return new;
  end if;

  select prior.* into prior_decision
  from public.outcome_claim_eligibility_decisions prior
  where prior.id = new.supersedes_decision_id;

  if prior_decision.id is null
    or prior_decision.outcome_id <> new.outcome_id
    or prior_decision.claim_type <> new.claim_type
    or new.version <> prior_decision.version + 1
    or new.decided_at < prior_decision.decided_at then
    raise exception using
      errcode = '23514',
      message = 'Claim eligibility supersession must preserve outcome and claim lineage.';
  end if;
  if exists (
    select 1
    from public.outcome_claim_eligibility_decisions successor
    where successor.supersedes_decision_id = prior_decision.id
  ) then
    raise exception using errcode = '23514', message = 'Claim eligibility cannot branch.';
  end if;
  return new;
end;
$$;

create or replace function app_private.validate_outcome_claim_eligibility_evidence()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  linked_decision public.outcome_claim_eligibility_decisions%rowtype;
  linked_evidence public.auction_outcome_evidence%rowtype;
begin
  new.created_at := clock_timestamp();
  select decision_row.* into linked_decision
  from public.outcome_claim_eligibility_decisions decision_row
  where decision_row.id = new.eligibility_decision_id;

  select evidence_row.* into linked_evidence
  from public.auction_outcome_evidence evidence_row
  where evidence_row.id = new.evidence_id;

  if linked_decision.id is null
    or linked_evidence.id is null
    or linked_decision.outcome_id <> new.outcome_id
    or linked_evidence.outcome_id <> new.outcome_id
    or not (new.evidence_id = any(linked_decision.evidence_ids)) then
    raise exception using errcode = '23514', message = 'Eligibility evidence must stay on one outcome.';
  end if;
  if linked_evidence.created_at > linked_decision.decided_at then
    raise exception using
      errcode = '23514',
      message = 'Eligibility evidence must exist before the eligibility decision.';
  end if;
  if linked_evidence.evidence_grade not in ('A', 'B')
    or not (linked_decision.claim_type = any(linked_evidence.claim_types)) then
    raise exception using errcode = '23514', message = 'Eligibility requires claim-specific A/B evidence.';
  end if;
  if coalesce(linked_evidence.lot_matching_confidence, 0) < 0.95
    or coalesce(linked_evidence.round_matching_confidence, 0) < 0.95 then
    raise exception using errcode = '23514', message = 'Eligibility evidence requires confirmed lot and round matching.';
  end if;
  if not exists (
    select 1
    from public.evidence_reviews review_row
    where review_row.evidence_id = linked_evidence.id
      and review_row.decision = 'approved'
      and review_row.reviewed_at >= linked_evidence.created_at
      and review_row.reviewed_at <= linked_decision.decided_at
      and review_row.recorded_at <= linked_decision.created_at
  ) or exists (
    select 1
    from public.evidence_reviews review_row
    where review_row.evidence_id = linked_evidence.id
      and review_row.decision in ('rejected', 'needs_correction')
      and review_row.reviewed_at <= linked_decision.decided_at
      and review_row.recorded_at <= linked_decision.created_at
  ) then
    raise exception using errcode = '23514', message = 'Eligibility evidence requires an unconflicted human approval.';
  end if;
  return new;
end;
$$;

create or replace function public.decide_outcome_claim_eligibility(
  p_outcome_id uuid,
  p_claim_type text,
  p_decision text,
  p_evidence_ids uuid[],
  p_decision_reason text default null,
  p_supersedes_decision_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id uuid := auth.uid();
  prior_decision public.outcome_claim_eligibility_decisions%rowtype;
  inserted_id uuid;
  inserted_version integer;
  evidence_id uuid;
begin
  if caller_id is null then
    raise exception using errcode = '28000', message = 'An authenticated administrator is required.';
  end if;
  perform 1
  from public.user_profiles profile
  where profile.user_id = caller_id
    and profile.user_role = 'admin'
  for share;
  if not found then
    raise exception using
      errcode = '42501',
      message = 'Only an administrator may decide claim eligibility.';
  end if;
  if p_decision not in ('eligible', 'rejected', 'conflicted') then
    raise exception using errcode = '23514', message = 'Claim eligibility decision is invalid.';
  end if;
  if p_decision <> 'eligible'
    and nullif(pg_catalog.btrim(p_decision_reason), '') is null then
    raise exception using
      errcode = '23514',
      message = 'Negative claim eligibility decisions require an audit reason.';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'immojudis:claim-eligibility:' || p_outcome_id::text || ':' || p_claim_type,
      0
    )
  );
  if p_supersedes_decision_id is null then
    if exists (
      select 1
      from public.outcome_claim_eligibility_decisions existing_decision
      where existing_decision.outcome_id = p_outcome_id
        and existing_decision.claim_type = p_claim_type
    ) then
      raise exception using
        errcode = '23505',
        message = 'Claim eligibility already has a root decision; supersede its current tip.';
    end if;
    inserted_version := 1;
  else
    select decision_row.* into prior_decision
    from public.outcome_claim_eligibility_decisions decision_row
    where decision_row.id = p_supersedes_decision_id
    for update;
    if not found
      or prior_decision.outcome_id <> p_outcome_id
      or prior_decision.claim_type <> p_claim_type
      or exists (
        select 1
        from public.outcome_claim_eligibility_decisions successor
        where successor.supersedes_decision_id = prior_decision.id
      ) then
      raise exception using
        errcode = '23514',
        message = 'Claim eligibility supersession must target the current matching tip.';
    end if;
    inserted_version := prior_decision.version + 1;
  end if;

  insert into public.outcome_claim_eligibility_decisions (
    outcome_id,
    claim_type,
    version,
    decision,
    reviewer_user_id,
    evidence_ids,
    evidence_manifest_hash,
    review_manifest_hash,
    decision_reason,
    decided_at,
    supersedes_decision_id
  ) values (
    p_outcome_id,
    p_claim_type,
    inserted_version,
    p_decision,
    caller_id,
    coalesce(p_evidence_ids, '{}'::uuid[]),
    repeat('0', 64),
    repeat('0', 64),
    nullif(pg_catalog.btrim(p_decision_reason), ''),
    clock_timestamp(),
    p_supersedes_decision_id
  )
  returning id into inserted_id;

  foreach evidence_id in array coalesce(p_evidence_ids, '{}'::uuid[]) loop
    insert into public.outcome_claim_eligibility_evidence (
      eligibility_decision_id,
      outcome_id,
      evidence_id
    ) values (
      inserted_id,
      p_outcome_id,
      evidence_id
    );
  end loop;

  return inserted_id;
end;
$$;

create or replace function app_private.guard_outcome_statistics_reviewer_history()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if (
    exists (
      select 1
      from public.evidence_reviews review_row
      where review_row.reviewer_user_id = old.user_id
    )
    or exists (
      select 1
      from public.outcome_claim_eligibility_decisions decision_row
      where decision_row.reviewer_user_id = old.user_id
    )
  ) and (
    tg_op = 'DELETE'
    or new.user_role is distinct from 'admin'
  ) then
    raise exception using
      errcode = '55000',
      message = 'A statistical reviewer identity and administrator role are immutable after review.';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

create or replace function app_private.outcome_claim_evidence_manifest_hash(
  p_eligibility_decision_id uuid
)
returns text
language sql
stable
security invoker
set search_path = ''
as $$
  select pg_catalog.encode(
    extensions.digest(
      pg_catalog.convert_to(
        coalesce(
          pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
              'evidenceId', evidence.id,
              'outcomeId', evidence.outcome_id,
              'sourceId', evidence.source_id,
              'rawArtifactId', evidence.raw_artifact_id,
              'evidenceType', evidence.evidence_type,
              'evidenceGrade', evidence.evidence_grade,
              'claimTypes', (
                select coalesce(pg_catalog.jsonb_agg(claim_type order by claim_type), '[]'::jsonb)
                from pg_catalog.unnest(evidence.claim_types) claim_type
              ),
              'lotMatchingConfidence', evidence.lot_matching_confidence,
              'roundMatchingConfidence', evidence.round_matching_confidence,
              'priceExtractionConfidence', evidence.price_extraction_confidence,
              'finalityConfidence', evidence.finality_confidence,
              'createdAtEpoch', extract(epoch from evidence.created_at)
            ) order by evidence.id
          ),
          '[]'::jsonb
        )::text,
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  )
  from public.outcome_claim_eligibility_evidence link
  join public.auction_outcome_evidence evidence
    on evidence.id = link.evidence_id
   and evidence.outcome_id = link.outcome_id
  where link.eligibility_decision_id = p_eligibility_decision_id;
$$;

create or replace function app_private.outcome_claim_review_manifest_hash(
  p_eligibility_decision_id uuid
)
returns text
language sql
stable
security invoker
set search_path = ''
as $$
  select pg_catalog.encode(
    extensions.digest(
      pg_catalog.convert_to(
        coalesce(
          pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
              'reviewId', review_row.id,
              'evidenceId', review_row.evidence_id,
              'reviewerUserId', review_row.reviewer_user_id,
              'reviewType', review_row.review_type,
              'decision', review_row.decision,
              'fieldDecisions', review_row.field_decisions,
              'notes', review_row.notes,
              'independentReview', review_row.independent_review,
              'reviewedAtEpoch', extract(epoch from review_row.reviewed_at),
              'recordedAtEpoch', extract(epoch from review_row.recorded_at)
            ) order by review_row.evidence_id, review_row.id
          ),
          '[]'::jsonb
        )::text,
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  )
  from public.outcome_claim_eligibility_decisions decision_row
  left join public.outcome_claim_eligibility_evidence link
    on link.eligibility_decision_id = decision_row.id
  left join public.evidence_reviews review_row
    on review_row.evidence_id = link.evidence_id
   and review_row.reviewed_at <= decision_row.decided_at
   and review_row.recorded_at <= decision_row.created_at
  where decision_row.id = p_eligibility_decision_id
    and review_row.id is not null;
$$;

create or replace function app_private.validate_outcome_claim_manifests()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  decision_id uuid;
  linked_decision public.outcome_claim_eligibility_decisions%rowtype;
begin
  if tg_table_name = 'outcome_claim_eligibility_decisions' then
    decision_id := new.id;
  else
    decision_id := new.eligibility_decision_id;
  end if;

  select decision_row.* into linked_decision
  from public.outcome_claim_eligibility_decisions decision_row
  where decision_row.id = decision_id;

  if linked_decision.id is null
    or linked_decision.evidence_ids is distinct from (
      select coalesce(array_agg(link.evidence_id order by link.evidence_id), '{}'::uuid[])
      from public.outcome_claim_eligibility_evidence link
      where link.eligibility_decision_id = decision_id
    )
    or linked_decision.evidence_manifest_hash <>
      app_private.outcome_claim_evidence_manifest_hash(decision_id)
    or linked_decision.review_manifest_hash <>
      app_private.outcome_claim_review_manifest_hash(decision_id) then
    raise exception using
      errcode = '23514',
      message = 'Claim eligibility hashes must match the linked evidence and reviews.';
  end if;

  return null;
end;
$$;

create or replace function app_private.outcome_claim_is_eligible_at(
  p_outcome_id uuid,
  p_claim_type text,
  p_knowledge_cutoff_at timestamptz
)
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select exists (
    select 1
    from public.outcome_claim_eligibility_decisions decision_row
    where decision_row.outcome_id = p_outcome_id
      and decision_row.claim_type = p_claim_type
      and decision_row.decision = 'eligible'
      and decision_row.decided_at <= p_knowledge_cutoff_at
      and decision_row.created_at <= p_knowledge_cutoff_at
      and not exists (
        select 1
        from public.outcome_claim_eligibility_decisions successor
        where successor.supersedes_decision_id = decision_row.id
          and successor.decided_at <= p_knowledge_cutoff_at
          and successor.created_at <= p_knowledge_cutoff_at
      )
      and exists (
        select 1
        from public.outcome_claim_eligibility_evidence link
        join public.auction_outcome_evidence evidence
          on evidence.id = link.evidence_id
         and evidence.outcome_id = link.outcome_id
        where link.eligibility_decision_id = decision_row.id
          and link.created_at <= p_knowledge_cutoff_at
          and evidence.evidence_grade in ('A', 'B')
          and p_claim_type = any(evidence.claim_types)
          and evidence.created_at <= p_knowledge_cutoff_at
          and exists (
            select 1
            from public.evidence_reviews review_row
            where review_row.evidence_id = evidence.id
              and review_row.decision = 'approved'
              and review_row.reviewed_at >= evidence.created_at
              and review_row.reviewed_at <= p_knowledge_cutoff_at
              and review_row.recorded_at <= p_knowledge_cutoff_at
          )
          and not exists (
            select 1
            from public.evidence_reviews review_row
            where review_row.evidence_id = evidence.id
              and review_row.decision in ('rejected', 'needs_correction')
              and review_row.reviewed_at <= p_knowledge_cutoff_at
              and review_row.recorded_at <= p_knowledge_cutoff_at
          )
      )
  );
$$;

create or replace function app_private.outcome_claim_is_double_reviewed_at(
  p_outcome_id uuid,
  p_claim_type text,
  p_knowledge_cutoff_at timestamptz
)
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select app_private.outcome_claim_is_eligible_at(
    p_outcome_id,
    p_claim_type,
    p_knowledge_cutoff_at
  )
  and exists (
    select 1
    from public.outcome_claim_eligibility_decisions decision_row
    join public.outcome_claim_eligibility_evidence link
      on link.eligibility_decision_id = decision_row.id
     and link.outcome_id = decision_row.outcome_id
    join public.auction_outcome_evidence evidence
      on evidence.id = link.evidence_id
     and evidence.outcome_id = link.outcome_id
    join public.evidence_reviews review_row
      on review_row.evidence_id = evidence.id
    where decision_row.outcome_id = p_outcome_id
      and decision_row.claim_type = p_claim_type
      and decision_row.decision = 'eligible'
      and decision_row.decided_at <= p_knowledge_cutoff_at
      and decision_row.created_at <= p_knowledge_cutoff_at
      and link.created_at <= p_knowledge_cutoff_at
      and evidence.created_at <= p_knowledge_cutoff_at
      and evidence.evidence_grade in ('A', 'B')
      and p_claim_type = any(evidence.claim_types)
      and review_row.decision = 'approved'
      and review_row.reviewed_at >= evidence.created_at
      and review_row.reviewed_at <= p_knowledge_cutoff_at
      and review_row.recorded_at <= p_knowledge_cutoff_at
      and not exists (
        select 1
        from public.outcome_claim_eligibility_decisions successor
        where successor.supersedes_decision_id = decision_row.id
          and successor.decided_at <= p_knowledge_cutoff_at
          and successor.created_at <= p_knowledge_cutoff_at
      )
      and not exists (
        select 1
        from public.evidence_reviews conflicting_review
        where conflicting_review.evidence_id = evidence.id
          and conflicting_review.decision in ('rejected', 'needs_correction')
          and conflicting_review.reviewed_at <= p_knowledge_cutoff_at
          and conflicting_review.recorded_at <= p_knowledge_cutoff_at
      )
    group by decision_row.id, evidence.id
    having count(distinct review_row.reviewer_user_id) >= 2
      and bool_or(review_row.independent_review)
  );
$$;

create or replace function app_private.outcome_feature_snapshot_content_hash(
  p_feature_snapshot_id uuid
)
returns text
language sql
stable
security invoker
set search_path = ''
as $$
  select pg_catalog.encode(
    extensions.digest(
      pg_catalog.convert_to(
        pg_catalog.jsonb_build_object(
          'featureSnapshotId', snapshot_row.id,
          'lotId', snapshot_row.lot_id,
          'roundId', snapshot_row.round_id,
          'predictionHorizon', snapshot_row.prediction_horizon,
          'featureCutoffAtEpoch', extract(epoch from snapshot_row.feature_cutoff_at),
          'builtAtEpoch', extract(epoch from snapshot_row.built_at),
          'createdAtEpoch', extract(epoch from snapshot_row.created_at),
          'recordedAtEpoch', extract(epoch from snapshot_row.recorded_at),
          'featureSchemaVersion', snapshot_row.feature_schema_version,
          'featureBuilderVersion', snapshot_row.feature_builder_version,
          'features', snapshot_row.features,
          'sourceManifest', snapshot_row.source_manifest,
          'marketEstimateVersion', snapshot_row.market_estimate_version,
          'dvfRelease', snapshot_row.dvf_release,
          'bdnbRelease', snapshot_row.bdnb_release,
          'rnicRelease', snapshot_row.rnic_release,
          'dpeRelease', snapshot_row.dpe_release,
          'leakageCheckStatus', snapshot_row.leakage_check_status,
          'retrospective', snapshot_row.retrospective
        )::text,
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  )
  from public.auction_feature_snapshots snapshot_row
  where snapshot_row.id = p_feature_snapshot_id;
$$;

create or replace function app_private.tribunal_statistics_member_hash(
  p_round_id uuid,
  p_feature_snapshot_id uuid,
  p_outcome_id uuid,
  p_court_id uuid,
  p_status_claim_eligible boolean,
  p_initial_starting_price_claim_eligible boolean,
  p_effective_starting_price_claim_eligible boolean,
  p_initial_hammer_price_claim_eligible boolean,
  p_final_hammer_price_claim_eligible boolean,
  p_finality_status_claim_eligible boolean,
  p_market_price_claim_eligible boolean,
  p_surenchere_claim_eligible boolean,
  p_result_observed_at_claim_eligible boolean,
  p_postponement_delay_eligible boolean,
  p_double_reviewed boolean,
  p_exclusion_reasons text[],
  p_knowledge_cutoff_at timestamptz,
  p_eligibility_rule_version text
)
returns text
language sql
stable
security invoker
set search_path = ''
as $$
  select pg_catalog.encode(
    extensions.digest(
      pg_catalog.convert_to(
        pg_catalog.jsonb_build_object(
          'roundId', p_round_id,
          'featureSnapshotId', p_feature_snapshot_id,
          'featureSnapshotContentHash',
            app_private.outcome_feature_snapshot_content_hash(p_feature_snapshot_id),
          'roundContent', (
            select pg_catalog.jsonb_build_object(
              'roundKind', round_row.round_kind,
              'sequenceNumber', round_row.sequence_number,
              'scheduledAtEpoch', extract(epoch from round_row.scheduled_at),
              'localTimezone', round_row.local_timezone,
              'courtId', round_row.court_id,
              'initialStartingPriceEur', round_row.initial_starting_price_eur,
              'effectiveStartingPriceEur', round_row.effective_starting_price_eur,
              'recordedAtEpoch', extract(epoch from round_row.recorded_at)
            )
            from public.auction_rounds round_row
            where round_row.id = p_round_id
          ),
          'outcomeId', p_outcome_id,
          'outcomeContent', (
            select pg_catalog.jsonb_build_object(
              'version', outcome_row.version,
              'outcomeStatus', outcome_row.outcome_status,
              'initialHammerPriceEur', outcome_row.initial_hammer_price_eur,
              'finalHammerPriceEur', outcome_row.final_hammer_price_eur,
              'surenchereStatus', outcome_row.surenchere_status,
              'finalityStatus', outcome_row.finality_status,
              'resultObservedAtEpoch', extract(epoch from outcome_row.result_observed_at),
              'validFromEpoch', extract(epoch from outcome_row.valid_from),
              'validToEpoch', extract(epoch from outcome_row.valid_to),
              'supersedesOutcomeId', outcome_row.supersedes_outcome_id,
              'createdAtEpoch', extract(epoch from outcome_row.created_at),
              'recordedAtEpoch', extract(epoch from outcome_row.recorded_at)
            )
            from public.auction_outcomes outcome_row
            where outcome_row.id = p_outcome_id
          ),
          'courtId', p_court_id,
          'knowledgeCutoffAtEpoch', extract(epoch from p_knowledge_cutoff_at),
          'eligibilityRuleVersion', p_eligibility_rule_version,
          'flags', pg_catalog.jsonb_build_object(
            'status', p_status_claim_eligible,
            'initialStartingPrice', p_initial_starting_price_claim_eligible,
            'effectiveStartingPrice', p_effective_starting_price_claim_eligible,
            'initialHammerPrice', p_initial_hammer_price_claim_eligible,
            'finalHammerPrice', p_final_hammer_price_claim_eligible,
            'finalityStatus', p_finality_status_claim_eligible,
            'marketPrice', p_market_price_claim_eligible,
            'surenchere', p_surenchere_claim_eligible,
            'resultObservedAt', p_result_observed_at_claim_eligible,
            'postponementDelay', p_postponement_delay_eligible,
            'doubleReviewed', p_double_reviewed
          ),
          'exclusionReasons', (
            select coalesce(pg_catalog.jsonb_agg(reason order by reason), '[]'::jsonb)
            from pg_catalog.unnest(p_exclusion_reasons) reason
          ),
          'eligibilityDecisions', (
            select coalesce(
              pg_catalog.jsonb_agg(
                pg_catalog.jsonb_build_object(
                  'decisionId', decision_row.id,
                  'claimType', decision_row.claim_type,
                  'version', decision_row.version,
                  'evidenceManifestHash', decision_row.evidence_manifest_hash,
                  'reviewManifestHash', decision_row.review_manifest_hash,
                  'decidedAtEpoch', extract(epoch from decision_row.decided_at),
                  'recordedAtEpoch', extract(epoch from decision_row.created_at)
                ) order by decision_row.claim_type, decision_row.version
              ),
              '[]'::jsonb
            )
            from public.outcome_claim_eligibility_decisions decision_row
            where decision_row.outcome_id = p_outcome_id
              and decision_row.decision = 'eligible'
              and decision_row.decided_at <= p_knowledge_cutoff_at
              and decision_row.created_at <= p_knowledge_cutoff_at
              and decision_row.claim_type = any(array_remove(array[
                case when p_status_claim_eligible then 'outcome_status' end,
                case when p_initial_starting_price_claim_eligible then 'initial_starting_price_eur' end,
                case when p_effective_starting_price_claim_eligible then 'effective_starting_price_eur' end,
                case when p_initial_hammer_price_claim_eligible then 'initial_hammer_price_eur' end,
                case when p_final_hammer_price_claim_eligible then 'final_hammer_price_eur' end,
                case when p_finality_status_claim_eligible then 'finality_status' end,
                case when p_surenchere_claim_eligible then 'surenchere_status' end,
                case when p_result_observed_at_claim_eligible then 'result_observed_at' end
              ]::text[], null))
              and not exists (
                select 1
                from public.outcome_claim_eligibility_decisions successor
                where successor.supersedes_decision_id = decision_row.id
                  and successor.decided_at <= p_knowledge_cutoff_at
                  and successor.created_at <= p_knowledge_cutoff_at
              )
          ),
          'reviewsAtCutoff', (
            select coalesce(
              pg_catalog.jsonb_agg(
                pg_catalog.jsonb_build_object(
                  'evidenceId', link.evidence_id,
                  'reviewId', review_row.id,
                  'reviewerUserId', review_row.reviewer_user_id,
                  'decision', review_row.decision,
                  'independentReview', review_row.independent_review,
                  'reviewedAtEpoch', extract(epoch from review_row.reviewed_at),
                  'recordedAtEpoch', extract(epoch from review_row.recorded_at)
                ) order by link.evidence_id, review_row.id
              ),
              '[]'::jsonb
            )
            from public.outcome_claim_eligibility_decisions decision_row
            join public.outcome_claim_eligibility_evidence link
              on link.eligibility_decision_id = decision_row.id
             and link.outcome_id = decision_row.outcome_id
            join public.evidence_reviews review_row
              on review_row.evidence_id = link.evidence_id
            where decision_row.outcome_id = p_outcome_id
              and decision_row.decision = 'eligible'
              and decision_row.decided_at <= p_knowledge_cutoff_at
              and decision_row.created_at <= p_knowledge_cutoff_at
              and link.created_at <= p_knowledge_cutoff_at
              and review_row.reviewed_at <= p_knowledge_cutoff_at
              and review_row.recorded_at <= p_knowledge_cutoff_at
              and decision_row.claim_type = any(array_remove(array[
                case when p_status_claim_eligible then 'outcome_status' end,
                case when p_initial_starting_price_claim_eligible then 'initial_starting_price_eur' end,
                case when p_effective_starting_price_claim_eligible then 'effective_starting_price_eur' end,
                case when p_initial_hammer_price_claim_eligible then 'initial_hammer_price_eur' end,
                case when p_final_hammer_price_claim_eligible then 'final_hammer_price_eur' end,
                case when p_finality_status_claim_eligible then 'finality_status' end,
                case when p_surenchere_claim_eligible then 'surenchere_status' end,
                case when p_result_observed_at_claim_eligible then 'result_observed_at' end
              ]::text[], null))
              and not exists (
                select 1
                from public.outcome_claim_eligibility_decisions successor
                where successor.supersedes_decision_id = decision_row.id
                  and successor.decided_at <= p_knowledge_cutoff_at
                  and successor.created_at <= p_knowledge_cutoff_at
              )
          )
        )::text,
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  );
$$;

create or replace function app_private.tribunal_statistics_raw_quantiles(
  p_snapshot_id uuid,
  p_distribution_key text
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  with transformed_values as (
    select case p_distribution_key
      when 'finalToInitial' then pg_catalog.ln(
        outcome_row.final_hammer_price_eur / round_row.initial_starting_price_eur
      )
      when 'finalToEffective' then pg_catalog.ln(
        outcome_row.final_hammer_price_eur / round_row.effective_starting_price_eur
      )
      when 'hearingToKnownResult' then pg_catalog.ln(
        1 + extract(epoch from outcome_row.result_observed_at - round_row.scheduled_at) /
          86400
      )
    end as transformed_value
    from public.tribunal_statistics_members member_row
    join public.auction_rounds round_row on round_row.id = member_row.round_id
    join public.auction_outcomes outcome_row on outcome_row.id = member_row.outcome_id
    where member_row.snapshot_id = p_snapshot_id
      and (
        (
          p_distribution_key = 'finalToInitial'
          and member_row.status_claim_eligible
          and member_row.initial_starting_price_claim_eligible
          and member_row.final_hammer_price_claim_eligible
          and member_row.finality_status_claim_eligible
        )
        or (
          p_distribution_key = 'finalToEffective'
          and member_row.status_claim_eligible
          and member_row.effective_starting_price_claim_eligible
          and member_row.final_hammer_price_claim_eligible
          and member_row.finality_status_claim_eligible
        )
        or (
          p_distribution_key = 'hearingToKnownResult'
          and member_row.status_claim_eligible
          and member_row.result_observed_at_claim_eligible
        )
      )
  ), quantiles as (
    select
      pg_catalog.percentile_cont(0.10) within group (order by transformed_value) as p10,
      pg_catalog.percentile_cont(0.50) within group (order by transformed_value) as p50,
      pg_catalog.percentile_cont(0.90) within group (order by transformed_value) as p90
    from transformed_values
    where transformed_value is not null
  )
  select case
    when p10 is null then null
    when p_distribution_key = 'hearingToKnownResult' then
      pg_catalog.jsonb_build_object(
        'p10', pg_catalog.round(greatest(0, pg_catalog.exp(p10) - 1)::numeric, 6),
        'p50', pg_catalog.round(greatest(0, pg_catalog.exp(p50) - 1)::numeric, 6),
        'p90', pg_catalog.round(greatest(0, pg_catalog.exp(p90) - 1)::numeric, 6)
      )
    else
      pg_catalog.jsonb_build_object(
        'p10', pg_catalog.round(greatest(0, pg_catalog.exp(p10))::numeric, 6),
        'p50', pg_catalog.round(greatest(0, pg_catalog.exp(p50))::numeric, 6),
        'p90', pg_catalog.round(greatest(0, pg_catalog.exp(p90))::numeric, 6)
      )
  end
  from quantiles;
$$;

create or replace function app_private.tribunal_statistics_source_manifest_hash(
  p_scope_type text,
  p_court_id uuid,
  p_round_kind text,
  p_window_months smallint,
  p_period_start date,
  p_period_end date,
  p_knowledge_cutoff_at timestamptz,
  p_maturity_days smallint,
  p_builder_version text,
  p_eligibility_rule_version text,
  p_unfrozen_round_count bigint,
  p_unfrozen_rounds jsonb,
  p_members jsonb
)
returns text
language sql
immutable
security invoker
set search_path = ''
as $$
  select pg_catalog.encode(
    extensions.digest(
      pg_catalog.convert_to(
        pg_catalog.jsonb_build_object(
          'scopeType', p_scope_type,
          'courtId', p_court_id,
          'roundKind', p_round_kind,
          'windowMonths', p_window_months,
          'periodStart', p_period_start,
          'periodEnd', p_period_end,
          'knowledgeCutoffAtEpoch', extract(epoch from p_knowledge_cutoff_at),
          'maturityDays', p_maturity_days,
          'unfrozenRoundCount', p_unfrozen_round_count,
          'unfrozenRounds', (
            select coalesce(
              pg_catalog.jsonb_agg(
                unfrozen_value order by unfrozen_value ->> 'roundId'
              ),
              '[]'::jsonb
            )
            from pg_catalog.jsonb_array_elements(
              coalesce(p_unfrozen_rounds, '[]'::jsonb)
            ) unfrozen_value
          ),
          'builderVersion', p_builder_version,
          'eligibilityRuleVersion', p_eligibility_rule_version,
          'members', (
            select coalesce(
              pg_catalog.jsonb_agg(
                member_value order by member_value ->> 'roundId', member_value ->> 'memberHash'
              ),
              '[]'::jsonb
            )
            from pg_catalog.jsonb_array_elements(coalesce(p_members, '[]'::jsonb)) member_value
          )
        )::text,
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  );
$$;

create or replace function app_private.tribunal_statistics_prior_strength(
  p_sample_size integer
)
returns integer
language sql
immutable
strict
security invoker
set search_path = ''
as $$
  select case
    when p_sample_size < 30 then 30
    when p_sample_size < 100 then 15
    else 5
  end;
$$;

create or replace function app_private.tribunal_statistics_log_gamma(
  p_value double precision
)
returns double precision
language plpgsql
immutable
strict
security invoker
set search_path = ''
as $$
declare
  coefficients constant double precision[] := array[
    676.5203681218851,
    -1259.1392167224028,
    771.3234287776531,
    -176.6150291621406,
    12.507343278686905,
    -0.13857109526572012,
    0.000009984369578019572,
    0.00000015056327351493116
  ];
  shifted double precision;
  series double precision := 0.9999999999998099;
  coefficient double precision;
  coefficient_index integer := 0;
  t double precision;
begin
  if p_value <= 0 then
    raise exception using errcode = '22003', message = 'Log-gamma requires a positive value.';
  end if;
  if p_value < 0.5 then
    return pg_catalog.ln(pg_catalog.pi())
      - pg_catalog.ln(pg_catalog.sin(pg_catalog.pi() * p_value))
      - app_private.tribunal_statistics_log_gamma(1 - p_value);
  end if;

  shifted := p_value - 1;
  foreach coefficient in array coefficients loop
    coefficient_index := coefficient_index + 1;
    series := series + coefficient / (shifted + coefficient_index);
  end loop;
  t := shifted + cardinality(coefficients) - 0.5;
  return 0.5 * pg_catalog.ln(2 * pg_catalog.pi())
    + (shifted + 0.5) * pg_catalog.ln(t)
    - t
    + pg_catalog.ln(series);
end;
$$;

create or replace function app_private.tribunal_statistics_beta_continued_fraction(
  p_alpha double precision,
  p_beta double precision,
  p_x double precision
)
returns double precision
language plpgsql
immutable
strict
security invoker
set search_path = ''
as $$
declare
  epsilon constant double precision := 3e-14;
  floor_value constant double precision := 1e-300;
  qab double precision := p_alpha + p_beta;
  qap double precision := p_alpha + 1;
  qam double precision := p_alpha - 1;
  c double precision := 1;
  d double precision := 1 - qab * p_x / qap;
  result_value double precision;
  iteration integer;
  doubled integer;
  coefficient double precision;
  delta double precision;
begin
  if abs(d) < floor_value then
    d := floor_value;
  end if;
  d := 1 / d;
  result_value := d;

  for iteration in 1..10000 loop
    doubled := 2 * iteration;
    coefficient := iteration * (p_beta - iteration) * p_x
      / ((qam + doubled) * (p_alpha + doubled));
    d := 1 + coefficient * d;
    if abs(d) < floor_value then d := floor_value; end if;
    c := 1 + coefficient / c;
    if abs(c) < floor_value then c := floor_value; end if;
    d := 1 / d;
    result_value := result_value * d * c;

    coefficient := -((p_alpha + iteration) * (qab + iteration) * p_x
      / ((p_alpha + doubled) * (qap + doubled)));
    d := 1 + coefficient * d;
    if abs(d) < floor_value then d := floor_value; end if;
    c := 1 + coefficient / c;
    if abs(c) < floor_value then c := floor_value; end if;
    d := 1 / d;
    delta := d * c;
    result_value := result_value * delta;
    if abs(delta - 1) < epsilon then
      return result_value;
    end if;
  end loop;

  raise exception using
    errcode = '22003',
    message = 'Beta continued fraction did not converge.';
end;
$$;

create or replace function app_private.tribunal_statistics_regularized_beta(
  p_x double precision,
  p_alpha double precision,
  p_beta double precision
)
returns double precision
language plpgsql
immutable
strict
security invoker
set search_path = ''
as $$
declare
  logarithm double precision;
  factor double precision;
begin
  if p_alpha <= 0 or p_beta <= 0 then
    raise exception using errcode = '22003', message = 'Beta parameters must be positive.';
  end if;
  if p_x <= 0 then return 0; end if;
  if p_x >= 1 then return 1; end if;

  logarithm := app_private.tribunal_statistics_log_gamma(p_alpha + p_beta)
    - app_private.tribunal_statistics_log_gamma(p_alpha)
    - app_private.tribunal_statistics_log_gamma(p_beta)
    + p_alpha * pg_catalog.ln(p_x)
    + p_beta * pg_catalog.ln(1 - p_x);
  factor := pg_catalog.exp(logarithm);
  if p_x < (p_alpha + 1) / (p_alpha + p_beta + 2) then
    return factor * app_private.tribunal_statistics_beta_continued_fraction(
      p_alpha, p_beta, p_x
    ) / p_alpha;
  end if;
  return 1 - factor * app_private.tribunal_statistics_beta_continued_fraction(
    p_beta, p_alpha, 1 - p_x
  ) / p_beta;
end;
$$;

create or replace function app_private.tribunal_statistics_beta_quantile(
  p_probability double precision,
  p_alpha double precision,
  p_beta double precision
)
returns double precision
language plpgsql
immutable
strict
security invoker
set search_path = ''
as $$
declare
  low_value double precision := 0;
  high_value double precision := 1;
  middle_value double precision;
  iteration integer;
begin
  if p_probability < 0 or p_probability > 1 then
    raise exception using errcode = '22003', message = 'Beta probability must be between zero and one.';
  end if;
  for iteration in 1..80 loop
    middle_value := (low_value + high_value) / 2;
    if app_private.tribunal_statistics_regularized_beta(
      middle_value, p_alpha, p_beta
    ) < p_probability then
      low_value := middle_value;
    else
      high_value := middle_value;
    end if;
  end loop;
  return (low_value + high_value) / 2;
end;
$$;

create or replace function app_private.tribunal_statistics_v1_metric_formula_is_valid(
  p_metric jsonb,
  p_parent_metric jsonb,
  p_national boolean
)
returns boolean
language plpgsql
immutable
security invoker
set search_path = ''
as $$
declare
  numerator_value integer;
  denominator_value integer;
  parent_adjusted double precision;
  prior_strength integer := 0;
  alpha_value double precision;
  beta_value double precision;
  expected_raw numeric;
  expected_adjusted numeric;
  expected_low numeric;
  expected_high numeric;
begin
  if p_metric ->> 'method' = 'suppressed' then return true; end if;
  if p_metric ->> 'method' <> 'beta_binomial' then return false; end if;

  numerator_value := (p_metric ->> 'numerator')::integer;
  denominator_value := (p_metric ->> 'knownDenominator')::integer;
  if not p_national then
    if p_parent_metric is null
      or p_parent_metric ->> 'method' = 'suppressed'
      or pg_catalog.jsonb_typeof(p_parent_metric -> 'adjustedValue') <> 'number' then
      return false;
    end if;
    parent_adjusted := (p_parent_metric ->> 'adjustedValue')::double precision;
    prior_strength := app_private.tribunal_statistics_prior_strength(denominator_value);
  else
    parent_adjusted := 0;
  end if;

  alpha_value := numerator_value + 0.5 + parent_adjusted * prior_strength;
  beta_value := denominator_value - numerator_value + 0.5
    + (case when p_national then 0 else 1 - parent_adjusted end) * prior_strength;
  expected_raw := pg_catalog.round(
    numerator_value::numeric / denominator_value,
    9
  );
  expected_adjusted := pg_catalog.round(
    greatest(0, least(1, alpha_value / (alpha_value + beta_value)))::numeric,
    9
  );
  expected_low := pg_catalog.round(
    greatest(0, least(1, app_private.tribunal_statistics_beta_quantile(
      0.025, alpha_value, beta_value
    )))::numeric,
    9
  );
  expected_high := pg_catalog.round(
    greatest(0, least(1, app_private.tribunal_statistics_beta_quantile(
      0.975, alpha_value, beta_value
    )))::numeric,
    9
  );

  return abs((p_metric ->> 'rawValue')::numeric - expected_raw) <= 0.000000001
    and abs((p_metric ->> 'adjustedValue')::numeric - expected_adjusted) <= 0.000000001
    and abs((p_metric #>> array['confidenceInterval', 'low'])::numeric - expected_low)
      <= 0.000000001
    and abs((p_metric #>> array['confidenceInterval', 'high'])::numeric - expected_high)
      <= 0.000000001;
exception
  when others then
    return false;
end;
$$;

create or replace function app_private.tribunal_statistics_v1_distribution_formula_is_valid(
  p_distribution jsonb,
  p_parent_distribution jsonb,
  p_national boolean,
  p_transform text
)
returns boolean
language plpgsql
immutable
security invoker
set search_path = ''
as $$
declare
  sample_size_value integer;
  prior_strength integer;
  local_weight double precision;
  raw_p10 double precision;
  raw_p50 double precision;
  raw_p90 double precision;
  parent_p10 double precision;
  parent_p50 double precision;
  parent_p90 double precision;
  expected_p10 numeric;
  expected_p50 numeric;
  expected_p90 numeric;
begin
  if p_distribution ->> 'method' = 'suppressed' then return true; end if;
  if p_transform not in ('log', 'log1p') then return false; end if;

  sample_size_value := (p_distribution ->> 'sampleSize')::integer;
  raw_p10 := (p_distribution #>> array['raw', 'p10'])::double precision;
  raw_p50 := (p_distribution #>> array['raw', 'p50'])::double precision;
  raw_p90 := (p_distribution #>> array['raw', 'p90'])::double precision;
  if p_transform = 'log' and least(raw_p10, raw_p50, raw_p90) <= 0 then
    return false;
  end if;

  if p_national then
    if sample_size_value < 30
      or (p_distribution ->> 'parentSampleSize')::integer <> 0 then
      return false;
    end if;
    if sample_size_value >= 100 then
      return p_distribution ->> 'method' = 'raw'
        and (p_distribution #>> array['adjusted', 'p10'])::numeric = raw_p10::numeric
        and (p_distribution #>> array['adjusted', 'p50'])::numeric = raw_p50::numeric
        and (p_distribution #>> array['adjusted', 'p90'])::numeric = raw_p90::numeric;
    end if;
    if p_distribution ->> 'method' <> 'log_shrinkage' then return false; end if;
    prior_strength := app_private.tribunal_statistics_prior_strength(sample_size_value);
    local_weight := sample_size_value::double precision / (sample_size_value + prior_strength);
    if p_transform = 'log' then
      expected_p10 := pg_catalog.round(greatest(0, pg_catalog.exp(
        local_weight * pg_catalog.ln(raw_p10)
          + (1 - local_weight) * pg_catalog.ln(raw_p50)
      ))::numeric, 6);
      expected_p50 := pg_catalog.round(greatest(0, raw_p50)::numeric, 6);
      expected_p90 := pg_catalog.round(greatest(0, pg_catalog.exp(
        local_weight * pg_catalog.ln(raw_p90)
          + (1 - local_weight) * pg_catalog.ln(raw_p50)
      ))::numeric, 6);
    else
      expected_p10 := pg_catalog.round(greatest(0, pg_catalog.exp(
        local_weight * pg_catalog.ln(1 + raw_p10)
          + (1 - local_weight) * pg_catalog.ln(1 + raw_p50)
      ) - 1)::numeric, 6);
      expected_p50 := pg_catalog.round(greatest(0, raw_p50)::numeric, 6);
      expected_p90 := pg_catalog.round(greatest(0, pg_catalog.exp(
        local_weight * pg_catalog.ln(1 + raw_p90)
          + (1 - local_weight) * pg_catalog.ln(1 + raw_p50)
      ) - 1)::numeric, 6);
    end if;
  else
    if p_distribution ->> 'method' <> 'log_shrinkage'
      or p_parent_distribution is null
      or p_parent_distribution ->> 'method' = 'suppressed'
      or (p_distribution ->> 'parentSampleSize')::integer < 10
      or (p_distribution ->> 'parentSampleSize')::integer <>
        (p_parent_distribution ->> 'sampleSize')::integer then
      return false;
    end if;
    parent_p10 := (p_parent_distribution #>> array['adjusted', 'p10'])::double precision;
    parent_p50 := (p_parent_distribution #>> array['adjusted', 'p50'])::double precision;
    parent_p90 := (p_parent_distribution #>> array['adjusted', 'p90'])::double precision;
    if p_transform = 'log'
      and least(parent_p10, parent_p50, parent_p90) <= 0 then
      return false;
    end if;
    prior_strength := app_private.tribunal_statistics_prior_strength(sample_size_value);
    local_weight := sample_size_value::double precision / (sample_size_value + prior_strength);
    if p_transform = 'log' then
      expected_p10 := pg_catalog.round(greatest(0, pg_catalog.exp(
        local_weight * pg_catalog.ln(raw_p10)
          + (1 - local_weight) * pg_catalog.ln(parent_p10)
      ))::numeric, 6);
      expected_p50 := pg_catalog.round(greatest(0, pg_catalog.exp(
        local_weight * pg_catalog.ln(raw_p50)
          + (1 - local_weight) * pg_catalog.ln(parent_p50)
      ))::numeric, 6);
      expected_p90 := pg_catalog.round(greatest(0, pg_catalog.exp(
        local_weight * pg_catalog.ln(raw_p90)
          + (1 - local_weight) * pg_catalog.ln(parent_p90)
      ))::numeric, 6);
    else
      expected_p10 := pg_catalog.round(greatest(0, pg_catalog.exp(
        local_weight * pg_catalog.ln(1 + raw_p10)
          + (1 - local_weight) * pg_catalog.ln(1 + parent_p10)
      ) - 1)::numeric, 6);
      expected_p50 := pg_catalog.round(greatest(0, pg_catalog.exp(
        local_weight * pg_catalog.ln(1 + raw_p50)
          + (1 - local_weight) * pg_catalog.ln(1 + parent_p50)
      ) - 1)::numeric, 6);
      expected_p90 := pg_catalog.round(greatest(0, pg_catalog.exp(
        local_weight * pg_catalog.ln(1 + raw_p90)
          + (1 - local_weight) * pg_catalog.ln(1 + parent_p90)
      ) - 1)::numeric, 6);
    end if;
  end if;

  return abs((p_distribution #>> array['adjusted', 'p10'])::numeric - expected_p10)
      <= 0.000001
    and abs((p_distribution #>> array['adjusted', 'p50'])::numeric - expected_p50)
      <= 0.000001
    and abs((p_distribution #>> array['adjusted', 'p90'])::numeric - expected_p90)
      <= 0.000001;
exception
  when others then
    return false;
end;
$$;

create or replace function app_private.tribunal_statistics_v1_formulas_are_valid(
  p_statistics jsonb,
  p_scope_type text,
  p_parent_statistics jsonb,
  p_status_sample_size integer
)
returns boolean
language plpgsql
immutable
security invoker
set search_path = ''
as $$
declare
  metric_path text[];
  distribution_path text[];
  expected_local_weight numeric;
  is_national boolean := p_scope_type = 'national';
begin
  foreach metric_path slice 1 in array array[
    array['flow', 'held'],
    array['flow', 'postponed'],
    array['flow', 'cancelled'],
    array['flow', 'notRequested'],
    array['flow', 'noBidIfHeld'],
    array['flow', 'adjudicatedIfHeld'],
    array['surenchere', 'filed']
  ]::text[][] loop
    if not app_private.tribunal_statistics_v1_metric_formula_is_valid(
      p_statistics #> metric_path,
      p_parent_statistics #> metric_path,
      is_national
    ) then
      return false;
    end if;
  end loop;

  foreach distribution_path slice 1 in array array[
    array['priceRatios', 'finalToInitial'],
    array['priceRatios', 'finalToEffective']
  ]::text[][] loop
    if not app_private.tribunal_statistics_v1_distribution_formula_is_valid(
      p_statistics #> distribution_path,
      p_parent_statistics #> distribution_path,
      is_national,
      'log'
    ) then
      return false;
    end if;
  end loop;
  if not app_private.tribunal_statistics_v1_distribution_formula_is_valid(
    p_statistics #> array['delays', 'hearingToKnownResult'],
    p_parent_statistics #> array['delays', 'hearingToKnownResult'],
    is_national,
    'log1p'
  ) then
    return false;
  end if;

  if p_statistics #>> array['priceRatios', 'finalToMarket', 'method'] <> 'suppressed'
    or p_statistics #>> array['delays', 'postponementToNextHearing', 'method'] <> 'suppressed' then
    return false;
  end if;

  if is_national then
    return p_statistics #>> array['fallback', 'scope'] = 'none'
      and pg_catalog.jsonb_typeof(p_statistics #> array['fallback', 'parentLabel']) = 'null'
      and (p_statistics #>> array['fallback', 'localWeight'])::numeric = 1;
  end if;

  expected_local_weight := case
    when p_statistics #>> array['flow', 'held', 'method'] = 'suppressed' then 0
    else pg_catalog.round(
      p_status_sample_size::numeric /
        (
          p_status_sample_size
          + app_private.tribunal_statistics_prior_strength(p_status_sample_size)
          + 1
        ),
      9
    )
  end;
  return p_statistics #>> array['fallback', 'scope'] = 'national'
    and p_statistics #>> array['fallback', 'parentLabel'] = 'France entière'
    and abs(
      (p_statistics #>> array['fallback', 'localWeight'])::numeric
        - expected_local_weight
    ) <= 0.000000001;
exception
  when others then
    return false;
end;
$$;

create or replace function app_private.tribunal_statistics_v1_suppression_contract_is_valid(
  p_statistics jsonb,
  p_scope_type text,
  p_parent_statistics jsonb,
  p_quality_gate_passed boolean,
  p_status_sample_size integer,
  p_initial_price_sample_size integer,
  p_effective_price_sample_size integer,
  p_surenchere_sample_size integer,
  p_result_delay_sample_size integer
)
returns boolean
language plpgsql
immutable
security invoker
set search_path = ''
as $$
declare
  cell_path text[];
  denominator_value integer;
  sample_size_value integer;
  minimum_distribution_sample integer;
  should_publish boolean;
  is_national boolean := p_scope_type = 'national';
begin
  foreach cell_path slice 1 in array array[
    array['flow', 'held'],
    array['flow', 'postponed'],
    array['flow', 'cancelled'],
    array['flow', 'notRequested'],
    array['flow', 'noBidIfHeld'],
    array['flow', 'adjudicatedIfHeld'],
    array['surenchere', 'filed']
  ]::text[][] loop
    denominator_value := case
      when cell_path[1] = 'surenchere' then p_surenchere_sample_size
      when cell_path[2] in ('noBidIfHeld', 'adjudicatedIfHeld') then
        case
          when p_statistics #>> array['flow', 'held', 'method'] = 'suppressed'
            then 0
          else (p_statistics #>> array['flow', 'held', 'numerator'])::integer
        end
      else p_status_sample_size
    end;
    should_publish := p_quality_gate_passed
      and denominator_value >= 10
      and (
        is_national
        or coalesce(
          p_parent_statistics #>> (cell_path || array['method']) <> 'suppressed',
          false
        )
      );
    if (
      p_statistics #>> (cell_path || array['method']) <> 'suppressed'
    ) is distinct from should_publish then
      return false;
    end if;
  end loop;

  minimum_distribution_sample := case when is_national then 30 else 10 end;
  foreach cell_path slice 1 in array array[
    array['priceRatios', 'finalToInitial'],
    array['priceRatios', 'finalToEffective'],
    array['delays', 'hearingToKnownResult']
  ]::text[][] loop
    sample_size_value := case cell_path[2]
      when 'finalToInitial' then p_initial_price_sample_size
      when 'finalToEffective' then p_effective_price_sample_size
      else p_result_delay_sample_size
    end;
    should_publish := p_quality_gate_passed
      and sample_size_value >= minimum_distribution_sample
      and (
        is_national
        or coalesce(
          p_parent_statistics #>> (cell_path || array['method']) <> 'suppressed',
          false
        )
      );
    if (
      p_statistics #>> (cell_path || array['method']) <> 'suppressed'
    ) is distinct from should_publish then
      return false;
    end if;
  end loop;

  return p_statistics #>> array['priceRatios', 'finalToMarket', 'method'] =
      'suppressed'
    and p_statistics #>> array['delays', 'postponementToNextHearing', 'method'] =
      'suppressed';
exception
  when others then
    return false;
end;
$$;

create or replace function app_private.validate_tribunal_statistics_snapshot()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  linked_court public.outcome_courts%rowtype;
  parent_snapshot public.tribunal_statistics_snapshots%rowtype;
  distribution_path text[];
begin
  new.computed_at := clock_timestamp();
  new.created_at := new.computed_at;
  new.statistics_hash := pg_catalog.encode(
    extensions.digest(
      pg_catalog.convert_to(
        pg_catalog.jsonb_build_object(
          'scopeType', new.scope_type,
          'courtId', new.court_id,
          'courtCode', new.court_code,
          'courtName', new.court_name,
          'judicialRegion', new.judicial_region,
          'parentSnapshotId', new.parent_snapshot_id,
          'roundKind', new.round_kind,
          'windowMonths', new.window_months,
          'periodStart', new.period_start,
          'periodEnd', new.period_end,
          'knowledgeCutoffAtEpoch', extract(epoch from new.knowledge_cutoff_at),
          'maturityDays', new.maturity_days,
          'builderVersion', new.builder_version,
          'eligibilityRuleVersion', new.eligibility_rule_version,
          'smoothingRuleVersion', new.smoothing_rule_version,
          'reliabilityStatus', new.reliability_status,
          'qualityGatePassed', new.quality_gate_passed,
          'eligibleRoundCount', new.eligible_round_count,
          'unfrozenRoundCount', new.unfrozen_round_count,
          'freezeCoverage', new.freeze_coverage,
          'statusSampleSize', new.status_sample_size,
          'initialPriceSampleSize', new.initial_price_sample_size,
          'effectivePriceSampleSize', new.effective_price_sample_size,
          'marketPriceSampleSize', new.market_price_sample_size,
          'surenchereSampleSize', new.surenchere_sample_size,
          'resultDelaySampleSize', new.result_delay_sample_size,
          'postponementDelaySampleSize', new.postponement_delay_sample_size,
          'doubleReviewedCount', new.double_reviewed_count,
          'outcomeCoverage', new.outcome_coverage,
          'statistics', new.statistics,
          'sourceManifestHash', new.source_manifest_hash
        )::text,
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  );
  if new.knowledge_cutoff_at > new.computed_at then
    raise exception using
      errcode = '23514',
      message = 'Statistics snapshots cannot be future-dated.';
  end if;

  if new.scope_type = 'national' then
    foreach distribution_path slice 1 in array array[
      array['priceRatios', 'finalToInitial'],
      array['priceRatios', 'finalToEffective'],
      array['priceRatios', 'finalToMarket'],
      array['delays', 'hearingToKnownResult'],
      array['delays', 'postponementToNextHearing']
    ] loop
      if new.statistics #>> (distribution_path || array['method']) <> 'suppressed'
        and (
          (new.statistics #>> (distribution_path || array['sampleSize']))::integer < 30
          or (new.statistics #>> (distribution_path || array['parentSampleSize']))::integer <> 0
        ) then
        raise exception using
          errcode = '23514',
          message = 'National distributions require at least 30 samples and no parent reference.';
      end if;
    end loop;
    if not app_private.tribunal_statistics_v1_suppression_contract_is_valid(
      new.statistics,
      new.scope_type,
      null,
      new.quality_gate_passed,
      new.status_sample_size,
      new.initial_price_sample_size,
      new.effective_price_sample_size,
      new.surenchere_sample_size,
      new.result_delay_sample_size
    ) then
      raise exception using
        errcode = '23514',
        message = 'National cells must be published or suppressed exactly by the v1 thresholds.';
    end if;
    if not app_private.tribunal_statistics_v1_formulas_are_valid(
      new.statistics,
      new.scope_type,
      null,
      new.status_sample_size
    ) then
      raise exception using
        errcode = '23514',
        message = 'Published national cells must match the exact v1 adjustment formulas.';
    end if;
    return new;
  end if;

  select court_row.* into linked_court
  from public.outcome_courts court_row
  where court_row.id = new.court_id;

  select snapshot_row.* into parent_snapshot
  from public.tribunal_statistics_snapshots snapshot_row
  where snapshot_row.id = new.parent_snapshot_id;

  if linked_court.id is null
    or new.court_code is distinct from linked_court.code
    or new.court_name is distinct from linked_court.name
    or new.judicial_region is distinct from linked_court.judicial_region then
    raise exception using
      errcode = '23514',
      message = 'Tribunal snapshot metadata must match the canonical court registry.';
  end if;

  if parent_snapshot.id is null
    or parent_snapshot.scope_type <> 'national'
    or parent_snapshot.round_kind <> new.round_kind
    or parent_snapshot.window_months <> new.window_months
    or parent_snapshot.period_start <> new.period_start
    or parent_snapshot.period_end <> new.period_end
    or parent_snapshot.knowledge_cutoff_at <> new.knowledge_cutoff_at
    or parent_snapshot.maturity_days <> new.maturity_days
    or parent_snapshot.builder_version <> new.builder_version
    or parent_snapshot.eligibility_rule_version <> new.eligibility_rule_version
    or parent_snapshot.smoothing_rule_version <> new.smoothing_rule_version then
    raise exception using
      errcode = '23514',
      message = 'Tribunal snapshots require a matching national parent snapshot.';
  end if;

  if not exists (
    select 1
    from public.auction_rounds round_row
    join public.auction_lots lot_row on lot_row.id = round_row.lot_id
    join public.auction_cases case_row on case_row.id = lot_row.auction_case_id
    join pg_catalog.pg_timezone_names timezone_row
      on timezone_row.name = round_row.local_timezone
    where round_row.court_id = new.court_id
      and case_row.court_id = round_row.court_id
      and round_row.round_kind = new.round_kind
      and round_row.scheduled_at is not null
      and round_row.created_at <= new.knowledge_cutoff_at
      and round_row.recorded_at <= new.knowledge_cutoff_at
      and (round_row.scheduled_at at time zone timezone_row.name)::date
        between new.period_start and new.period_end
  ) then
    raise exception using
      errcode = '23514',
      message = 'A tribunal snapshot court must belong to its parent mature-round universe.';
  end if;

  if new.quality_gate_passed and not parent_snapshot.quality_gate_passed then
    raise exception using
      errcode = '23514',
      message = 'A publishable tribunal snapshot requires a publishable national parent.';
  end if;
  if not parent_snapshot.quality_gate_passed
    and not (
      new.statistics -> 'warnings' @>
        '["Référence nationale non publiable: toutes les valeurs locales sont masquées."]'::jsonb
    ) then
    raise exception using
      errcode = '23514',
      message = 'An unpublished national reference must be disclosed by the closed warning code.';
  end if;
  if parent_snapshot.quality_gate_passed
    and new.statistics -> 'warnings' @>
      '["Référence nationale non publiable: toutes les valeurs locales sont masquées."]'::jsonb then
    raise exception using
      errcode = '23514',
      message = 'The unpublished national reference warning must reflect the parent gate.';
  end if;

  foreach distribution_path slice 1 in array array[
    array['priceRatios', 'finalToInitial'],
    array['priceRatios', 'finalToEffective'],
    array['priceRatios', 'finalToMarket'],
    array['delays', 'hearingToKnownResult'],
    array['delays', 'postponementToNextHearing']
  ] loop
    if new.statistics #>> (distribution_path || array['method']) <> 'suppressed'
      and (
        parent_snapshot.statistics #>> (distribution_path || array['method']) = 'suppressed'
        or (new.statistics #>> (distribution_path || array['parentSampleSize']))::integer <>
          (parent_snapshot.statistics #>> (distribution_path || array['sampleSize']))::integer
      ) then
      raise exception using
        errcode = '23514',
        message = 'Published tribunal distributions require their matching national parent cell.';
    end if;
  end loop;

  if not app_private.tribunal_statistics_v1_suppression_contract_is_valid(
    new.statistics,
    new.scope_type,
    parent_snapshot.statistics,
    new.quality_gate_passed,
    new.status_sample_size,
    new.initial_price_sample_size,
    new.effective_price_sample_size,
    new.surenchere_sample_size,
    new.result_delay_sample_size
  ) then
    raise exception using
      errcode = '23514',
      message = 'Tribunal cells must be published or suppressed exactly by the v1 thresholds and parent cells.';
  end if;

  if not app_private.tribunal_statistics_v1_formulas_are_valid(
    new.statistics,
    new.scope_type,
    parent_snapshot.statistics,
    new.status_sample_size
  ) then
    raise exception using
      errcode = '23514',
      message = 'Published tribunal cells must match the exact v1 parent-adjusted formulas.';
  end if;

  return new;
end;
$$;

create or replace function app_private.validate_tribunal_statistics_member()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  linked_snapshot public.tribunal_statistics_snapshots%rowtype;
  linked_round public.auction_rounds%rowtype;
  linked_feature_snapshot public.auction_feature_snapshots%rowtype;
  linked_outcome public.auction_outcomes%rowtype;
  linked_case_court_id uuid;
  expected_status_claim_eligible boolean;
  expected_initial_starting_price_claim_eligible boolean;
  expected_effective_starting_price_claim_eligible boolean;
  expected_initial_hammer_price_claim_eligible boolean;
  expected_final_hammer_price_claim_eligible boolean;
  expected_finality_status_claim_eligible boolean;
  expected_surenchere_claim_eligible boolean;
  expected_result_observed_at_claim_eligible boolean;
  expected_double_reviewed boolean;
begin
  new.created_at := clock_timestamp();
  select snapshot_row.* into linked_snapshot
  from public.tribunal_statistics_snapshots snapshot_row
  where snapshot_row.id = new.snapshot_id;
  select round_row.* into linked_round
  from public.auction_rounds round_row
  where round_row.id = new.round_id;

  select feature_row.* into linked_feature_snapshot
  from public.auction_feature_snapshots feature_row
  where feature_row.id = new.feature_snapshot_id;

  select case_row.court_id into linked_case_court_id
  from public.auction_lots lot_row
  join public.auction_cases case_row on case_row.id = lot_row.auction_case_id
  where lot_row.id = linked_round.lot_id;

  if linked_snapshot.id is null
    or linked_round.id is null
    or linked_feature_snapshot.id is null
    or linked_feature_snapshot.round_id <> new.round_id
    or linked_feature_snapshot.built_at > linked_snapshot.knowledge_cutoff_at
    or linked_feature_snapshot.created_at > linked_snapshot.knowledge_cutoff_at
    or linked_feature_snapshot.recorded_at > linked_snapshot.knowledge_cutoff_at
    or linked_feature_snapshot.feature_cutoff_at > linked_snapshot.knowledge_cutoff_at
    or linked_feature_snapshot.retrospective
    or linked_feature_snapshot.leakage_check_status <> 'passed'
    or linked_round.created_at > linked_snapshot.knowledge_cutoff_at
    or linked_round.recorded_at > linked_snapshot.knowledge_cutoff_at
    or linked_case_court_id is null
    or linked_case_court_id <> linked_round.court_id
    or linked_round.court_id <> new.court_id
    or linked_round.round_kind <> linked_snapshot.round_kind
    or linked_round.scheduled_at is null
    or not exists (
      select 1
      from pg_catalog.pg_timezone_names timezone_row
      where timezone_row.name = linked_round.local_timezone
    )
    or (linked_snapshot.scope_type = 'tribunal' and linked_snapshot.court_id <> new.court_id) then
    raise exception using errcode = '23514', message = 'Statistics member is outside its snapshot universe.';
  end if;

  if (linked_round.scheduled_at at time zone linked_round.local_timezone)::date
    not between linked_snapshot.period_start and linked_snapshot.period_end then
    raise exception using errcode = '23514', message = 'Statistics member is outside its snapshot universe.';
  end if;

  if not new.status_claim_eligible and cardinality(new.exclusion_reasons) = 0 then
    raise exception using
      errcode = '23514',
      message = 'Unknown or excluded outcomes require an explicit exclusion reason.';
  end if;

  if new.outcome_id is null then
    if exists (
      select 1
      from public.auction_outcomes candidate_outcome
      where candidate_outcome.round_id = new.round_id
        and candidate_outcome.valid_from <= linked_snapshot.knowledge_cutoff_at
        and candidate_outcome.created_at <= linked_snapshot.knowledge_cutoff_at
        and candidate_outcome.recorded_at <= linked_snapshot.knowledge_cutoff_at
        and (
          candidate_outcome.valid_to is null
          or candidate_outcome.valid_to > linked_snapshot.knowledge_cutoff_at
        )
        and not exists (
          select 1
          from public.auction_outcomes successor
          where successor.supersedes_outcome_id = candidate_outcome.id
            and successor.valid_from <= linked_snapshot.knowledge_cutoff_at
            and successor.created_at <= linked_snapshot.knowledge_cutoff_at
            and successor.recorded_at <= linked_snapshot.knowledge_cutoff_at
        )
    ) then
      raise exception using
        errcode = '23514',
        message = 'Statistics member cannot omit a terminal outcome known at cutoff.';
    end if;
    if cardinality(new.exclusion_reasons) <> 1
      or new.exclusion_reasons[1] not in (
        'no_terminal_outcome_at_cutoff',
        'ambiguous_terminal_outcome'
      ) then
      raise exception using
        errcode = '23514',
        message = 'A missing terminal outcome requires its exact closed v1 reason.';
    end if;
    new.member_hash := app_private.tribunal_statistics_member_hash(
      new.round_id,
      new.feature_snapshot_id,
      null,
      new.court_id,
      new.status_claim_eligible,
      new.initial_starting_price_claim_eligible,
      new.effective_starting_price_claim_eligible,
      new.initial_hammer_price_claim_eligible,
      new.final_hammer_price_claim_eligible,
      new.finality_status_claim_eligible,
      new.market_price_claim_eligible,
      new.surenchere_claim_eligible,
      new.result_observed_at_claim_eligible,
      new.postponement_delay_eligible,
      new.double_reviewed,
      new.exclusion_reasons,
      linked_snapshot.knowledge_cutoff_at,
      linked_snapshot.eligibility_rule_version
    );
    return new;
  end if;
  select outcome_row.* into linked_outcome
  from public.auction_outcomes outcome_row
  where outcome_row.id = new.outcome_id;
  if linked_outcome.id is null
    or linked_outcome.round_id <> new.round_id
    or linked_outcome.valid_from > linked_snapshot.knowledge_cutoff_at
    or linked_outcome.created_at > linked_snapshot.knowledge_cutoff_at
    or linked_outcome.recorded_at > linked_snapshot.knowledge_cutoff_at
    or (
      linked_outcome.valid_to is not null
      and linked_outcome.valid_to <= linked_snapshot.knowledge_cutoff_at
    )
    or exists (
      select 1
      from public.auction_outcomes successor
      where successor.supersedes_outcome_id = linked_outcome.id
        and successor.valid_from <= linked_snapshot.knowledge_cutoff_at
        and successor.created_at <= linked_snapshot.knowledge_cutoff_at
        and successor.recorded_at <= linked_snapshot.knowledge_cutoff_at
    ) then
    raise exception using errcode = '23514', message = 'Statistics member must use the terminal outcome at cutoff.';
  end if;

  expected_status_claim_eligible :=
    linked_outcome.outcome_status in (
      'cancelled', 'not_requested', 'postponed', 'held_no_bid', 'held_adjudicated'
    )
    and app_private.outcome_claim_is_eligible_at(
      new.outcome_id, 'outcome_status', linked_snapshot.knowledge_cutoff_at
    );
  expected_initial_starting_price_claim_eligible :=
    expected_status_claim_eligible
    and linked_round.initial_starting_price_eur is not null
    and linked_round.initial_starting_price_eur > 0
    and app_private.outcome_claim_is_eligible_at(
      new.outcome_id, 'initial_starting_price_eur', linked_snapshot.knowledge_cutoff_at
    );
  expected_effective_starting_price_claim_eligible :=
    expected_status_claim_eligible
    and linked_round.effective_starting_price_eur is not null
    and linked_round.effective_starting_price_eur > 0
    and app_private.outcome_claim_is_eligible_at(
      new.outcome_id, 'effective_starting_price_eur', linked_snapshot.knowledge_cutoff_at
    );
  expected_initial_hammer_price_claim_eligible :=
    expected_status_claim_eligible
    and linked_outcome.outcome_status = 'held_adjudicated'
    and linked_outcome.initial_hammer_price_eur is not null
    and linked_outcome.initial_hammer_price_eur > 0
    and app_private.outcome_claim_is_eligible_at(
      new.outcome_id, 'initial_hammer_price_eur', linked_snapshot.knowledge_cutoff_at
    );
  expected_finality_status_claim_eligible :=
    expected_status_claim_eligible
    and linked_outcome.outcome_status = 'held_adjudicated'
    and linked_outcome.finality_status = 'procedurally_definitive'
    and app_private.outcome_claim_is_eligible_at(
      new.outcome_id, 'finality_status', linked_snapshot.knowledge_cutoff_at
    );
  expected_final_hammer_price_claim_eligible :=
    expected_finality_status_claim_eligible
    and linked_outcome.final_hammer_price_eur is not null
    and linked_outcome.final_hammer_price_eur > 0
    and app_private.outcome_claim_is_eligible_at(
      new.outcome_id, 'final_hammer_price_eur', linked_snapshot.knowledge_cutoff_at
    );
  expected_surenchere_claim_eligible :=
    expected_status_claim_eligible
    and linked_outcome.outcome_status = 'held_adjudicated'
    and linked_outcome.surenchere_status in ('filed', 'not_filed', 'deadline_expired')
    and app_private.outcome_claim_is_eligible_at(
      new.outcome_id, 'surenchere_status', linked_snapshot.knowledge_cutoff_at
    );
  expected_result_observed_at_claim_eligible :=
    expected_status_claim_eligible
    and linked_outcome.result_observed_at is not null
    and linked_outcome.result_observed_at >= linked_round.scheduled_at
    and linked_outcome.result_observed_at <= linked_snapshot.knowledge_cutoff_at
    and app_private.outcome_claim_is_eligible_at(
      new.outcome_id, 'result_observed_at', linked_snapshot.knowledge_cutoff_at
    );
  expected_double_reviewed :=
    expected_status_claim_eligible
    and app_private.outcome_claim_is_double_reviewed_at(
      new.outcome_id, 'outcome_status', linked_snapshot.knowledge_cutoff_at
    );

  if new.status_claim_eligible is distinct from expected_status_claim_eligible
    or new.initial_starting_price_claim_eligible is distinct from
      expected_initial_starting_price_claim_eligible
    or new.effective_starting_price_claim_eligible is distinct from
      expected_effective_starting_price_claim_eligible
    or new.initial_hammer_price_claim_eligible is distinct from
      expected_initial_hammer_price_claim_eligible
    or new.final_hammer_price_claim_eligible is distinct from
      expected_final_hammer_price_claim_eligible
    or new.finality_status_claim_eligible is distinct from
      expected_finality_status_claim_eligible
    or new.market_price_claim_eligible
    or new.surenchere_claim_eligible is distinct from expected_surenchere_claim_eligible
    or new.result_observed_at_claim_eligible is distinct from
      expected_result_observed_at_claim_eligible
    or new.postponement_delay_eligible
    or new.double_reviewed is distinct from expected_double_reviewed then
    raise exception using
      errcode = '23514',
      message = 'Statistics member flags must exactly equal the closed v1 predicates at cutoff.';
  end if;

  if expected_status_claim_eligible and cardinality(new.exclusion_reasons) <> 0 then
    raise exception using
      errcode = '23514',
      message = 'A known eligible status cannot carry an exclusion reason.';
  elsif not expected_status_claim_eligible then
    if app_private.outcome_claim_is_eligible_at(
      new.outcome_id, 'outcome_status', linked_snapshot.knowledge_cutoff_at
    ) and linked_outcome.outcome_status = 'unknown' then
      if new.exclusion_reasons is distinct from array['unknown_outcome_status']::text[] then
        raise exception using
          errcode = '23514',
          message = 'An unknown outcome status requires its exact closed v1 reason.';
      end if;
    elsif new.exclusion_reasons is distinct from
      array['outcome_status_claim_ineligible']::text[] then
      raise exception using
        errcode = '23514',
        message = 'An ineligible outcome status requires its exact closed v1 reason.';
    end if;
  end if;

  if new.status_claim_eligible
    and not app_private.outcome_claim_is_eligible_at(
      new.outcome_id, 'outcome_status', linked_snapshot.knowledge_cutoff_at
    ) then
    raise exception using errcode = '23514', message = 'Outcome status claim is not eligible at cutoff.';
  end if;
  if new.status_claim_eligible and linked_outcome.outcome_status = 'unknown' then
    raise exception using errcode = '23514', message = 'Unknown is not a known outcome status.';
  end if;
  if new.initial_starting_price_claim_eligible
    and (
      linked_round.initial_starting_price_eur is null
      or linked_round.initial_starting_price_eur <= 0
      or not app_private.outcome_claim_is_eligible_at(
        new.outcome_id, 'initial_starting_price_eur', linked_snapshot.knowledge_cutoff_at
      )
    ) then
    raise exception using errcode = '23514', message = 'Initial starting price claim is not eligible at cutoff.';
  end if;
  if new.effective_starting_price_claim_eligible
    and (
      linked_round.effective_starting_price_eur is null
      or linked_round.effective_starting_price_eur <= 0
      or not app_private.outcome_claim_is_eligible_at(
        new.outcome_id, 'effective_starting_price_eur', linked_snapshot.knowledge_cutoff_at
      )
    ) then
    raise exception using errcode = '23514', message = 'Effective starting price claim is not eligible at cutoff.';
  end if;
  if new.initial_hammer_price_claim_eligible
    and (
      linked_outcome.outcome_status <> 'held_adjudicated'
      or linked_outcome.initial_hammer_price_eur is null
      or linked_outcome.initial_hammer_price_eur <= 0
      or not app_private.outcome_claim_is_eligible_at(
        new.outcome_id, 'initial_hammer_price_eur', linked_snapshot.knowledge_cutoff_at
      )
    ) then
    raise exception using errcode = '23514', message = 'Initial hammer price claim is not eligible at cutoff.';
  end if;
  if new.final_hammer_price_claim_eligible
    and (
      linked_outcome.outcome_status <> 'held_adjudicated'
      or linked_outcome.final_hammer_price_eur is null
      or linked_outcome.final_hammer_price_eur <= 0
      or not app_private.outcome_claim_is_eligible_at(
        new.outcome_id, 'final_hammer_price_eur', linked_snapshot.knowledge_cutoff_at
      )
    ) then
    raise exception using errcode = '23514', message = 'Final hammer price claim is not eligible at cutoff.';
  end if;
  if new.finality_status_claim_eligible
    and (
      linked_outcome.outcome_status <> 'held_adjudicated'
      or linked_outcome.finality_status <> 'procedurally_definitive'
      or not app_private.outcome_claim_is_eligible_at(
        new.outcome_id, 'finality_status', linked_snapshot.knowledge_cutoff_at
      )
    ) then
    raise exception using errcode = '23514', message = 'Finality claim is not eligible and definitive at cutoff.';
  end if;
  if new.surenchere_claim_eligible
    and (
      linked_outcome.outcome_status <> 'held_adjudicated'
      or linked_outcome.surenchere_status not in ('filed', 'not_filed', 'deadline_expired')
      or not app_private.outcome_claim_is_eligible_at(
        new.outcome_id, 'surenchere_status', linked_snapshot.knowledge_cutoff_at
      )
    ) then
    raise exception using errcode = '23514', message = 'Surenchere claim is not eligible at cutoff.';
  end if;
  if new.result_observed_at_claim_eligible
    and (
      linked_outcome.result_observed_at is null
      or linked_outcome.result_observed_at < linked_round.scheduled_at
      or linked_outcome.result_observed_at > linked_snapshot.knowledge_cutoff_at
      or not app_private.outcome_claim_is_eligible_at(
        new.outcome_id, 'result_observed_at', linked_snapshot.knowledge_cutoff_at
      )
    ) then
    raise exception using errcode = '23514', message = 'Result observation claim is not eligible at cutoff.';
  end if;
  if new.postponement_delay_eligible
    and (
      linked_outcome.outcome_status <> 'postponed'
      or not exists (
        select 1
        from public.auction_rounds successor_round
        where successor_round.previous_round_id = linked_round.id
          and successor_round.lot_id = linked_round.lot_id
          and successor_round.scheduled_at is not null
          and successor_round.scheduled_at >= linked_round.scheduled_at
          and successor_round.created_at <= linked_snapshot.knowledge_cutoff_at
      )
    ) then
    raise exception using
      errcode = '23514',
      message = 'Postponement delay requires a verified later hearing at cutoff.';
  end if;
  if new.double_reviewed
    and not app_private.outcome_claim_is_double_reviewed_at(
      new.outcome_id, 'outcome_status', linked_snapshot.knowledge_cutoff_at
    ) then
    raise exception using errcode = '23514', message = 'Outcome status has not been independently double-reviewed at cutoff.';
  end if;
  new.member_hash := app_private.tribunal_statistics_member_hash(
    new.round_id,
    new.feature_snapshot_id,
    new.outcome_id,
    new.court_id,
    new.status_claim_eligible,
    new.initial_starting_price_claim_eligible,
    new.effective_starting_price_claim_eligible,
    new.initial_hammer_price_claim_eligible,
    new.final_hammer_price_claim_eligible,
    new.finality_status_claim_eligible,
    new.market_price_claim_eligible,
    new.surenchere_claim_eligible,
    new.result_observed_at_claim_eligible,
    new.postponement_delay_eligible,
    new.double_reviewed,
    new.exclusion_reasons,
    linked_snapshot.knowledge_cutoff_at,
    linked_snapshot.eligibility_rule_version
  );
  return new;
end;
$$;

create or replace function app_private.validate_tribunal_statistics_manifest()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  manifest_member_count bigint;
  manifest_status_count bigint;
  manifest_initial_price_count bigint;
  manifest_effective_price_count bigint;
  manifest_market_price_count bigint;
  manifest_surenchere_count bigint;
  manifest_result_delay_count bigint;
  manifest_postponement_delay_count bigint;
  manifest_double_reviewed_count bigint;
  manifest_held_count bigint;
  manifest_postponed_count bigint;
  manifest_cancelled_count bigint;
  manifest_not_requested_count bigint;
  manifest_no_bid_count bigint;
  manifest_adjudicated_count bigint;
  manifest_surenchere_filed_count bigint;
  manifest_status_unknown_count bigint;
  manifest_status_exclusion_reasons jsonb;
  manifest_surenchere_unknown_count bigint;
  manifest_surenchere_exclusion_count bigint;
  manifest_surenchere_exclusion_reasons jsonb;
  manifest_initial_price_unknown_count bigint;
  manifest_initial_price_exclusion_count bigint;
  manifest_initial_price_exclusion_reasons jsonb;
  manifest_effective_price_unknown_count bigint;
  manifest_effective_price_exclusion_count bigint;
  manifest_effective_price_exclusion_reasons jsonb;
  manifest_result_delay_unknown_count bigint;
  manifest_result_delay_exclusion_count bigint;
  manifest_result_delay_exclusion_reasons jsonb;
  manifest_first_500_double_reviewed_count bigint;
  manifest_expected_quality_gate boolean;
  universe_round_count bigint;
  actual_unfrozen_round_count bigint;
  expected_child_court_ids uuid[];
  actual_child_court_ids uuid[];
  expected_warnings jsonb;
  normalized_expected_warnings jsonb;
  normalized_actual_warnings jsonb;
  manifest_unfrozen_rounds jsonb;
  manifest_members jsonb;
  expected_source_manifest_hash text;
  cell_path text[];
  cell jsonb;
begin
  select
    count(*),
    count(*) filter (where member_row.status_claim_eligible),
    count(*) filter (
      where member_row.status_claim_eligible
        and member_row.initial_starting_price_claim_eligible
        and member_row.final_hammer_price_claim_eligible
        and member_row.finality_status_claim_eligible
    ),
    count(*) filter (
      where member_row.status_claim_eligible
        and member_row.effective_starting_price_claim_eligible
        and member_row.final_hammer_price_claim_eligible
        and member_row.finality_status_claim_eligible
    ),
    count(*) filter (
      where member_row.status_claim_eligible
        and member_row.market_price_claim_eligible
        and member_row.final_hammer_price_claim_eligible
        and member_row.finality_status_claim_eligible
    ),
    count(*) filter (
      where member_row.status_claim_eligible
        and member_row.surenchere_claim_eligible
    ),
    count(*) filter (
      where member_row.status_claim_eligible
        and member_row.result_observed_at_claim_eligible
    ),
    count(*) filter (
      where member_row.status_claim_eligible
        and member_row.postponement_delay_eligible
    ),
    count(*) filter (where member_row.double_reviewed),
    count(*) filter (
      where member_row.status_claim_eligible
        and outcome_row.outcome_status in ('held_no_bid', 'held_adjudicated')
    ),
    count(*) filter (
      where member_row.status_claim_eligible
        and outcome_row.outcome_status = 'postponed'
    ),
    count(*) filter (
      where member_row.status_claim_eligible
        and outcome_row.outcome_status = 'cancelled'
    ),
    count(*) filter (
      where member_row.status_claim_eligible
        and outcome_row.outcome_status = 'not_requested'
    ),
    count(*) filter (
      where member_row.status_claim_eligible
        and outcome_row.outcome_status = 'held_no_bid'
    ),
    count(*) filter (
      where member_row.status_claim_eligible
        and outcome_row.outcome_status = 'held_adjudicated'
    ),
    count(*) filter (
      where member_row.status_claim_eligible
        and member_row.surenchere_claim_eligible
        and outcome_row.surenchere_status = 'filed'
    )
  into
    manifest_member_count,
    manifest_status_count,
    manifest_initial_price_count,
    manifest_effective_price_count,
    manifest_market_price_count,
    manifest_surenchere_count,
    manifest_result_delay_count,
    manifest_postponement_delay_count,
    manifest_double_reviewed_count,
    manifest_held_count,
    manifest_postponed_count,
    manifest_cancelled_count,
    manifest_not_requested_count,
    manifest_no_bid_count,
    manifest_adjudicated_count,
    manifest_surenchere_filed_count
  from public.tribunal_statistics_members member_row
  left join public.auction_outcomes outcome_row on outcome_row.id = member_row.outcome_id
  where member_row.snapshot_id = new.id;

  select
    count(*) filter (
      where member_row.exclusion_reasons = array['unknown_outcome_status']::text[]
    ),
    coalesce(
      (
        select pg_catalog.jsonb_object_agg(reason_count.reason, reason_count.reason_total)
        from (
          select reason, count(*) as reason_total
          from public.tribunal_statistics_members reason_member
          cross join lateral pg_catalog.unnest(reason_member.exclusion_reasons) reason
          where reason_member.snapshot_id = new.id
            and reason <> 'unknown_outcome_status'
          group by reason
        ) reason_count
      ),
      '{}'::jsonb
    )
  into manifest_status_unknown_count, manifest_status_exclusion_reasons
  from public.tribunal_statistics_members member_row
  where member_row.snapshot_id = new.id;

  with adjudicated_rows as (
    select
      member_row.*,
      round_row.initial_starting_price_eur,
      round_row.effective_starting_price_eur,
      round_row.scheduled_at,
      outcome_row.final_hammer_price_eur,
      outcome_row.finality_status,
      outcome_row.surenchere_status,
      outcome_row.result_observed_at,
      app_private.outcome_claim_is_eligible_at(
        outcome_row.id, 'initial_starting_price_eur', new.knowledge_cutoff_at
      ) as initial_claim,
      app_private.outcome_claim_is_eligible_at(
        outcome_row.id, 'effective_starting_price_eur', new.knowledge_cutoff_at
      ) as effective_claim,
      app_private.outcome_claim_is_eligible_at(
        outcome_row.id, 'final_hammer_price_eur', new.knowledge_cutoff_at
      ) as final_claim,
      app_private.outcome_claim_is_eligible_at(
        outcome_row.id, 'finality_status', new.knowledge_cutoff_at
      ) as finality_claim,
      app_private.outcome_claim_is_eligible_at(
        outcome_row.id, 'surenchere_status', new.knowledge_cutoff_at
      ) as surenchere_claim
    from public.tribunal_statistics_members member_row
    join public.auction_rounds round_row on round_row.id = member_row.round_id
    join public.auction_outcomes outcome_row on outcome_row.id = member_row.outcome_id
    where member_row.snapshot_id = new.id
      and member_row.status_claim_eligible
      and outcome_row.outcome_status = 'held_adjudicated'
  ), derived as (
    select
      count(*) filter (
        where surenchere_claim
          and surenchere_status not in ('filed', 'not_filed', 'deadline_expired')
      ) as surenchere_unknown,
      count(*) filter (where not surenchere_claim) as surenchere_excluded,
      count(*) filter (
        where initial_claim and final_claim and finality_claim
          and (
            finality_status <> 'procedurally_definitive'
            or initial_starting_price_eur is null
            or final_hammer_price_eur is null
          )
      ) as initial_unknown,
      count(*) filter (
        where not initial_claim
          or (initial_claim and not final_claim)
          or (initial_claim and final_claim and not finality_claim)
          or (
            initial_claim and final_claim and finality_claim
            and finality_status = 'procedurally_definitive'
            and initial_starting_price_eur is not null
            and final_hammer_price_eur is not null
            and (initial_starting_price_eur <= 0 or final_hammer_price_eur <= 0)
          )
      ) as initial_excluded,
      count(*) filter (
        where effective_claim and final_claim and finality_claim
          and (
            finality_status <> 'procedurally_definitive'
            or effective_starting_price_eur is null
            or final_hammer_price_eur is null
          )
      ) as effective_unknown,
      count(*) filter (
        where not effective_claim
          or (effective_claim and not final_claim)
          or (effective_claim and final_claim and not finality_claim)
          or (
            effective_claim and final_claim and finality_claim
            and finality_status = 'procedurally_definitive'
            and effective_starting_price_eur is not null
            and final_hammer_price_eur is not null
            and (effective_starting_price_eur <= 0 or final_hammer_price_eur <= 0)
          )
      ) as effective_excluded,
      count(*) filter (where not initial_claim) as initial_claim_excluded,
      count(*) filter (where initial_claim and not final_claim) as initial_final_excluded,
      count(*) filter (
        where initial_claim and final_claim and not finality_claim
      ) as initial_finality_excluded,
      count(*) filter (
        where initial_claim and final_claim and finality_claim
          and finality_status = 'procedurally_definitive'
          and initial_starting_price_eur is not null
          and final_hammer_price_eur is not null
          and (initial_starting_price_eur <= 0 or final_hammer_price_eur <= 0)
      ) as initial_non_positive,
      count(*) filter (where not effective_claim) as effective_claim_excluded,
      count(*) filter (where effective_claim and not final_claim) as effective_final_excluded,
      count(*) filter (
        where effective_claim and final_claim and not finality_claim
      ) as effective_finality_excluded,
      count(*) filter (
        where effective_claim and final_claim and finality_claim
          and finality_status = 'procedurally_definitive'
          and effective_starting_price_eur is not null
          and final_hammer_price_eur is not null
          and (effective_starting_price_eur <= 0 or final_hammer_price_eur <= 0)
      ) as effective_non_positive
    from adjudicated_rows
  )
  select
    surenchere_unknown,
    surenchere_excluded,
    pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
      'surenchere_status_claim_ineligible',
      case when surenchere_excluded > 0 then surenchere_excluded end
    )),
    initial_unknown,
    initial_excluded,
    pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
      'initial_starting_price_eur_claim_ineligible',
      case when initial_claim_excluded > 0 then initial_claim_excluded end,
      'final_hammer_price_claim_ineligible',
      case when initial_final_excluded > 0 then initial_final_excluded end,
      'finality_status_claim_ineligible',
      case when initial_finality_excluded > 0 then initial_finality_excluded end,
      'non_positive_price',
      case when initial_non_positive > 0 then initial_non_positive end
    )),
    effective_unknown,
    effective_excluded,
    pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
      'effective_starting_price_eur_claim_ineligible',
      case when effective_claim_excluded > 0 then effective_claim_excluded end,
      'final_hammer_price_claim_ineligible',
      case when effective_final_excluded > 0 then effective_final_excluded end,
      'finality_status_claim_ineligible',
      case when effective_finality_excluded > 0 then effective_finality_excluded end,
      'non_positive_price',
      case when effective_non_positive > 0 then effective_non_positive end
    ))
  into
    manifest_surenchere_unknown_count,
    manifest_surenchere_exclusion_count,
    manifest_surenchere_exclusion_reasons,
    manifest_initial_price_unknown_count,
    manifest_initial_price_exclusion_count,
    manifest_initial_price_exclusion_reasons,
    manifest_effective_price_unknown_count,
    manifest_effective_price_exclusion_count,
    manifest_effective_price_exclusion_reasons
  from derived;

  with status_rows as (
    select
      round_row.scheduled_at,
      outcome_row.result_observed_at,
      app_private.outcome_claim_is_eligible_at(
        outcome_row.id, 'result_observed_at', new.knowledge_cutoff_at
      ) as result_claim
    from public.tribunal_statistics_members member_row
    join public.auction_rounds round_row on round_row.id = member_row.round_id
    join public.auction_outcomes outcome_row on outcome_row.id = member_row.outcome_id
    where member_row.snapshot_id = new.id
      and member_row.status_claim_eligible
  ), derived as (
    select
      count(*) filter (where result_claim and result_observed_at is null) as result_unknown,
      count(*) filter (
        where not result_claim
          or (
            result_claim and result_observed_at is not null
            and result_observed_at > new.knowledge_cutoff_at
          )
          or (
            result_claim and result_observed_at is not null
            and result_observed_at <= new.knowledge_cutoff_at
            and result_observed_at < scheduled_at
          )
      ) as result_excluded,
      count(*) filter (where not result_claim) as claim_excluded,
      count(*) filter (
        where result_claim and result_observed_at is not null
          and result_observed_at > new.knowledge_cutoff_at
      ) as after_cutoff,
      count(*) filter (
        where result_claim and result_observed_at is not null
          and result_observed_at <= new.knowledge_cutoff_at
          and result_observed_at < scheduled_at
      ) as before_hearing
    from status_rows
  )
  select
    result_unknown,
    result_excluded,
    pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
      'result_observed_at_claim_ineligible',
      case when claim_excluded > 0 then claim_excluded end,
      'result_observed_after_cutoff',
      case when after_cutoff > 0 then after_cutoff end,
      'result_observed_before_hearing',
      case when before_hearing > 0 then before_hearing end
    ))
  into
    manifest_result_delay_unknown_count,
    manifest_result_delay_exclusion_count,
    manifest_result_delay_exclusion_reasons
  from derived;

  select count(*) filter (where qa_member.double_reviewed)
  into manifest_first_500_double_reviewed_count
  from (
    select member_row.double_reviewed
    from public.tribunal_statistics_members member_row
    join public.auction_rounds round_row on round_row.id = member_row.round_id
    where member_row.snapshot_id = new.id
      and member_row.status_claim_eligible
    order by round_row.scheduled_at, round_row.id
    limit 500
  ) qa_member;

  select coalesce(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'roundId', member_row.round_id,
        'memberHash', member_row.member_hash
      ) order by member_row.round_id
    ),
    '[]'::jsonb
  ) into manifest_members
  from public.tribunal_statistics_members member_row
  where member_row.snapshot_id = new.id;

  select
    count(*) filter (where feature_state.is_frozen),
    count(*) filter (where not feature_state.is_frozen),
    coalesce(
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'roundId', round_row.id,
          'lotId', round_row.lot_id,
          'courtId', round_row.court_id,
          'courtCode', court_row.code,
          'courtName', court_row.name,
          'judicialRegion', court_row.judicial_region,
          'scheduledAtEpoch', extract(epoch from round_row.scheduled_at),
          'localTimezone', round_row.local_timezone
        ) order by round_row.id
      ) filter (where not feature_state.is_frozen),
      '[]'::jsonb
    )
  into universe_round_count, actual_unfrozen_round_count, manifest_unfrozen_rounds
  from public.auction_rounds round_row
  join public.auction_lots lot_row on lot_row.id = round_row.lot_id
  join public.auction_cases case_row on case_row.id = lot_row.auction_case_id
  join public.outcome_courts court_row on court_row.id = round_row.court_id
  join pg_catalog.pg_timezone_names timezone_row
    on timezone_row.name = round_row.local_timezone
  cross join lateral (
    select exists (
      select 1
      from public.auction_feature_snapshots feature_row
      where feature_row.round_id = round_row.id
        and feature_row.built_at <= new.knowledge_cutoff_at
        and feature_row.created_at <= new.knowledge_cutoff_at
        and feature_row.recorded_at <= new.knowledge_cutoff_at
        and feature_row.feature_cutoff_at <= new.knowledge_cutoff_at
        and not feature_row.retrospective
        and feature_row.leakage_check_status = 'passed'
    ) as is_frozen
  ) feature_state
  where round_row.round_kind = new.round_kind
    and round_row.scheduled_at is not null
    and round_row.created_at <= new.knowledge_cutoff_at
    and round_row.recorded_at <= new.knowledge_cutoff_at
    and (round_row.scheduled_at at time zone timezone_row.name)::date
      between new.period_start and new.period_end
    and case_row.court_id = round_row.court_id
    and (new.scope_type = 'national' or round_row.court_id = new.court_id);

  expected_source_manifest_hash := app_private.tribunal_statistics_source_manifest_hash(
    new.scope_type,
    new.court_id,
    new.round_kind,
    new.window_months,
    new.period_start,
    new.period_end,
    new.knowledge_cutoff_at,
    new.maturity_days,
    new.builder_version,
    new.eligibility_rule_version,
    new.unfrozen_round_count,
    manifest_unfrozen_rounds,
    manifest_members
  );

  manifest_expected_quality_gate := manifest_status_count >= 10
    and manifest_first_500_double_reviewed_count >=
      pg_catalog.ceil(least(manifest_status_count, 500::bigint) * 0.20)
    and manifest_member_count * 5 >=
      (manifest_member_count + actual_unfrozen_round_count) * 4
    and (
      new.scope_type = 'national'
      or exists (
        select 1
        from public.tribunal_statistics_snapshots parent_snapshot
        where parent_snapshot.id = new.parent_snapshot_id
          and parent_snapshot.quality_gate_passed
      )
    );

  if new.scope_type = 'national' then
    select coalesce(
      pg_catalog.array_agg(distinct round_row.court_id order by round_row.court_id),
      '{}'::uuid[]
    )
    into expected_child_court_ids
    from public.auction_rounds round_row
    join public.auction_lots lot_row on lot_row.id = round_row.lot_id
    join public.auction_cases case_row on case_row.id = lot_row.auction_case_id
    join pg_catalog.pg_timezone_names timezone_row
      on timezone_row.name = round_row.local_timezone
    where round_row.round_kind = new.round_kind
      and round_row.scheduled_at is not null
      and round_row.created_at <= new.knowledge_cutoff_at
      and round_row.recorded_at <= new.knowledge_cutoff_at
      and (round_row.scheduled_at at time zone timezone_row.name)::date
        between new.period_start and new.period_end
      and case_row.court_id = round_row.court_id;

    select coalesce(
      pg_catalog.array_agg(child_snapshot.court_id order by child_snapshot.court_id),
      '{}'::uuid[]
    )
    into actual_child_court_ids
    from public.tribunal_statistics_snapshots child_snapshot
    where child_snapshot.parent_snapshot_id = new.id;

    if actual_child_court_ids is distinct from expected_child_court_ids then
      raise exception using
        errcode = '23514',
        message = 'A national snapshot requires exactly one tribunal child for every mature-universe court.';
    end if;
  end if;

  expected_warnings := pg_catalog.jsonb_build_array(
    'Statistiques descriptives historiques, pas une prédiction individuelle.',
    'Seules les preuves A/B validées pour chaque champ sont comptées.',
    'Le ratio de prix exige un prix final procéduralement définitif; le prix initial d’adjudication ne le remplace jamais.',
    'Ratio au marché et délai vers la prochaine audience masqués faute de preuve canonique dédiée.'
  );
  if manifest_status_count < 10 then
    expected_warnings := expected_warnings || pg_catalog.jsonb_build_array(
      'Échantillon inférieur à 10: toutes les valeurs de la cellule sont masquées.'
    );
  end if;
  if manifest_first_500_double_reviewed_count <
    pg_catalog.ceil(least(manifest_status_count, 500::bigint) * 0.20) then
    expected_warnings := expected_warnings || pg_catalog.jsonb_build_array(
      'Contrôle qualité non atteint: 20 % des 500 premiers résultats vérifiés doivent être relus indépendamment.'
    );
  end if;
  if manifest_status_count * 5 < manifest_member_count * 4 then
    expected_warnings := expected_warnings || pg_catalog.jsonb_build_array(
      'Couverture des résultats inférieure à 80 %: niveau robuste interdit.'
    );
  end if;
  if actual_unfrozen_round_count > 0 then
    expected_warnings := expected_warnings ||
      pg_catalog.jsonb_build_array('round_not_frozen_at_cutoff');
  end if;
  if manifest_member_count * 5 <
    (manifest_member_count + actual_unfrozen_round_count) * 4 then
    expected_warnings := expected_warnings || pg_catalog.jsonb_build_array(
      'Couverture du gel antérieur au cutoff inférieure à 80 %: publication supprimée.'
    );
  end if;
  if new.scope_type = 'tribunal' then
    if exists (
      select 1
      from public.tribunal_statistics_snapshots parent_snapshot
      where parent_snapshot.id = new.parent_snapshot_id
        and not parent_snapshot.quality_gate_passed
    ) then
      expected_warnings := expected_warnings || pg_catalog.jsonb_build_array(
        'Référence nationale non publiable: toutes les valeurs locales sont masquées.'
      );
    end if;
    expected_warnings := expected_warnings || pg_catalog.jsonb_build_array(
      'Le poids local affiché concerne l’échantillon de statuts; chaque cellule conserve son propre dénominateur.'
    );
  end if;

  select coalesce(pg_catalog.jsonb_agg(warning.value order by warning.value), '[]'::jsonb)
  into normalized_expected_warnings
  from pg_catalog.jsonb_array_elements(expected_warnings) warning(value);
  select coalesce(pg_catalog.jsonb_agg(warning.value order by warning.value), '[]'::jsonb)
  into normalized_actual_warnings
  from pg_catalog.jsonb_array_elements(new.statistics -> 'warnings') warning(value);
  if normalized_actual_warnings is distinct from normalized_expected_warnings then
    raise exception using
      errcode = '23514',
      message = 'Statistics warnings must exactly disclose the closed v1 limitations.';
  end if;

  if manifest_member_count <> new.eligible_round_count
    or universe_round_count <> new.eligible_round_count
    or actual_unfrozen_round_count <> new.unfrozen_round_count
    or manifest_status_count <> new.status_sample_size
    or manifest_initial_price_count <> new.initial_price_sample_size
    or manifest_effective_price_count <> new.effective_price_sample_size
    or manifest_market_price_count <> new.market_price_sample_size
    or manifest_surenchere_count <> new.surenchere_sample_size
    or manifest_result_delay_count <> new.result_delay_sample_size
    or manifest_postponement_delay_count <> new.postponement_delay_sample_size
    or manifest_double_reviewed_count <> new.double_reviewed_count
    or new.quality_gate_passed is distinct from manifest_expected_quality_gate
    or new.source_manifest_hash <> expected_source_manifest_hash then
    raise exception using
      errcode = '23514',
      message = 'Statistics snapshot counters and source hash must match its complete mature-round manifest.';
  end if;

  if manifest_held_count + manifest_postponed_count + manifest_cancelled_count +
      manifest_not_requested_count <> manifest_status_count
    or manifest_no_bid_count + manifest_adjudicated_count <> manifest_held_count
    or (
      new.statistics #>> array['flow', 'held', 'method'] <> 'suppressed'
      and (new.statistics #>> array['flow', 'held', 'numerator'])::bigint <>
        manifest_held_count
    )
    or (
      new.statistics #>> array['flow', 'postponed', 'method'] <> 'suppressed'
      and (new.statistics #>> array['flow', 'postponed', 'numerator'])::bigint <>
        manifest_postponed_count
    )
    or (
      new.statistics #>> array['flow', 'cancelled', 'method'] <> 'suppressed'
      and (new.statistics #>> array['flow', 'cancelled', 'numerator'])::bigint <>
        manifest_cancelled_count
    )
    or (
      new.statistics #>> array['flow', 'notRequested', 'method'] <> 'suppressed'
      and (new.statistics #>> array['flow', 'notRequested', 'numerator'])::bigint <>
        manifest_not_requested_count
    )
    or (
      new.statistics #>> array['flow', 'noBidIfHeld', 'method'] <> 'suppressed'
      and (new.statistics #>> array['flow', 'noBidIfHeld', 'numerator'])::bigint <>
        manifest_no_bid_count
    )
    or (
      new.statistics #>> array['flow', 'adjudicatedIfHeld', 'method'] <> 'suppressed'
      and (new.statistics #>> array['flow', 'adjudicatedIfHeld', 'numerator'])::bigint <>
        manifest_adjudicated_count
    )
    or (
      new.statistics #>> array['surenchere', 'filed', 'method'] <> 'suppressed'
      and (new.statistics #>> array['surenchere', 'filed', 'numerator'])::bigint <>
        manifest_surenchere_filed_count
    ) then
    raise exception using
      errcode = '23514',
      message = 'Published flow numerators must match the immutable snapshot member manifest.';
  end if;

  foreach cell_path slice 1 in array array[
    array['flow', 'held'],
    array['flow', 'postponed'],
    array['flow', 'cancelled'],
    array['flow', 'notRequested']
  ]::text[][] loop
    cell := new.statistics #> cell_path;
    if cell ->> 'method' <> 'suppressed'
      and (
        (cell ->> 'eligibleUniverse')::bigint <> manifest_member_count
        or (cell ->> 'knownDenominator')::bigint <> manifest_status_count
        or (cell ->> 'unknownCount')::bigint <> manifest_status_unknown_count
        or (cell ->> 'excludedCount')::bigint <>
          manifest_member_count - manifest_status_count - manifest_status_unknown_count
        or cell -> 'exclusionReasons' is distinct from manifest_status_exclusion_reasons
      ) then
      raise exception using
        errcode = '23514',
        message = 'Published flow partitions must be exactly derived from snapshot members.';
    end if;
  end loop;

  cell := new.statistics #> array['surenchere', 'filed'];
  if cell ->> 'method' <> 'suppressed'
    and (
      (cell ->> 'eligibleUniverse')::bigint <> manifest_adjudicated_count
      or (cell ->> 'knownDenominator')::bigint <> manifest_surenchere_count
      or (cell ->> 'unknownCount')::bigint <> manifest_surenchere_unknown_count
      or (cell ->> 'excludedCount')::bigint <> manifest_surenchere_exclusion_count
      or cell -> 'exclusionReasons' is distinct from manifest_surenchere_exclusion_reasons
    ) then
    raise exception using
      errcode = '23514',
      message = 'Published surenchere partitions must be exactly derived from adjudicated members.';
  end if;

  cell := new.statistics #> array['priceRatios', 'finalToInitial'];
  if cell ->> 'method' <> 'suppressed'
    and (
      (cell ->> 'eligibleUniverse')::bigint <> manifest_adjudicated_count
      or (cell ->> 'sampleSize')::bigint <> manifest_initial_price_count
      or (cell ->> 'unknownCount')::bigint <> manifest_initial_price_unknown_count
      or (cell ->> 'excludedCount')::bigint <> manifest_initial_price_exclusion_count
      or cell -> 'exclusionReasons' is distinct from manifest_initial_price_exclusion_reasons
    ) then
    raise exception using
      errcode = '23514',
      message = 'Published initial-price partitions must be exactly derived from adjudicated members.';
  end if;

  cell := new.statistics #> array['priceRatios', 'finalToEffective'];
  if cell ->> 'method' <> 'suppressed'
    and (
      (cell ->> 'eligibleUniverse')::bigint <> manifest_adjudicated_count
      or (cell ->> 'sampleSize')::bigint <> manifest_effective_price_count
      or (cell ->> 'unknownCount')::bigint <> manifest_effective_price_unknown_count
      or (cell ->> 'excludedCount')::bigint <> manifest_effective_price_exclusion_count
      or cell -> 'exclusionReasons' is distinct from manifest_effective_price_exclusion_reasons
    ) then
    raise exception using
      errcode = '23514',
      message = 'Published effective-price partitions must be exactly derived from adjudicated members.';
  end if;

  cell := new.statistics #> array['delays', 'hearingToKnownResult'];
  if cell ->> 'method' <> 'suppressed'
    and (
      (cell ->> 'eligibleUniverse')::bigint <> manifest_status_count
      or (cell ->> 'sampleSize')::bigint <> manifest_result_delay_count
      or (cell ->> 'unknownCount')::bigint <> manifest_result_delay_unknown_count
      or (cell ->> 'excludedCount')::bigint <> manifest_result_delay_exclusion_count
      or cell -> 'exclusionReasons' is distinct from manifest_result_delay_exclusion_reasons
    ) then
    raise exception using
      errcode = '23514',
      message = 'Published result-delay partitions must be exactly derived from known-status members.';
  end if;

  if (
      new.statistics #>> array['priceRatios', 'finalToInitial', 'method'] <>
        'suppressed'
      and new.statistics #> array['priceRatios', 'finalToInitial', 'raw'] is distinct from
        app_private.tribunal_statistics_raw_quantiles(new.id, 'finalToInitial')
    )
    or (
      new.statistics #>> array['priceRatios', 'finalToEffective', 'method'] <>
        'suppressed'
      and new.statistics #> array['priceRatios', 'finalToEffective', 'raw'] is distinct from
        app_private.tribunal_statistics_raw_quantiles(new.id, 'finalToEffective')
    )
    or (
      new.statistics #>> array['delays', 'hearingToKnownResult', 'method'] <>
        'suppressed'
      and new.statistics #> array['delays', 'hearingToKnownResult', 'raw'] is distinct from
        app_private.tribunal_statistics_raw_quantiles(new.id, 'hearingToKnownResult')
    )
    or new.statistics #>> array['priceRatios', 'finalToMarket', 'method'] <>
      'suppressed'
    or new.statistics #>> array['delays', 'postponementToNextHearing', 'method'] <>
      'suppressed' then
    raise exception using
      errcode = '23514',
      message = 'Published raw distributions must be derived from the immutable snapshot member manifest.';
  end if;

  if new.scope_type = 'tribunal' and exists (
    select 1
    from public.tribunal_statistics_members member_row
    left join public.tribunal_statistics_members parent_member
      on parent_member.snapshot_id = new.parent_snapshot_id
     and parent_member.round_id = member_row.round_id
     and parent_member.feature_snapshot_id = member_row.feature_snapshot_id
     and parent_member.outcome_id is not distinct from member_row.outcome_id
     and parent_member.court_id = member_row.court_id
     and parent_member.status_claim_eligible = member_row.status_claim_eligible
     and parent_member.initial_starting_price_claim_eligible =
       member_row.initial_starting_price_claim_eligible
     and parent_member.effective_starting_price_claim_eligible =
       member_row.effective_starting_price_claim_eligible
     and parent_member.initial_hammer_price_claim_eligible =
       member_row.initial_hammer_price_claim_eligible
     and parent_member.final_hammer_price_claim_eligible =
       member_row.final_hammer_price_claim_eligible
     and parent_member.finality_status_claim_eligible =
       member_row.finality_status_claim_eligible
     and parent_member.market_price_claim_eligible = member_row.market_price_claim_eligible
     and parent_member.surenchere_claim_eligible = member_row.surenchere_claim_eligible
     and parent_member.result_observed_at_claim_eligible =
       member_row.result_observed_at_claim_eligible
     and parent_member.postponement_delay_eligible = member_row.postponement_delay_eligible
     and parent_member.double_reviewed = member_row.double_reviewed
     and parent_member.exclusion_reasons = member_row.exclusion_reasons
    where member_row.snapshot_id = new.id
      and parent_member.snapshot_id is null
  ) then
    raise exception using
      errcode = '23514',
      message = 'Tribunal snapshot members must be an exact subset of the national parent manifest.';
  end if;

  return null;
end;
$$;

do $$
begin
  if exists (
    select 1
    from public.auction_rounds round_row
    join public.auction_lots lot_row on lot_row.id = round_row.lot_id
    join public.auction_cases case_row on case_row.id = lot_row.auction_case_id
    where case_row.court_id <> round_row.court_id
  ) then
    raise exception using
      errcode = '23514',
      message = 'Existing auction lineage has inconsistent case and round courts.';
  end if;
end;
$$;

create or replace function app_private.guard_auction_case_statistics_identity()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.court_id is distinct from old.court_id then
    raise exception using
      errcode = '55000',
      message = 'Auction case statistical identity is immutable; create a new case.';
  end if;
  return new;
end;
$$;

create or replace function app_private.guard_auction_lot_statistics_identity()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.auction_case_id is distinct from old.auction_case_id then
    raise exception using
      errcode = '55000',
      message = 'Auction lot statistical identity is immutable; create a new lot.';
  end if;
  return new;
end;
$$;

create or replace function app_private.guard_auction_round_statistics_identity()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception using
      errcode = '55000',
      message = 'Auction round statistical identity is immutable; create a new round.';
  end if;
  if new.lot_id is distinct from old.lot_id
    or new.round_kind is distinct from old.round_kind
    or new.sequence_number is distinct from old.sequence_number
    or new.previous_round_id is distinct from old.previous_round_id
    or new.scheduled_at is distinct from old.scheduled_at
    or new.local_timezone is distinct from old.local_timezone
    or new.court_id is distinct from old.court_id
    or new.initial_starting_price_eur is distinct from old.initial_starting_price_eur
    or new.effective_starting_price_eur is distinct from old.effective_starting_price_eur
    or new.created_at is distinct from old.created_at
    or new.recorded_at is distinct from old.recorded_at then
    raise exception using
      errcode = '55000',
      message = 'Auction round statistical identity is immutable; create a new round.';
  end if;
  return new;
end;
$$;

create or replace function app_private.guard_outcome_court_statistics_identity()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if (
    new.code is distinct from old.code
    or new.name is distinct from old.name
    or new.judicial_region is distinct from old.judicial_region
  ) and exists (
    select 1
    from public.tribunal_statistics_snapshots snapshot_row
    where snapshot_row.court_id = old.id
  ) then
    raise exception using
      errcode = '55000',
      message = 'Court statistical metadata is immutable after its first snapshot.';
  end if;
  return new;
end;
$$;

create trigger a_lock_outcome_claim_eligibility_decisions_for_tribunal_statistics
before insert or update or delete on public.outcome_claim_eligibility_decisions
for each statement execute function app_private.lock_tribunal_statistics_source_write();

create trigger a_lock_outcome_claim_eligibility_evidence_for_tribunal_statistics
before insert or update or delete on public.outcome_claim_eligibility_evidence
for each statement execute function app_private.lock_tribunal_statistics_source_write();

create trigger guard_auction_case_statistics_identity_before_update
before update on public.auction_cases
for each row execute function app_private.guard_auction_case_statistics_identity();

create trigger guard_auction_lot_statistics_identity_before_update
before update on public.auction_lots
for each row execute function app_private.guard_auction_lot_statistics_identity();

create trigger z_guard_auction_round_statistics_identity_before_update
before update or delete on public.auction_rounds
for each row execute function app_private.guard_auction_round_statistics_identity();

create trigger guard_outcome_court_statistics_identity_before_update
before update on public.outcome_courts
for each row execute function app_private.guard_outcome_court_statistics_identity();

create trigger user_profiles_statistics_reviewer_update_guard
before update of user_role on public.user_profiles
for each row execute function app_private.guard_outcome_statistics_reviewer_history();

create trigger user_profiles_statistics_reviewer_delete_guard
before delete on public.user_profiles
for each row execute function app_private.guard_outcome_statistics_reviewer_history();

create trigger validate_outcome_claim_eligibility_decision_before_insert
before insert on public.outcome_claim_eligibility_decisions
for each row execute function app_private.validate_outcome_claim_eligibility_decision();

create trigger validate_outcome_claim_eligibility_evidence_before_insert
before insert on public.outcome_claim_eligibility_evidence
for each row execute function app_private.validate_outcome_claim_eligibility_evidence();

create constraint trigger validate_outcome_claim_decision_manifests_after_insert
after insert on public.outcome_claim_eligibility_decisions
deferrable initially deferred
for each row execute function app_private.validate_outcome_claim_manifests();

create constraint trigger validate_outcome_claim_evidence_manifests_after_insert
after insert on public.outcome_claim_eligibility_evidence
deferrable initially deferred
for each row execute function app_private.validate_outcome_claim_manifests();

create trigger validate_tribunal_statistics_snapshot_before_insert
before insert on public.tribunal_statistics_snapshots
for each row execute function app_private.validate_tribunal_statistics_snapshot();

create trigger validate_tribunal_statistics_member_before_insert
before insert on public.tribunal_statistics_members
for each row execute function app_private.validate_tribunal_statistics_member();

create constraint trigger validate_tribunal_statistics_manifest_after_insert
after insert on public.tribunal_statistics_snapshots
deferrable initially deferred
for each row execute function app_private.validate_tribunal_statistics_manifest();

create trigger outcome_claim_eligibility_decisions_append_only
before update or delete on public.outcome_claim_eligibility_decisions
for each row execute function app_private.reject_outcome_graph_mutation();

create trigger outcome_claim_eligibility_evidence_append_only
before update or delete on public.outcome_claim_eligibility_evidence
for each row execute function app_private.reject_outcome_graph_mutation();

create trigger tribunal_statistics_snapshots_append_only
before update or delete on public.tribunal_statistics_snapshots
for each row execute function app_private.reject_outcome_graph_mutation();

create trigger tribunal_statistics_members_append_only
before update or delete on public.tribunal_statistics_members
for each row execute function app_private.reject_outcome_graph_mutation();

alter table public.outcome_claim_eligibility_decisions enable row level security;
alter table public.outcome_claim_eligibility_evidence enable row level security;
alter table public.tribunal_statistics_snapshots enable row level security;
alter table public.tribunal_statistics_members enable row level security;

revoke all on table
  public.outcome_claim_eligibility_decisions,
  public.outcome_claim_eligibility_evidence,
  public.tribunal_statistics_snapshots,
  public.tribunal_statistics_members
from public, anon, authenticated, service_role;

grant select on table
  public.outcome_claim_eligibility_decisions,
  public.outcome_claim_eligibility_evidence
to service_role;

grant select, insert on table
  public.tribunal_statistics_snapshots,
  public.tribunal_statistics_members
to service_role;

revoke insert on table public.evidence_reviews from service_role;

revoke all on function app_private.validate_outcome_claim_eligibility_decision()
from public, anon, authenticated;
revoke all on function app_private.guard_outcome_statistics_reviewer_history()
from public, anon, authenticated, service_role;
revoke all on function public.review_outcome_evidence(uuid, text, text, jsonb, text)
from public, anon, service_role;
revoke all on function public.decide_outcome_claim_eligibility(
  uuid, text, text, uuid[], text, uuid
)
from public, anon, service_role;
revoke all on function app_private.lock_tribunal_statistics_source_write()
from public, anon, authenticated;
revoke all on function app_private.validate_auction_round_local_timezone()
from public, anon, authenticated;
revoke all on function app_private.validate_auction_round_statistics_lineage()
from public, anon, authenticated;
revoke all on function app_private.guard_auction_case_statistics_identity()
from public, anon, authenticated;
revoke all on function app_private.guard_auction_lot_statistics_identity()
from public, anon, authenticated;
revoke all on function app_private.guard_auction_round_statistics_identity()
from public, anon, authenticated;
revoke all on function app_private.guard_outcome_court_statistics_identity()
from public, anon, authenticated;
revoke all on function app_private.stamp_tribunal_statistics_source_recorded_at()
from public, anon, authenticated;
revoke all on function app_private.tribunal_statistics_published_metric_is_valid(jsonb)
from public, anon, authenticated;
revoke all on function app_private.tribunal_statistics_published_distribution_is_valid(jsonb)
from public, anon, authenticated;
revoke all on function app_private.tribunal_statistics_suppression_is_safe(jsonb, boolean)
from public, anon, authenticated;
revoke all on function app_private.tribunal_statistics_payload_counts_are_consistent(
  jsonb, integer, integer, integer, integer, integer, integer, integer, integer
)
from public, anon, authenticated;
revoke all on function app_private.stamp_feature_snapshot_recorded_at()
from public, anon, authenticated;
revoke all on function app_private.validate_outcome_claim_eligibility_evidence()
from public, anon, authenticated;
revoke all on function app_private.stamp_evidence_review_recorded_at()
from public, anon, authenticated;
revoke all on function app_private.outcome_claim_evidence_manifest_hash_for(uuid[])
from public, anon, authenticated;
revoke all on function app_private.outcome_claim_review_manifest_hash_for(
  uuid[], timestamptz, timestamptz
)
from public, anon, authenticated;
revoke all on function app_private.outcome_claim_evidence_manifest_hash(uuid)
from public, anon, authenticated;
revoke all on function app_private.outcome_claim_review_manifest_hash(uuid)
from public, anon, authenticated;
revoke all on function app_private.validate_outcome_claim_manifests()
from public, anon, authenticated;
revoke all on function app_private.outcome_claim_is_eligible_at(uuid, text, timestamptz)
from public, anon, authenticated;
revoke all on function app_private.outcome_claim_is_double_reviewed_at(uuid, text, timestamptz)
from public, anon, authenticated;
revoke all on function app_private.outcome_feature_snapshot_content_hash(uuid)
from public, anon, authenticated;
revoke all on function app_private.tribunal_statistics_raw_quantiles(uuid, text)
from public, anon, authenticated;
revoke all on function app_private.tribunal_statistics_member_hash(
  uuid, uuid, uuid, uuid,
  boolean, boolean, boolean, boolean, boolean, boolean,
  boolean, boolean, boolean, boolean, boolean,
  text[], timestamptz, text
)
from public, anon, authenticated;
revoke all on function app_private.tribunal_statistics_source_manifest_hash(
  text, uuid, text, smallint, date, date, timestamptz, smallint,
  text, text, bigint, jsonb, jsonb
)
from public, anon, authenticated;
revoke all on function app_private.tribunal_statistics_prior_strength(integer)
from public, anon, authenticated;
revoke all on function app_private.tribunal_statistics_log_gamma(double precision)
from public, anon, authenticated;
revoke all on function app_private.tribunal_statistics_beta_continued_fraction(
  double precision, double precision, double precision
)
from public, anon, authenticated;
revoke all on function app_private.tribunal_statistics_regularized_beta(
  double precision, double precision, double precision
)
from public, anon, authenticated;
revoke all on function app_private.tribunal_statistics_beta_quantile(
  double precision, double precision, double precision
)
from public, anon, authenticated;
revoke all on function app_private.tribunal_statistics_v1_metric_formula_is_valid(
  jsonb, jsonb, boolean
)
from public, anon, authenticated;
revoke all on function app_private.tribunal_statistics_v1_distribution_formula_is_valid(
  jsonb, jsonb, boolean, text
)
from public, anon, authenticated;
revoke all on function app_private.tribunal_statistics_v1_formulas_are_valid(
  jsonb, text, jsonb, integer
)
from public, anon, authenticated;
revoke all on function app_private.tribunal_statistics_v1_suppression_contract_is_valid(
  jsonb, text, jsonb, boolean, integer, integer, integer, integer, integer
)
from public, anon, authenticated;
revoke all on function app_private.validate_tribunal_statistics_snapshot()
from public, anon, authenticated;
revoke all on function app_private.validate_tribunal_statistics_member()
from public, anon, authenticated;
revoke all on function app_private.validate_tribunal_statistics_manifest()
from public, anon, authenticated;

grant execute on function app_private.outcome_claim_is_eligible_at(uuid, text, timestamptz)
to service_role;
grant execute on function app_private.tribunal_statistics_published_metric_is_valid(jsonb)
to service_role;
grant execute on function app_private.tribunal_statistics_published_distribution_is_valid(jsonb)
to service_role;
grant execute on function app_private.tribunal_statistics_suppression_is_safe(jsonb, boolean)
to service_role;
grant execute on function app_private.tribunal_statistics_payload_counts_are_consistent(
  jsonb, integer, integer, integer, integer, integer, integer, integer, integer
)
to service_role;
grant execute on function app_private.outcome_claim_is_double_reviewed_at(uuid, text, timestamptz)
to service_role;
grant execute on function app_private.outcome_feature_snapshot_content_hash(uuid)
to service_role;
grant execute on function app_private.tribunal_statistics_raw_quantiles(uuid, text)
to service_role;
grant execute on function app_private.outcome_claim_evidence_manifest_hash(uuid)
to service_role;
grant execute on function app_private.outcome_claim_review_manifest_hash(uuid)
to service_role;
grant execute on function app_private.outcome_claim_evidence_manifest_hash_for(uuid[])
to service_role;
grant execute on function app_private.outcome_claim_review_manifest_hash_for(
  uuid[], timestamptz, timestamptz
)
to service_role;
grant execute on function app_private.tribunal_statistics_member_hash(
  uuid, uuid, uuid, uuid,
  boolean, boolean, boolean, boolean, boolean, boolean,
  boolean, boolean, boolean, boolean, boolean,
  text[], timestamptz, text
)
to service_role;
grant execute on function app_private.tribunal_statistics_source_manifest_hash(
  text, uuid, text, smallint, date, date, timestamptz, smallint,
  text, text, bigint, jsonb, jsonb
)
to service_role;
grant execute on function app_private.tribunal_statistics_prior_strength(integer)
to service_role;
grant execute on function app_private.tribunal_statistics_log_gamma(double precision)
to service_role;
grant execute on function app_private.tribunal_statistics_beta_continued_fraction(
  double precision, double precision, double precision
)
to service_role;
grant execute on function app_private.tribunal_statistics_regularized_beta(
  double precision, double precision, double precision
)
to service_role;
grant execute on function app_private.tribunal_statistics_beta_quantile(
  double precision, double precision, double precision
)
to service_role;
grant execute on function app_private.tribunal_statistics_v1_metric_formula_is_valid(
  jsonb, jsonb, boolean
)
to service_role;
grant execute on function app_private.tribunal_statistics_v1_distribution_formula_is_valid(
  jsonb, jsonb, boolean, text
)
to service_role;
grant execute on function app_private.tribunal_statistics_v1_formulas_are_valid(
  jsonb, text, jsonb, integer
)
to service_role;
grant execute on function app_private.tribunal_statistics_v1_suppression_contract_is_valid(
  jsonb, text, jsonb, boolean, integer, integer, integer, integer, integer
)
to service_role;
grant execute on function public.review_outcome_evidence(
  uuid, text, text, jsonb, text
)
to authenticated;
grant execute on function public.decide_outcome_claim_eligibility(
  uuid, text, text, uuid[], text, uuid
)
to authenticated;

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
      'tribunal.statistics_viewed',
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

comment on table public.outcome_claim_eligibility_decisions is
  'Append-only, claim-specific decisions that gate A/B evidence into descriptive tribunal statistics.';
comment on table public.tribunal_statistics_snapshots is
  'Immutable descriptive aggregates by court and closed period; never a ranking or a prediction.';
comment on table public.tribunal_statistics_members is
  'Private reproducibility manifest with one row per mature hearing in a statistics snapshot.';

notify pgrst, 'reload schema';

commit;
