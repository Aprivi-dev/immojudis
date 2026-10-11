begin;

select plan(29);

-- Privileges -----------------------------------------------------------------

select ok(
  has_function_privilege('service_role', 'public.tribunal_outcome_graph_past_hearings(timestamptz,timestamptz,text)', 'EXECUTE'),
  'the server reads archived hearings with service_role'
);
select ok(
  not has_function_privilege('anon', 'public.tribunal_outcome_graph_past_hearings(timestamptz,timestamptz,text)', 'EXECUTE')
    and not has_function_privilege('authenticated', 'public.tribunal_outcome_graph_past_hearings(timestamptz,timestamptz,text)', 'EXECUTE'),
  'archived hearings are not exposed to anon or authenticated'
);
select ok(
  not has_function_privilege('authenticated', 'public.remap_archived_catalogue_courts_by_label_batch(uuid,integer)', 'EXECUTE')
    and has_function_privilege('service_role', 'public.remap_archived_catalogue_courts_by_label_batch(uuid,integer)', 'EXECUTE'),
  'the archive remapping RPC is private to service_role'
);
select ok(
  not has_function_privilege('authenticated', 'app_private.resolve_tribunal_code_from_label(text)', 'EXECUTE')
    and not has_function_privilege('anon', 'app_private.catalogue_bridge_court_mapping_input(uuid,uuid)', 'EXECUTE'),
  'label helpers stay private'
);
select ok(
  (select prosecdef and proconfig @> array['search_path=""'] from pg_proc
   where oid = 'public.tribunal_outcome_graph_past_hearings(timestamptz,timestamptz,text)'::regprocedure),
  'the history RPC is SECURITY DEFINER with an empty search_path'
);

-- Label resolution -------------------------------------------------------------

insert into public.tribunals(code, canonical_name, department, city, aliases)
values
  ('test_tj_testville', 'TJ Testville-sur-Mer', '99', 'Testville-sur-Mer',
   '["Tribunal judiciaire de Testville-sur-Mer"]'::jsonb),
  ('test_tj_avignon', 'TJ Avignonnet', '99', 'Avignonnet', '[]'::jsonb),
  ('test_tj_dup_a', 'TJ Saint-Doublon', '99', 'Saint-Doublon', '[]'::jsonb),
  ('test_tj_dup_b', 'TJ Saint Doublon', '99', 'Saint Doublon', '[]'::jsonb);

select is(
  (select label_keys from public.tribunals where code = 'test_tj_testville'),
  array['testville sur mer']::text[],
  'reference rows store their court keys'
);
select is(app_private.resolve_tribunal_code_from_label('TJ Testville-sur-Mer'), 'test_tj_testville', 'canonical label resolves');
select is(app_private.resolve_tribunal_code_from_label('Tribunal Judiciaire de TESTVILLE SUR MER'), 'test_tj_testville', 'case, accents and hyphens are normalized');
select is(app_private.resolve_tribunal_code_from_label('TJ D Avignonnet'), 'test_tj_avignon', 'an elided d is ignored after the court prefix');
select is(app_private.resolve_tribunal_code_from_label('Testville-sur-Mer'), null, 'a bare commune never resolves to a court');
select is(app_private.resolve_tribunal_code_from_label('TJ Saint-Doublon'), null, 'an ambiguous key resolves to NULL');
select is(app_private.resolve_tribunal_code_from_label(null), null, 'NULL label resolves to NULL');

-- Archived bridges: label remapping --------------------------------------------

insert into public.auction_sales(
  id, source_name, source_url, tribunal, tribunal_code, sale_venue_type, department, city,
  address, postal_code, property_type, sale_date, status, starting_price_eur, raw_payload
) values
  ('c4470000-0000-4000-8000-000000000001', 'licitor', 'https://example.test/447/judicial',
   'Tribunal judiciaire de Testville-sur-Mer', null, 'tribunal', '99', 'Testville-sur-Mer',
   '1 rue du Test', '99000', 'apartment', statement_timestamp() - interval '10 days', 'past', 81000, '{}'::jsonb),
  ('c4470000-0000-4000-8000-000000000002', 'notaires', 'https://example.test/447/notary',
   'TJ Testville-sur-Mer', null, 'notary', '99', 'Testville-sur-Mer',
   '2 rue du Test', '99000', 'house', statement_timestamp() - interval '10 days', 'past', 82000, '{}'::jsonb),
  ('c4470000-0000-4000-8000-000000000003', 'licitor', 'https://example.test/447/unknown',
   'Tribunal à confirmer', null, 'tribunal', '99', 'Testville-sur-Mer',
   '3 rue du Test', '99000', 'house', statement_timestamp() - interval '10 days', 'past', 83000, '{}'::jsonb),
  ('c4470000-0000-4000-8000-000000000004', 'licitor', 'https://example.test/447/quarantined',
   'TJ Testville-sur-Mer', null, 'tribunal', '99', 'Testville-sur-Mer',
   '4 rue du Test', '99000', 'house', statement_timestamp() - interval '10 days', 'quarantined', 84000, '{}'::jsonb);

select * from public.bridge_auction_sales_to_outcome_graph();

delete from public.auction_sales where id::text like 'c4470000-%';

select results_eq(
  $$select scanned_count >= 4, remapped_count >= 2
    from public.remap_archived_catalogue_courts_by_label_batch(null, 500)$$,
  $$values (true, true)$$,
  'archived bridges whose explicit label names one court are remapped'
);

create temporary table bridge_447 as
select bridge.*, court_row.code as court_code
from public.auction_sale_outcome_bridges bridge
join public.auction_rounds round_row on round_row.id = bridge.round_id
join public.outcome_courts court_row on court_row.id = round_row.court_id
where bridge.source_url_snapshot like 'https://example.test/447/%';

select is(
  (select court_code from bridge_447 where source_url_snapshot like '%/judicial'),
  'test_tj_testville',
  'the judicial archived hearing is attached to its labelled court'
);
select is(
  (select court_mapping_method from bridge_447 where source_url_snapshot like '%/judicial'),
  'tribunal_label_exact',
  'the bridge provenance records the label method'
);
select is(
  (select court_mapping_input->>'label_key' from bridge_447 where source_url_snapshot like '%/judicial'),
  'testville sur mer',
  'the bridge provenance keeps the matched key'
);
select ok(
  (select case_row.court_id = round_row.court_id
   from bridge_447 bridge
   join public.auction_cases case_row on case_row.id = bridge.case_id
   join public.auction_rounds round_row on round_row.id = bridge.round_id
   where bridge.source_url_snapshot like '%/judicial'),
  'case and round move together'
);
select is(
  (select court_code from bridge_447 where source_url_snapshot like '%/notary'),
  'legacy:unmapped',
  'a notarial source is never attached by label'
);
select is(
  (select court_code from bridge_447 where source_url_snapshot like '%/unknown'),
  'legacy:unmapped',
  'an unresolvable label stays unmapped'
);
select ok(
  exists (
    select 1 from public.catalogue_court_reconciliation_events event_row
    join bridge_447 bridge on bridge.id = event_row.bridge_id
    where bridge.source_url_snapshot like '%/judicial'
      and event_row.mapping_method = 'tribunal_label_exact'
  ),
  'the remapping is audited'
);
select is(
  (select sum(remapped_count) from public.remap_archived_catalogue_courts_by_label_batch(null, 500)),
  0::numeric,
  'the archive remapping is idempotent'
);

-- History RPC -------------------------------------------------------------------

select results_eq(
  $$select court_code, initial_starting_price_eur, source_name, auction_sale_id
    from public.tribunal_outcome_graph_past_hearings(
      statement_timestamp() - interval '12 months', statement_timestamp(), 'TEST_TJ_TESTVILLE')$$,
  $$values ('test_tj_testville'::text, 81000::numeric, 'licitor'::text, null::uuid)$$,
  'only the attached, non-quarantined judicial hearing is returned'
);
select is(
  (select count(*) from public.tribunal_outcome_graph_past_hearings(
    statement_timestamp() - interval '12 months', statement_timestamp() - interval '20 days', 'test_tj_testville')),
  0::bigint,
  'hearings after the requested end are excluded'
);
select throws_ok(
  $$select * from public.tribunal_outcome_graph_past_hearings(statement_timestamp() - interval '40 months', statement_timestamp(), null)$$,
  '22023',
  'The history window cannot exceed 38 months.',
  'the history window is bounded'
);

-- Guards stay closed --------------------------------------------------------------

select throws_ok(
  $$update public.auction_sale_outcome_bridges
    set court_mapping_input = court_mapping_input || '{"court_code":"test_tj_avignon"}'::jsonb
    where source_url_snapshot = 'https://example.test/447/judicial'$$,
  '55000',
  'Outcome catalogue bridge identity and mapping are immutable.',
  'label provenance cannot be rewritten by hand'
);
select throws_ok(
  $$update public.auction_cases
    set court_id = (select id from public.outcome_courts where code = 'test_tj_avignon')
    where id = (select case_id from bridge_447 where source_url_snapshot like '%/judicial')$$,
  '55000',
  'Auction case statistical identity is immutable; create a new case.',
  'an archived case cannot be moved to a court its label does not name'
);

-- Live catalogue: label court through the pipeline reconciliation ----------------

insert into public.auction_sales(
  id, source_name, source_url, tribunal, tribunal_code, sale_venue_type, department, city,
  address, postal_code, property_type, sale_date, status, starting_price_eur, raw_payload
) values (
  'c4470000-0000-4000-8000-000000000010', 'vench', 'https://example.test/447/live',
  'TJ Testville sur Mer', null, 'tribunal', '99', 'Testville-sur-Mer',
  '10 rue du Test', '99000', 'apartment', statement_timestamp() + interval '20 days', 'upcoming', 90000, '{}'::jsonb
);

select * from public.bridge_auction_sales_to_outcome_graph();

create temporary table live_reconciliation_447 as
select * from public.reconcile_catalogue_competent_courts();

select ok(
  (select blocked_count = 0 and complete from live_reconciliation_447),
  'a label mapping never blocks the pre-cleanup reconciliation'
);
select is(
  (select court_row.code
   from public.auction_sale_outcome_bridges bridge
   join public.auction_rounds round_row on round_row.id = bridge.round_id
   join public.outcome_courts court_row on court_row.id = round_row.court_id
   where bridge.auction_sale_id = 'c4470000-0000-4000-8000-000000000010'),
  'test_tj_testville',
  'a live unverified sale is attached by its explicit label'
);
select results_eq(
  $$select corrected_count, blocked_count from public.reconcile_catalogue_competent_courts()$$,
  $$values (0::bigint, 0::bigint)$$,
  'the live reconciliation is idempotent'
);

select * from finish();
rollback;
