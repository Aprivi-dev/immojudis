-- 20261116100500 : projection app_private.project_sale_fields (lot R1, étape M4).
--   * exécutable par aucun rôle de l'API ; simulation sans écriture, application en un seul UPDATE ;
--   * idempotente : un second appel n'écrit rien ;
--   * une pièce ne tient un champ que si sa DERNIÈRE décision est une acceptation, d'un lot identifié, d'une
--     origine qui peut tenir : un document resté candidat ne tient rien, un document accepté tient, l'annonce
--     ne tient jamais, une origine non classée non plus ;
--   * même dossier, pièce plus récente : elle remplace ; deux origines au même rang qui se contredisent :
--     « conflicted », rien ne bascule ;
--   * retrait, opposition, rejet : la valeur de l'annonce revient ;
--   * les décisions d'une vente absorbée par fusion valent pour la vente conservée.
begin;

set local timezone = 'UTC';

select plan(68);

-- Fonction et droits --------------------------------------------------------------------------------------------
select has_function(
  'app_private', 'project_sale_fields', array['uuid', 'text[]', 'boolean'], 'the projection exists'
);

select ok(
  (select prosecdef and proconfig @> array['search_path=""']::text[] and provolatile = 'v'
          and pg_get_function_result(oid) = 'jsonb'
          and pg_get_function_arguments(oid)
            = 'p_sale_id uuid, p_fields text[] DEFAULT NULL::text[], p_apply boolean DEFAULT false'
     from pg_proc where oid = 'app_private.project_sale_fields(uuid,text[],boolean)'::regprocedure),
  'the projection is volatile, security definer, with an empty search_path, and simulates by default'
);

select is(
  (select count(*)::integer
     from unnest(array[
       'app_private.project_sale_fields(uuid,text[],boolean)',
       'app_private.fact_claim_source_kind(text,text,jsonb)',
       'app_private.sale_field_claim_value(text,jsonb)',
       'app_private.sale_field_comparable(text,jsonb)',
       'app_private.sale_field_values_match(text,jsonb,jsonb,numeric,numeric)',
       'app_private.validate_auction_fact_claim_decision()',
       'app_private.fact_registry_append_only()',
       'app_private.refuse_auction_fact_claims_truncate()']) routine(signature)
     cross join unnest(array['anon', 'authenticated', 'service_role']) api_role(name)
     where has_function_privilege(api_role.name, routine.signature, 'execute')),
  0,
  'no API role can execute the projection or any registry function'
);

-- Jeu d'essai ---------------------------------------------------------------------------------------------------
insert into auth.users (id) values ('88300000-0000-4000-8000-0000000000a1');

insert into public.auction_sales (
  id, source_name, source_url, status, sale_date, city, property_type, starting_price_eur,
  raw_payload, sale_procedure, sale_venue_type,
  surface_m2, app_surface_m2, app_surface_kind, surface_source, surface_confidence,
  land_surface_m2, rooms_count, bedrooms_count, occupancy_status, visit_dates
)
select
  ('88300000-1000-4000-8000-00000000000' || n)::uuid, 'licitor', 'https://example.test/883/sale-' || n,
  'upcoming', current_timestamp + interval '20 days', 'Alphaville', 'house', 90000, '{}'::jsonb,
  '{}'::jsonb, 'tribunal', 50, 50, 'habitable', 'listing_text', 0.7, null, 2, 1, 'occupied', '[]'::jsonb
from generate_series(1, 6) n;

-- Observations. Origines : dossiers d'avocat A, B et C (professional_email), saisie d'administrateur, document,
-- annonce, recherche d'agent (non classée), pont de l'agent d'information d'avant le lot R2.
insert into public.auction_fact_claims (
  id, auction_sale_id, field_key, value_jsonb, evidence_kind, evidence_locator, source_url, confidence_score,
  extractor_name, extractor_version, created_by
) values
  -- Vente 1 : remplacement, retrait, opposition, rejet.
  ('88300000-2000-4000-8000-000000000101', '88300000-1000-4000-8000-000000000001', 'property.surface_m2',
    '54'::jsonb, 'professional_email', '{"case_id": "88300000-3000-4000-8000-00000000000a"}'::jsonb, null,
    0.9, 'information_agent', 'v1', '88300000-0000-4000-8000-0000000000a1'),
  ('88300000-2000-4000-8000-000000000102', '88300000-1000-4000-8000-000000000001', 'property.surface_m2',
    '56'::jsonb, 'professional_email', '{"case_id": "88300000-3000-4000-8000-00000000000a"}'::jsonb, null,
    0.6, 'information_agent', 'v1', '88300000-0000-4000-8000-0000000000a1'),
  ('88300000-2000-4000-8000-000000000103', '88300000-1000-4000-8000-000000000001', 'property.surface_m2',
    '52'::jsonb, 'professional_email', '{"case_id": "88300000-3000-4000-8000-00000000000a"}'::jsonb, null,
    0.6, 'information_agent', 'v1', '88300000-0000-4000-8000-0000000000a1'),
  ('88300000-2000-4000-8000-000000000104', '88300000-1000-4000-8000-000000000001',
    'property.land_surface_m2', '800'::jsonb, 'professional_email',
    '{"case_id": "88300000-3000-4000-8000-00000000000a"}'::jsonb, null, 0.6, 'information_agent', 'v1',
    '88300000-0000-4000-8000-0000000000a1'),
  ('88300000-2000-4000-8000-000000000105', '88300000-1000-4000-8000-000000000001', 'property.rooms_count',
    '3'::jsonb, 'professional_email', '{"case_id": "88300000-3000-4000-8000-00000000000a"}'::jsonb, null,
    0.6, 'information_agent', 'v1', '88300000-0000-4000-8000-0000000000a1'),
  ('88300000-2000-4000-8000-000000000106', '88300000-1000-4000-8000-000000000001', 'property.rooms_count',
    '1'::jsonb, 'admin_entry', '{}'::jsonb, null, null, 'admin_entry', 'v1',
    '88300000-0000-4000-8000-0000000000a1'),
  -- Vente 2 : contradictions.
  ('88300000-2000-4000-8000-000000000201', '88300000-1000-4000-8000-000000000002', 'property.rooms_count',
    '3'::jsonb, 'professional_email', '{"case_id": "88300000-3000-4000-8000-00000000000a"}'::jsonb, null,
    0.6, 'information_agent', 'v1', '88300000-0000-4000-8000-0000000000a1'),
  ('88300000-2000-4000-8000-000000000202', '88300000-1000-4000-8000-000000000002', 'property.rooms_count',
    '4'::jsonb, 'professional_email', '{"case_id": "88300000-3000-4000-8000-00000000000b"}'::jsonb, null,
    0.6, 'information_agent', 'v1', '88300000-0000-4000-8000-0000000000a1'),
  ('88300000-2000-4000-8000-000000000203', '88300000-1000-4000-8000-000000000002', 'property.surface_m2',
    '54'::jsonb, 'professional_email', '{"case_id": "88300000-3000-4000-8000-00000000000a"}'::jsonb, null,
    0.6, 'information_agent', 'v1', '88300000-0000-4000-8000-0000000000a1'),
  ('88300000-2000-4000-8000-000000000204', '88300000-1000-4000-8000-000000000002', 'property.surface_m2',
    '54.5'::jsonb, 'professional_email', '{"case_id": "88300000-3000-4000-8000-00000000000b"}'::jsonb, null,
    0.6, 'information_agent', 'v1', '88300000-0000-4000-8000-0000000000a1'),
  ('88300000-2000-4000-8000-000000000205', '88300000-1000-4000-8000-000000000002',
    'property.occupancy_status', '"vacant"'::jsonb, 'professional_email',
    '{"case_id": "88300000-3000-4000-8000-00000000000a"}'::jsonb, null, 0.6, 'information_agent', 'v1',
    '88300000-0000-4000-8000-0000000000a1'),
  ('88300000-2000-4000-8000-000000000206', '88300000-1000-4000-8000-000000000002',
    'property.occupancy_status', '"rented"'::jsonb, 'professional_email',
    '{"case_id": "88300000-3000-4000-8000-00000000000b"}'::jsonb, null, 0.6, 'information_agent', 'v1',
    '88300000-0000-4000-8000-0000000000a1'),
  ('88300000-2000-4000-8000-000000000207', '88300000-1000-4000-8000-000000000002',
    'property.land_surface_m2', '800'::jsonb, 'professional_email',
    '{"case_id": "88300000-3000-4000-8000-00000000000a"}'::jsonb, null, 0.6, 'information_agent', 'v1',
    '88300000-0000-4000-8000-0000000000a1'),
  ('88300000-2000-4000-8000-000000000208', '88300000-1000-4000-8000-000000000002',
    'property.land_surface_m2', '700'::jsonb, 'professional_email',
    '{"case_id": "88300000-3000-4000-8000-00000000000b"}'::jsonb, null, 0.6, 'information_agent', 'v1',
    '88300000-0000-4000-8000-0000000000a1'),
  ('88300000-2000-4000-8000-000000000209', '88300000-1000-4000-8000-000000000002',
    'property.land_surface_m2', '900'::jsonb, 'professional_email',
    '{"case_id": "88300000-3000-4000-8000-00000000000c"}'::jsonb, null, 0.6, 'information_agent', 'v1',
    '88300000-0000-4000-8000-0000000000a1'),
  ('88300000-2000-4000-8000-000000000210', '88300000-1000-4000-8000-000000000002', 'property.rooms_count',
    '5'::jsonb, 'admin_entry', '{}'::jsonb, null, null, 'admin_entry', 'v1',
    '88300000-0000-4000-8000-0000000000a1'),
  -- Vente 3 : lots et origines.
  ('88300000-2000-4000-8000-000000000301', '88300000-1000-4000-8000-000000000003', 'property.rooms_count',
    '3'::jsonb, 'professional_email', '{"case_id": "88300000-3000-4000-8000-00000000000a"}'::jsonb, null,
    0.6, 'information_agent', 'v1', '88300000-0000-4000-8000-0000000000a1'),
  ('88300000-2000-4000-8000-000000000302', '88300000-1000-4000-8000-000000000003',
    'property.occupancy_status', '"rented"'::jsonb, 'source_document', '{}'::jsonb,
    'https://example.test/883/cahier.pdf', 0.5, 'immojudis-fact-claims', 'v1', null),
  ('88300000-2000-4000-8000-000000000303', '88300000-1000-4000-8000-000000000003',
    'property.occupancy_status', '"vacant"'::jsonb, 'professional_email',
    '{"case_id": "88300000-3000-4000-8000-00000000000a"}'::jsonb, null, 0.6, 'information_agent', 'v1',
    '88300000-0000-4000-8000-0000000000a1'),
  ('88300000-2000-4000-8000-000000000304', '88300000-1000-4000-8000-000000000003', 'property.surface_m2',
    '48'::jsonb, 'source_listing', '{}'::jsonb, 'https://example.test/883/sale-3', 0.5,
    'immojudis-fact-claims', 'v1', null),
  ('88300000-2000-4000-8000-000000000305', '88300000-1000-4000-8000-000000000003',
    'property.land_surface_m2', '500'::jsonb, 'agent_research', '{}'::jsonb,
    'https://example.test/883/recherche', 0.5, 'research_agent', 'v1', null),
  ('88300000-2000-4000-8000-000000000306', '88300000-1000-4000-8000-000000000003', 'property.surface_m2',
    '"abc"'::jsonb, 'professional_email', '{"case_id": "88300000-3000-4000-8000-00000000000a"}'::jsonb, null,
    0.6, 'information_agent', 'v1', '88300000-0000-4000-8000-0000000000a1'),
  -- Vente 5, absorbée plus bas par la vente 4.
  ('88300000-2000-4000-8000-000000000501', '88300000-1000-4000-8000-000000000005', 'property.rooms_count',
    '4'::jsonb, 'professional_email', '{"case_id": "88300000-3000-4000-8000-00000000000a"}'::jsonb, null,
    0.6, 'information_agent', 'v1', '88300000-0000-4000-8000-0000000000a1');

-- Observation déjà « acceptée » dans auction_fact_claims (ancien statut), sans décision au journal.
insert into public.auction_fact_claims (
  id, auction_sale_id, field_key, value_jsonb, claim_status, evidence_kind, evidence_locator, extractor_name,
  extractor_version, created_by, resolution_actor_type, resolution_actor_id, resolved_at
) values (
  '88300000-2000-4000-8000-000000000601', '88300000-1000-4000-8000-000000000006', 'property.rooms_count',
  '3'::jsonb, 'accepted', 'manual_review',
  '{"information_agent_fact_id": "88300000-5000-4000-8000-000000000001",
    "case_id": "88300000-3000-4000-8000-00000000000a"}'::jsonb,
  'information_agent', 'reviewed_v1', '88300000-0000-4000-8000-0000000000a1', 'human',
  '88300000-0000-4000-8000-0000000000a1', statement_timestamp()
);

-- Décision d'un administrateur sur une observation (la vente et le champ sont ceux de l'observation).
prepare decide(text, text, text, timestamptz, text) as
  insert into public.auction_fact_claim_decisions (
    claim_id, sale_id, field_key, decision, lot_attachment, actor_kind, actor_id, reason, recipient_kind,
    received_at
  )
  select claim.id, claim.auction_sale_id, claim.field_key, $2, $3, 'admin',
    '88300000-0000-4000-8000-0000000000a1', $5, 'source_lawyer', $4
  from public.auction_fact_claims claim
  where claim.id = ('88300000-2000-4000-8000-000000000' || $1)::uuid;

-- Vente sans décision ------------------------------------------------------------------------------------------
select is(
  app_private.project_sale_fields('88300000-1000-4000-8000-000000000001'),
  '{
     "sale_id": "88300000-1000-4000-8000-000000000001", "applied": false, "changed": false,
     "fields": {
       "property.land_surface_m2": {"state": "pass_through"},
       "property.occupancy_status": {"state": "pass_through"},
       "property.rooms_count": {"state": "pass_through"},
       "property.surface_m2": {"state": "pass_through"},
       "sale.visit_dates": {"state": "pass_through"}
     }
   }'::jsonb,
  'a sale without any decision passes its five fields through'
);

-- Simulation puis application ---------------------------------------------------------------------------------
execute decide('101', 'accepted', 'single_lot', '2026-11-12 09:00:00+00', null);

create temporary table projection_marks on commit drop as
select 'before'::text as step, ctid as row_version, updated_at
from public.auction_sales where id = '88300000-1000-4000-8000-000000000001';

create temporary table projection_results on commit drop as
select 'simulation'::text as step,
  app_private.project_sale_fields('88300000-1000-4000-8000-000000000001', null, false) as result;

select is(
  (select result - 'fields' from projection_results where step = 'simulation'),
  '{"sale_id": "88300000-1000-4000-8000-000000000001", "applied": false, "changed": true}'::jsonb,
  'the simulation announces a change'
);

select is(
  (select (result #> '{fields,property.surface_m2}') - 'decision_id' from projection_results
     where step = 'simulation'),
  '{"state": "held", "value": 54, "claim_id": "88300000-2000-4000-8000-000000000101"}'::jsonb,
  'the simulation says which piece would hold the surface'
);

select ok(
  (select sale.ctid = mark.row_version and sale.updated_at = mark.updated_at and sale.held_fields is null
          and sale.surface_m2 = 50
     from public.auction_sales sale, projection_marks mark
     where sale.id = '88300000-1000-4000-8000-000000000001' and mark.step = 'before')
  and not exists (select 1 from public.auction_sale_field_hold_events
                  where sale_id = '88300000-1000-4000-8000-000000000001'),
  'the simulation writes nothing: neither the sale nor an event'
);

insert into projection_results
select 'apply', app_private.project_sale_fields('88300000-1000-4000-8000-000000000001', null, true);

select is(
  (select result -> 'fields' from projection_results where step = 'apply'),
  (select result -> 'fields' from projection_results where step = 'simulation'),
  'applying gives the result that the simulation announced'
);

select results_eq(
  $$select surface_m2, app_surface_m2, app_surface_kind, surface_source, surface_confidence, rooms_count,
           occupancy_status
      from public.auction_sales where id = '88300000-1000-4000-8000-000000000001'$$,
  $$values (54::numeric, 54::numeric, 'fact_registry_lawyer_email', 'fact_registry_lawyer_email',
            0.9::numeric, 2, 'occupied')$$,
  'the accepted surface is written with its whole group; the other fields keep the listing values'
);

select is(
  (select (held_fields #> '{property.surface_m2}') - 'decision_id'
     from public.auction_sales where id = '88300000-1000-4000-8000-000000000001'),
  '{
     "v": 1, "value": 54, "state": "held",
     "listing": {"surface_m2": 50, "app_surface_m2": 50, "app_surface_kind": "habitable",
                 "surface_source": "listing_text", "surface_confidence": 0.7},
     "claim_id": "88300000-2000-4000-8000-000000000101", "source_kind": "lawyer_email", "rank": 30,
     "received_on": "2026-11-12", "publication_mode": "manual", "recipient_kind": "source_lawyer",
     "tolerance": {"abs": 1, "rel": 0.02}, "on_listing_change": "keep_and_review"
   }'::jsonb,
  'the held entry carries the value, the listing values to restore, the provenance and the setting, no text'
);

select ok(
  (select sale.updated_at > mark.updated_at from public.auction_sales sale, projection_marks mark
     where sale.id = '88300000-1000-4000-8000-000000000001' and mark.step = 'before'),
  'applying advances updated_at (stale optimistic writes of the collection give up)'
);

select results_eq(
  $$select field_key, event, held_value, listing_value, incoming_value,
           decision_id = (select id from public.auction_fact_claim_decisions
                            where claim_id = '88300000-2000-4000-8000-000000000101')
      from public.auction_sale_field_hold_events
      where sale_id = '88300000-1000-4000-8000-000000000001'$$,
  $$values ('property.surface_m2', 'projection_held', '54'::jsonb, '50'::jsonb, null::jsonb, true)$$,
  'the first hold is journaled with the held value, the listing value and its decision'
);

-- Idempotence ------------------------------------------------------------------------------------------------------
-- (xmin ne distingue pas deux écritures d'une même transaction : la version physique de la ligne, ctid, si.)
insert into projection_marks
select 'applied', ctid, updated_at from public.auction_sales
where id = '88300000-1000-4000-8000-000000000001';

select is(
  app_private.project_sale_fields('88300000-1000-4000-8000-000000000001', null, true)
    - 'sale_id' #- '{fields,property.surface_m2,decision_id}',
  '{
     "applied": true, "changed": false,
     "fields": {
       "property.land_surface_m2": {"state": "pass_through"},
       "property.occupancy_status": {"state": "pass_through"},
       "property.rooms_count": {"state": "pass_through"},
       "property.surface_m2": {
         "state": "unchanged", "value": 54, "claim_id": "88300000-2000-4000-8000-000000000101"},
       "sale.visit_dates": {"state": "pass_through"}
     }
   }'::jsonb,
  'a second projection changes nothing'
);

select ok(
  (select sale.ctid = mark.row_version and sale.updated_at = mark.updated_at
     from public.auction_sales sale, projection_marks mark
     where sale.id = '88300000-1000-4000-8000-000000000001' and mark.step = 'applied')
  and (select count(*) = 1 from public.auction_sale_field_hold_events
         where sale_id = '88300000-1000-4000-8000-000000000001'),
  'idempotent: the second projection rewrites neither the row nor updated_at, and journals nothing'
);

-- Même dossier, pièce plus récente : elle remplace ---------------------------------------------------------------
execute decide('102', 'accepted', 'single_lot', '2026-11-14 09:00:00+00', null);

select is(
  app_private.project_sale_fields('88300000-1000-4000-8000-000000000001', array['property.surface_m2'], true)
    #> '{fields}' #- '{property.surface_m2,decision_id}',
  '{"property.surface_m2": {
      "state": "held", "value": 56, "claim_id": "88300000-2000-4000-8000-000000000102"}}'::jsonb,
  'a later message of the same case replaces the piece; only the requested field is computed'
);

select results_eq(
  $$select surface_m2, app_surface_m2, surface_confidence, held_fields #> '{property.surface_m2,listing,surface_m2}',
           held_fields #>> '{property.surface_m2,received_on}'
      from public.auction_sales where id = '88300000-1000-4000-8000-000000000001'$$,
  $$values (56::numeric, 56::numeric, 0.85::numeric, '50'::jsonb, '2026-11-14')$$,
  'the replacement is not cancelled by the hold trigger, and the listing block still holds the listing value'
);

-- Une pièce plus ancienne du même dossier, acceptée après coup, ne reprend pas la main.
execute decide('103', 'accepted', 'single_lot', '2026-11-10 09:00:00+00', null);

select is(
  app_private.project_sale_fields('88300000-1000-4000-8000-000000000001', null, true)
    #>> '{fields,property.surface_m2,state}',
  'unchanged',
  'the most recently received piece of a case holds, not the most recently accepted one'
);

-- Retrait : la pièce précédente du dossier, encore acceptée, reprend ; puis l'annonce ---------------------------
execute decide('102', 'withdrawn', 'single_lot', null, 'Erreur de lecture.');

select is(
  (app_private.project_sale_fields('88300000-1000-4000-8000-000000000001', null, true)
    #> '{fields,property.surface_m2}') - 'decision_id',
  '{"state": "held", "value": 54, "claim_id": "88300000-2000-4000-8000-000000000101"}'::jsonb,
  'withdrawing the latest piece gives the field to the previous piece of the case that is still accepted'
);

execute decide('101', 'withdrawn', 'single_lot', null, 'Erreur de lecture.');
execute decide('103', 'withdrawn', 'single_lot', null, 'Erreur de lecture.');

select is(
  app_private.project_sale_fields('88300000-1000-4000-8000-000000000001', null, true)
    #> '{fields,property.surface_m2}',
  '{"state": "released", "released": true, "listing_value": 50}'::jsonb,
  'once every piece is withdrawn, the field is released'
);

select results_eq(
  $$select surface_m2, app_surface_m2, app_surface_kind, surface_source, surface_confidence, held_fields
      from public.auction_sales where id = '88300000-1000-4000-8000-000000000001'$$,
  $$values (50::numeric, 50::numeric, 'habitable', 'listing_text', 0.7::numeric, null::jsonb)$$,
  'withdrawal restores the listing value of the whole surface group and empties held_fields'
);

select results_eq(
  $$select event, held_value, listing_value from public.auction_sale_field_hold_events
      where sale_id = '88300000-1000-4000-8000-000000000001' and event = 'projection_released'$$,
  $$values ('projection_released', '54'::jsonb, '50'::jsonb)$$,
  'the release is journaled with the value that was held and the listing value that came back'
);

-- Opposition de l'avocat : retour à une annonce qui ne disait rien ---------------------------------------------
execute decide('104', 'accepted', 'single_lot', '2026-11-12 09:00:00+00', null);
select app_private.project_sale_fields('88300000-1000-4000-8000-000000000001', null, true) ->> 'changed';

select results_eq(
  $$select land_surface_m2, held_fields #> '{property.land_surface_m2,listing}'
      from public.auction_sales where id = '88300000-1000-4000-8000-000000000001'$$,
  $$values (800::numeric, '{}'::jsonb)$$,
  'a piece can fill a field that the listing left empty'
);

insert into public.auction_fact_claim_decisions (
  claim_id, sale_id, field_key, decision, lot_attachment, actor_kind, reason
) values (
  '88300000-2000-4000-8000-000000000104', '88300000-1000-4000-8000-000000000001',
  'property.land_surface_m2', 'opposed', 'single_lot', 'lawyer', 'Opposition du cabinet.'
);

select is(
  app_private.project_sale_fields('88300000-1000-4000-8000-000000000001', null, true)
    #> '{fields,property.land_surface_m2}',
  '{"state": "released", "released": true}'::jsonb,
  'an opposition releases the field'
);

select results_eq(
  $$select land_surface_m2, held_fields from public.auction_sales
      where id = '88300000-1000-4000-8000-000000000001'$$,
  $$values (null::numeric, null::jsonb)$$,
  'opposition restores the empty listing value: the opposed value is no longer displayed'
);

-- Rejet après acceptation -----------------------------------------------------------------------------------------
execute decide('105', 'accepted', 'single_lot', '2026-11-12 09:00:00+00', null);
select app_private.project_sale_fields('88300000-1000-4000-8000-000000000001', null, true) ->> 'changed';
execute decide('105', 'rejected', 'single_lot', null, 'Valeur d''un autre lot.');

select is(
  app_private.project_sale_fields('88300000-1000-4000-8000-000000000001', null, true)
    #>> '{fields,property.rooms_count,state}',
  'released',
  'a later rejection releases the field: only the latest decision of a piece counts'
);

select is(
  (select rooms_count from public.auction_sales where id = '88300000-1000-4000-8000-000000000001'),
  2,
  'the rejected room count gives way to the listing value'
);

-- Une pièce incompatible avec la fiche fait échouer la projection, sans rien écrire ------------------------------
update public.auction_sales set bedrooms_count = 2 where id = '88300000-1000-4000-8000-000000000001';
execute decide('106', 'accepted', 'single_lot', null, null);

select throws_ok(
  $$select app_private.project_sale_fields('88300000-1000-4000-8000-000000000001', null, true)$$,
  '23514',
  'new row for relation "auction_sales" violates check constraint "auction_sales_rooms_bedrooms_check"',
  'a room count below the bedroom count is refused by the table, loudly'
);

select results_eq(
  $$select rooms_count, held_fields from public.auction_sales
      where id = '88300000-1000-4000-8000-000000000001'$$,
  $$values (2, null::jsonb)$$,
  'the refused projection wrote nothing'
);

-- Contradiction de deux origines au même rang, champ libre ----------------------------------------------------
execute decide('201', 'accepted', 'single_lot', '2026-11-12 09:00:00+00', null);
execute decide('202', 'accepted', 'single_lot', '2026-11-13 09:00:00+00', null);

select is(
  app_private.project_sale_fields('88300000-1000-4000-8000-000000000002', array['property.rooms_count'], true)
    #> '{fields,property.rooms_count}' #- '{conflicting,0,decision_id}' #- '{conflicting,1,decision_id}',
  '{"state": "conflicted", "conflicting": [
      {"claim_id": "88300000-2000-4000-8000-000000000202", "value": 4},
      {"claim_id": "88300000-2000-4000-8000-000000000201", "value": 3}]}'::jsonb,
  'two origins of the same rank that disagree are a conflict, with both pieces named'
);

select results_eq(
  $$select rooms_count, held_fields from public.auction_sales
      where id = '88300000-1000-4000-8000-000000000002'$$,
  $$values (2, null::jsonb)$$,
  'a conflict on a free field holds nothing: the listing value stays displayed'
);

select app_private.project_sale_fields('88300000-1000-4000-8000-000000000002', array['property.rooms_count'], true)
  ->> 'changed';

select results_eq(
  $$select event, held_value, jsonb_array_length(incoming_value), decision_id is not null
      from public.auction_sale_field_hold_events
      where sale_id = '88300000-1000-4000-8000-000000000002'$$,
  $$values ('conflicted', null::jsonb, 2, true)$$,
  'the conflict is journaled once for review, even when the projection runs again'
);

-- Une origine de rang plus fort tranche.
execute decide('210', 'accepted', 'single_lot', null, null);

select is(
  (app_private.project_sale_fields('88300000-1000-4000-8000-000000000002', array['property.rooms_count'], true)
    #> '{fields,property.rooms_count}') - 'decision_id',
  '{"state": "held", "value": 5, "claim_id": "88300000-2000-4000-8000-000000000210"}'::jsonb,
  'an administrator entry outranks the two lawyers and holds the field'
);

select is(
  (select (held_fields #> '{property.rooms_count}') - 'decision_id' - 'claim_id' - 'listing' - 'tolerance'
     from public.auction_sales where id = '88300000-1000-4000-8000-000000000002'),
  '{"v": 1, "value": 5, "state": "held", "source_kind": "admin", "rank": 10, "publication_mode": "manual",
    "recipient_kind": "source_lawyer", "on_listing_change": "keep_and_review"}'::jsonb,
  'the entry names the administrator origin and its rank'
);

-- Deux origines qui concordent à la tolérance près : pas de contradiction.
execute decide('203', 'accepted', 'single_lot', '2026-11-12 09:00:00+00', null);
execute decide('204', 'accepted', 'single_lot', '2026-11-13 09:00:00+00', null);

select is(
  (app_private.project_sale_fields('88300000-1000-4000-8000-000000000002', array['property.surface_m2'], true)
    #> '{fields,property.surface_m2}') - 'decision_id',
  '{"state": "held", "value": 54.5, "claim_id": "88300000-2000-4000-8000-000000000204"}'::jsonb,
  'two origins that agree within the tolerance do not conflict: the most recent holds'
);

-- Contradiction sur un champ déjà tenu : l'affichage ne change pas.
execute decide('205', 'accepted', 'single_lot', '2026-11-12 09:00:00+00', null);
select app_private.project_sale_fields('88300000-1000-4000-8000-000000000002', null, true) ->> 'changed';
execute decide('206', 'accepted', 'single_lot', '2026-11-13 09:00:00+00', null);

select is(
  (app_private.project_sale_fields(
    '88300000-1000-4000-8000-000000000002', array['property.occupancy_status'], true)
    #> '{fields,property.occupancy_status}') - 'decision_id' - 'conflicting',
  '{"state": "conflicted", "value": "vacant", "claim_id": "88300000-2000-4000-8000-000000000205"}'::jsonb,
  'a contradiction on a held field is a conflict that keeps the displayed piece'
);

select results_eq(
  $$select occupancy_status, held_fields #>> '{property.occupancy_status,state}',
           held_fields #>> '{property.occupancy_status,claim_id}'
      from public.auction_sales where id = '88300000-1000-4000-8000-000000000002'$$,
  $$values ('vacant', 'conflicted', '88300000-2000-4000-8000-000000000205')$$,
  'no automatic switch: the displayed value is unchanged and the entry is marked conflicted'
);

update public.auction_sales set occupancy_status = 'squatted'
where id = '88300000-1000-4000-8000-000000000002';

select is(
  (select occupancy_status from public.auction_sales where id = '88300000-1000-4000-8000-000000000002'),
  'vacant',
  'a conflicted field is still held against a direct write'
);

execute decide('206', 'withdrawn', 'single_lot', null, 'Réponse d''un autre bien.');

select is(
  (app_private.project_sale_fields(
    '88300000-1000-4000-8000-000000000002', array['property.occupancy_status'], true)
    #> '{fields,property.occupancy_status}') - 'decision_id',
  '{"state": "held", "value": "vacant", "claim_id": "88300000-2000-4000-8000-000000000205"}'::jsonb,
  'once the contradicting piece is withdrawn, the field is plainly held again'
);

-- La pièce qui tenait le champ est contestée pendant que deux autres se contredisent : plus rien ne tient.
execute decide('207', 'accepted', 'single_lot', '2026-11-12 09:00:00+00', null);
select app_private.project_sale_fields('88300000-1000-4000-8000-000000000002', null, true) ->> 'changed';
execute decide('208', 'accepted', 'single_lot', '2026-11-13 09:00:00+00', null);
execute decide('209', 'accepted', 'single_lot', '2026-11-14 09:00:00+00', null);
execute decide('207', 'opposed', 'single_lot', null, 'Opposition du cabinet.');

select is(
  (app_private.project_sale_fields(
    '88300000-1000-4000-8000-000000000002', array['property.land_surface_m2'], true)
    #> '{fields,property.land_surface_m2}') - 'conflicting',
  '{"state": "conflicted", "released": true}'::jsonb,
  'an opposed piece does not stay displayed behind a conflict between two other pieces'
);

select results_eq(
  $$select land_surface_m2, held_fields ? 'property.land_surface_m2'
      from public.auction_sales where id = '88300000-1000-4000-8000-000000000002'$$,
  $$values (null::numeric, false)$$,
  'the opposed land surface is gone and the conflicting pieces hold nothing'
);

select is(
  (select array_agg(event order by event) from public.auction_sale_field_hold_events
     where sale_id = '88300000-1000-4000-8000-000000000002' and field_key = 'property.land_surface_m2'),
  array['conflicted', 'projection_held', 'projection_released'],
  'the hold, its release and the conflict are journaled'
);

-- Lot inconnu ou non rattaché -----------------------------------------------------------------------------------
execute decide('301', 'accepted', 'unknown', '2026-11-12 09:00:00+00', null);

select is(
  app_private.project_sale_fields('88300000-1000-4000-8000-000000000003', null, true)
    #>> '{fields,property.rooms_count,state}',
  'pass_through',
  'an accepted piece whose lot is unknown holds nothing'
);

execute decide('301', 'accepted', 'unmatched', '2026-11-12 09:00:00+00', null);

select is(
  app_private.project_sale_fields('88300000-1000-4000-8000-000000000003', null, true)
    #>> '{fields,property.rooms_count,state}',
  'pass_through',
  'an accepted piece attached to no lot of the sale holds nothing'
);

select results_eq(
  $$select rooms_count, held_fields from public.auction_sales
      where id = '88300000-1000-4000-8000-000000000003'$$,
  $$values (2, null::jsonb)$$,
  'neither piece without an identified lot wrote the sale'
);

insert into public.auction_fact_claim_decisions (
  claim_id, sale_id, field_key, decision, lot_attachment, lot_ref, actor_kind, actor_id, received_at
) values (
  '88300000-2000-4000-8000-000000000301', '88300000-1000-4000-8000-000000000003', 'property.rooms_count',
  'accepted', 'matched', 'lot 2', 'admin', '88300000-0000-4000-8000-0000000000a1', '2026-11-12 09:00:00+00'
);

select is(
  app_private.project_sale_fields('88300000-1000-4000-8000-000000000003', null, true)
    #>> '{fields,property.rooms_count,state}',
  'held',
  'the same piece holds once its lot is matched'
);

select results_eq(
  $$select rooms_count, held_fields #>> '{property.rooms_count,claim_id}'
      from public.auction_sales where id = '88300000-1000-4000-8000-000000000003'$$,
  $$values (3, '88300000-2000-4000-8000-000000000301')$$,
  'the matched piece is displayed'
);

-- Pièce de document : candidate, elle ne tient rien ; acceptée par une personne, elle tient ---------------------
select is(
  app_private.project_sale_fields('88300000-1000-4000-8000-000000000003', null, true)
    #>> '{fields,property.occupancy_status,state}',
  'pass_through',
  'a document observation that is still a candidate (no decision) holds nothing'
);

select results_eq(
  $$select occupancy_status, held_fields ? 'property.occupancy_status'
      from public.auction_sales where id = '88300000-1000-4000-8000-000000000003'$$,
  $$values ('occupied', false)$$,
  'the candidate document did not write the sale'
);

execute decide('302', 'rejected', 'single_lot', null, 'Extrait d''un autre lot.');

select is(
  app_private.project_sale_fields('88300000-1000-4000-8000-000000000003', null, true)
    #>> '{fields,property.occupancy_status,state}',
  'pass_through',
  'a rejected document observation holds nothing'
);

insert into public.auction_fact_claim_decisions (
  claim_id, sale_id, field_key, decision, lot_attachment, actor_kind, actor_id
) values (
  '88300000-2000-4000-8000-000000000302', '88300000-1000-4000-8000-000000000003',
  'property.occupancy_status', 'accepted', 'single_lot', 'admin', '88300000-0000-4000-8000-0000000000a1'
);

select is(
  (app_private.project_sale_fields('88300000-1000-4000-8000-000000000003', null, true)
    #> '{fields,property.occupancy_status}') - 'decision_id',
  '{"state": "held", "value": "rented", "claim_id": "88300000-2000-4000-8000-000000000302"}'::jsonb,
  'a document observation accepted by a person holds the field'
);

select results_eq(
  $$select occupancy_status, held_fields #>> '{property.occupancy_status,source_kind}',
           (held_fields #>> '{property.occupancy_status,rank}')::integer,
           held_fields #> '{property.occupancy_status,listing}'
      from public.auction_sales where id = '88300000-1000-4000-8000-000000000003'$$,
  $$values ('rented', 'document', 50, '{"occupancy_status": "occupied"}'::jsonb)$$,
  'the entry names the document origin, its rank and the listing value to restore'
);

-- Un avocat l'emporte sur un document, sans contradiction (rangs différents).
execute decide('303', 'accepted', 'single_lot', '2026-11-12 09:00:00+00', null);

select is(
  (app_private.project_sale_fields('88300000-1000-4000-8000-000000000003', null, true)
    #> '{fields,property.occupancy_status}') - 'decision_id',
  '{"state": "held", "value": "vacant", "claim_id": "88300000-2000-4000-8000-000000000303"}'::jsonb,
  'a lawyer answer outranks an accepted document and replaces it, without conflict'
);

select is(
  (select held_fields #> '{property.occupancy_status,listing}' from public.auction_sales
     where id = '88300000-1000-4000-8000-000000000003'),
  '{"occupancy_status": "occupied"}'::jsonb,
  'the listing block is still the listing value, not the document value'
);

-- L'annonce ne tient jamais ; une origine non classée non plus ; une valeur irrecevable non plus ---------------
execute decide('304', 'accepted', 'single_lot', null, null);
execute decide('305', 'accepted', 'single_lot', null, null);
execute decide('306', 'accepted', 'single_lot', '2026-11-12 09:00:00+00', null);

select is(
  app_private.project_sale_fields(
    '88300000-1000-4000-8000-000000000003', array['property.surface_m2', 'property.land_surface_m2'], true),
  '{
     "sale_id": "88300000-1000-4000-8000-000000000003", "applied": true, "changed": false,
     "fields": {
       "property.land_surface_m2": {"state": "pass_through"},
       "property.surface_m2": {
         "state": "pass_through", "invalid_claims": ["88300000-2000-4000-8000-000000000306"]}
     }
   }'::jsonb,
  'an accepted listing observation never holds, nor an unclassified origin; an unreadable value is reported'
);

select results_eq(
  $$select surface_m2, land_surface_m2, held_fields ?| array['property.surface_m2', 'property.land_surface_m2']
      from public.auction_sales where id = '88300000-1000-4000-8000-000000000003'$$,
  $$values (50::numeric, null::numeric, false)$$,
  'none of the three wrote the sale'
);

-- Ancien statut « accepted » d'une observation, sans décision au journal -------------------------------------
select is(
  app_private.project_sale_fields('88300000-1000-4000-8000-000000000006', null, true),
  '{
     "sale_id": "88300000-1000-4000-8000-000000000006", "applied": true, "changed": false,
     "fields": {
       "property.land_surface_m2": {"state": "pass_through"},
       "property.occupancy_status": {"state": "pass_through"},
       "property.rooms_count": {"state": "pass_through"},
       "property.surface_m2": {"state": "pass_through"},
       "sale.visit_dates": {"state": "pass_through"}
     }
   }'::jsonb,
  'an observation marked accepted in auction_fact_claims holds nothing without a journaled decision'
);

-- Origine d'une observation (fonction pure) ---------------------------------------------------------------------
select results_eq(
  $$select evidence_kind, extractor_name,
           app_private.fact_claim_source_kind(evidence_kind, extractor_name, evidence_locator)
      from (values
        (1, 'admin_entry', 'admin_entry', '{}'::jsonb),
        (2, 'professional_form', 'lawyer_form', '{}'::jsonb),
        (3, 'professional_email', 'information_agent', '{}'::jsonb),
        (4, 'manual_review', 'information_agent', '{"information_agent_fact_id": "x"}'::jsonb),
        (5, 'email_attachment', 'information_agent', '{"information_agent_fact_id": "x"}'::jsonb),
        (6, 'manual_review', 'information_agent', '{}'::jsonb),
        (7, 'manual_review', 'reviewer', '{"information_agent_fact_id": "x"}'::jsonb),
        (8, 'source_document', 'immojudis-fact-claims', '{}'::jsonb),
        (9, 'source_listing', 'immojudis-fact-claims', '{}'::jsonb),
        (10, 'agent_research', 'research_agent', '{}'::jsonb),
        (11, 'other', null, '{}'::jsonb)
      ) origin(position, evidence_kind, extractor_name, evidence_locator)
      order by position$$,
  $$values
      ('admin_entry', 'admin_entry', 'admin'),
      ('professional_form', 'lawyer_form', 'lawyer_form'),
      ('professional_email', 'information_agent', 'lawyer_email'),
      ('manual_review', 'information_agent', 'lawyer_email'),
      ('email_attachment', 'information_agent', 'lawyer_email'),
      ('manual_review', 'information_agent', null),
      ('manual_review', 'reviewer', null),
      ('source_document', 'immojudis-fact-claims', 'document'),
      ('source_listing', 'immojudis-fact-claims', 'listing'),
      ('agent_research', 'research_agent', null),
      ('other', null, null)$$,
  'the origin of an observation follows its nature; what is not classified has no origin'
);

select ok(
  app_private.sale_field_claim_value('property.surface_m2', '54.5'::jsonb) = '54.5'::jsonb
  and app_private.sale_field_claim_value('property.surface_m2', '0'::jsonb) is null
  and app_private.sale_field_claim_value('property.surface_m2', '"54"'::jsonb) is null
  and app_private.sale_field_claim_value('property.land_surface_m2', '100000001'::jsonb) is null
  and app_private.sale_field_claim_value('property.rooms_count', '3'::jsonb) = '3'::jsonb
  and app_private.sale_field_claim_value('property.rooms_count', '2.5'::jsonb) is null
  and app_private.sale_field_claim_value('property.rooms_count', '101'::jsonb) is null
  and app_private.sale_field_claim_value('property.occupancy_status', '"rented"'::jsonb) = '"rented"'::jsonb
  and app_private.sale_field_claim_value('property.occupancy_status', '"unknown"'::jsonb) is null
  and app_private.sale_field_claim_value('sale.visit_dates', '["2026-11-25", "2026-11-20", "2026-11-25"]'::jsonb)
    = '["2026-11-20", "2026-11-25"]'::jsonb
  and app_private.sale_field_claim_value('sale.visit_dates', '["demain"]'::jsonb) is null
  and app_private.sale_field_claim_value('sale.visit_dates', '[]'::jsonb) is null
  and app_private.sale_field_claim_value('sale.starting_price_eur', '90000'::jsonb) is null,
  'a piece value is checked strictly: type, bounds, known codes; anything else is not a piece'
);

-- Fusion : les décisions de la vente absorbée valent pour la vente conservée -----------------------------------
execute decide('501', 'accepted', 'single_lot', '2026-11-12 09:00:00+00', null);
update public.auction_sales
set source_urls = '["https://example.test/883/sale-4", "https://example.test/883/sale-5"]'::jsonb
where id = '88300000-1000-4000-8000-000000000004';
select count(*) > 0 from public.bridge_auction_sales_to_outcome_graph();
delete from public.auction_sales where id = '88300000-1000-4000-8000-000000000005';

select results_eq(
  $$select claim.auction_sale_id, decision.sale_id, merge.canonical_sale_id
      from public.auction_fact_claims claim
      join public.auction_fact_claim_decisions decision on decision.claim_id = claim.id
      join app_private.auction_sale_merges merge on merge.old_sale_id = decision.sale_id
      where claim.id = '88300000-2000-4000-8000-000000000501'$$,
  $$values (null::uuid, '88300000-1000-4000-8000-000000000005'::uuid,
            '88300000-1000-4000-8000-000000000004'::uuid)$$,
  'after a merge the observation is detached, its decision keeps the absorbed sale, the merge is recorded'
);

select is(
  (app_private.project_sale_fields('88300000-1000-4000-8000-000000000004', null, true)
    #> '{fields,property.rooms_count}') - 'decision_id',
  '{"state": "held", "value": 4, "claim_id": "88300000-2000-4000-8000-000000000501"}'::jsonb,
  'the kept sale is held by the piece accepted on the sale it absorbed'
);

select is(
  (select rooms_count from public.auction_sales where id = '88300000-1000-4000-8000-000000000004'),
  4,
  'the piece of the absorbed sale is displayed on the kept sale'
);

-- Paramètres ---------------------------------------------------------------------------------------------------
select throws_ok(
  $$select app_private.project_sale_fields(
      '88300000-1000-4000-8000-000000000001', array['sale.starting_price_eur'], false)$$,
  '22023',
  'Unknown fact registry field.',
  'an unknown field is refused'
);

select throws_ok(
  $$select app_private.project_sale_fields('88300000-1000-4000-8000-000000000001', array[]::text[], false)$$,
  '22023',
  'Unknown fact registry field.',
  'an empty field list is refused (null means every field)'
);

select throws_ok(
  $$select app_private.project_sale_fields('88300000-1000-4000-8000-0000000000ff', null, true)$$,
  'P0002',
  'Auction sale not found.',
  'an unknown sale is refused'
);

select throws_ok(
  $$select app_private.project_sale_fields(null, null, true)$$,
  '22023',
  'A sale and an apply flag are required.',
  'a sale is required'
);

-- Le réglage de transaction de la projection ne reste pas posé après elle ---------------------------------------
select is(
  current_setting('app.sale_field_projection', true),
  '',
  'the projection marker is cleared after each projection'
);

-- Aucun rôle de l'API n'exécute la projection ------------------------------------------------------------------
set local role service_role;
select throws_ok(
  $$select app_private.project_sale_fields('88300000-1000-4000-8000-000000000001', null, true)$$,
  '42501',
  null,
  'the server role cannot call the projection'
);
reset role;

set local role authenticated;
select throws_ok(
  $$select app_private.project_sale_fields('88300000-1000-4000-8000-000000000001', null, false)$$,
  '42501',
  null,
  'a signed-in browser session cannot call the projection, even to simulate'
);
reset role;

select * from finish();
rollback;
