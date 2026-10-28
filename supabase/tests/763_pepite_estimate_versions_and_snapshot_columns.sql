-- Version de l'estimation dans la pépite et colonnes d'instantané complétées (migration 20261108140000) :
--   * auction_sale_pepites porte estimate_model_version et estimate_engine_kind ;
--   * l'instantané les archive, avec la date de l'estimation lue par l'évaluation, le multiplicateur, la
--     fourchette, les effectifs, les motifs, le mode des pépites et le gel ;
--   * une vente jamais évaluée a ces colonnes nulles ; un détail mal formé n'empêche pas l'instantané ;
--   * rien d'identifiant n'est ajouté et les droits restent fermés.
begin;

select plan(14);

insert into public.auction_sales (
  id, source_name, source_url, title, status, sale_date, starting_price_eur, department, property_type,
  sale_venue_type
) values
  ('c7610000-1000-4000-8000-000000000001', 'pgtap-761', 'https://example.test/761/a', 'Maison A', 'upcoming',
   '2000-01-02 12:00:00Z', 201000, '33', 'house', 'notary'),
  ('c7610000-1000-4000-8000-000000000002', 'pgtap-761', 'https://example.test/761/b', 'Maison B', 'upcoming',
   '2000-01-02 12:00:00Z', 202000, '33', 'house', 'notary'),
  ('c7610000-1000-4000-8000-000000000003', 'pgtap-761', 'https://example.test/761/c', 'Maison C', 'upcoming',
   '2000-01-02 12:00:00Z', 203000, '33', 'house', 'notary');

update public.auction_sale_market_estimates
   set status = 'ready',
       estimate = '{}'::jsonb,
       value_p10_eur = 150000,
       value_p50_eur = 250000,
       value_p90_eur = 300000,
       actionable = true,
       comparable_count = 12,
       confidence_score = 70,
       engine_kind = 'hybrid_lightgbm',
       model_version = 'pgtap-761-v2',
       computed_at = '1999-12-28 08:00:00Z'
 where auction_sale_id::text like 'c7610000-1000-4000-8000-00000000000%';

-- a : évaluée avec le modèle v1 (l'estimation a été recalculée depuis) ; b : détail mal formé ; c : jamais évaluée.
insert into public.auction_sale_pepites (
  sale_id, rule_version, engine_version, regime_version, status, is_pepite, details, reason_codes,
  input_estimate_computed_at, estimate_model_version, estimate_engine_kind, frozen_at, first_pepite_at,
  evaluated_at
) values
  ('c7610000-1000-4000-8000-000000000001', 'pepite-v1.1', 'pgtap', 'pgtap', 'pepite', true,
   '{"regime": "tribunal", "multiplierKey": "q75", "multiplier": 2.1, "rangeLowEur": 150000, "rangeHighEur": 230000, "startingShareOfValue": 0.2, "estimateReliability": "forte", "estimateEffectiveSample": 11.5, "chanceSample": 55, "chanceWilsonLow": 0.62, "referenceCeilingEur": 180000, "costRatio": 0.6}'::jsonb,
   array['pass:test_b_chance', 'pass:test_c_cost', 'stab:frozen'],
   '1999-12-20 08:00:00Z', 'pgtap-761-v1', 'comparable_ensemble', '1999-12-26 08:00:00Z',
   '1999-12-15 08:00:00Z', '1999-12-30 08:00:00Z'),
  ('c7610000-1000-4000-8000-000000000002', 'pepite-v1.1', 'pgtap', 'pgtap', 'pepite', true,
   '{"multiplierKey": 7, "multiplier": "beaucoup", "rangeLowEur": [1], "estimateReliability": null, "chanceSample": {"x": 1}}'::jsonb,
   array['pass:test_c_cost'], null, null, null, null, null, '1999-12-30 09:00:00Z');

select count(*) from public.bridge_auction_sales_to_outcome_graph();

-- Structure ---------------------------------------------------------------------------------------------------
select is(
  (select count(*) from information_schema.columns
    where table_schema = 'public' and table_name = 'auction_sale_pepites'
      and column_name in ('estimate_model_version', 'estimate_engine_kind')),
  2::bigint,
  'the pepite row carries the model version and the engine of the estimate it read'
);
select is(
  (select count(*) from information_schema.columns
    where table_schema = 'app_private' and table_name = 'sale_market_estimate_snapshots'
      and column_name in (
        'estimate_model_version', 'estimate_engine_kind', 'pepite_input_estimate_computed_at',
        'pepite_multiplier_key', 'pepite_multiplier', 'pepite_range_low_eur', 'pepite_range_high_eur',
        'pepite_starting_share_of_value', 'pepite_estimate_reliability', 'pepite_estimate_effective_sample',
        'pepite_chance_sample', 'pepite_chance_wilson_low', 'pepite_reason_codes', 'pepite_mode',
        'pepite_frozen_at', 'pepite_first_pepite_at'
      )),
  16::bigint,
  'the snapshot carries the versions, the input estimate date, the multiplier, the range, the sample sizes, the reason codes, the mode and the freeze'
);
select is(
  (select count(*) from information_schema.columns
    where table_schema = 'app_private' and table_name = 'sale_market_estimate_snapshots'
      and column_name in ('sale_id', 'auction_sale_id', 'address', 'city', 'title', 'source_url', 'latitude', 'longitude', 'lawyer_name', 'investment_score')),
  0::bigint,
  'still no identifier, address or score column'
);
select ok(
  not has_table_privilege('anon', 'app_private.sale_market_estimate_snapshots', 'SELECT')
  and not has_table_privilege('authenticated', 'app_private.sale_market_estimate_snapshots', 'SELECT')
  and not has_table_privilege('anon', 'public.auction_sale_pepites', 'SELECT')
  and not has_table_privilege('authenticated', 'public.auction_sale_pepites', 'SELECT'),
  'the snapshots and the pepite rows stay closed to the browser roles'
);
select ok(
  (select bool_and(procedure_row.prosecdef and procedure_row.proconfig @> array['search_path=""']::text[])
     from pg_proc procedure_row
    where procedure_row.oid = 'app_private.snapshot_sale_market_estimate(public.auction_sales)'::regprocedure),
  'the writing function is still security definer with an empty search_path'
);

-- a : tout est archivé ----------------------------------------------------------------------------------------
select lives_ok(
  $$delete from public.auction_sales where id = 'c7610000-1000-4000-8000-000000000001'$$,
  'an evaluated sale is purged at its session'
);
select ok(
  (select estimate_model_version = 'pgtap-761-v1' and estimate_engine_kind = 'comparable_ensemble'
          and model_version = 'pgtap-761-v2' and engine_kind = 'hybrid_lightgbm'
          and pepite_input_estimate_computed_at = '1999-12-20 08:00:00Z'::timestamptz
          and estimate_computed_at = '1999-12-28 08:00:00Z'::timestamptz
     from app_private.sale_market_estimate_snapshots where starting_price_eur = 201000),
  'the model version and engine read by the evaluation are kept apart from those of the archived estimate'
);
select ok(
  (select pepite_multiplier_key = 'q75' and pepite_multiplier = 2.1 and pepite_range_low_eur = 150000
          and pepite_range_high_eur = 230000 and pepite_starting_share_of_value = 0.2
          and pepite_estimate_reliability = 'forte' and pepite_estimate_effective_sample = 11.5
          and pepite_chance_sample = 55 and pepite_chance_wilson_low = 0.62
     from app_private.sale_market_estimate_snapshots where starting_price_eur = 201000),
  'the multiplier, the range, the share of the value and the sample sizes are archived'
);
select ok(
  (select pepite_reason_codes = array['pass:test_b_chance', 'pass:test_c_cost', 'stab:frozen']
          and pepite_mode in ('off', 'shadow', 'on')
          and pepite_frozen_at = '1999-12-26 08:00:00Z'::timestamptz
          and pepite_first_pepite_at = '1999-12-15 08:00:00Z'::timestamptz
     from app_private.sale_market_estimate_snapshots where starting_price_eur = 201000),
  'the reason codes, the mode, the freeze date and the first publication date are archived'
);

-- b : détail mal formé ----------------------------------------------------------------------------------------
select lives_ok(
  $$delete from public.auction_sales where id = 'c7610000-1000-4000-8000-000000000002'$$,
  'a malformed detail does not stop the purge'
);
select ok(
  (select count(*) = 1 and bool_and(pepite_multiplier is null and pepite_range_low_eur is null
          and pepite_chance_sample is null and pepite_estimate_effective_sample is null)
     from app_private.sale_market_estimate_snapshots where starting_price_eur = 202000),
  'a detail that is not made of numbers still leaves a snapshot, without numbers'
);

-- c : jamais évaluée --------------------------------------------------------------------------------------------
select lives_ok(
  $$delete from public.auction_sales where id = 'c7610000-1000-4000-8000-000000000003'$$,
  'a sale that was never evaluated is purged'
);
select ok(
  (select estimate_model_version is null and estimate_engine_kind is null and pepite_reason_codes is null
          and pepite_mode is null and pepite_frozen_at is null and pepite_multiplier_key is null
     from app_private.sale_market_estimate_snapshots where starting_price_eur = 203000),
  'a sale that was never evaluated has no pepite columns'
);

select * from finish();
rollback;
