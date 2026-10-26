-- Instantanés d'estimation, ventes notariales et résultat de la pépite (migration 20261104110000) :
--   * une vente notariale (sans tribunal) laisse un instantané, comme une vente de tribunal ;
--   * le résultat de la pépite (version, statut, plafond de référence, prix probable, part B, ratio C, régime,
--     occupation, état) y est archivé quand la vente a été évaluée ;
--   * le résultat d'une vente notariale (prix d'adjudication, mention « Vendu ») y est archivé quand la source
--     l'a publié à la sortie de statut ; un second écrit ne complète qu'un résultat encore vide ;
--   * une vente d'un autre type, ou de tribunal sans code de tribunal, ne laisse rien ;
--   * rien d'identifiant n'est ajouté ; un détail de pépite mal formé n'empêche jamais l'instantané.
begin;

select plan(30);

insert into public.tribunals (code, canonical_name, department, city, aliases)
values ('pgtap_752_tj', 'TJ pgTAP 752', '33', 'Bordeaux', '[]'::jsonb);

-- Ventes dont la séance est passée (2000-01-02), en statut « upcoming » : l'estimation est mise en file à
-- l'insertion par le déclencheur de file ; une estimation « ready » est posée à la main plus bas.
--   a : notariale, adjugée (passage à « past » avec prix et mention « Vendu »)          -> résultat archivé
--   b : notariale, supprimée sans résultat, évaluée (pépite)                             -> pépite archivée
--   c : de tribunal, supprimée, évaluée (pépite)                                         -> code de tribunal et pépite
--   d : d'un autre type (domaniale)                                                      -> aucun
--   e : de tribunal sans code de tribunal                                                -> aucun
--   f : notariale, sortie de statut sans résultat, puis résultat publié, puis suppression -> résultat complété
--   g : notariale, détail de pépite mal formé                                            -> instantané sans nombres
--   h : notariale non évaluée                                                            -> colonnes de pépite nulles
insert into public.auction_sales (
  id, source_name, source_url, title, status, sale_date, starting_price_eur, tribunal_code, department,
  property_type, sale_venue_type
) values
  ('c7520000-1000-4000-8000-000000000001', 'pgtap-752', 'https://example.test/752/a', 'Maison A', 'upcoming',
   '2000-01-02 12:00:00Z', 101000, null, '33', 'house', 'notary'),
  ('c7520000-1000-4000-8000-000000000002', 'pgtap-752', 'https://example.test/752/b', 'Appartement B', 'upcoming',
   '2000-01-02 12:00:00Z', 102000, null, '33', 'apartment', 'notary'),
  ('c7520000-1000-4000-8000-000000000003', 'pgtap-752', 'https://example.test/752/c', 'Maison C', 'upcoming',
   '2000-01-02 12:00:00Z', 103000, 'pgtap_752_tj', '33', 'house', 'tribunal'),
  ('c7520000-1000-4000-8000-000000000004', 'pgtap-752', 'https://example.test/752/d', 'Maison D', 'upcoming',
   '2000-01-02 12:00:00Z', 104000, null, '33', 'house', 'state'),
  ('c7520000-1000-4000-8000-000000000005', 'pgtap-752', 'https://example.test/752/e', 'Maison E', 'upcoming',
   '2000-01-02 12:00:00Z', 105000, null, '33', 'house', 'tribunal'),
  ('c7520000-1000-4000-8000-000000000006', 'pgtap-752', 'https://example.test/752/f', 'Maison F', 'upcoming',
   '2000-01-02 12:00:00Z', 106000, null, '33', 'house', 'notary'),
  ('c7520000-1000-4000-8000-000000000007', 'pgtap-752', 'https://example.test/752/g', 'Maison G', 'upcoming',
   '2000-01-02 12:00:00Z', 107000, null, '33', 'house', 'notary'),
  ('c7520000-1000-4000-8000-000000000008', 'pgtap-752', 'https://example.test/752/h', 'Maison H', 'upcoming',
   '2000-01-02 12:00:00Z', 108000, null, '33', 'house', 'notary');

update public.auction_sale_market_estimates
   set status = 'ready',
       estimate = '{}'::jsonb,
       value_p10_eur = 150000,
       value_p50_eur = 200000,
       value_p90_eur = 260000,
       actionable = true,
       comparable_count = 12,
       confidence_score = 70,
       engine_kind = 'comparable_ensemble',
       model_version = 'pgtap-752-v1',
       computed_at = '1999-12-20 08:00:00Z'
 where auction_sale_id::text like 'c7520000-1000-4000-8000-00000000000%';

-- Évaluations de pépite (b, c, f, g) ; a, d, e et h n'en ont pas.
insert into public.auction_sale_pepites (
  sale_id, rule_version, engine_version, regime_version, status, is_pepite, details, evaluated_at
) values
  ('c7520000-1000-4000-8000-000000000002', 'pepite-v1', 'pgtap', 'pgtap', 'pepite', true,
   '{"regime": "notary_online", "occupancy": "libre", "conditionStatus": "unknown", "referenceCeilingEur": 160000, "probablePriceEur": 102000, "chanceShare": null, "costRatio": 0.55}'::jsonb,
   '1999-12-30 08:00:00Z'),
  ('c7520000-1000-4000-8000-000000000003', 'pepite-v1', 'pgtap', 'pgtap', 'not_pepite', false,
   '{"regime": "tribunal", "occupancy": "occupe", "conditionStatus": "light_refresh", "referenceCeilingEur": 190000, "probablePriceEur": 154500, "chanceShare": 0.72, "costRatio": 0.71}'::jsonb,
   '1999-12-30 09:00:00Z'),
  ('c7520000-1000-4000-8000-000000000006', 'pepite-v1', 'pgtap', 'pgtap', 'pepite', true,
   '{"regime": "notary_auction", "occupancy": "libre", "conditionStatus": "good", "referenceCeilingEur": 170000, "probablePriceEur": 106000, "costRatio": 0.6}'::jsonb,
   '1999-12-30 10:00:00Z'),
  ('c7520000-1000-4000-8000-000000000007', 'pepite-v1', 'pgtap', 'pgtap', 'pepite', true,
   '{"regime": "notary_auction", "occupancy": "libre", "referenceCeilingEur": "beaucoup", "probablePriceEur": [1], "chanceShare": {"x": 1}, "costRatio": null}'::jsonb,
   '1999-12-30 11:00:00Z');

-- Pont Outcome Graph exigé avant toute suppression d'une vente (garde de 20260730163756), comme les autres tests.
select count(*) from public.bridge_auction_sales_to_outcome_graph();

-- Structure ---------------------------------------------------------------------------------------------------
select ok(
  (select is_nullable = 'YES' from information_schema.columns
    where table_schema = 'app_private' and table_name = 'sale_market_estimate_snapshots'
      and column_name = 'court_code'),
  'the court code is optional (a notarial sale has no court)'
);
select is(
  (select count(*) from information_schema.columns
    where table_schema = 'app_private' and table_name = 'sale_market_estimate_snapshots'
      and column_name in (
        'sale_venue_type', 'regime', 'occupancy', 'condition_status', 'pepite_rule_version',
        'pepite_status', 'pepite_is_pepite', 'pepite_reference_ceiling_eur', 'pepite_probable_price_eur',
        'pepite_chance_share', 'pepite_cost_ratio', 'pepite_evaluated_at', 'adjudication_price_eur',
        'sale_result'
      )),
  14::bigint,
  'the snapshot carries the sale type, the pepite result and the notarial result'
);
select is(
  (select count(*) from information_schema.columns
    where table_schema = 'app_private' and table_name = 'sale_market_estimate_snapshots'
      and column_name in (
        'id', 'sale_id', 'auction_sale_id', 'address', 'city', 'postal_code', 'title', 'source_url',
        'latitude', 'longitude', 'lawyer_name', 'lawyer_contact', 'observations', 'tribunal_name',
        'investment_score'
      )),
  0::bigint,
  'still no address, place, title, source, sale identifier, lawyer or score column'
);
select throws_ok(
  $$insert into app_private.sale_market_estimate_snapshots (
      snapshot_key, court_code, starting_price_eur, sale_date, value_p50_eur, actionable, comparable_count,
      sale_venue_type
    ) values (repeat('b', 64), null, 10000, '2000-01-02', 12000, true, 5, 'tribunal')$$,
  '23514', null, 'a court sale must still have its court code'
);
select throws_ok(
  $$insert into app_private.sale_market_estimate_snapshots (
      snapshot_key, court_code, starting_price_eur, sale_date, value_p50_eur, actionable, comparable_count,
      sale_venue_type
    ) values (repeat('c', 64), 'x', 10000, '2000-01-02', 12000, true, 5, 'state')$$,
  '23514', null, 'only court and notarial sales are kept'
);
select ok(
  not has_table_privilege('anon', 'app_private.sale_market_estimate_snapshots', 'SELECT')
  and not has_table_privilege('authenticated', 'app_private.sale_market_estimate_snapshots', 'SELECT')
  and not has_table_privilege('authenticated', 'app_private.sale_market_estimate_snapshots', 'INSERT'),
  'the snapshots stay closed to the browser roles'
);
select ok(
  (select bool_and(procedure_row.prosecdef and procedure_row.proconfig @> array['search_path=""']::text[])
     from pg_proc procedure_row
    where procedure_row.oid = 'app_private.snapshot_sale_market_estimate(public.auction_sales)'::regprocedure),
  'the writing function is still security definer with an empty search_path'
);
select ok(
  not has_function_privilege('anon', 'app_private.snapshot_sale_market_estimate(public.auction_sales)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'app_private.snapshot_sale_market_estimate(public.auction_sales)', 'EXECUTE')
  and not has_function_privilege('anon', 'app_private.pepite_details_number(jsonb, text)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'app_private.pepite_details_number(jsonb, text)', 'EXECUTE'),
  'nobody outside the triggers writes a snapshot or reads a pepite detail'
);
select is(
  (select count(*) from app_private.sale_market_estimate_snapshots
    where starting_price_eur between 101000 and 108000),
  0::bigint,
  'nothing is captured while the sales are alive'
);

-- a : adjugée -------------------------------------------------------------------------------------------------
update public.auction_sales
   set status = 'past',
       adjudication_price_eur = 150000,
       raw_payload = '{"source_property_features": {"sale_conditions": {"procedure": "notarial_auction", "result": "Vendu", "adjudication_price_eur": 150000}}}'::jsonb
 where id = 'c7520000-1000-4000-8000-000000000001';
select is(
  (select count(*) from app_private.sale_market_estimate_snapshots where starting_price_eur = 101000),
  1::bigint,
  'a notarial sale leaving « upcoming » leaves a snapshot'
);
select ok(
  (select sale_venue_type = 'notary' and court_code is null and department = '33' and property_type = 'house'
          and property_group = 'housing' and sale_date = date '2000-01-02'
     from app_private.sale_market_estimate_snapshots where starting_price_eur = 101000),
  'it carries the sale type, no court, department, type, comparison group and hearing day'
);
select ok(
  (select value_p10_eur = 150000 and value_p50_eur = 200000 and value_p90_eur = 260000 and actionable
          and comparable_count = 12 and model_version = 'pgtap-752-v1'
          and estimate_computed_at = '1999-12-20 08:00:00Z'::timestamptz
     from app_private.sale_market_estimate_snapshots where starting_price_eur = 101000),
  'it carries the estimate and its quality, as for a court sale'
);
select ok(
  (select adjudication_price_eur = 150000 and sale_result = 'Vendu'
     from app_private.sale_market_estimate_snapshots where starting_price_eur = 101000),
  'the notarial result published when the sale leaves « upcoming » (price and « Vendu ») is archived'
);
select ok(
  (select pepite_rule_version is null and pepite_status is null and pepite_is_pepite is null
          and pepite_reference_ceiling_eur is null and regime is null and occupancy is null
     from app_private.sale_market_estimate_snapshots where starting_price_eur = 101000),
  'a sale that was never evaluated has no pepite columns'
);

-- b : notariale évaluée ------------------------------------------------------------------------------------------
select lives_ok(
  $$delete from public.auction_sales where id = 'c7520000-1000-4000-8000-000000000002'$$,
  'a notarial sale is purged at its session'
);
select ok(
  (select pepite_rule_version = 'pepite-v1' and pepite_status = 'pepite' and pepite_is_pepite
          and pepite_reference_ceiling_eur = 160000 and pepite_probable_price_eur = 102000
          and pepite_chance_share is null and pepite_cost_ratio = 0.55
          and regime = 'notary_online' and occupancy = 'libre' and condition_status = 'unknown'
          and pepite_evaluated_at = '1999-12-30 08:00:00Z'::timestamptz
     from app_private.sale_market_estimate_snapshots where starting_price_eur = 102000),
  'the pepite result is archived: rule, status, reference ceiling, probable price, shares, regime, occupation, condition'
);
select ok(
  (select adjudication_price_eur is null and sale_result is null
     from app_private.sale_market_estimate_snapshots where starting_price_eur = 102000),
  'no result is invented when the source did not publish one'
);

-- c : tribunal évaluée -----------------------------------------------------------------------------------------
select lives_ok(
  $$delete from public.auction_sales where id = 'c7520000-1000-4000-8000-000000000003'$$,
  'a court sale is purged at its hearing'
);
select ok(
  (select sale_venue_type = 'tribunal' and court_code = 'pgtap_752_tj' and pepite_status = 'not_pepite'
          and not pepite_is_pepite and pepite_chance_share = 0.72 and pepite_cost_ratio = 0.71
          and regime = 'tribunal' and occupancy = 'occupe' and condition_status = 'light_refresh'
          and adjudication_price_eur is null
     from app_private.sale_market_estimate_snapshots where starting_price_eur = 103000),
  'a court sale keeps its court code and its pepite result, and no notarial result'
);

-- d, e : rien ---------------------------------------------------------------------------------------------------
select lives_ok(
  $$delete from public.auction_sales
     where id in ('c7520000-1000-4000-8000-000000000004', 'c7520000-1000-4000-8000-000000000005')$$,
  'a sale of another type and a court sale without court are purged'
);
select is(
  (select count(*) from app_private.sale_market_estimate_snapshots
    where starting_price_eur in (104000, 105000)),
  0::bigint,
  'neither leaves a snapshot'
);

-- f : résultat publié après la sortie de statut ------------------------------------------------------------------
update public.auction_sales set status = 'adjudicated' where id = 'c7520000-1000-4000-8000-000000000006';
select ok(
  (select adjudication_price_eur is null and sale_result is null and pepite_status = 'pepite'
     from app_private.sale_market_estimate_snapshots where starting_price_eur = 106000),
  'a sale leaving « upcoming » before its result is published is archived without result'
);
update public.auction_sales
   set adjudication_price_eur = 130000,
       raw_payload = '{"source_property_features": {"sale_conditions": {"result": "Vendu"}}}'::jsonb
 where id = 'c7520000-1000-4000-8000-000000000006';
update public.auction_sale_pepites
   set status = 'not_pepite', is_pepite = false,
       details = '{"regime": "notary_auction", "occupancy": "occupe", "referenceCeilingEur": 1}'::jsonb
 where sale_id = 'c7520000-1000-4000-8000-000000000006';
select lives_ok(
  $$delete from public.auction_sales where id = 'c7520000-1000-4000-8000-000000000006'$$,
  'the sale is purged after its result was published'
);
select ok(
  (select adjudication_price_eur = 130000 and sale_result = 'Vendu'
     from app_private.sale_market_estimate_snapshots where starting_price_eur = 106000),
  'the second write completes the empty result'
);
select ok(
  (select pepite_status = 'pepite' and pepite_is_pepite and pepite_reference_ceiling_eur = 170000
          and occupancy = 'libre' and value_p50_eur = 200000
     from app_private.sale_market_estimate_snapshots where starting_price_eur = 106000),
  'but never changes the estimate or the pepite result archived the first time'
);
select is(
  (select count(*) from app_private.sale_market_estimate_snapshots where starting_price_eur = 106000),
  1::bigint,
  'and leaves one snapshot for the sale'
);

-- g : détail mal formé ---------------------------------------------------------------------------------------------
select lives_ok(
  $$delete from public.auction_sales where id = 'c7520000-1000-4000-8000-000000000007'$$,
  'a sale whose pepite details are malformed is purged'
);
select ok(
  (select pepite_status = 'pepite' and pepite_reference_ceiling_eur is null and pepite_probable_price_eur is null
          and pepite_chance_share is null and pepite_cost_ratio is null and regime = 'notary_auction'
     from app_private.sale_market_estimate_snapshots where starting_price_eur = 107000),
  'a detail that is not a number never fails the snapshot: the number stays empty'
);

-- h : non évaluée ----------------------------------------------------------------------------------------------------
select lives_ok(
  $$delete from public.auction_sales where id = 'c7520000-1000-4000-8000-000000000008'$$,
  'a notarial sale that was never evaluated is purged'
);
select ok(
  (select pepite_status is null and pepite_is_pepite is null and sale_venue_type = 'notary'
     from app_private.sale_market_estimate_snapshots where starting_price_eur = 108000),
  'its snapshot is kept without pepite columns'
);

select * from finish();

rollback;
