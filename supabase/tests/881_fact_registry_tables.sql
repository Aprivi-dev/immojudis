-- 20261116100000 à 20261116100400 : fondations du registre des pièces (lot R1, étapes M1 à M3b).
--   * quatre tables fermées aux rôles de l'API (RLS sans politique, lecture seule pour service_role), sans clé
--     étrangère vers auction_sales, lues par aucune vue ;
--   * champs et préséance de départ : cinq champs, « keep_and_review » partout, visites verrouillées ; admin 10,
--     lawyer_form 20, lawyer_email 30, document 50 tenables, listing 60 jamais ;
--   * journal des décisions et évènements en ajout seul (UPDATE, DELETE, TRUNCATE : 55000 et message), même en
--     session_replication_role = replica ; ordre par seq (séquence commune aux deux journaux depuis
--     20261117100000, voir 884), date imposée par la base ;
--   * publication automatique impossible, acceptation par un administrateur existant seulement, motif en liste
--     fermée (aucun texte libre), valeur recevable seulement (occupation : libre, occupé, loué) ;
--   * auction_fact_claims : trois origines de plus, réservées aux fonctions du serveur ; vidage refusé ;
--   * auction_sales.held_fields : nulle, sans défaut, objet JSON seulement, invisible des rôles du navigateur.
begin;

set local timezone = 'UTC';

select plan(98);

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
  (select array_agg(relation.name || ':' || privilege.name order by relation.name collate "C", privilege.name collate "C")
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
  $$update public.auction_fact_fields set hold_enabled = false where field_key = 'property.rooms_count'$$,
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

-- Aucune vue ne lit le registre ni held_fields (une vue créée sans option s'exécute avec les droits de son
-- propriétaire et les exposerait à qui peut la lire).
select is(
  (select count(*)::integer from information_schema.view_table_usage
     where table_schema = 'public' and table_name in (
       'auction_fact_fields', 'auction_fact_source_precedence', 'auction_fact_claim_decisions',
       'auction_sale_field_hold_events')),
  0,
  'no view reads a registry table'
);

select is(
  (select count(*)::integer from information_schema.view_column_usage
     where table_schema = 'public' and table_name = 'auction_sales' and column_name = 'held_fields'),
  0,
  'no view reads auction_sales.held_fields'
);

select is(
  (select array_agg(routine.pronamespace::regnamespace::text || '.' || routine.proname order by routine.proname)
     from pg_proc routine
     where routine.prosrc like '%app.sale_field_projection%'),
  array[
    'app_private.hold_projected_sale_fields', 'app_private.project_sale_fields',
    'app_private.refuse_sale_field_projection_marker'
  ]::text[],
  'only the projection, the hold function and the marker guard name the projection marker'
);

-- Données de départ ---------------------------------------------------------------------------------------------
select results_eq(
  $$select field_key, held_columns, value_type, on_listing_change, hold_enabled
      from public.auction_fact_fields order by field_key collate "C"$$,
  $$values
      ('property.land_surface_m2', array['land_surface_m2'], 'numeric', 'keep_and_review', true),
      ('property.occupancy_status', array['occupancy_status'], 'enum', 'keep_and_review', true),
      ('property.rooms_count', array['rooms_count'], 'integer', 'keep_and_review', true),
      ('property.surface_m2',
        array['surface_m2', 'app_surface_m2', 'app_surface_kind', 'surface_source', 'surface_confidence'],
        'numeric', 'keep_and_review', true),
      ('sale.visit_dates', array['visit_dates'], 'date_list', 'keep_and_review', false)$$,
  'five fields: the listing change keeps the piece and asks for a review, visits cannot be held'
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
  $$update public.auction_fact_fields set hold_enabled = true where field_key = 'sale.visit_dates'$$,
  '23514',
  'new row for relation "auction_fact_fields" violates check constraint "auction_fact_fields_visit_dates_locked"',
  'visit dates are locked: they cannot be made holdable in data'
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
-- a1 : administrateur ; a2 : compte sans droit d'administration ; a3 : identifiant sans compte.
insert into auth.users (id) values
  ('88100000-0000-4000-8000-0000000000a1'), ('88100000-0000-4000-8000-0000000000a2');
insert into public.user_profiles (user_id, email, user_role) values
  ('88100000-0000-4000-8000-0000000000a1', 'registre-admin-881@example.test', 'admin'),
  ('88100000-0000-4000-8000-0000000000a2', 'registre-user-881@example.test', 'user')
on conflict (user_id) do update set user_role = excluded.user_role;

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
        '88100000-0000-4000-8000-0000000000a1'),
      -- Valeurs que le registre ne peut pas tenir, et un champ hors registre.
      ('88100000-2000-4000-8000-000000000004', '88100000-1000-4000-8000-000000000001',
        'property.surface_m2', '"abc"'::jsonb, 'professional_email', '{}'::jsonb, 'information_agent', 'v1',
        '88100000-0000-4000-8000-0000000000a1'),
      ('88100000-2000-4000-8000-000000000005', '88100000-1000-4000-8000-000000000001',
        'property.occupancy_status', '"owner_occupied"'::jsonb, 'professional_email', '{}'::jsonb,
        'information_agent', 'v1', '88100000-0000-4000-8000-0000000000a1'),
      ('88100000-2000-4000-8000-000000000006', '88100000-1000-4000-8000-000000000001',
        'property.occupancy_status', '"squatted"'::jsonb, 'professional_email', '{}'::jsonb,
        'information_agent', 'v1', '88100000-0000-4000-8000-0000000000a1'),
      ('88100000-2000-4000-8000-000000000007', '88100000-1000-4000-8000-000000000001',
        'property.occupancy_status', '"rented"'::jsonb, 'professional_email', '{}'::jsonb,
        'information_agent', 'v1', '88100000-0000-4000-8000-0000000000a1'),
      ('88100000-2000-4000-8000-000000000008', '88100000-1000-4000-8000-000000000001',
        'sale.starting_price_eur', '95000'::jsonb, 'professional_email', '{}'::jsonb,
        'information_agent', 'v1', '88100000-0000-4000-8000-0000000000a1')$$,
  'a server function can insert a fact claim from a professional email, a professional form or an administrator'
);

set local role service_role;
select throws_ok(
  $$insert into public.auction_fact_claims (
      auction_sale_id, field_key, value_jsonb, evidence_kind, source_url
    )
    select '88100000-1000-4000-8000-000000000001', 'property.rooms_count', '3'::jsonb, kind,
      'https://example.test/881/forged'
    from unnest(array['professional_email']) kind$$,
  '42501',
  'A professional or administrator fact claim cannot be inserted by an API role.',
  'the server role cannot insert a fact claim that says it comes from a professional email'
);
select throws_ok(
  $$insert into public.auction_fact_claims (
      auction_sale_id, field_key, value_jsonb, evidence_kind, source_url
    ) values (
      '88100000-1000-4000-8000-000000000001', 'property.rooms_count', '3'::jsonb, 'professional_form',
      'https://example.test/881/forged')$$,
  '42501',
  'A professional or administrator fact claim cannot be inserted by an API role.',
  'nor from a professional form'
);
select throws_ok(
  $$insert into public.auction_fact_claims (
      auction_sale_id, field_key, value_jsonb, evidence_kind, source_url
    ) values (
      '88100000-1000-4000-8000-000000000001', 'property.rooms_count', '3'::jsonb, 'admin_entry',
      'https://example.test/881/forged')$$,
  '42501',
  'A professional or administrator fact claim cannot be inserted by an API role.',
  'nor from an administrator'
);
select lives_ok(
  $$insert into public.auction_fact_claims (
      auction_sale_id, field_key, value_jsonb, evidence_kind, source_url
    ) values
      ('88100000-1000-4000-8000-000000000001', 'property.rooms_count', '3'::jsonb, 'source_listing',
        'https://example.test/881/sale-1'),
      ('88100000-1000-4000-8000-000000000001', 'property.rooms_count', '4'::jsonb, 'source_document',
        'https://example.test/881/cahier.pdf')$$,
  'the server role inserts listing and document fact claims as before'
);
reset role;

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

-- Journal des décisions : forme ---------------------------------------------------------------------------------
select ok(
  (select bool_and(attidentity = '' and attnotnull and not atthasdef) and count(*) = 2 from pg_attribute
     where attrelid in (
       'public.auction_fact_claim_decisions'::regclass, 'public.auction_sale_field_hold_events'::regclass)
       and attname = 'seq')
  and (select bool_and(prosrc like '%new.seq := pg_catalog.nextval(''app_private.fact_registry_seq''::regclass)%')
         and count(*) = 2
       from pg_proc where oid in (
         'app_private.validate_auction_fact_claim_decision()'::regprocedure,
         'app_private.stamp_fact_registry_event()'::regprocedure)),
  'both journals are ordered by a number that their insert trigger takes from the common sequence, never from the writer'
);

select hasnt_column(
  'public', 'auction_fact_claim_decisions', 'reason', 'the journal has no free-text reason'
);

select is(
  (select array_agg(attname::text order by attname) from pg_attribute attribute
     join pg_type type on type.oid = attribute.atttypid
     where attribute.attrelid in (
       'public.auction_fact_claim_decisions'::regclass, 'public.auction_sale_field_hold_events'::regclass)
       and attribute.attnum > 0 and not attribute.attisdropped
       and type.typname in ('text', 'varchar', 'bpchar')
       and attribute.attname not in (
         'field_key', 'decision', 'lot_attachment', 'actor_kind', 'reason_code', 'recipient_kind',
         'publication_mode', 'event')),
  array['lot_ref']::text[],
  'apart from the lot label (40 characters at most), every text column of the journals is a closed list'
);

-- Le libellé du lot : un motif structurel (20261117100100), écrit sans BETWEEN.
select is(
  (select pg_get_constraintdef(constraint_row.oid) from pg_constraint constraint_row
     where constraint_row.conrelid = 'public.auction_fact_claim_decisions'::regclass
       and constraint_row.conname = 'auction_fact_claim_decisions_lot_ref_check'),
  $def$CHECK (((lot_ref IS NULL) OR (lot_ref ~* '^((lots? )?(n[°º] ?)?[1-9][0-9]{0,2}[a-z]?( ?(et|,|-|à) ?[1-9][0-9]{0,2}[a-z]?){0,3}|[1-9][0-9]{0,2}(er|e|ème|eme|nd)? lot)$'::text)))$def$,
  'the lot label is bounded by one anchored structural pattern, without BETWEEN'
);

-- Libellés acceptés : ceux que la collecte lit dans les annonces et les documents. Refusés : tout mot libre, tout
-- numéro de plus de trois chiffres ou à zéro initial, toute date écrite avec « / ». Limite connue, tenue ici pour
-- qu'elle ne change pas sans être vue : une suite de deux à quatre groupes de un à trois chiffres a la forme
-- d'une liste de lots et passe (« 612-345-678 » comme « lots 685,686,687 »).
select results_eq(
  $$select sample.label, sample.lot_ref is null
           or sample.lot_ref ~* '^((lots? )?(n[°º] ?)?[1-9][0-9]{0,2}[a-z]?( ?(et|,|-|à) ?[1-9][0-9]{0,2}[a-z]?){0,3}|[1-9][0-9]{0,2}(er|e|ème|eme|nd)? lot)$'
      from (values
        (1, 'null', null::text), (2, 'lot 2', 'lot 2'), (3, 'Lot 14', 'Lot 14'), (4, 'lots 2 et 3', 'lots 2 et 3'),
        (5, 'lots 1-2', 'lots 1-2'), (6, 'Lot n° 3', 'Lot n° 3'), (7, 'lots n° 1 et 2', 'lots n° 1 et 2'),
        (8, 'bare number', '12'), (9, 'letter suffix', 'lot 3B'), (10, 'four lots', 'LOTS 1, 2, 3 et 4'),
        (11, 'ordinal', '2ème lot'), (12, 'range', 'lots 5 à 8'),
        (13, 'three lots of three digits', 'lots 685,686,687'), (14, 'digit groups', '612-345-678'),
        (20, 'name and phone', 'M. Jean Dupont 06 12 34 56 78'),
        (21, 'name and address', 'Mme Martin, 12 rue des Lilas (Paris)'),
        (22, 'phone with dashes', '06-12-34-56-78'), (23, 'phone', '0612345678'), (24, 'word', 'lot unique'),
        (25, 'name', 'lot Dupont'), (26, 'five lots', 'lots 1, 2, 3, 4 et 5'), (27, 'empty', ''),
        (28, 'blank', '   '), (29, 'leading space', ' lot 2'), (30, 'email', 'lot 2 a.b@example.test'),
        (31, 'trailing newline', E'lot 2\n'), (32, 'inner newline', E'lot\n2'), (33, 'url', 'https://example.test/2'),
        (34, 'five digits', 'lot 12345'), (35, 'trailing words', 'lot 2 de la copropriété'),
        (36, 'four digits', 'lot 1024'), (37, 'date with slashes', '12/11/1985'),
        (38, 'short date with slashes', '1/2/1980'), (39, 'card number', '4532-7153-3790-1241'),
        (40, 'phone with country code', '33-612-3456-78'), (41, 'slash list', 'lots 1/2'),
        (42, 'non-breaking space', 'lot' || chr(160) || '2'), (43, 'leading zero', 'lot 02'),
        (44, 'five numbers', '1-2-3-4-5')
      ) sample(position, label, lot_ref) order by sample.position$$,
  $$values ('null', true), ('lot 2', true), ('Lot 14', true), ('lots 2 et 3', true), ('lots 1-2', true),
           ('Lot n° 3', true), ('lots n° 1 et 2', true), ('bare number', true), ('letter suffix', true),
           ('four lots', true), ('ordinal', true), ('range', true), ('three lots of three digits', true),
           ('digit groups', true),
           ('name and phone', false), ('name and address', false), ('phone with dashes', false), ('phone', false),
           ('word', false), ('name', false), ('five lots', false), ('empty', false), ('blank', false),
           ('leading space', false), ('email', false), ('trailing newline', false), ('inner newline', false),
           ('url', false), ('five digits', false), ('trailing words', false), ('four digits', false),
           ('date with slashes', false), ('short date with slashes', false), ('card number', false),
           ('phone with country code', false), ('slash list', false), ('non-breaking space', false),
           ('leading zero', false), ('five numbers', false)$$,
  'the pattern takes lot numbers as the collection reads them, three digits at most each, and no free word, long number or date with slashes; four groups of three digits at most still have the shape of a lot list'
);

select throws_ok(
  $$insert into public.auction_fact_claim_decisions (
      claim_id, sale_id, field_key, decision, lot_attachment, lot_ref, actor_kind, actor_id
    ) values (
      '88100000-2000-4000-8000-000000000001', '88100000-1000-4000-8000-000000000001',
      'property.surface_m2', 'rejected', 'unknown', 'M. Jean Dupont 06 12 34 56 78', 'admin',
      '88100000-0000-4000-8000-0000000000a1')$$,
  '23514',
  'new row for relation "auction_fact_claim_decisions" violates check constraint "auction_fact_claim_decisions_lot_ref_check"',
  'the journal refuses a lot label that is not a lot label'
);

-- Journal des décisions : contraintes -------------------------------------------------------------------------
select lives_ok(
  $$insert into public.auction_fact_claim_decisions (
      id, claim_id, sale_id, field_key, decision, lot_attachment, actor_kind, actor_id, recipient_kind,
      received_at, information_agent_fact_id, decided_at
    ) values (
      '88100000-4000-4000-8000-000000000001', '88100000-2000-4000-8000-000000000001',
      '88100000-1000-4000-8000-000000000001', 'property.surface_m2', 'accepted', 'single_lot', 'admin',
      '88100000-0000-4000-8000-0000000000a1', 'source_lawyer', '2026-10-12 09:00:00+00',
      '88100000-5000-4000-8000-000000000001', '2999-01-01 00:00:00+00')$$,
  'an administrator acceptance is journaled'
);

select results_eq(
  $$select publication_mode, decided_at between statement_timestamp() - interval '1 hour'
             and clock_timestamp()
      from public.auction_fact_claim_decisions where id = '88100000-4000-4000-8000-000000000001'$$,
  $$values ('manual', true)$$,
  'a decision is manual by default and dated by the database, whatever date the writer gives'
);

-- Sans le déclencheur de validation, une décision n'a pas de numéro : l'insertion échoue au lieu de passer sans
-- ordre (seq est NOT NULL et n'a pas de valeur par défaut). Le numéro qu'un écrivain fournit est remplacé : 884.
alter table public.auction_fact_claim_decisions disable trigger auction_fact_claim_decisions_validate;
select throws_ok(
  $$insert into public.auction_fact_claim_decisions (
      claim_id, sale_id, field_key, decision, lot_attachment, actor_kind, actor_id
    ) values (
      '88100000-2000-4000-8000-000000000002', '88100000-1000-4000-8000-000000000001',
      'property.rooms_count', 'accepted', 'single_lot', 'admin', '88100000-0000-4000-8000-0000000000a1')$$,
  '23502',
  null,
  'without its insert trigger a decision gets no order and is refused'
);
alter table public.auction_fact_claim_decisions enable always trigger auction_fact_claim_decisions_validate;

select throws_ok(
  $$insert into public.auction_fact_claim_decisions (
      claim_id, sale_id, field_key, decision, lot_attachment, actor_kind, actor_id, publication_mode
    ) values (
      '88100000-2000-4000-8000-000000000002', '88100000-1000-4000-8000-000000000001',
      'property.rooms_count', 'accepted', 'single_lot', 'admin', '88100000-0000-4000-8000-0000000000a1',
      'auto')$$,
  '23514',
  'new row for relation "auction_fact_claim_decisions" violates check constraint "auction_fact_claim_decisions_auto_locked"',
  'automatic publication is locked: no decision can be automatic'
);

-- Qui peut accepter : un administrateur existant, et personne d'autre.
select throws_ok(
  $$insert into public.auction_fact_claim_decisions (
      claim_id, sale_id, field_key, decision, lot_attachment, actor_kind
    ) values (
      '88100000-2000-4000-8000-000000000002', '88100000-1000-4000-8000-000000000001',
      'property.rooms_count', 'accepted', 'single_lot', 'system')$$,
  '23514',
  'new row for relation "auction_fact_claim_decisions" violates check constraint "auction_fact_claim_decisions_accepted_by_admin"',
  'the system never accepts a piece'
);

select throws_ok(
  $$insert into public.auction_fact_claim_decisions (
      claim_id, sale_id, field_key, decision, lot_attachment, actor_kind, actor_id
    ) values (
      '88100000-2000-4000-8000-000000000002', '88100000-1000-4000-8000-000000000001',
      'property.rooms_count', 'accepted', 'single_lot', 'lawyer', '88100000-0000-4000-8000-0000000000a1')$$,
  '23514',
  'new row for relation "auction_fact_claim_decisions" violates check constraint "auction_fact_claim_decisions_accepted_by_admin"',
  'a lawyer cannot accept a piece alone: the answer is an observation, accepted by a member of the team'
);

select throws_ok(
  $$insert into public.auction_fact_claim_decisions (
      claim_id, sale_id, field_key, decision, lot_attachment, actor_kind, actor_id
    ) values (
      '88100000-2000-4000-8000-000000000002', '88100000-1000-4000-8000-000000000001',
      'property.rooms_count', 'accepted', 'single_lot', 'admin', '88100000-0000-4000-8000-0000000000a3')$$,
  '42501',
  'A fact claim is accepted by an existing administrator.',
  'an acceptance by an administrator that does not exist is refused'
);

select throws_ok(
  $$insert into public.auction_fact_claim_decisions (
      claim_id, sale_id, field_key, decision, lot_attachment, actor_kind, actor_id
    ) values (
      '88100000-2000-4000-8000-000000000002', '88100000-1000-4000-8000-000000000001',
      'property.rooms_count', 'accepted', 'single_lot', 'admin', '88100000-0000-4000-8000-0000000000a2')$$,
  '42501',
  'A fact claim is accepted by an existing administrator.',
  'an acceptance by an account that is not an administrator is refused'
);

select throws_ok(
  $$insert into public.auction_fact_claim_decisions (
      claim_id, sale_id, field_key, decision, lot_attachment, actor_kind, reason_code
    ) values (
      '88100000-2000-4000-8000-000000000002', '88100000-1000-4000-8000-000000000001',
      'property.rooms_count', 'rejected', 'single_lot', 'admin', 'other')$$,
  '23514',
  'new row for relation "auction_fact_claim_decisions" violates check constraint "auction_fact_claim_decisions_admin_actor"',
  'an administrator decision names its administrator'
);

-- Motifs : liste fermée par type de décision, aucun texte libre.
select throws_ok(
  $$insert into public.auction_fact_claim_decisions (
      claim_id, sale_id, field_key, decision, lot_attachment, actor_kind
    ) values (
      '88100000-2000-4000-8000-000000000001', '88100000-1000-4000-8000-000000000001',
      'property.surface_m2', 'withdrawn', 'single_lot', 'system')$$,
  '23514',
  'new row for relation "auction_fact_claim_decisions" violates check constraint "auction_fact_claim_decisions_reason_code_check"',
  'a withdrawal says why'
);

select throws_ok(
  $$insert into public.auction_fact_claim_decisions (
      claim_id, sale_id, field_key, decision, lot_attachment, actor_kind, reason_code
    ) values (
      '88100000-2000-4000-8000-000000000001', '88100000-1000-4000-8000-000000000001',
      'property.surface_m2', 'withdrawn', 'single_lot', 'system',
      'Le cabinet de Maître Untel a rappelé.')$$,
  '23514',
  'new row for relation "auction_fact_claim_decisions" violates check constraint "auction_fact_claim_decisions_reason_code_check"',
  'a reason is a code of the closed list, never a free text'
);

select throws_ok(
  $$insert into public.auction_fact_claim_decisions (
      claim_id, sale_id, field_key, decision, lot_attachment, actor_kind, reason_code
    ) values (
      '88100000-2000-4000-8000-000000000001', '88100000-1000-4000-8000-000000000001',
      'property.surface_m2', 'rejected', 'single_lot', 'system', 'professional_opposition')$$,
  '23514',
  'new row for relation "auction_fact_claim_decisions" violates check constraint "auction_fact_claim_decisions_reason_code_check"',
  'a reason code belongs to the list of its decision'
);

select throws_ok(
  $$insert into public.auction_fact_claim_decisions (
      claim_id, sale_id, field_key, decision, lot_attachment, actor_kind, actor_id, reason_code
    ) values (
      '88100000-2000-4000-8000-000000000002', '88100000-1000-4000-8000-000000000001',
      'property.rooms_count', 'accepted', 'single_lot', 'admin', '88100000-0000-4000-8000-0000000000a1',
      'other')$$,
  '23514',
  'new row for relation "auction_fact_claim_decisions" violates check constraint "auction_fact_claim_decisions_reason_code_check"',
  'an acceptance carries no reason'
);

select lives_ok(
  $$insert into public.auction_fact_claim_decisions (
      claim_id, sale_id, field_key, decision, lot_attachment, actor_kind, reason_code
    )
    select '88100000-2000-4000-8000-000000000002', '88100000-1000-4000-8000-000000000001',
      'property.rooms_count', reason.decision, 'single_lot', 'system', reason.code
    from (values
      ('rejected', 'already_known'), ('rejected', 'other_lot'), ('rejected', 'doubtful_statement'),
      ('rejected', 'implausible_value'), ('rejected', 'other'),
      ('withdrawn', 'entry_error'), ('withdrawn', 'other_lot'), ('withdrawn', 'authorization_withdrawn'),
      ('withdrawn', 'replaced_by_source'), ('withdrawn', 'other'),
      ('opposed', 'professional_opposition'), ('opposed', 'other'),
      ('contradicted', 'by_listing'), ('contradicted', 'by_document'), ('contradicted', 'by_professional'),
      ('contradicted', 'other')
    ) reason(decision, code)$$,
  'the sixteen reason codes of the four non-accepting decisions are journaled'
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

-- Valeur recevable seulement.
select throws_ok(
  $$insert into public.auction_fact_claim_decisions (
      claim_id, sale_id, field_key, decision, lot_attachment, actor_kind, actor_id
    ) values (
      '88100000-2000-4000-8000-000000000004', '88100000-1000-4000-8000-000000000001',
      'property.surface_m2', 'accepted', 'single_lot', 'admin', '88100000-0000-4000-8000-0000000000a1')$$,
  '22023',
  'An accepted fact claim must carry a value that the registry can hold.',
  'a piece whose value the registry cannot hold is refused at acceptance, not ignored later'
);

select throws_ok(
  $$insert into public.auction_fact_claim_decisions (
      claim_id, sale_id, field_key, decision, lot_attachment, actor_kind, actor_id
    ) values (
      '88100000-2000-4000-8000-000000000005', '88100000-1000-4000-8000-000000000001',
      'property.occupancy_status', 'accepted', 'single_lot', 'admin', '88100000-0000-4000-8000-0000000000a1')$$,
  '22023',
  'An accepted fact claim must carry a value that the registry can hold.',
  'occupancy: « occupied by the owner » says who occupies and is never accepted'
);

select throws_ok(
  $$insert into public.auction_fact_claim_decisions (
      claim_id, sale_id, field_key, decision, lot_attachment, actor_kind, actor_id
    ) values (
      '88100000-2000-4000-8000-000000000006', '88100000-1000-4000-8000-000000000001',
      'property.occupancy_status', 'accepted', 'single_lot', 'admin', '88100000-0000-4000-8000-0000000000a1')$$,
  '22023',
  'An accepted fact claim must carry a value that the registry can hold.',
  'occupancy: « squatted » says why and is never accepted'
);

select lives_ok(
  $$insert into public.auction_fact_claim_decisions (
      claim_id, sale_id, field_key, decision, lot_attachment, actor_kind, actor_id
    ) values
      ('88100000-2000-4000-8000-000000000007', '88100000-1000-4000-8000-000000000001',
        'property.occupancy_status', 'accepted', 'single_lot', 'admin', '88100000-0000-4000-8000-0000000000a1'),
      ('88100000-2000-4000-8000-000000000008', '88100000-1000-4000-8000-000000000001',
        'sale.starting_price_eur', 'accepted', 'single_lot', 'admin', '88100000-0000-4000-8000-0000000000a1')$$,
  'occupancy « rented » is accepted, and so is a decision on a field that the registry does not hold'
);

select ok(
  app_private.sale_field_claim_value('property.occupancy_status', '"vacant"'::jsonb) = '"vacant"'::jsonb
  and app_private.sale_field_claim_value('property.occupancy_status', '"occupied"'::jsonb) = '"occupied"'::jsonb
  and app_private.sale_field_claim_value('property.occupancy_status', '"rented"'::jsonb) = '"rented"'::jsonb
  and app_private.sale_field_claim_value('property.occupancy_status', '"owner_occupied"'::jsonb) is null
  and app_private.sale_field_claim_value('property.occupancy_status', '"squatted"'::jsonb) is null
  and app_private.sale_field_claim_value('property.occupancy_status', '"unknown"'::jsonb) is null,
  'the registry holds three occupancy values and no other: vacant, occupied, rented'
);

-- Cohérence avec l'observation.
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
      claim_id, sale_id, field_key, decision, lot_attachment, actor_kind, actor_id, reason_code,
      supersedes_decision_id
    ) values (
      '88100000-2000-4000-8000-000000000001', '88100000-1000-4000-8000-000000000001',
      'property.surface_m2', 'withdrawn', 'single_lot', 'admin', '88100000-0000-4000-8000-0000000000a1',
      'entry_error', '88100000-4000-4000-8000-000000000002')$$,
  '23514',
  'A fact claim decision can only supersede a decision of the same fact claim.',
  'a decision only supersedes a decision of the same fact claim'
);

-- Idempotence d'un fait relu : un double clic est refusé, une nouvelle acceptation nomme ce qu'elle remplace ---
select throws_ok(
  $$insert into public.auction_fact_claim_decisions (
      claim_id, sale_id, field_key, decision, lot_attachment, actor_kind, actor_id, information_agent_fact_id
    ) values (
      '88100000-2000-4000-8000-000000000001', '88100000-1000-4000-8000-000000000001',
      'property.surface_m2', 'accepted', 'single_lot', 'admin', '88100000-0000-4000-8000-0000000000a1',
      '88100000-5000-4000-8000-000000000001')$$,
  '23505',
  'duplicate key value violates unique constraint "auction_fact_claim_decisions_fact_accepted_key"',
  'a second acceptance of the same reviewed answer (double click) is refused'
);

select lives_ok(
  $$insert into public.auction_fact_claim_decisions (
      id, claim_id, sale_id, field_key, decision, lot_attachment, actor_kind, actor_id, reason_code,
      information_agent_fact_id
    ) values (
      '88100000-4000-4000-8000-000000000003', '88100000-2000-4000-8000-000000000001',
      '88100000-1000-4000-8000-000000000001', 'property.surface_m2', 'withdrawn', 'single_lot', 'admin',
      '88100000-0000-4000-8000-0000000000a1', 'entry_error', '88100000-5000-4000-8000-000000000001')$$,
  'the acceptance is withdrawn by mistake'
);

select throws_ok(
  $$insert into public.auction_fact_claim_decisions (
      claim_id, sale_id, field_key, decision, lot_attachment, actor_kind, actor_id, information_agent_fact_id
    ) values (
      '88100000-2000-4000-8000-000000000001', '88100000-1000-4000-8000-000000000001',
      'property.surface_m2', 'accepted', 'single_lot', 'admin', '88100000-0000-4000-8000-0000000000a1',
      '88100000-5000-4000-8000-000000000001')$$,
  '23505',
  'duplicate key value violates unique constraint "auction_fact_claim_decisions_fact_accepted_key"',
  'accepting the same answer again without naming what it replaces is still refused'
);

select lives_ok(
  $$insert into public.auction_fact_claim_decisions (
      id, claim_id, sale_id, field_key, decision, lot_attachment, actor_kind, actor_id,
      information_agent_fact_id, supersedes_decision_id
    ) values (
      '88100000-4000-4000-8000-000000000004', '88100000-2000-4000-8000-000000000001',
      '88100000-1000-4000-8000-000000000001', 'property.surface_m2', 'accepted', 'unknown', 'admin',
      '88100000-0000-4000-8000-0000000000a1', '88100000-5000-4000-8000-000000000001',
      '88100000-4000-4000-8000-000000000003')$$,
  'the same answer can be accepted again when the new acceptance names the withdrawal it replaces'
);

select throws_ok(
  $$insert into public.auction_fact_claim_decisions (
      claim_id, sale_id, field_key, decision, lot_attachment, actor_kind, actor_id,
      information_agent_fact_id, supersedes_decision_id
    ) values (
      '88100000-2000-4000-8000-000000000001', '88100000-1000-4000-8000-000000000001',
      'property.surface_m2', 'accepted', 'unknown', 'admin', '88100000-0000-4000-8000-0000000000a1',
      '88100000-5000-4000-8000-000000000001', '88100000-4000-4000-8000-000000000003')$$,
  '23505',
  'duplicate key value violates unique constraint "auction_fact_claim_decisions_fact_accepted_key"',
  'a double click on that second acceptance is refused too'
);

select lives_ok(
  $$insert into public.auction_fact_claim_decisions (
      claim_id, sale_id, field_key, decision, lot_attachment, lot_ref, actor_kind, actor_id,
      information_agent_fact_id, supersedes_decision_id
    ) values (
      '88100000-2000-4000-8000-000000000001', '88100000-1000-4000-8000-000000000001',
      'property.surface_m2', 'accepted', 'matched', 'lot 2', 'admin', '88100000-0000-4000-8000-0000000000a1',
      '88100000-5000-4000-8000-000000000001', '88100000-4000-4000-8000-000000000004')$$,
  'the lot attachment of an accepted answer can be corrected from unknown to matched by a new acceptance'
);

select is(
  (select array_agg(decision || ':' || lot_attachment order by seq)
     from public.auction_fact_claim_decisions
     where claim_id = '88100000-2000-4000-8000-000000000001'),
  array['accepted:single_lot', 'withdrawn:single_lot', 'accepted:unknown', 'accepted:matched'],
  'the journal keeps the four decisions of that answer in the order they were taken'
);

-- Ajout seul : journal des décisions --------------------------------------------------------------------------
select throws_ok(
  $$update public.auction_fact_claim_decisions set decision = 'rejected', reason_code = 'other'
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
  id, sale_id, field_key, event, held_value, listing_value, incoming_value, decision_id, created_at
) values (
  '88100000-6000-4000-8000-000000000001', '88100000-1000-4000-8000-000000000001', 'property.surface_m2',
  'listing_changed_kept', '54'::jsonb, '50'::jsonb, '60'::jsonb, '88100000-4000-4000-8000-000000000001',
  '2999-01-01 00:00:00+00'
);

select ok(
  (select created_at <= clock_timestamp() from public.auction_sale_field_hold_events
     where id = '88100000-6000-4000-8000-000000000001'),
  'a hold event is dated by the database, whatever date the writer gives'
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
  'a hold event is one of the seven known events'
);

select throws_ok(
  $$insert into public.auction_sale_field_hold_events (sale_id, field_key, event)
      values ('88100000-1000-4000-8000-000000000001', 'sale.starting_price_eur', 'conflicted')$$,
  '23503',
  null,
  'a hold event names a field of the catalogue'
);

-- Les gardes restent actives quand les déclencheurs ordinaires sont coupés (session_replication_role) --------
select is(
  (select array_agg(trigger_row.tgname::text order by trigger_row.tgname)
     from pg_trigger trigger_row
     join pg_class relation on relation.oid = trigger_row.tgrelid
     where not trigger_row.tgisinternal and trigger_row.tgenabled = 'A'
       and relation.relnamespace = 'public'::regnamespace),
  array[
    'aaab_auction_sales_held_fields_insert_guard', 'aaab_auction_sales_held_fields_marker_guard',
    'aaab_auction_sales_held_fields_role_guard',
    'aaab_auction_sales_hold_projected_fields', 'auction_fact_claim_decisions_append_only',
    'auction_fact_claim_decisions_no_truncate', 'auction_fact_claim_decisions_validate',
    'auction_fact_claims_no_truncate', 'auction_fact_claims_registry_origin_guard',
    'auction_sale_field_hold_events_append_only', 'auction_sale_field_hold_events_no_truncate',
    'auction_sale_field_hold_events_stamp'
  ]::text[],
  'the twelve triggers of the registry, and no other trigger of the public schema, fire always'
);

set local session_replication_role = replica;

select throws_ok(
  $$update public.auction_fact_claim_decisions set decision = 'rejected', reason_code = 'other'
      where id = '88100000-4000-4000-8000-000000000001'$$,
  '55000',
  'public.auction_fact_claim_decisions est en ajout seul : ni modification, ni suppression, ni vidage.',
  'replica mode: a journaled decision still cannot be updated'
);

select throws_ok(
  $$delete from public.auction_sale_field_hold_events where id = '88100000-6000-4000-8000-000000000001'$$,
  '55000',
  'public.auction_sale_field_hold_events est en ajout seul : ni modification, ni suppression, ni vidage.',
  'replica mode: a hold event still cannot be deleted'
);

select throws_ok(
  'truncate table public.auction_fact_claim_decisions, public.auction_sale_field_hold_events',
  '55000',
  'public.auction_fact_claim_decisions est en ajout seul : ni modification, ni suppression, ni vidage.',
  'replica mode: the journals still cannot be truncated'
);

select throws_ok(
  'truncate table public.auction_fact_claims cascade',
  '55000',
  'Fact claims cannot be truncated; supersede or withdraw them.',
  'replica mode: fact claims still cannot be truncated'
);

select throws_ok(
  $$insert into public.auction_fact_claim_decisions (
      claim_id, sale_id, field_key, decision, lot_attachment, actor_kind, actor_id
    ) values (
      '88100000-2000-4000-8000-000000000002', '88100000-1000-4000-8000-000000000001',
      'property.rooms_count', 'accepted', 'single_lot', 'admin', '88100000-0000-4000-8000-0000000000a3')$$,
  '42501',
  'A fact claim is accepted by an existing administrator.',
  'replica mode: a decision is still validated'
);

select throws_ok(
  $$update public.auction_sales set held_fields = '{"property.rooms_count": {"value": 9}}'::jsonb
      where id = '88100000-1000-4000-8000-000000000001'$$,
  '42501',
  'auction_sales.held_fields is written only by app_private.project_sale_fields.',
  'replica mode: held_fields still cannot be written outside the projection'
);

select throws_ok(
  $$insert into public.auction_sales (source_name, source_url, held_fields)
      values ('licitor', 'https://example.test/881/forged', '{"property.rooms_count": {"value": 9}}'::jsonb)$$,
  '42501',
  'A new auction sale holds no field: auction_sales.held_fields is written only by app_private.project_sale_fields.',
  'replica mode: a new sale still cannot be inserted with held fields'
);

set local session_replication_role = origin;

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
      claim_id, sale_id, field_key, decision, lot_attachment, actor_kind, actor_id, reason_code
    ) values (
      '88100000-2000-4000-8000-000000000003', '88100000-1000-4000-8000-000000000002',
      'property.rooms_count', 'withdrawn', 'single_lot', 'admin', '88100000-0000-4000-8000-0000000000a1',
      'other')$$,
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
