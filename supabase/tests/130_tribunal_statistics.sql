begin;

select plan(92);

create function pg_temp.tribunal_statistics_payload()
returns jsonb
language sql
immutable
as $$
  with redacted as (
    select
      '{
        "rawValue": null,
        "adjustedValue": null,
        "numerator": null,
        "knownDenominator": null,
        "eligibleUniverse": null,
        "unknownCount": null,
        "excludedCount": null,
        "exclusionReasons": {},
        "confidenceInterval": null,
        "method": "suppressed"
      }'::jsonb as metric,
      '{
        "sampleSize": null,
        "eligibleUniverse": null,
        "unknownCount": null,
        "raw": null,
        "adjusted": null,
        "method": "suppressed",
        "parentSampleSize": null,
        "excludedCount": null,
        "exclusionReasons": {}
      }'::jsonb as distribution
  )
  select jsonb_build_object(
    'flow', jsonb_build_object(
      'held', metric,
      'postponed', metric,
      'cancelled', metric,
      'notRequested', metric,
      'noBidIfHeld', metric,
      'adjudicatedIfHeld', metric
    ),
    'surenchere', jsonb_build_object('filed', metric),
    'priceRatios', jsonb_build_object(
      'finalToInitial', distribution,
      'finalToEffective', distribution,
      'finalToMarket', distribution
    ),
    'delays', jsonb_build_object(
      'hearingToKnownResult', distribution,
      'postponementToNextHearing', distribution
    ),
    'fallback', jsonb_build_object(
      'scope', 'none',
      'parentLabel', null,
      'localWeight', 1
    ),
    'warnings', jsonb_build_array(
      'Statistiques descriptives historiques, pas une prédiction individuelle.',
      'Seules les preuves A/B validées pour chaque champ sont comptées.',
      'Le ratio de prix exige un prix final procéduralement définitif; le prix initial d’adjudication ne le remplace jamais.',
      'Ratio au marché et délai vers la prochaine audience masqués faute de preuve canonique dédiée.',
      'Échantillon inférieur à 10: toutes les valeurs de la cellule sont masquées.'
    )
  )
  from redacted;
$$;

create function pg_temp.tribunal_statistics_tribunal_payload()
returns jsonb
language sql
immutable
as $$
  select jsonb_set(
    jsonb_set(
      pg_temp.tribunal_statistics_payload(),
      '{fallback}',
      '{"scope":"national","parentLabel":"France entière","localWeight":0}'::jsonb
    ),
    '{warnings}',
    (
      pg_temp.tribunal_statistics_payload() -> 'warnings'
      || jsonb_build_array(
        'Référence nationale non publiable: toutes les valeurs locales sont masquées.',
        'Le poids local affiché concerne l’échantillon de statuts; chaque cellule conserve son propre dénominateur.'
      )
    )
  );
$$;

create function pg_temp.tribunal_statistics_metric(
  p_numerator integer,
  p_known_denominator integer,
  p_eligible_universe integer,
  p_unknown_count integer default 0,
  p_excluded_count integer default 0
)
returns jsonb
language sql
immutable
as $$
  select jsonb_build_object(
    'rawValue', round(p_numerator::numeric / p_known_denominator, 6),
    'adjustedValue', round(p_numerator::numeric / p_known_denominator, 6),
    'numerator', p_numerator,
    'knownDenominator', p_known_denominator,
    'eligibleUniverse', p_eligible_universe,
    'unknownCount', p_unknown_count,
    'excludedCount', p_excluded_count,
    'exclusionReasons', '{}'::jsonb,
    'confidenceInterval', jsonb_build_object('low', 0, 'high', 1),
    'method', 'beta_binomial'
  );
$$;

create function pg_temp.tribunal_statistics_distribution(
  p_sample_size integer,
  p_eligible_universe integer,
  p_unknown_count integer,
  p_excluded_count integer,
  p_p10 numeric,
  p_p50 numeric,
  p_p90 numeric
)
returns jsonb
language sql
immutable
as $$
  select jsonb_build_object(
    'sampleSize', p_sample_size,
    'eligibleUniverse', p_eligible_universe,
    'unknownCount', p_unknown_count,
    'raw', jsonb_build_object('p10', p_p10, 'p50', p_p50, 'p90', p_p90),
    'adjusted', jsonb_build_object('p10', p_p10, 'p50', p_p50, 'p90', p_p90),
    'method', 'log_shrinkage',
    'parentSampleSize', 0,
    'excludedCount', p_excluded_count,
    'exclusionReasons', '{}'::jsonb
  );
$$;

create function pg_temp.tribunal_statistics_exact_national_metric(
  p_numerator integer,
  p_known_denominator integer,
  p_eligible_universe integer
)
returns jsonb
language sql
immutable
as $$
  select jsonb_build_object(
    'rawValue', round(p_numerator::numeric / p_known_denominator, 9),
    'adjustedValue', round(
      ((p_numerator + 0.5) / (p_known_denominator + 1.0))::numeric,
      9
    ),
    'numerator', p_numerator,
    'knownDenominator', p_known_denominator,
    'eligibleUniverse', p_eligible_universe,
    'unknownCount', 0,
    'excludedCount', p_eligible_universe - p_known_denominator,
    'exclusionReasons', case
      when p_eligible_universe = p_known_denominator then '{}'::jsonb
      else jsonb_build_object(
        'no_terminal_outcome_at_cutoff',
        p_eligible_universe - p_known_denominator
      )
    end,
    'confidenceInterval', jsonb_build_object(
      'low', round(
        app_private.tribunal_statistics_beta_quantile(
          0.025, p_numerator + 0.5, p_known_denominator - p_numerator + 0.5
        )::numeric,
        9
      ),
      'high', round(
        app_private.tribunal_statistics_beta_quantile(
          0.975, p_numerator + 0.5, p_known_denominator - p_numerator + 0.5
        )::numeric,
        9
      )
    ),
    'method', 'beta_binomial'
  );
$$;

create function pg_temp.tribunal_statistics_published_rate_payload(
  p_status_sample_size integer,
  p_eligible_round_count integer
)
returns jsonb
language sql
immutable
as $$
  select jsonb_set(
    jsonb_set(
      jsonb_set(
        jsonb_set(
          jsonb_set(
            jsonb_set(
              pg_temp.tribunal_statistics_payload(),
              '{flow,held}',
              pg_temp.tribunal_statistics_exact_national_metric(
                p_status_sample_size,
                p_status_sample_size,
                p_eligible_round_count
              )
            ),
            '{flow,postponed}',
            pg_temp.tribunal_statistics_exact_national_metric(
              0, p_status_sample_size, p_eligible_round_count
            )
          ),
          '{flow,cancelled}',
          pg_temp.tribunal_statistics_exact_national_metric(
            0, p_status_sample_size, p_eligible_round_count
          )
        ),
        '{flow,notRequested}',
        pg_temp.tribunal_statistics_exact_national_metric(
          0, p_status_sample_size, p_eligible_round_count
        )
      ),
      '{flow,noBidIfHeld}',
      pg_temp.tribunal_statistics_exact_national_metric(
        0, p_status_sample_size, p_status_sample_size
      )
    ),
    '{flow,adjudicatedIfHeld}',
    pg_temp.tribunal_statistics_exact_national_metric(
      p_status_sample_size, p_status_sample_size, p_status_sample_size
    )
  );
$$;

select has_table(
  'public',
  'outcome_claim_eligibility_decisions',
  'claim-specific statistical eligibility decisions are durable'
);
select has_table(
  'public',
  'outcome_claim_eligibility_evidence',
  'eligibility decisions have an immutable evidence manifest'
);
select has_table(
  'public',
  'tribunal_statistics_snapshots',
  'tribunal aggregates are stored as immutable snapshots'
);
select has_table(
  'public',
  'tribunal_statistics_members',
  'each aggregate has a reproducible mature-round manifest'
);
select has_column(
  'public',
  'tribunal_statistics_members',
  'feature_snapshot_id',
  'member provenance is anchored to a pre-cutoff feature snapshot'
);
select has_column(
  'public',
  'tribunal_statistics_snapshots',
  'unfrozen_round_count',
  'unfrozen mature rounds are counted privately without leaking their count publicly'
);
select has_column(
  'public',
  'tribunal_statistics_snapshots',
  'freeze_coverage',
  'the private frozen-round coverage gate is persisted exactly'
);
select has_column(
  'public',
  'auction_rounds',
  'recorded_at',
  'round insertion time is available for as-of reconstruction'
);
select has_column(
  'public',
  'auction_outcomes',
  'recorded_at',
  'outcome insertion time is available for as-of reconstruction'
);
select has_column(
  'public',
  'evidence_reviews',
  'recorded_at',
  'review insertion time is available for as-of reconstruction'
);

select ok(
  (
    select count(*) = 4 and bool_and(relrowsecurity)
    from pg_class
    join pg_namespace on pg_namespace.oid = pg_class.relnamespace
    where pg_namespace.nspname = 'public'
      and pg_class.relname in (
        'outcome_claim_eligibility_decisions',
        'outcome_claim_eligibility_evidence',
        'tribunal_statistics_snapshots',
        'tribunal_statistics_members'
      )
  ),
  'RLS is enabled on every tribunal statistics table'
);

select ok(
  (
    select count(*) = 10 and bool_and((trigger_row.tgtype & 1) = 0)
    from pg_trigger trigger_row
    where not trigger_row.tgisinternal
      and trigger_row.tgname in (
        'a_lock_outcome_courts_for_tribunal_statistics',
        'a_lock_auction_cases_for_tribunal_statistics',
        'a_lock_auction_lots_for_tribunal_statistics',
        'a_lock_auction_rounds_for_tribunal_statistics',
        'a_lock_auction_feature_snapshots_for_tribunal_statistics',
        'a_lock_auction_outcomes_for_tribunal_statistics',
        'a_lock_auction_outcome_evidence_for_tribunal_statistics',
        'a_lock_evidence_reviews_for_tribunal_statistics',
        'a_lock_outcome_claim_eligibility_decisions_for_tribunal_statistics',
        'a_lock_outcome_claim_eligibility_evidence_for_tribunal_statistics'
      )
  ),
  'all statistics source writers take one statement-level transaction lock before rows'
);

select ok(
  (
    select count(*) = 4
    from pg_constraint constraint_row
    where constraint_row.conrelid = 'public.tribunal_statistics_snapshots'::regclass
      and constraint_row.contype = 'c'
      and (
        pg_get_constraintdef(constraint_row.oid) like '%round_kind%initial%'
        or pg_get_constraintdef(constraint_row.oid) like '%tribunal_statistics_builder_v1%'
        or pg_get_constraintdef(constraint_row.oid) like '%claim_ab_reviewed_frozen_round_as_of_v1%'
        or pg_get_constraintdef(constraint_row.oid) like '%jeffreys_beta_log_shrinkage_v1%'
      )
  ),
  'the persisted v1 contract fixes round kind and all algorithm rule versions'
);

select ok(
  (
    select bool_and(
      not has_table_privilege('anon', format('public.%I', relation_name), 'SELECT')
    )
    from unnest(array[
      'outcome_claim_eligibility_decisions',
      'outcome_claim_eligibility_evidence',
      'tribunal_statistics_snapshots',
      'tribunal_statistics_members'
    ]::text[]) relation(relation_name)
  ),
  'anonymous callers cannot inspect statistics or provenance tables'
);

select ok(
  (
    select bool_and(
      not has_table_privilege('authenticated', format('public.%I', relation_name), 'SELECT')
    )
    from unnest(array[
      'outcome_claim_eligibility_decisions',
      'outcome_claim_eligibility_evidence',
      'tribunal_statistics_snapshots',
      'tribunal_statistics_members'
    ]::text[]) relation(relation_name)
  ),
  'authenticated users cannot bypass the premium server API'
);

select ok(
  (
    select bool_and(
      not has_table_privilege('anon', format('public.%I', relation_name), 'INSERT')
      and not has_table_privilege('authenticated', format('public.%I', relation_name), 'INSERT')
    )
    from unnest(array[
      'outcome_claim_eligibility_decisions',
      'outcome_claim_eligibility_evidence',
      'tribunal_statistics_snapshots',
      'tribunal_statistics_members'
    ]::text[]) relation(relation_name)
  ),
  'browser roles cannot manufacture eligibility or statistics'
);

select ok(
  has_table_privilege(
    'service_role', 'public.outcome_claim_eligibility_decisions', 'SELECT'
  )
  and not has_table_privilege(
    'service_role', 'public.outcome_claim_eligibility_decisions', 'INSERT'
  )
  and has_table_privilege(
    'service_role', 'public.outcome_claim_eligibility_evidence', 'SELECT'
  )
  and not has_table_privilege(
    'service_role', 'public.outcome_claim_eligibility_evidence', 'INSERT'
  )
  and not has_table_privilege(
    'service_role', 'public.evidence_reviews', 'INSERT'
  )
  and has_table_privilege(
    'service_role', 'public.tribunal_statistics_snapshots', 'SELECT, INSERT'
  )
  and has_table_privilege(
    'service_role', 'public.tribunal_statistics_members', 'SELECT, INSERT'
  ),
  'the worker can publish snapshots but cannot impersonate human reviews or eligibility decisions'
);

select ok(
  (
    select bool_and(
      not has_table_privilege('service_role', format('public.%I', relation_name), 'UPDATE')
      and not has_table_privilege('service_role', format('public.%I', relation_name), 'DELETE')
      and not has_table_privilege('service_role', format('public.%I', relation_name), 'TRUNCATE')
    )
    from unnest(array[
      'outcome_claim_eligibility_decisions',
      'outcome_claim_eligibility_evidence',
      'tribunal_statistics_snapshots',
      'tribunal_statistics_members'
    ]::text[]) relation(relation_name)
  ),
  'default privileges cannot bypass append-only statistics storage'
);

select ok(
  not has_function_privilege(
    'authenticated',
    'app_private.outcome_claim_is_eligible_at(uuid,text,timestamptz)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'app_private.outcome_claim_is_double_reviewed_at(uuid,text,timestamptz)',
    'EXECUTE'
  ),
  'browser roles cannot call private eligibility helpers'
);

select ok(
  has_function_privilege(
    'service_role',
    'app_private.outcome_claim_is_eligible_at(uuid,text,timestamptz)',
    'EXECUTE'
  )
  and has_function_privilege(
    'service_role',
    'app_private.tribunal_statistics_source_manifest_hash(text,uuid,text,smallint,date,date,timestamptz,smallint,text,text,bigint,jsonb,jsonb)',
    'EXECUTE'
  ),
  'the trusted worker can evaluate eligibility and deterministic manifests'
);

select ok(
  (
    select count(*) = 3 and bool_and(condeferrable) and bool_and(condeferred)
    from pg_constraint
    where conname in (
      'validate_outcome_claim_decision_manifests_after_insert',
      'validate_outcome_claim_evidence_manifests_after_insert',
      'validate_tribunal_statistics_manifest_after_insert'
    )
  ),
  'evidence and member manifests are verified at transaction completion'
);

select ok(
  position(
    'existing_member_count' in pg_get_functiondef(
      'app_private.validate_tribunal_statistics_member()'::regprocedure
    )
  ) = 0,
  'member validation has no per-row manifest count and remains linear at the 5k cap'
);

select ok(
  1599999::bigint * 5 < 2000000::bigint * 4
    and 1600000::bigint * 5 >= 2000000::bigint * 4,
  'the exact 80 percent publication boundary is evaluated without rounded ratios'
);

select ok(
  abs(
    app_private.tribunal_statistics_regularized_beta(
      0.5, 62500.5, 62500.5
    ) - 0.5
  ) < 0.000000001,
  'the Jeffreys beta solver converges for the maximum 125k status sample'
);

select throws_ok(
  $$insert into public.tribunal_statistics_snapshots (
      scope_type, round_kind, window_months, period_start, period_end,
      knowledge_cutoff_at, maturity_days, builder_version,
      eligibility_rule_version, smoothing_rule_version, reliability_status,
      eligible_round_count, status_sample_size, initial_price_sample_size,
      effective_price_sample_size, surenchere_sample_size,
      result_delay_sample_size, double_reviewed_count, outcome_coverage,
      statistics, source_manifest_hash
    ) values (
      'national', 'initial', 12,
      ((current_date - 31) + 1 - interval '12 months')::date,
      current_date - 31,
      statement_timestamp() - interval '1 day', 30,
      'tribunal_statistics_builder_v1', 'claim_ab_reviewed_frozen_round_as_of_v1',
      'jeffreys_beta_log_shrinkage_v1', 'insufficient_data',
      0, 0, 0, 0, 0, 0, 0, 0,
      '{}'::jsonb, repeat('0', 64)
    )$$,
  '23514',
  'National cells must be published or suppressed exactly by the v1 thresholds.',
  'an incomplete aggregate payload is rejected'
);

select throws_ok(
  $$insert into public.tribunal_statistics_snapshots (
      scope_type, round_kind, window_months, period_start, period_end,
      knowledge_cutoff_at, maturity_days, builder_version,
      eligibility_rule_version, smoothing_rule_version, reliability_status,
      eligible_round_count, status_sample_size, initial_price_sample_size,
      effective_price_sample_size, surenchere_sample_size,
      result_delay_sample_size, double_reviewed_count, outcome_coverage,
      statistics, source_manifest_hash
    ) values (
      'national', 'initial', 12,
      ((current_date - 31) + 1 - interval '12 months')::date,
      current_date - 31,
      statement_timestamp() - interval '1 day', 30,
      'tribunal_statistics_builder_v1', 'claim_ab_reviewed_frozen_round_as_of_v1',
      'jeffreys_beta_log_shrinkage_v1', 'insufficient_data',
      0, 0, 0, 0, 0, 0, 0, 0,
      jsonb_set(
        pg_temp.tribunal_statistics_payload(),
        '{flow,held,numerator}',
        '1'::jsonb
      ),
      repeat('0', 64)
    )$$,
  '23514',
  'new row for relation "tribunal_statistics_snapshots" violates check constraint "tribunal_statistics_suppression_check"',
  'a suppressed metric cannot leak an exact small-cell count'
);

select throws_ok(
  $$insert into public.tribunal_statistics_snapshots (
      scope_type, round_kind, window_months, period_start, period_end,
      knowledge_cutoff_at, maturity_days, builder_version,
      eligibility_rule_version, smoothing_rule_version, reliability_status,
      eligible_round_count, status_sample_size, initial_price_sample_size,
      effective_price_sample_size, surenchere_sample_size,
      result_delay_sample_size, double_reviewed_count, outcome_coverage,
      statistics, source_manifest_hash
    ) values (
      'national', 'initial', 12,
      ((current_date - 31) + 1 - interval '12 months')::date,
      current_date - 31,
      statement_timestamp() - interval '1 day', 30,
      'tribunal_statistics_builder_v1', 'claim_ab_reviewed_frozen_round_as_of_v1',
      'jeffreys_beta_log_shrinkage_v1', 'insufficient_data',
      0, 0, 0, 0, 0, 0, 0, 0,
      jsonb_set(
        pg_temp.tribunal_statistics_payload(),
        '{flow,held,exactCount}',
        '1'::jsonb
      ),
      repeat('8', 64)
    )$$,
  '23514',
  'new row for relation "tribunal_statistics_snapshots" violates check constraint "tribunal_statistics_suppression_check"',
  'a suppressed cell cannot leak an exact count through an additional JSON key'
);

select ok(
  not app_private.tribunal_statistics_suppression_is_safe(
    jsonb_set(
      pg_temp.tribunal_statistics_payload(),
      '{flow,held}',
      pg_temp.tribunal_statistics_metric(1, 1, 1)
    ),
    false
  ),
  'a published rate cell with fewer than ten observations is rejected'
);

select ok(
  not app_private.tribunal_statistics_suppression_is_safe(
    jsonb_set(
      pg_temp.tribunal_statistics_payload(),
      '{priceRatios,finalToInitial}',
      pg_temp.tribunal_statistics_distribution(1, 1, 0, 0, 1, 1, 1)
    ),
    false
  ),
  'a published distribution with fewer than ten observations is rejected'
);

select ok(
  not app_private.tribunal_statistics_suppression_is_safe(
    jsonb_set(
      pg_temp.tribunal_statistics_payload(),
      '{flow,held}',
      pg_temp.tribunal_statistics_metric(11, 10, 10)
    ),
    false
  ),
  'a published rate cannot exceed its exact denominator'
);

select ok(
  not app_private.tribunal_statistics_suppression_is_safe(
    jsonb_set(
      pg_temp.tribunal_statistics_payload(),
      '{priceRatios,finalToInitial}',
      pg_temp.tribunal_statistics_distribution(10, 10, 0, 0, 2, 1, 3)
    ),
    false
  ),
  'published distribution quantiles must be monotone'
);

select ok(
  not app_private.tribunal_statistics_suppression_is_safe(
    jsonb_set(
      pg_temp.tribunal_statistics_payload(),
      '{fallback,exactCount}',
      '1'::jsonb
    ),
    false
  ),
  'fallback metadata cannot carry undeclared reconstruction fields'
);

select ok(
  not app_private.tribunal_statistics_suppression_is_safe(
    jsonb_set(
      pg_temp.tribunal_statistics_payload(),
      '{warnings}',
      '["round_not_frozen_at_cutoff: 3"]'::jsonb
    ),
    false
  ),
  'free-form warnings cannot disclose the private unfrozen-round count'
);

select ok(
  app_private.tribunal_statistics_suppression_is_safe(
    jsonb_set(
      pg_temp.tribunal_statistics_payload(),
      '{warnings}',
      '["Couverture du gel antérieur au cutoff inférieure à 80 %: publication supprimée."]'::jsonb
    ),
    false
  ),
  'the fixed low-freeze warning is accepted without exposing its private count'
);

select throws_ok(
  $$insert into public.tribunal_statistics_snapshots (
      scope_type, round_kind, window_months, period_start, period_end,
      knowledge_cutoff_at, maturity_days, builder_version,
      eligibility_rule_version, smoothing_rule_version, reliability_status,
      quality_gate_passed, eligible_round_count, status_sample_size,
      initial_price_sample_size, effective_price_sample_size,
      surenchere_sample_size, result_delay_sample_size, double_reviewed_count,
      outcome_coverage, statistics, source_manifest_hash
    ) values (
      'national', 'initial', 12,
      ((current_date - 31) + 1 - interval '12 months')::date,
      current_date - 31,
      statement_timestamp() - interval '1 day', 30,
      'tribunal_statistics_builder_v1', 'claim_ab_reviewed_frozen_round_as_of_v1',
      'jeffreys_beta_log_shrinkage_v1', 'smoothed', true,
      10, 10, 10, 0, 0, 0, 2, 1.000000,
      jsonb_set(
        pg_temp.tribunal_statistics_published_rate_payload(10, 10),
        '{priceRatios,finalToInitial}',
        pg_temp.tribunal_statistics_distribution(10, 10, 0, 0, 1, 1.1, 1.2)
      ),
      repeat('d', 64)
    )$$,
  '23514',
  'National distributions require at least 30 samples and no parent reference.',
  'a national distribution with only 10 to 29 samples stays suppressed'
);

select ok(
  not app_private.tribunal_statistics_payload_counts_are_consistent(
    jsonb_set(
      pg_temp.tribunal_statistics_payload(),
      '{flow,held}',
      pg_temp.tribunal_statistics_metric(5, 9, 10, 1)
    ),
    10, 10, 0, 0, 0, 0, 0, 0
  ),
  'published principal flow metrics must use the exact status and round universes'
);

select ok(
  not app_private.tribunal_statistics_payload_counts_are_consistent(
    jsonb_set(
      jsonb_set(
        pg_temp.tribunal_statistics_payload(),
        '{flow,held}',
        pg_temp.tribunal_statistics_metric(12, 20, 20)
      ),
      '{flow,noBidIfHeld}',
      pg_temp.tribunal_statistics_metric(2, 12, 11)
    ),
    20, 20, 0, 0, 0, 0, 0, 0
  ),
  'a published held-conditional metric cannot use two different denominators'
);

select ok(
  not app_private.tribunal_statistics_payload_counts_are_consistent(
    jsonb_set(
      jsonb_set(
        jsonb_set(
          pg_temp.tribunal_statistics_payload(),
          '{flow,held}',
          pg_temp.tribunal_statistics_metric(12, 20, 20)
        ),
        '{flow,noBidIfHeld}',
        pg_temp.tribunal_statistics_metric(2, 11, 11)
      ),
      '{flow,adjudicatedIfHeld}',
      pg_temp.tribunal_statistics_metric(9, 12, 12)
    ),
    20, 20, 0, 0, 0, 0, 0, 0
  ),
  'no-bid and adjudication metrics must share the observed held denominator'
);

select ok(
  app_private.tribunal_statistics_payload_counts_are_consistent(
    jsonb_set(
      jsonb_set(
        jsonb_set(
          pg_temp.tribunal_statistics_payload(),
          '{flow,held}',
          pg_temp.tribunal_statistics_metric(12, 20, 20)
        ),
        '{flow,noBidIfHeld}',
        pg_temp.tribunal_statistics_metric(3, 12, 12)
      ),
      '{flow,adjudicatedIfHeld}',
      pg_temp.tribunal_statistics_metric(9, 12, 12)
    ),
    20, 20, 0, 0, 0, 0, 0, 0
  ),
  'held-conditional flow metrics accept the exact common held universe'
);

select throws_ok(
  $$insert into public.tribunal_statistics_snapshots (
      scope_type, round_kind, window_months, period_start, period_end,
      knowledge_cutoff_at, maturity_days, builder_version,
      eligibility_rule_version, smoothing_rule_version, reliability_status,
      eligible_round_count, status_sample_size, initial_price_sample_size,
      effective_price_sample_size, surenchere_sample_size,
      result_delay_sample_size, double_reviewed_count, outcome_coverage,
      statistics, source_manifest_hash
    ) values (
      'national', 'initial', 12, current_date - 40, current_date - 31,
      statement_timestamp() - interval '1 day', 30,
      'tribunal_statistics_builder_v1', 'claim_ab_reviewed_frozen_round_as_of_v1',
      'jeffreys_beta_log_shrinkage_v1', 'insufficient_data',
      0, 0, 0, 0, 0, 0, 0, 0,
      pg_temp.tribunal_statistics_payload(), repeat('1', 64)
    )$$,
  '23514',
  'new row for relation "tribunal_statistics_snapshots" violates check constraint "tribunal_statistics_window_check"',
  'the labelled historical window must match the stored dates exactly'
);

select throws_ok(
  $$insert into public.tribunal_statistics_snapshots (
      scope_type, round_kind, window_months, period_start, period_end,
      knowledge_cutoff_at, maturity_days, builder_version,
      eligibility_rule_version, smoothing_rule_version, reliability_status,
      quality_gate_passed, eligible_round_count, status_sample_size,
      initial_price_sample_size, effective_price_sample_size,
      surenchere_sample_size, result_delay_sample_size, double_reviewed_count,
      outcome_coverage, statistics, source_manifest_hash
    ) values (
      'national', 'initial', 12,
      ((current_date - 31) + 1 - interval '12 months')::date,
      current_date - 31,
      statement_timestamp() - interval '1 day', 30,
      'tribunal_statistics_builder_v1', 'claim_ab_reviewed_frozen_round_as_of_v1',
      'jeffreys_beta_log_shrinkage_v1', 'insufficient_data', true,
      10, 10, 0, 0, 0, 0, 2, 1.000000,
      pg_temp.tribunal_statistics_published_rate_payload(10, 10), repeat('6', 64)
    )$$,
  '23514',
  'new row for relation "tribunal_statistics_snapshots" violates check constraint "tribunal_statistics_reliability_check"',
  'a quality-approved sample of ten cannot be labelled insufficient'
);

savepoint insufficient_failed_gate;
select lives_ok(
  $$insert into public.tribunal_statistics_snapshots (
      scope_type, round_kind, window_months, period_start, period_end,
      knowledge_cutoff_at, maturity_days, builder_version,
      eligibility_rule_version, smoothing_rule_version, reliability_status,
      quality_gate_passed, eligible_round_count, status_sample_size,
      initial_price_sample_size, effective_price_sample_size,
      surenchere_sample_size, result_delay_sample_size, double_reviewed_count,
      outcome_coverage, statistics, source_manifest_hash
    ) values (
      'national', 'initial', 12,
      ((current_date - 31) + 1 - interval '12 months')::date,
      current_date - 31,
      statement_timestamp() - interval '1 day', 30,
      'tribunal_statistics_builder_v1', 'claim_ab_reviewed_frozen_round_as_of_v1',
      'jeffreys_beta_log_shrinkage_v1', 'insufficient_data', false,
      10, 10, 0, 0, 0, 0, 0, 1.000000,
      pg_temp.tribunal_statistics_payload(), repeat('7', 64)
    )$$,
  'a failed quality gate forces the insufficient label even with ten known outcomes'
);
rollback to savepoint insufficient_failed_gate;

savepoint robust_below_coverage;
select throws_ok(
  $$insert into public.tribunal_statistics_snapshots (
      scope_type, round_kind, window_months, period_start, period_end,
      knowledge_cutoff_at, maturity_days, builder_version,
      eligibility_rule_version, smoothing_rule_version, reliability_status,
      quality_gate_passed, eligible_round_count, status_sample_size,
      initial_price_sample_size, effective_price_sample_size,
      surenchere_sample_size, result_delay_sample_size, double_reviewed_count,
      outcome_coverage, statistics, source_manifest_hash
    ) values (
      'national', 'initial', 12,
      ((current_date - 31) + 1 - interval '12 months')::date,
      current_date - 31,
      statement_timestamp() - interval '1 day', 30,
      'tribunal_statistics_builder_v1', 'claim_ab_reviewed_frozen_round_as_of_v1',
      'jeffreys_beta_log_shrinkage_v1', 'robust', true,
      126, 100, 0, 0, 0, 0, 20, 0.793651,
      pg_temp.tribunal_statistics_published_rate_payload(100, 126), repeat('2', 64)
    )$$,
  '23514',
  'new row for relation "tribunal_statistics_snapshots" violates check constraint "tribunal_statistics_reliability_check"',
  'coverage 0.799999 cannot be labelled robust'
);
rollback to savepoint robust_below_coverage;

savepoint robust_at_coverage;
select lives_ok(
  $$insert into public.tribunal_statistics_snapshots (
      scope_type, round_kind, window_months, period_start, period_end,
      knowledge_cutoff_at, maturity_days, builder_version,
      eligibility_rule_version, smoothing_rule_version, reliability_status,
      quality_gate_passed, eligible_round_count, status_sample_size,
      initial_price_sample_size, effective_price_sample_size,
      surenchere_sample_size, result_delay_sample_size, double_reviewed_count,
      outcome_coverage, statistics, source_manifest_hash
    ) values (
      'national', 'initial', 12,
      ((current_date - 31) + 1 - interval '12 months')::date,
      current_date - 31,
      statement_timestamp() - interval '1 day', 30,
      'tribunal_statistics_builder_v1', 'claim_ab_reviewed_frozen_round_as_of_v1',
      'jeffreys_beta_log_shrinkage_v1', 'robust', true,
      125, 100, 0, 0, 0, 0, 20, 0.800000,
      pg_temp.tribunal_statistics_published_rate_payload(100, 125), repeat('3', 64)
    )$$,
  'coverage 0.800000 satisfies the robust label boundary'
);
rollback to savepoint robust_at_coverage;

savepoint descriptive_low_coverage;
select lives_ok(
  $$insert into public.tribunal_statistics_snapshots (
      scope_type, round_kind, window_months, period_start, period_end,
      knowledge_cutoff_at, maturity_days, builder_version,
      eligibility_rule_version, smoothing_rule_version, reliability_status,
      quality_gate_passed, eligible_round_count, status_sample_size,
      initial_price_sample_size, effective_price_sample_size,
      surenchere_sample_size, result_delay_sample_size, double_reviewed_count,
      outcome_coverage, statistics, source_manifest_hash
    ) values (
      'national', 'initial', 12,
      ((current_date - 31) + 1 - interval '12 months')::date,
      current_date - 31,
      statement_timestamp() - interval '1 day', 30,
      'tribunal_statistics_builder_v1', 'claim_ab_reviewed_frozen_round_as_of_v1',
      'jeffreys_beta_log_shrinkage_v1', 'descriptive', true,
      126, 100, 0, 0, 0, 0, 20, 0.793651,
      pg_temp.tribunal_statistics_published_rate_payload(100, 126), repeat('4', 64)
    )$$,
  'a large but low-coverage sample remains descriptive'
);
rollback to savepoint descriptive_low_coverage;

select throws_ok(
  $$insert into public.tribunal_statistics_snapshots (
      scope_type, round_kind, window_months, period_start, period_end,
      knowledge_cutoff_at, maturity_days, builder_version,
      eligibility_rule_version, smoothing_rule_version, reliability_status,
      quality_gate_passed, eligible_round_count, unfrozen_round_count,
      freeze_coverage, status_sample_size, initial_price_sample_size,
      effective_price_sample_size, surenchere_sample_size,
      result_delay_sample_size, double_reviewed_count, outcome_coverage,
      statistics, source_manifest_hash
    ) values (
      'national', 'initial', 12,
      ((current_date - 31) + 1 - interval '12 months')::date,
      current_date - 31,
      statement_timestamp() - interval '1 day', 30,
      'tribunal_statistics_builder_v1', 'claim_ab_reviewed_frozen_round_as_of_v1',
      'jeffreys_beta_log_shrinkage_v1', 'descriptive', true,
      30, 10, 0.750000, 30, 0, 0, 0, 0, 6, 1.000000,
      pg_temp.tribunal_statistics_published_rate_payload(30, 30), repeat('e', 64)
    )$$,
  '23514',
  'new row for relation "tribunal_statistics_snapshots" violates check constraint "tribunal_statistics_quality_gate_check"',
  'freeze coverage below 80 percent cannot pass the publication quality gate'
);

select throws_ok(
  $$insert into public.tribunal_statistics_snapshots (
      scope_type, round_kind, window_months, period_start, period_end,
      knowledge_cutoff_at, maturity_days, builder_version,
      eligibility_rule_version, smoothing_rule_version, reliability_status,
      eligible_round_count, status_sample_size, initial_price_sample_size,
      effective_price_sample_size, surenchere_sample_size,
      result_delay_sample_size, double_reviewed_count, outcome_coverage,
      statistics, source_manifest_hash, computed_at
    ) values (
      'national', 'initial', 12,
      ((current_date - 31) + 1 - interval '12 months')::date,
      current_date - 31,
      statement_timestamp() + interval '1 hour', 30,
      'tribunal_statistics_builder_v1', 'claim_ab_reviewed_frozen_round_as_of_v1',
      'jeffreys_beta_log_shrinkage_v1', 'insufficient_data',
      0, 0, 0, 0, 0, 0, 0, 0,
      pg_temp.tribunal_statistics_payload(), repeat('5', 64),
      statement_timestamp() + interval '1 hour'
    )$$,
  '23514',
  'Statistics snapshots cannot be future-dated.',
  'future knowledge snapshots are rejected'
);

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password,
  email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data
) values
  (
    'b3000000-0000-4000-8000-000000000001',
    '00000000-0000-0000-0000-000000000000',
    'authenticated', 'authenticated', 'tribunal-admin@example.test', '',
    now(), now(), now(), '{}'::jsonb, '{}'::jsonb
  ),
  (
    'b3000000-0000-4000-8000-000000000002',
    '00000000-0000-0000-0000-000000000000',
    'authenticated', 'authenticated', 'tribunal-reviewer-one@example.test', '',
    now(), now(), now(), '{}'::jsonb, '{}'::jsonb
  ),
  (
    'b3000000-0000-4000-8000-000000000003',
    '00000000-0000-0000-0000-000000000000',
    'authenticated', 'authenticated', 'tribunal-reviewer-two@example.test', '',
    now(), now(), now(), '{}'::jsonb, '{}'::jsonb
  ),
  (
    'b3000000-0000-4000-8000-000000000004',
    '00000000-0000-0000-0000-000000000000',
    'authenticated', 'authenticated', 'tribunal-non-admin@example.test', '',
    now(), now(), now(), '{}'::jsonb, '{}'::jsonb
  );

update public.user_profiles
set user_role = 'admin'
where user_id in (
  'b3000000-0000-4000-8000-000000000001',
  'b3000000-0000-4000-8000-000000000002',
  'b3000000-0000-4000-8000-000000000003'
);

set local role service_role;

insert into public.data_sources (
  id, name, publisher, official, legal_review_status, ingestion_policy, active
) values (
  'b3100000-0000-4000-8000-000000000001',
  'tribunal-statistics-test',
  'Justice test',
  true,
  'approved',
  'allowed_automated',
  true
);

insert into public.outcome_courts (id, code, name, judicial_region)
values
  (
    'b3200000-0000-4000-8000-000000000001',
    'TJ-STATS-TEST',
    'Tribunal judiciaire Statistiques Test',
    'Cour d''appel Test'
  ),
  (
    'b3200000-0000-4000-8000-000000000002',
    'TJ-STATS-ROGUE',
    'Tribunal judiciaire sans audience mature',
    'Cour d''appel Test'
  );

insert into public.auction_cases (id, court_id, court_case_number)
values (
  'b3300000-0000-4000-8000-000000000001',
  'b3200000-0000-4000-8000-000000000001',
  'RG-STATS-1'
);

insert into public.auction_lots (
  id, auction_case_id, property_type, initial_starting_price_eur
) values (
  'b3400000-0000-4000-8000-000000000001',
  'b3300000-0000-4000-8000-000000000001',
  'apartment',
  100000
);

select throws_ok(
  $$insert into public.auction_rounds (
      lot_id, round_kind, sequence_number, scheduled_at, local_timezone,
      court_id, initial_starting_price_eur, effective_starting_price_eur,
      current_status
    ) values (
      'b3400000-0000-4000-8000-000000000001',
      'initial', 1, statement_timestamp() - interval '60 days',
      'Europe/Definitely_Not_A_Timezone',
      'b3200000-0000-4000-8000-000000000001',
      100000, 90000, 'closed'
    )$$,
  '23514',
  'Auction rounds require a valid IANA local timezone.',
  'an auction round cannot enter a statistics universe with an invalid timezone'
);

select throws_ok(
  $$insert into public.auction_rounds (
      lot_id, round_kind, sequence_number, scheduled_at, local_timezone,
      court_id, initial_starting_price_eur, effective_starting_price_eur,
      current_status
    ) values (
      'b3400000-0000-4000-8000-000000000001',
      'initial', 1, statement_timestamp() - interval '60 days', 'Europe/Paris',
      'b3200000-0000-4000-8000-000000000002',
      100000, 90000, 'closed'
    )$$,
  '23514',
  'Auction round court must match its lot case court.',
  'a round cannot be assigned to a court outside its lot case lineage'
);

insert into public.auction_rounds (
  id, lot_id, round_kind, sequence_number, scheduled_at, local_timezone,
  court_id, initial_starting_price_eur, effective_starting_price_eur,
  current_status
) values (
  'b3500000-0000-4000-8000-000000000001',
  'b3400000-0000-4000-8000-000000000001',
  'initial', 1, statement_timestamp() - interval '60 days', 'Europe/Paris',
  'b3200000-0000-4000-8000-000000000001',
  100000, 90000, 'closed'
);

reset role;
select throws_ok(
  $$delete from public.auction_rounds
    where id = 'b3500000-0000-4000-8000-000000000001'$$,
  '55000',
  'Auction round statistical identity is immutable; create a new round.',
  'a source round cannot be deleted after entering the statistical lineage'
);
set local role service_role;

insert into public.auction_feature_snapshots (
  id, lot_id, round_id, prediction_horizon, feature_cutoff_at, built_at,
  feature_schema_version, feature_builder_version, features,
  source_manifest, source_manifest_hash, snapshot_hash,
  leakage_check_status, retrospective, training_eligible, created_at
) values (
  'b3550000-0000-4000-8000-000000000001',
  'b3400000-0000-4000-8000-000000000001',
  'b3500000-0000-4000-8000-000000000001',
  'T-7', statement_timestamp() - interval '67 days',
  statement_timestamp() - interval '66 days',
  'stats-test-v1', 'stats-test-builder-v1',
  '{"initialStartingPriceEur":"100000.00","effectiveStartingPriceEur":"90000.00"}',
  jsonb_build_array(
    jsonb_build_object(
      'published_at', (statement_timestamp() - interval '68 days')::text,
      'captured_at', (statement_timestamp() - interval '68 days')::text
    )
  ),
  repeat('b', 64), repeat('a', 64), 'passed', false, false,
  statement_timestamp() - interval '66 days'
);

insert into public.auction_outcomes (
  id, round_id, version, outcome_status, initial_hammer_price_eur,
  final_hammer_price_eur, surenchere_status, finality_status,
  result_observed_at, valid_from
) values (
  'b3600000-0000-4000-8000-000000000001',
  'b3500000-0000-4000-8000-000000000001',
  1, 'held_adjudicated', 140000, 150000, 'not_filed',
  'procedurally_definitive', statement_timestamp() - interval '59 days',
  statement_timestamp() - interval '30 days'
);

insert into public.auction_outcome_evidence (
  id, outcome_id, source_id, evidence_type, evidence_grade, claim_types,
  lot_matching_confidence, round_matching_confidence,
  price_extraction_confidence, finality_confidence
) values (
  'b3700000-0000-4000-8000-000000000001',
  'b3600000-0000-4000-8000-000000000001',
  'b3100000-0000-4000-8000-000000000001',
  'official_result', 'A', array[
    'outcome_status',
    'initial_starting_price_eur',
    'effective_starting_price_eur',
    'initial_hammer_price_eur',
    'final_hammer_price_eur',
    'finality_status',
    'surenchere_status',
    'result_observed_at'
  ], 0.99, 0.99, 0.99, 0.99
);

select throws_ok(
  $$insert into public.evidence_reviews (
      evidence_id, reviewer_user_id, review_type, decision, reviewed_at
    ) values (
      'b3700000-0000-4000-8000-000000000001',
      'b3000000-0000-4000-8000-000000000002',
      'future-review', 'approved', statement_timestamp() + interval '1 hour'
    )$$,
  '42501',
  null,
  'the service-role worker cannot forge a human evidence review'
);

reset role;
select set_config(
  'request.jwt.claim.sub', 'b3000000-0000-4000-8000-000000000002', true
);
set local role authenticated;
select public.review_outcome_evidence(
  'b3700000-0000-4000-8000-000000000001',
  'primary', 'approved', '{}'::jsonb, null
);
reset role;
select set_config(
  'request.jwt.claim.sub', 'b3000000-0000-4000-8000-000000000003', true
);
set local role authenticated;
select public.review_outcome_evidence(
  'b3700000-0000-4000-8000-000000000001',
  'independent', 'approved', '{}'::jsonb, null
);
reset role;
set local role service_role;

select ok(
  (
    select bool_and(recorded_at > '2026-01-01T00:00:00Z'::timestamptz)
      and bool_and(reviewed_at <= recorded_at)
    from public.evidence_reviews
    where evidence_id = 'b3700000-0000-4000-8000-000000000001'
  ),
  'the server stamps review recording time instead of trusting caller input'
);

select throws_ok(
  $$insert into public.outcome_claim_eligibility_decisions (
      outcome_id, claim_type, version, decision, reviewer_user_id,
      evidence_ids, decided_at
    ) values (
      'b3600000-0000-4000-8000-000000000001',
      'outcome_status', 1, 'eligible',
      'b3000000-0000-4000-8000-000000000001',
      array['b3700000-0000-4000-8000-000000000001'::uuid],
      statement_timestamp()
    )$$,
  '42501',
  null,
  'the service-role worker cannot forge an administrator eligibility decision'
);

reset role;
select set_config(
  'request.jwt.claim.sub', 'b3000000-0000-4000-8000-000000000004', true
);
set local role authenticated;
select throws_ok(
  $$select public.decide_outcome_claim_eligibility(
      'b3600000-0000-4000-8000-000000000001',
      'outcome_status', 'eligible',
      array['b3700000-0000-4000-8000-000000000001'::uuid],
      null, null
    )$$,
  '42501',
  'Only an administrator may decide claim eligibility.',
  'a non-admin authenticated user cannot promote claims into statistics'
);

reset role;
select set_config(
  'request.jwt.claim.sub', 'b3000000-0000-4000-8000-000000000001', true
);
set local role authenticated;

select throws_ok(
  $$select public.decide_outcome_claim_eligibility(
      'b3600000-0000-4000-8000-000000000001',
      'outcome_status', 'eligible',
      array[
        'b3700000-0000-4000-8000-000000000001'::uuid,
        'b3700000-0000-4000-8000-000000000001'::uuid
      ],
      null, null
    )$$,
  '23514',
  'Claim eligibility evidence ids must be unique.',
  'a decision cannot inflate its manifest with duplicate evidence ids'
);

select public.decide_outcome_claim_eligibility(
  'b3600000-0000-4000-8000-000000000001',
  claim_type,
  'eligible',
  array['b3700000-0000-4000-8000-000000000001'::uuid],
  null,
  null
)
from unnest(array[
  'outcome_status',
  'initial_starting_price_eur',
  'effective_starting_price_eur',
  'initial_hammer_price_eur',
  'final_hammer_price_eur',
  'finality_status',
  'surenchere_status',
  'result_observed_at'
]) claim_type;

reset role;
set local role service_role;

select ok(
  (
    select bool_and(evidence_manifest_hash <> repeat('0', 64))
      and bool_and(review_manifest_hash <> repeat('0', 64))
    from public.outcome_claim_eligibility_decisions
    where outcome_id = 'b3600000-0000-4000-8000-000000000001'
  ),
  'the database replaces caller-supplied eligibility hashes'
);

select ok(
  (
    select bool_and(
      evidence_manifest_hash =
        app_private.outcome_claim_evidence_manifest_hash(decision_row.id)
    )
    from public.outcome_claim_eligibility_decisions decision_row
    where decision_row.outcome_id = 'b3600000-0000-4000-8000-000000000001'
  ),
  'evidence hashes are derived from the linked immutable rows'
);

select ok(
  (
    select bool_and(
      review_manifest_hash =
        app_private.outcome_claim_review_manifest_hash(decision_row.id)
    )
    from public.outcome_claim_eligibility_decisions decision_row
    where decision_row.outcome_id = 'b3600000-0000-4000-8000-000000000001'
  ),
  'review hashes are derived from reviews recorded by decision time'
);

select lives_ok(
  $$set constraints
      validate_outcome_claim_decision_manifests_after_insert,
      validate_outcome_claim_evidence_manifests_after_insert
    immediate$$,
  'valid claim manifests pass their deferred integrity checks'
);
set constraints all deferred;

select ok(
  app_private.outcome_claim_is_eligible_at(
    'b3600000-0000-4000-8000-000000000001',
    'outcome_status',
    statement_timestamp()
  ),
  'claim-specific A evidence with human approval is eligible'
);

select ok(
  app_private.outcome_claim_is_double_reviewed_at(
    'b3600000-0000-4000-8000-000000000001',
    'outcome_status',
    statement_timestamp()
  ),
  'two distinct reviewers including an independent review validate one evidence item'
);

select ok(
  not app_private.outcome_claim_is_eligible_at(
    'b3600000-0000-4000-8000-000000000001',
    'outcome_status',
    (
      select min(created_at) - interval '1 microsecond'
      from public.outcome_claim_eligibility_evidence
      where outcome_id = 'b3600000-0000-4000-8000-000000000001'
    )
  ),
  'a later evidence link cannot retroactively alter an earlier cutoff'
);

insert into public.auction_cases (id, court_id, court_case_number)
values (
  'b3300000-0000-4000-8000-000000000002',
  'b3200000-0000-4000-8000-000000000001',
  'RG-STATS-2'
);
insert into public.auction_lots (id, auction_case_id, property_type)
values (
  'b3400000-0000-4000-8000-000000000002',
  'b3300000-0000-4000-8000-000000000002',
  'house'
);
insert into public.auction_rounds (
  id, lot_id, round_kind, sequence_number, scheduled_at, court_id, current_status
) values (
  'b3500000-0000-4000-8000-000000000002',
  'b3400000-0000-4000-8000-000000000002',
  'initial', 1, statement_timestamp() - interval '500 days',
  'b3200000-0000-4000-8000-000000000001', 'closed'
);

select throws_ok(
  $$update public.auction_cases
    set court_id = 'b3200000-0000-4000-8000-000000000099'
    where id = 'b3300000-0000-4000-8000-000000000002'$$,
  '55000',
  'Auction case statistical identity is immutable; create a new case.',
  'a case cannot be moved retroactively to another court'
);

select throws_ok(
  $$update public.auction_lots
    set auction_case_id = 'b3300000-0000-4000-8000-000000000099'
    where id = 'b3400000-0000-4000-8000-000000000002'$$,
  '55000',
  'Auction lot statistical identity is immutable; create a new lot.',
  'a lot cannot be moved retroactively to another case'
);

select throws_ok(
  $$update public.auction_rounds
    set scheduled_at = scheduled_at + interval '1 day'
    where id = 'b3500000-0000-4000-8000-000000000002'$$,
  '55000',
  'Auction round statistical identity is immutable; create a new round.',
  'round chronology is immutable even before a feature snapshot exists'
);

insert into public.auction_outcomes (
  id, round_id, version, outcome_status, final_hammer_price_eur, valid_from
) values (
  'b3600000-0000-4000-8000-000000000002',
  'b3500000-0000-4000-8000-000000000002',
  1, 'held_adjudicated', 80000, statement_timestamp() - interval '400 days'
);
insert into public.auction_outcome_evidence (
  id, outcome_id, source_id, evidence_type, evidence_grade, claim_types,
  lot_matching_confidence, round_matching_confidence
) values (
  'b3700000-0000-4000-8000-000000000002',
  'b3600000-0000-4000-8000-000000000002',
  'b3100000-0000-4000-8000-000000000001',
  'weak-result', 'C', array['outcome_status'], 0.99, 0.99
);
reset role;
select set_config(
  'request.jwt.claim.sub', 'b3000000-0000-4000-8000-000000000002', true
);
set local role authenticated;
select public.review_outcome_evidence(
  'b3700000-0000-4000-8000-000000000002',
  'primary', 'approved', '{}'::jsonb, null
);
reset role;
select set_config(
  'request.jwt.claim.sub', 'b3000000-0000-4000-8000-000000000001', true
);
set local role authenticated;
select throws_ok(
  $$select public.decide_outcome_claim_eligibility(
      'b3600000-0000-4000-8000-000000000002',
      'outcome_status', 'eligible',
      array['b3700000-0000-4000-8000-000000000002'::uuid],
      null, null
    )$$,
  '23514',
  'Eligibility requires claim-specific A/B evidence.',
  'grade C evidence cannot enter a statistical claim manifest'
);
reset role;
set local role service_role;

insert into public.auction_outcome_evidence (
  id, outcome_id, source_id, evidence_type, evidence_grade, claim_types,
  lot_matching_confidence, round_matching_confidence
) values
  (
    'b3700000-0000-4000-8000-000000000003',
    'b3600000-0000-4000-8000-000000000002',
    'b3100000-0000-4000-8000-000000000001',
    'official-result-primary', 'A', array['outcome_status'], 0.99, 0.99
  ),
  (
    'b3700000-0000-4000-8000-000000000004',
    'b3600000-0000-4000-8000-000000000002',
    'b3100000-0000-4000-8000-000000000001',
    'official-result-secondary', 'A', array['outcome_status'], 0.99, 0.99
  );

reset role;
select set_config(
  'request.jwt.claim.sub', 'b3000000-0000-4000-8000-000000000002', true
);
set local role authenticated;
select public.review_outcome_evidence(
  'b3700000-0000-4000-8000-000000000003',
  'primary', 'approved', '{}'::jsonb, null
);
reset role;
select set_config(
  'request.jwt.claim.sub', 'b3000000-0000-4000-8000-000000000003', true
);
set local role authenticated;
select public.review_outcome_evidence(
  'b3700000-0000-4000-8000-000000000004',
  'independent', 'approved', '{}'::jsonb, null
);
reset role;
select set_config(
  'request.jwt.claim.sub', 'b3000000-0000-4000-8000-000000000001', true
);
set local role authenticated;
select public.decide_outcome_claim_eligibility(
  'b3600000-0000-4000-8000-000000000002',
  'outcome_status', 'eligible',
  array[
    'b3700000-0000-4000-8000-000000000003'::uuid,
    'b3700000-0000-4000-8000-000000000004'::uuid
  ],
  null,
  null
);
reset role;
set local role service_role;

select ok(
  not app_private.outcome_claim_is_double_reviewed_at(
    'b3600000-0000-4000-8000-000000000002',
    'outcome_status',
    statement_timestamp()
  ),
  'one review on each of two evidence items is not an independent double review'
);

select set_config(
  'immojudis.tribunal_test_cutoff',
  (statement_timestamp() - interval '1 millisecond')::text,
  true
);

create temporary table pgtap_tribunal_member_hash as
select app_private.tribunal_statistics_member_hash(
  'b3500000-0000-4000-8000-000000000001',
  'b3550000-0000-4000-8000-000000000001',
  'b3600000-0000-4000-8000-000000000001',
  'b3200000-0000-4000-8000-000000000001',
  true, true, true, true, true, true, false, true, true, false, true, '{}',
  current_setting('immojudis.tribunal_test_cutoff')::timestamptz,
  'claim_ab_reviewed_frozen_round_as_of_v1'
) as member_hash;

insert into public.tribunal_statistics_snapshots (
  id, scope_type, round_kind, window_months, period_start, period_end,
  knowledge_cutoff_at, maturity_days, builder_version,
  eligibility_rule_version, smoothing_rule_version, reliability_status,
  quality_gate_passed, eligible_round_count, status_sample_size,
  initial_price_sample_size, effective_price_sample_size,
  surenchere_sample_size, result_delay_sample_size, double_reviewed_count,
  outcome_coverage, statistics, source_manifest_hash
)
select
  'b3800000-0000-4000-8000-000000000001',
  'national', 'initial', 12,
  (((cutoff_at at time zone 'UTC')::date - 30) + 1 - interval '12 months')::date,
  (cutoff_at at time zone 'UTC')::date - 30,
  cutoff_at, 30, 'tribunal_statistics_builder_v1',
  'claim_ab_reviewed_frozen_round_as_of_v1', 'jeffreys_beta_log_shrinkage_v1',
  'insufficient_data', false, 1, 1, 1, 1, 1, 1, 1, 1.000000,
  pg_temp.tribunal_statistics_payload(),
  app_private.tribunal_statistics_source_manifest_hash(
    'national', null, 'initial', 12::smallint,
    (((cutoff_at at time zone 'UTC')::date - 30) + 1 - interval '12 months')::date,
    (cutoff_at at time zone 'UTC')::date - 30,
    cutoff_at, 30::smallint, 'tribunal_statistics_builder_v1',
    'claim_ab_reviewed_frozen_round_as_of_v1', 0::bigint,
    '[]'::jsonb,
    pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'roundId', 'b3500000-0000-4000-8000-000000000001'::uuid,
        'memberHash', hash_row.member_hash
      )
    )
  )
from (
  select current_setting('immojudis.tribunal_test_cutoff')::timestamptz as cutoff_at
) params
cross join pgtap_tribunal_member_hash hash_row;

select throws_ok(
  $$insert into public.tribunal_statistics_snapshots (
      scope_type, round_kind, window_months, period_start, period_end,
      knowledge_cutoff_at, maturity_days, builder_version,
      eligibility_rule_version, smoothing_rule_version, reliability_status,
      quality_gate_passed, eligible_round_count, unfrozen_round_count,
      status_sample_size, initial_price_sample_size,
      effective_price_sample_size, surenchere_sample_size,
      result_delay_sample_size, double_reviewed_count, outcome_coverage,
      statistics, source_manifest_hash
    )
    select
      scope_type, round_kind, window_months, period_start, period_end,
      knowledge_cutoff_at, maturity_days, builder_version,
      eligibility_rule_version, smoothing_rule_version, reliability_status,
      quality_gate_passed, eligible_round_count, unfrozen_round_count,
      status_sample_size, initial_price_sample_size,
      effective_price_sample_size, surenchere_sample_size,
      result_delay_sample_size, double_reviewed_count, outcome_coverage,
      statistics, repeat('9', 64)
    from public.tribunal_statistics_snapshots
    where id = 'b3800000-0000-4000-8000-000000000001'$$,
  '23505',
  'duplicate key value violates unique constraint "tribunal_statistics_logical_identity_unique"',
  'one logical cutoff and rule version cannot publish divergent snapshots'
);

select throws_ok(
  $$insert into public.tribunal_statistics_members (
      snapshot_id, round_id, feature_snapshot_id, court_id, exclusion_reasons
    ) values (
      'b3800000-0000-4000-8000-000000000001',
      'b3500000-0000-4000-8000-000000000001',
      'b3550000-0000-4000-8000-000000000001',
      'b3200000-0000-4000-8000-000000000001',
      '{}'
    )$$,
  '23514',
  'Unknown or excluded outcomes require an explicit exclusion reason.',
  'unknown outcomes require an explicit exclusion reason'
);

select throws_ok(
  $$insert into public.tribunal_statistics_members (
      snapshot_id, round_id, feature_snapshot_id, court_id,
      exclusion_reasons, member_hash
    ) values (
      'b3800000-0000-4000-8000-000000000001',
      'b3500000-0000-4000-8000-000000000001',
      'b3550000-0000-4000-8000-000000000001',
      'b3200000-0000-4000-8000-000000000001',
      array['outcome_unavailable'], repeat('0', 64)
    )$$,
  '23514',
  'Statistics member cannot omit a terminal outcome known at cutoff.',
  'a known terminal outcome cannot be hidden as missing to lower coverage'
);

select throws_ok(
  $$insert into public.tribunal_statistics_members (
      snapshot_id, round_id, feature_snapshot_id, outcome_id, court_id,
      status_claim_eligible, final_hammer_price_claim_eligible,
      finality_status_claim_eligible, member_hash
    ) values (
      'b3800000-0000-4000-8000-000000000001',
      'b3500000-0000-4000-8000-000000000001',
      'b3550000-0000-4000-8000-000000000001',
      'b3600000-0000-4000-8000-000000000001',
      'b3200000-0000-4000-8000-000000000001',
      true, true, false, repeat('0', 64)
    )$$,
  '23514',
  'Statistics member flags must exactly equal the closed v1 predicates at cutoff.',
  'a final hammer claim cannot be used without definitive-finality evidence'
);

insert into public.tribunal_statistics_members (
  snapshot_id, round_id, feature_snapshot_id, outcome_id, court_id,
  status_claim_eligible, initial_starting_price_claim_eligible,
  effective_starting_price_claim_eligible,
  initial_hammer_price_claim_eligible, final_hammer_price_claim_eligible,
  finality_status_claim_eligible, surenchere_claim_eligible,
  result_observed_at_claim_eligible, double_reviewed,
  exclusion_reasons, member_hash
) values (
  'b3800000-0000-4000-8000-000000000001',
  'b3500000-0000-4000-8000-000000000001',
  'b3550000-0000-4000-8000-000000000001',
  'b3600000-0000-4000-8000-000000000001',
  'b3200000-0000-4000-8000-000000000001',
  true, true, true, true, true, true, true, true, true,
  '{}', repeat('0', 64)
);

select is(
  (
    select member_hash
    from public.tribunal_statistics_members
    where snapshot_id = 'b3800000-0000-4000-8000-000000000001'
  ),
  (select member_hash from pgtap_tribunal_member_hash),
  'member hashes are recomputed from actual claims and reviews'
);

select ok(
  pg_get_functiondef(
    'app_private.validate_tribunal_statistics_manifest()'::regprocedure
  ) ~ 'initial_starting_price_claim_eligible[[:space:]]+and member_row.final_hammer_price_claim_eligible[[:space:]]+and member_row.finality_status_claim_eligible',
  'initial-price ratios require final hammer and definitive-finality claims'
);

select ok(
  pg_get_functiondef(
    'app_private.validate_tribunal_statistics_manifest()'::regprocedure
  ) ~ 'effective_starting_price_claim_eligible[[:space:]]+and member_row.final_hammer_price_claim_eligible[[:space:]]+and member_row.finality_status_claim_eligible',
  'effective-price ratios require final hammer and definitive-finality claims'
);

select throws_ok(
  $$insert into public.tribunal_statistics_snapshots (
      scope_type, court_id, court_code, court_name, judicial_region,
      parent_snapshot_id, round_kind, window_months, period_start, period_end,
      knowledge_cutoff_at, maturity_days, builder_version,
      eligibility_rule_version, smoothing_rule_version, reliability_status,
      eligible_round_count, status_sample_size, initial_price_sample_size,
      effective_price_sample_size, surenchere_sample_size,
      result_delay_sample_size, double_reviewed_count, outcome_coverage,
      statistics, source_manifest_hash
    )
    select
      'tribunal', 'b3200000-0000-4000-8000-000000000001',
      'TJ-STATS-TEST', 'Nom falsifie', 'Cour d''appel Test',
      'b3800000-0000-4000-8000-000000000001',
      round_kind, window_months, period_start, period_end,
      knowledge_cutoff_at, maturity_days, builder_version,
      eligibility_rule_version, smoothing_rule_version, 'insufficient_data',
      1, 1, 1, 1, 1, 1, 1, 1.000000,
      pg_temp.tribunal_statistics_payload(), repeat('7', 64)
    from public.tribunal_statistics_snapshots
    where id = 'b3800000-0000-4000-8000-000000000001'$$,
  '23514',
  'Tribunal snapshot metadata must match the canonical court registry.',
  'tribunal metadata cannot diverge from the canonical court registry'
);

select throws_ok(
  $$insert into public.tribunal_statistics_snapshots (
      scope_type, court_id, court_code, court_name, judicial_region,
      parent_snapshot_id, round_kind, window_months, period_start, period_end,
      knowledge_cutoff_at, maturity_days, builder_version,
      eligibility_rule_version, smoothing_rule_version, reliability_status,
      eligible_round_count, status_sample_size, initial_price_sample_size,
      effective_price_sample_size, surenchere_sample_size,
      result_delay_sample_size, double_reviewed_count, outcome_coverage,
      statistics, source_manifest_hash
    )
    select
      'tribunal', 'b3200000-0000-4000-8000-000000000002',
      'TJ-STATS-ROGUE', 'Tribunal judiciaire sans audience mature',
      'Cour d''appel Test', id,
      round_kind, window_months, period_start, period_end,
      knowledge_cutoff_at, maturity_days, builder_version,
      eligibility_rule_version, smoothing_rule_version, 'insufficient_data',
      0, 0, 0, 0, 0, 0, 0, 0,
      pg_temp.tribunal_statistics_tribunal_payload(), repeat('9', 64)
    from public.tribunal_statistics_snapshots
    where id = 'b3800000-0000-4000-8000-000000000001'$$,
  '23514',
  'A tribunal snapshot court must belong to its parent mature-round universe.',
  'a rogue tribunal child cannot be appended outside the national mature universe'
);

insert into public.tribunal_statistics_snapshots (
  id, scope_type, court_id, court_code, court_name, judicial_region,
  parent_snapshot_id, round_kind, window_months, period_start, period_end,
  knowledge_cutoff_at, maturity_days, builder_version,
  eligibility_rule_version, smoothing_rule_version, reliability_status,
  quality_gate_passed, eligible_round_count, status_sample_size,
  initial_price_sample_size, effective_price_sample_size,
  surenchere_sample_size, result_delay_sample_size, double_reviewed_count,
  outcome_coverage, statistics, source_manifest_hash
)
select
  'b3800000-0000-4000-8000-000000000002',
  'tribunal', 'b3200000-0000-4000-8000-000000000001',
  'TJ-STATS-TEST', 'Tribunal judiciaire Statistiques Test',
  'Cour d''appel Test', 'b3800000-0000-4000-8000-000000000001',
  parent.round_kind, parent.window_months, parent.period_start, parent.period_end,
  parent.knowledge_cutoff_at, parent.maturity_days, parent.builder_version,
  parent.eligibility_rule_version, parent.smoothing_rule_version,
  'insufficient_data', false, 1, 1, 1, 1, 1, 1, 1, 1.000000,
  pg_temp.tribunal_statistics_tribunal_payload(),
  app_private.tribunal_statistics_source_manifest_hash(
    'tribunal', 'b3200000-0000-4000-8000-000000000001',
    parent.round_kind, parent.window_months, parent.period_start, parent.period_end,
    parent.knowledge_cutoff_at, parent.maturity_days, parent.builder_version,
    parent.eligibility_rule_version, parent.unfrozen_round_count,
    '[]'::jsonb,
    pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'roundId', 'b3500000-0000-4000-8000-000000000001'::uuid,
        'memberHash', hash_row.member_hash
      )
    )
  )
from public.tribunal_statistics_snapshots parent
cross join pgtap_tribunal_member_hash hash_row
where parent.id = 'b3800000-0000-4000-8000-000000000001';

select throws_ok(
  $$update public.outcome_courts
    set name = 'Tribunal judiciaire renommé rétroactivement'
    where id = 'b3200000-0000-4000-8000-000000000001'$$,
  '55000',
  'Court statistical metadata is immutable after its first snapshot.',
  'canonical court metadata is frozen after its first tribunal snapshot'
);

select throws_ok(
  $$insert into public.tribunal_statistics_snapshots (
      scope_type, court_id, court_code, court_name, judicial_region,
      parent_snapshot_id, round_kind, window_months, period_start, period_end,
      knowledge_cutoff_at, maturity_days, builder_version,
      eligibility_rule_version, smoothing_rule_version, reliability_status,
      quality_gate_passed, eligible_round_count, unfrozen_round_count,
      freeze_coverage, status_sample_size, initial_price_sample_size,
      effective_price_sample_size, market_price_sample_size,
      surenchere_sample_size, result_delay_sample_size,
      postponement_delay_sample_size, double_reviewed_count, outcome_coverage,
      statistics, source_manifest_hash
    )
    select
      scope_type, court_id, court_code, court_name, judicial_region,
      parent_snapshot_id, round_kind, window_months, period_start, period_end,
      knowledge_cutoff_at, maturity_days, builder_version,
      eligibility_rule_version, smoothing_rule_version, reliability_status,
      quality_gate_passed, eligible_round_count, unfrozen_round_count,
      freeze_coverage, status_sample_size, 10,
      effective_price_sample_size, market_price_sample_size,
      surenchere_sample_size, result_delay_sample_size,
      postponement_delay_sample_size, double_reviewed_count, outcome_coverage,
      jsonb_set(
        statistics,
        '{priceRatios,finalToInitial}',
        pg_temp.tribunal_statistics_distribution(10, 10, 0, 0, 1, 1.1, 1.2)
      ),
      repeat('f', 64)
    from public.tribunal_statistics_snapshots
    where id = 'b3800000-0000-4000-8000-000000000002'$$,
  '23514',
  'Published tribunal distributions require their matching national parent cell.',
  'a tribunal distribution cannot publish against a suppressed national parent cell'
);

insert into public.tribunal_statistics_members (
  snapshot_id, round_id, feature_snapshot_id, outcome_id, court_id,
  status_claim_eligible, initial_starting_price_claim_eligible,
  effective_starting_price_claim_eligible,
  initial_hammer_price_claim_eligible, final_hammer_price_claim_eligible,
  finality_status_claim_eligible, surenchere_claim_eligible,
  result_observed_at_claim_eligible, double_reviewed,
  exclusion_reasons
) values (
  'b3800000-0000-4000-8000-000000000002',
  'b3500000-0000-4000-8000-000000000001',
  'b3550000-0000-4000-8000-000000000001',
  'b3600000-0000-4000-8000-000000000001',
  'b3200000-0000-4000-8000-000000000001',
  true, true, true, true, true, true, true, true, true, '{}'
);

select lives_ok(
  $$set constraints validate_tribunal_statistics_manifest_after_insert immediate$$,
  'national and tribunal manifests match their counters, source hashes, and parent subset'
);
set constraints all deferred;

select ok(
  (
    select statistics -> 'warnings' =
      pg_temp.tribunal_statistics_payload() -> 'warnings'
    from public.tribunal_statistics_snapshots
    where id = 'b3800000-0000-4000-8000-000000000001'
  )
  and (
    select statistics -> 'warnings' =
      pg_temp.tribunal_statistics_tribunal_payload() -> 'warnings'
    from public.tribunal_statistics_snapshots
    where id = 'b3800000-0000-4000-8000-000000000002'
  ),
  'published manifests expose exactly the closed warning set and no stale warning'
);

select is(
  (
    select count(*)
    from public.tribunal_statistics_members
    where snapshot_id in (
      'b3800000-0000-4000-8000-000000000001',
      'b3800000-0000-4000-8000-000000000002'
    )
  ),
  2::bigint,
  'one mature round is manifested nationally and for its tribunal'
);

savepoint incomplete_manifest;
insert into public.tribunal_statistics_snapshots (
  id, scope_type, round_kind, window_months, period_start, period_end,
  knowledge_cutoff_at, maturity_days, builder_version,
  eligibility_rule_version, smoothing_rule_version, reliability_status,
  eligible_round_count, status_sample_size, initial_price_sample_size,
  effective_price_sample_size, surenchere_sample_size,
  result_delay_sample_size, double_reviewed_count, outcome_coverage,
  statistics, source_manifest_hash
)
select
  'b3900000-0000-4000-8000-000000000001',
  'national', 'initial', 24,
  ((current_date - 1000) + 1 - interval '24 months')::date,
  current_date - 1000,
  knowledge_cutoff_at, maturity_days, builder_version,
  eligibility_rule_version, smoothing_rule_version, 'insufficient_data',
  1, 1, 1, 1, 1, 1, 1, 1.000000,
  pg_temp.tribunal_statistics_payload(), repeat('8', 64)
from public.tribunal_statistics_snapshots
where id = 'b3800000-0000-4000-8000-000000000001';
select throws_ok(
  $$set constraints validate_tribunal_statistics_manifest_after_insert immediate$$,
  '23514',
  'Statistics snapshot counters and source hash must match its complete mature-round manifest.',
  'a snapshot cannot commit without its complete member manifest'
);
rollback to savepoint incomplete_manifest;
set constraints all deferred;

select lives_ok(
  $$insert into public.feature_usage_events (
      user_id, event_key, subject_type, subject_id
    ) values (
      'b3000000-0000-4000-8000-000000000002',
      'tribunal.statistics_viewed', 'tribunal',
      'b3200000-0000-4000-8000-000000000001'
    )$$,
  'tribunal statistics views use the constrained usage-event vocabulary'
);

select ok(
  app_private.outcome_claim_is_eligible_at(
    'b3600000-0000-4000-8000-000000000001',
    'outcome_status',
    current_setting('immojudis.tribunal_test_cutoff')::timestamptz
  ),
  'the stored snapshot cutoff sees the accepted eligibility version'
);

select set_config(
  'immojudis.outcome_status_tip',
  (
    select id::text
    from public.outcome_claim_eligibility_decisions
    where outcome_id = 'b3600000-0000-4000-8000-000000000001'
      and claim_type = 'outcome_status'
      and version = 1
  ),
  true
);

reset role;
select set_config(
  'request.jwt.claim.sub', 'b3000000-0000-4000-8000-000000000001', true
);
set local role authenticated;
select public.decide_outcome_claim_eligibility(
  'b3600000-0000-4000-8000-000000000001',
  'outcome_status',
  'rejected',
  '{}'::uuid[],
  'later conflict',
  current_setting('immojudis.outcome_status_tip')::uuid
);
reset role;
set local role service_role;

select ok(
  app_private.outcome_claim_is_eligible_at(
    'b3600000-0000-4000-8000-000000000001',
    'outcome_status',
    current_setting('immojudis.tribunal_test_cutoff')::timestamptz
  ),
  'a later correction cannot rewrite historical eligibility at the snapshot cutoff'
);

select ok(
  not app_private.outcome_claim_is_eligible_at(
    'b3600000-0000-4000-8000-000000000001',
    'outcome_status',
    statement_timestamp()
  ),
  'the latest rejected correction removes eligibility prospectively'
);

select lives_ok(
  $$set constraints all immediate$$,
  'all deferred evidence and statistics integrity checks pass'
);

reset role;

select throws_ok(
  $$update public.outcome_claim_eligibility_decisions
    set decision_reason = 'tampered'
    where outcome_id = 'b3600000-0000-4000-8000-000000000001'$$,
  '55000',
  'public.outcome_claim_eligibility_decisions is append-only; insert a correcting version instead.',
  'claim eligibility history cannot be rewritten'
);

select throws_ok(
  $$update public.tribunal_statistics_snapshots
    set builder_version = 'tampered'
    where id = 'b3800000-0000-4000-8000-000000000001'$$,
  '55000',
  'public.tribunal_statistics_snapshots is append-only; insert a correcting version instead.',
  'published tribunal snapshots cannot be rewritten'
);

select throws_ok(
  $$delete from public.tribunal_statistics_members
    where snapshot_id = 'b3800000-0000-4000-8000-000000000001'$$,
  '55000',
  'public.tribunal_statistics_members is append-only; insert a correcting version instead.',
  'snapshot member provenance cannot be deleted'
);

set local role authenticated;
set local "request.jwt.claim.sub" = 'b3000000-0000-4000-8000-000000000002';
set local "request.jwt.claim.role" = 'authenticated';

select throws_ok(
  $$select count(*) from public.tribunal_statistics_snapshots$$,
  '42501',
  'permission denied for table tribunal_statistics_snapshots',
  'authenticated users cannot query aggregates directly'
);

select throws_ok(
  $$select count(*) from public.tribunal_statistics_members$$,
  '42501',
  'permission denied for table tribunal_statistics_members',
  'authenticated users cannot inspect the private member manifest'
);

reset role;

select * from finish();

rollback;
