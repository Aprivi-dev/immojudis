-- 20261116100000 à 20261116100400 : fondations du registre des pièces (lot R1, étapes M1 à M3b).
--   * quatre tables fermées aux rôles de l'API (RLS sans politique, lecture seule pour service_role), sans clé
--     étrangère vers auction_sales ;
--   * champs et préséance de départ : cinq champs, « keep_and_review » partout, visites non tenables ; admin 10,
--     lawyer_form 20, lawyer_email 30, document 50 tenables, listing 60 jamais ;
--   * journal des décisions et évènements en ajout seul (UPDATE, DELETE, TRUNCATE : 55000 et message) ;
--   * publication automatique impossible (auction_fact_claim_decisions_auto_locked), acceptation toujours humaine ;
--   * auction_fact_claims : trois origines de plus, vidage refusé ;
--   * auction_sales.held_fields : nulle, sans défaut, objet JSON seulement, invisible des rôles du navigateur.
begin;

set local timezone = 'UTC';

select plan(56);

-- Structure, droits, RLS ---------------------------------------------------------------------------------------
select has_table('public', 'auction_fact_fields', 'the field catalogue exists');
select has_table('public', 'auction_fact_source_precedence', 'the source precedence exists');
select has_table('public', 'auction_fact_claim_decisions', 'the decision journal exists');
select has_table('public', 'auction_sale_field_hold_events', 'the hold event queue exists');

select is(
  (select count(*)::integer from pg_class
     where oid in (
       'public.auction_fact_fields'::regclass, 'public.auction_fact_source_precedence'::regclass,
       'public.auction_fact_claim_decisions'::regclass, 'public.auction_sale_field_hold_events'::regclass)
       and relrowsecurity),
  4,
  'row level security is on for the four registry tables'
);

select is(
  (select count(*)::integer from pg_policies
     where schemaname = 'public' and tablename in (
       'auction_fact_fields', 'auction_fact_source_precedence', 'auction_fact_claim_decisions',
       'auction_sale_field_hold_events')),
  0,
  'no policy opens a registry table'
);

select is(
  (select count(*)::integer
     from unnest(array[
       'public.auction_fact_fields', 'public.auction_fact_source_precedence',
       'public.auction_fact_claim_decisions', 'public.auction_sale_field_hold_events']) relation(name)
     cross join unnest(array['anon', 'authenticated']) api_role(name)
     cross join unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'])
       privilege(name)
     where has_table_privilege(api_role.name, relation.name, privilege.name)),
  0,
  'browser roles hold no privilege on any registry table'
);

select is(
  (select array_agg(relation.name || ':' || privilege.name order by relation.name, privilege.name)
     from unnest(array[
       'public.auction_fact_fields', 'public.auction_fact_source_precedence',
       'public.auction_fact_claim_decisions', 'public.auction_sale_field_hold_events']) relation(name)
     cross join unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'])
       privilege(name)
     where has_table_privilege('service_role', relation.name, privilege.name)),
  array[
    'public.auction_fact_claim_decisions:SELECT', 'public.auction_fact_fields:SELECT',
    'public.auction_fact_source_precedence:SELECT', 'public.auction_sale_field_hold_events:SELECT'
  ]::text[],
  'the server role reads the four tables and holds no other privilege on them'
);

set local role authenticated;
select throws_ok(
  'select count(*) from public.auction_fact_claim_decisions',
  '42501',
  null,
  'a signed-in browser session cannot read the decision journal'
);
reset role;

set local role service_role;
select is(
  (select count(*)::integer from public.auction_fact_fields),
  5,
  'the server role reads the field catalogue'
);
select throws_ok(
  $$update public.auction_fact_fields set hold_enabled = true where field_key = 'sale.visit_dates'$$,
  '42501',
  null,
  'the server role cannot change a field setting'
);
select throws_ok(
  $$update public.auction_fact_source_precedence set rank = 1 where source_kind = 'document'$$,
  '42501',
  null,
  'the server role cannot change the precedence'
);
reset role;

select is(
  (select count(*)::integer
     from pg_constraint
     where contype = 'f'
       and conrelid in (
         'public.auction_fact_fields'::regclass, 'public.auction_fact_source_precedence'::regclass,
         'public.auction_fact_claim_decisions'::regclass, 'public.auction_sale_field_hold_events'::regclass)
       and confrelid = 'public.auction_sales'::regclass),
  0,
  'no registry table has a foreign key to auction_sales'
);

-- Données de départ ---------------------------------------------------------------------------------------------
select results_eq(
  $$select field_key, held_columns, value_type, on_listing_change, hold_enabled
      from public.auction_fact_fields order by field_key$$,
  $$values
      ('property.land_surface_m2', array['land_surface_m2'], 'numeric', 'keep_and_review', true),
      ('property.occupancy_status', array['occupancy_status'], 'enum', 'keep_and_review', true),
      ('property.rooms_count', array['rooms_count'], 'integer', 'keep_and_review', true),
      ('property.surface_m2',
        array['surface_m2', 'app_surface_m2', 'app_surface_kind', 'surface_source', 'surface_confidence'],
        'numeric', 'keep_and_review', true),
      ('sale.visit_dates', array['visit_dates'], 'date_list', 'keep_and_review', false)$$,
  'five fields: the listing change keeps the piece and asks for a review, visits cannot be held yet'
);

select results_eq(
  $$select source_kind, rank::integer, can_hold, count(*)::integer
      from public.auction_fact_source_precedence group by 1, 2, 3 order by 2$$,
  $$values
      ('admin', 10, true, 5), ('lawyer_form', 20, true, 5), ('lawyer_email', 30, true, 5),
      ('document', 50, true, 5), ('listing', 60, false, 5)$$,
  'starting precedence: every origin but the listing can hold, for each of the five fields'
);

select throws_ok(
  $$update public.auction_fact_source_precedence set can_hold = true where source_kind = 'listing'$$,
  '23514',
  'new row for relation "auction_fact_source_precedence" violates check constraint "auction_fact_source_precedence_listing_never_holds"',
  'the listing can never hold a field'
);

select throws_ok(
  $$update public.auction_fact_fields set held_columns = array['starting_price_eur']
      where field_key = 'property.rooms_count'$$,
  '23514',
  'new row for relation "auction_fact_fields" violates check constraint "auction_fact_fields_shape"',
  'a field cannot announce a column that the hold trigger does not protect'
);

select throws_ok(
  $$insert into public.auction_fact_fields (field_key, held_columns, value_type)
      values ('sale.starting_price_eur', array['starting_price_eur'], 'numeric')$$,
  '23514',
  'new row for relation "auction_fact_fields" violates check constraint "auction_fact_fields_shape"',
  'a sixth field needs a migration that also teaches it to the hold trigger'
);

-- Jeu d'essai ---------------------------------------------------------------------------------------------------
insert into auth.users (id) values ('88100000-0000-4000-8000-0000000000a1');

insert into public.auction_sales (
  id, source_name, source_url, status, sale_date, city, property_type, starting_price_eur,
  raw_payload, sale_procedure, sale_venue_type, surface_m2, app_surface_m2, rooms_count
) values
  (
    '88100000-1000-4000-8000-000000000001', 'licitor', 'https://example.test/881/sale-1', 'upcoming',
    current_timestamp + interval '20 days', 'Alphaville', 'apartment', 90000,
    '{}'::jsonb, '{}'::jsonb, 'tribunal', 50, 50, 2
  ),
  (
    '88100000-1000-4000-8000-000000000002', 'licitor', 'https://example.test/881/sale-2', 'upcoming',
    current_timestamp + interval '20 days', 'Betaville', 'house', 120000,
    '{}'::jsonb, '{}'::jsonb, 'tribunal', 90, 90, 4
  );

-- Nouvelles origines d'une observation (M2) ------------------------------------------------------------------
select lives_ok(
  $$insert into public.auction_fact_claims (
      id, auction_sale_id, field_key, value_jsonb, evidence_kind, evidence_locator, extractor_name,
      extractor_version, created_by
    ) values
      ('88100000-2000-4000-8000-000000000001', '88100000-1000-4000-8000-000000000001',
        'property.surface_m2', '54'::jsonb, 'professional_email',
        '{"case_id": "88100000-3000-4000-8000-000000000001"}'::jsonb, 'information_agent', 'v1',
        '88100000-0000-4000-8000-0000000000a1'),
      ('88100000-2000-4000-8000-000000000002', '88100000-1000-4000-8000-000000000001',
        'property.rooms_count', '3'::jsonb, 'professional_form', '{}'::jsonb, 'lawyer_form', 'v1',
        '88100000-0000-4000-8000-0000000000a1'),
      ('88100000-2000-4000-8000-000000000003', '88100000-1000-4000-8000-000000000002',
        'property.rooms_count', '5'::jsonb, 'admin_entry', '{}'::jsonb, 'admin_entry', 'v1',
        '88100000-0000-4000-8000-0000000000a1')$$,
  'a fact claim can come from a professional email, a professional form or an administrator entry'
);

select throws_ok(
  $$insert into public.auction_fact_claims (
      auction_sale_id, field_key, value_jsonb, evidence_kind, created_by
    ) values (
      '88100000-1000-4000-8000-000000000001', 'property.rooms_count', '3'::jsonb, 'hearsay',
      '88100000-0000-4000-8000-0000000000a1')$$,
  '23514',
  'new row for relation "auction_fact_claims" violates check constraint "auction_fact_claims_evidence_kind_check"',
  'an unknown origin is still refused'
);

select ok(
  (select convalidated from pg_constraint
     where conrelid = 'public.auction_fact_claims'::regclass
       and conname = 'auction_fact_claims_evidence_kind_check'),
  'the widened evidence_kind constraint is validated'
);

select throws_ok(
  'truncate table public.auction_fact_claims cascade',
  '55000',
  'Fact claims cannot be truncated; supersede or withdraw them.',
  'fact claims cannot be truncated'
);

select throws_ok(
  $$update public.auction_fact_claims set value_jsonb = '99'::jsonb
      where id = '88100000-2000-4000-8000-000000000001'$$,
  '55000',
  'Fact claim observations and provenance are immutable.',
  'the immutability guard of fact claims is untouched'
);

-- Journal des décisions : contraintes -------------------------------------------------------------------------
select lives_ok(
  $$insert into public.auction_fact_claim_decisions (
      id, claim_id, sale_id, field_key, decision, lot_attachment, actor_kind, actor_id, recipient_kind,
      received_at
    ) values (
      '88100000-4000-4000-8000-000000000001', '88100000-2000-4000-8000-000000000001',
      '88100000-1000-4000-8000-000000000001', 'property.surface_m2', 'accepted', 'single_lot', 'admin',
      '88100000-0000-4000-8000-0000000000a1', 'source_lawyer', '2026-11-12 09:00:00+00')$$,
  'an administrator acceptance is journaled'
);

select is(
  (select publication_mode from public.auction_fact_claim_decisions
     where id = '88100000-4000-4000-8000-000000000001'),
  'manual',
  'a decision is manual by default'
);

select throws_ok(
  $$insert into public.auction_fact_claim_decisions (
      claim_id, sale_id, field_key, decision, lot_attachment, actor_kind, actor_id, publication_mode
    ) values (
      '88100000-2000-4000-8000-000000000001', '88100000-1000-4000-8000-000000000001',
      'property.surface_m2', 'accepted', 'single_lot', 'admin', '88100000-0000-4000-8000-0000000000a1',
      'auto')$$,
  '23514',
  'new row for relation "auction_fact_claim_decisions" violates check constraint "auction_fact_claim_decisions_auto_locked"',
  'automatic publication is locked: no decision can be automatic'
);

select throws_ok(
  $$insert into public.auction_fact_claim_decisions (
      claim_id, sale_id, field_key, decision, lot_attachment, actor_kind
    ) values (
      '88100000-2000-4000-8000-000000000001', '88100000-1000-4000-8000-000000000001',
      'property.surface_m2', 'accepted', 'single_lot', 'system')$$,
  '23514',
  'new row for relation "auction_fact_claim_decisions" violates check constraint "auction_fact_claim_decisions_accepted_by_person"',
  'the system never accepts a piece: an acceptance comes from a person'
);

select throws_ok(
  $$insert into public.auction_fact_claim_decisions (
      claim_id, sale_id, field_key, decision, lot_attachment, actor_kind
    ) values (
      '88100000-2000-4000-8000-000000000001', '88100000-1000-4000-8000-000000000001',
      'property.surface_m2', 'accepted', 'single_lot', 'admin')$$,
  '23514',
  'new row for relation "auction_fact_claim_decisions" violates check constraint "auction_fact_claim_decisions_admin_actor"',
  'an administrator decision names its administrator'
);

select throws_ok(
  $$insert into public.auction_fact_claim_decisions (
      claim_id, sale_id, field_key, decision, lot_attachment, actor_kind
    ) values (
      '88100000-2000-4000-8000-000000000001', '88100000-1000-4000-8000-000000000001',
      'property.surface_m2', 'withdrawn', 'single_lot', 'system')$$,
  '23514',
  'new row for relation "auction_fact_claim_decisions" violates check constraint "auction_fact_claim_decisions_reason_check"',
  'a withdrawal says why'
);

select throws_ok(
  $$insert into public.auction_fact_claim_decisions (
      claim_id, sale_id, field_key, decision, lot_attachment, actor_kind, actor_id
    ) values (
      '88100000-2000-4000-8000-000000000001', '88100000-1000-4000-8000-000000000001',
      'property.surface_m2', 'accepted', 'somewhere', 'admin', '88100000-0000-4000-8000-0000000000a1')$$,
  '23514',
  null,
  'the lot attachment is one of the four known judgments'
);

select throws_ok(
  $$insert into public.auction_fact_claim_decisions (
      claim_id, sale_id, field_key, decision, lot_attachment, actor_kind, actor_id
    ) values (
      '88100000-2000-4000-8000-000000000001', '88100000-1000-4000-8000-000000000001',
      'property.rooms_count', 'accepted', 'single_lot', 'admin', '88100000-0000-4000-8000-0000000000a1')$$,
  '23514',
  'A fact claim decision must carry the field of its fact claim.',
  'a decision carries the field of its fact claim'
);

select throws_ok(
  $$insert into public.auction_fact_claim_decisions (
      claim_id, sale_id, field_key, decision, lot_attachment, actor_kind, actor_id
    ) values (
      '88100000-2000-4000-8000-000000000001', '88100000-1000-4000-8000-000000000002',
      'property.surface_m2', 'accepted', 'single_lot', 'admin', '88100000-0000-4000-8000-0000000000a1')$$,
  '23514',
  'A fact claim decision must carry the sale of its fact claim.',
  'a decision carries the sale of its fact claim'
);

select throws_ok(
  $$insert into public.auction_fact_claim_decisions (
      claim_id, sale_id, field_key, decision, lot_attachment, actor_kind, actor_id
    ) values (
      '88100000-2000-4000-8000-0000000000ff', '88100000-1000-4000-8000-000000000001',
      'property.surface_m2', 'accepted', 'single_lot', 'admin', '88100000-0000-4000-8000-0000000000a1')$$,
  '23503',
  'A fact claim decision must name an existing fact claim.',
  'a decision names an existing fact claim'
);

select lives_ok(
  $$insert into public.auction_fact_claim_decisions (
      id, claim_id, sale_id, field_key, decision, lot_attachment, actor_kind, actor_id
    ) values (
      '88100000-4000-4000-8000-000000000002', '88100000-2000-4000-8000-000000000003',
      '88100000-1000-4000-8000-000000000002', 'property.rooms_count', 'accepted', 'single_lot', 'admin',
      '88100000-0000-4000-8000-0000000000a1')$$,
  'a decision on another fact claim is journaled'
);

select throws_ok(
  $$insert into public.auction_fact_claim_decisions (
      claim_id, sale_id, field_key, decision, lot_attachment, actor_kind, actor_id, reason,
      supersedes_decision_id
    ) values (
      '88100000-2000-4000-8000-000000000001', '88100000-1000-4000-8000-000000000001',
      'property.surface_m2', 'withdrawn', 'single_lot', 'admin', '88100000-0000-4000-8000-0000000000a1',
      'Erreur de saisie.', '88100000-4000-4000-8000-000000000002')$$,
  '23514',
  'A fact claim decision can only supersede a decision of the same fact claim.',
  'a decision only supersedes a decision of the same fact claim'
);

select throws_ok(
  $$insert into public.auction_fact_claim_decisions (
      claim_id, sale_id, field_key, decision, lot_attachment, actor_kind, actor_id, information_agent_fact_id
    ) values
      ('88100000-2000-4000-8000-000000000001', '88100000-1000-4000-8000-000000000001',
        'property.surface_m2', 'accepted', 'single_lot', 'admin', '88100000-0000-4000-8000-0000000000a1',
        '88100000-5000-4000-8000-000000000001'),
      ('88100000-2000-4000-8000-000000000001', '88100000-1000-4000-8000-000000000001',
        'property.surface_m2', 'accepted', 'single_lot', 'admin', '88100000-0000-4000-8000-0000000000a1',
        '88100000-5000-4000-8000-000000000001')$$,
  '23505',
  null,
  'one reviewed answer is accepted at most once (idempotent publication)'
);

-- Ajout seul : journal des décisions --------------------------------------------------------------------------
select throws_ok(
  $$update public.auction_fact_claim_decisions set decision = 'rejected', reason = 'Réécriture.'
      where id = '88100000-4000-4000-8000-000000000001'$$,
  '55000',
  'public.auction_fact_claim_decisions est en ajout seul : ni modification, ni suppression, ni vidage.',
  'a journaled decision cannot be updated'
);

select throws_ok(
  $$delete from public.auction_fact_claim_decisions where id = '88100000-4000-4000-8000-000000000001'$$,
  '55000',
  'public.auction_fact_claim_decisions est en ajout seul : ni modification, ni suppression, ni vidage.',
  'a journaled decision cannot be deleted'
);

select throws_ok(
  'truncate table public.auction_fact_claim_decisions cascade',
  '55000',
  'public.auction_fact_claim_decisions est en ajout seul : ni modification, ni suppression, ni vidage.',
  'the decision journal cannot be truncated'
);

select is(
  (select decision from public.auction_fact_claim_decisions
     where id = '88100000-4000-4000-8000-000000000001'),
  'accepted',
  'the journaled decision is intact after the three refused writes'
);

-- Ajout seul : évènements des champs tenus ---------------------------------------------------------------------
insert into public.auction_sale_field_hold_events (
  id, sale_id, field_key, event, held_value, listing_value, incoming_value, decision_id
) values (
  '88100000-6000-4000-8000-000000000001', '88100000-1000-4000-8000-000000000001', 'property.surface_m2',
  'listing_changed_kept', '54'::jsonb, '50'::jsonb, '60'::jsonb, '88100000-4000-4000-8000-000000000001'
);

select throws_ok(
  $$update public.auction_sale_field_hold_events set event = 'conflicted'
      where id = '88100000-6000-4000-8000-000000000001'$$,
  '55000',
  'public.auction_sale_field_hold_events est en ajout seul : ni modification, ni suppression, ni vidage.',
  'a hold event cannot be updated'
);

select throws_ok(
  $$delete from public.auction_sale_field_hold_events where id = '88100000-6000-4000-8000-000000000001'$$,
  '55000',
  'public.auction_sale_field_hold_events est en ajout seul : ni modification, ni suppression, ni vidage.',
  'a hold event cannot be deleted'
);

select throws_ok(
  'truncate table public.auction_sale_field_hold_events',
  '55000',
  'public.auction_sale_field_hold_events est en ajout seul : ni modification, ni suppression, ni vidage.',
  'the hold event queue cannot be truncated'
);

select throws_ok(
  'truncate table public.auction_fact_fields cascade',
  '55000',
  'public.auction_sale_field_hold_events est en ajout seul : ni modification, ni suppression, ni vidage.',
  'truncating the field catalogue in cascade does not empty the event queue either'
);

select throws_ok(
  $$insert into public.auction_sale_field_hold_events (sale_id, field_key, event)
      values ('88100000-1000-4000-8000-000000000001', 'property.surface_m2', 'something_else')$$,
  '23514',
  null,
  'a hold event is one of the five known events'
);

select throws_ok(
  $$insert into public.auction_sale_field_hold_events (sale_id, field_key, event)
      values ('88100000-1000-4000-8000-000000000001', 'sale.starting_price_eur', 'conflicted')$$,
  '23503',
  null,
  'a hold event names a field of the catalogue'
);

-- Le journal survit à la vente : aucune suppression en cascade -------------------------------------------------
-- (une vente ne se supprime qu'avec son pont vers l'Outcome Graph, comme le fait la collecte)
select count(*) from public.bridge_auction_sales_to_outcome_graph();
select lives_ok(
  $$delete from public.auction_sales where id = '88100000-1000-4000-8000-000000000002'$$,
  'a sale with journaled decisions can be deleted (merge or retention)'
);

select is(
  (select count(*)::integer from public.auction_fact_claim_decisions
     where sale_id = '88100000-1000-4000-8000-000000000002'),
  1,
  'the decisions of a deleted sale stay in the journal'
);

select throws_ok(
  $$insert into public.auction_fact_claim_decisions (
      claim_id, sale_id, field_key, decision, lot_attachment, actor_kind, actor_id
    ) values (
      '88100000-2000-4000-8000-000000000003', '88100000-1000-4000-8000-000000000001',
      'property.rooms_count', 'accepted', 'single_lot', 'admin', '88100000-0000-4000-8000-0000000000a1')$$,
  '23514',
  'A detached fact claim can only be decided for a sale named by one of its earlier decisions.',
  'a fact claim detached from its deleted sale cannot be decided for another sale'
);

select lives_ok(
  $$insert into public.auction_fact_claim_decisions (
      claim_id, sale_id, field_key, decision, lot_attachment, actor_kind, actor_id, reason
    ) values (
      '88100000-2000-4000-8000-000000000003', '88100000-1000-4000-8000-000000000002',
      'property.rooms_count', 'withdrawn', 'single_lot', 'admin', '88100000-0000-4000-8000-0000000000a1',
      'Retrait après fusion.')$$,
  'a detached fact claim can still be decided for the sale its earlier decisions name'
);

-- Colonne held_fields (M3) -------------------------------------------------------------------------------------
select col_type_is('public', 'auction_sales', 'held_fields', 'jsonb', 'held_fields is a jsonb column');
select col_is_null('public', 'auction_sales', 'held_fields', 'held_fields is nullable');
select col_hasnt_default('public', 'auction_sales', 'held_fields', 'held_fields has no default');

select ok(
  not has_column_privilege('anon', 'public.auction_sales', 'held_fields', 'SELECT')
  and not has_column_privilege('authenticated', 'public.auction_sales', 'held_fields', 'SELECT')
  and not has_column_privilege('authenticated', 'public.auction_sales', 'held_fields', 'UPDATE')
  and not has_column_privilege('authenticated', 'public.auction_sales', 'held_fields', 'INSERT'),
  'browser roles can neither read nor write held_fields'
);

select ok(
  (select convalidated from pg_constraint
     where conrelid = 'public.auction_sales'::regclass and conname = 'auction_sales_held_fields_shape'),
  'the shape constraint of held_fields is validated'
);

-- La forme est contrôlée même pour la projection (le réglage de transaction qu'elle pose est simulé ici).
select set_config('app.sale_field_projection', '88100000-1000-4000-8000-000000000001', true);
select throws_ok(
  $$update public.auction_sales set held_fields = '[]'::jsonb
      where id = '88100000-1000-4000-8000-000000000001'$$,
  '23514',
  'new row for relation "auction_sales" violates check constraint "auction_sales_held_fields_shape"',
  'held_fields is a JSON object or null'
);
select set_config('app.sale_field_projection', '', true);

select * from finish();
rollback;
