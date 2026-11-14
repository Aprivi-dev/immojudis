-- 20261119100900 : « Accepter et mettre à jour la fiche » passe par le registre des pièces (lot C, T4).
--   * deux fonctions internes (correspondance clé → champ, champ tenu par le registre), fermées aux rôles de l'API ;
--   * le noyau refuse une occupation que le registre ne tient pas (owner_occupied, squatted), avec un message clair ;
--   * pour un champ tenu, le noyau n'écrit pas la fiche : journal et raw_payload seulement ; le pont crée
--     l'observation sans décision ;
--   * la décision de l'administrateur (son jeton) tient la valeur : la fiche l'affiche, le journal du registre
--     porte la décision, et le bloc « annonce » est la vraie valeur de l'annonce ;
--   * la collecte réécrit la fiche avec l'annonce : la valeur acceptée reste ;
--   * la surface tenue garde sa mention « avocat poursuivant » ; retirée au registre, l'annonce revient et la
--     mention disparaît ;
--   * un champ que le registre ne tient pas (mise à prix) est écrit par le noyau comme avant ; sa décision est
--     journalisée sans rien afficher de plus ;
--   * une pièce publiée porte un libellé neutre (expéditeur, jour, type), jamais le nom du fichier d'origine.
begin;

set local timezone = 'UTC';

select plan(30);

-- Les deux fonctions internes ---------------------------------------------------------------------------------
select ok(
  not exists (
    select 1
    from unnest(array['public', 'anon', 'authenticated', 'service_role']) api_role(name)
    cross join unnest(array[
      'app_private.information_agent_fact_registry_field(text)',
      'app_private.information_agent_fact_held_by_registry(text)']) routine(signature)
    where has_function_privilege(api_role.name, routine.signature, 'EXECUTE')
  ),
  'no API role executes the two internal functions'
);
select results_eq(
  $$select app_private.information_agent_fact_registry_field(fact_key),
           app_private.information_agent_fact_held_by_registry(fact_key)
      from unnest(array['surface_m2', 'land_surface_m2', 'rooms_count', 'occupancy_status',
                        'starting_price_eur', 'sale_date', 'property_type', 'visit_information',
                        'document']) with ordinality as keys(fact_key, ord)
      order by ord$$,
  $$values ('property.surface_m2', true), ('property.land_surface_m2', true),
           ('property.rooms_count', true), ('property.occupancy_status', true),
           ('sale.starting_price_eur', false), ('sale.sale_date', false),
           ('property.property_type', false), (null::text, false), (null::text, false)$$,
  'the four fields of the registry are held for a lawyer reply; price, date and type are not; free text has no field'
);

-- Jeu d'essai --------------------------------------------------------------------------------------------------
insert into auth.users (id) values ('89500000-0000-4000-8000-0000000000a1');
insert into public.user_profiles (user_id, email, user_role) values
  ('89500000-0000-4000-8000-0000000000a1', 'registre-avocat-admin-895@example.test', 'admin')
on conflict (user_id) do update set user_role = excluded.user_role;

-- L'annonce : 40 m² habitables, 2 pièces, occupation inconnue, mise à prix 90 000 €.
insert into public.auction_sales (
  id, source_name, source_url, status, sale_date, city, property_type, starting_price_eur,
  raw_payload, sale_procedure, sale_venue_type,
  surface_m2, app_surface_m2, app_surface_kind, surface_source, surface_confidence, surface_evidence,
  land_surface_m2, rooms_count, bedrooms_count, occupancy_status
) values (
  '89500000-1000-4000-8000-000000000001', 'licitor', 'https://example.test/895/sale', 'upcoming',
  current_timestamp + interval '20 days', 'Alphaville', 'apartment', 90000,
  '{}'::jsonb, '{}'::jsonb, 'tribunal',
  40, 40, 'habitable', 'listing_text', 0.6, 'Appartement de 40 m² habitables',
  null, 2, 1, 'unknown'
);

insert into public.information_agent_cases (
  id, sale_id, created_by, status, recipient_kind, recipient_email, normalized_recipient_email, subject,
  body_text, question_keys, missing_information, sent_at, replied_at
) values (
  '89500000-3000-4000-8000-000000000001', '89500000-1000-4000-8000-000000000001',
  '89500000-0000-4000-8000-0000000000a1', 'replied', 'source_lawyer', 'avocat-895@example.test',
  'avocat-895@example.test', 'Demande d''informations 895',
  'Merci de nous transmettre les informations manquantes.',
  array['surface'], array['surface'], now() - interval '3 days', now() - interval '2 days'
);
insert into public.information_agent_missions (
  id, user_id, sale_id, case_id, status, recipient_email, subject, body_text, question_keys,
  missing_information, privacy_version
) values (
  '89500000-2000-4000-8000-000000000001', '89500000-0000-4000-8000-0000000000a1',
  '89500000-1000-4000-8000-000000000001', '89500000-3000-4000-8000-000000000001', 'sent',
  'avocat-895@example.test', 'Demande d''informations 895',
  'Merci de nous transmettre les informations manquantes.', array['surface'], array['surface'], '895-pgtap'
);
insert into public.information_agent_messages (
  id, mission_id, case_id, user_id, direction, message_kind, delivery_status, subject, body_text,
  received_at, provider_message_id, metadata
) values (
  '89500000-4000-4000-8000-000000000001', '89500000-2000-4000-8000-000000000001',
  '89500000-3000-4000-8000-000000000001', '89500000-0000-4000-8000-0000000000a1',
  'inbound', 'reply', 'received', 'Re: Demande d''informations 895', 'Voici les informations demandées.',
  '2026-11-12 09:30:00+01', 'registre-provider-895',
  '{"imported_manually": false, "sender_authentication": {"status": "pass"}, "sender_matches_recipient": true}'::jsonb
);
insert into public.information_agent_fact_candidates (
  id, case_id, message_id, sale_id, fact_key, proposed_value, display_value, evidence_excerpt, confidence
)
select
  fixture.id::uuid,
  '89500000-3000-4000-8000-000000000001',
  '89500000-4000-4000-8000-000000000001',
  '89500000-1000-4000-8000-000000000001',
  fixture.fact_key,
  jsonb_build_object('value', fixture.value),
  fixture.display_value,
  'Extrait du message 895',
  0.9
from (
  values
    ('89500000-5000-4000-8000-000000000001', 'surface_m2', '54', '54 m²'),
    ('89500000-5000-4000-8000-000000000002', 'rooms_count', '3', '3 pièces'),
    ('89500000-5000-4000-8000-000000000003', 'occupancy_status', 'owner_occupied', 'Occupé par le propriétaire'),
    ('89500000-5000-4000-8000-000000000004', 'occupancy_status', 'squatted', 'Squatté'),
    ('89500000-5000-4000-8000-000000000005', 'starting_price_eur', '95000', '95 000 €')
) as fixture(id, fact_key, value, display_value);

create function pg_temp.sign_in() returns void
language sql as $function$
  select set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', '89500000-0000-4000-8000-0000000000a1', 'role', 'authenticated')::text,
    true);
$function$;
create function pg_temp.claim_of(p_fact uuid) returns uuid
language sql as $function$
  select claim.id from public.auction_fact_claims claim
  where claim.evidence_locator->>'information_agent_fact_id' = p_fact::text
$function$;
-- Le rôle authenticated ne lit pas les observations : leurs identifiants sont relevés avant de changer de rôle.
create temporary table claims (label text primary key, claim_id uuid not null) on commit drop;
grant select on claims to authenticated;
create function pg_temp.remember_claim(p_label text, p_fact uuid) returns void
language sql as $function$
  insert into claims values (p_label, pg_temp.claim_of(p_fact))
$function$;
create temporary table results (label text primary key, result jsonb) on commit drop;
grant select, insert on results to authenticated;

-- L'occupation que le registre ne tient pas est refusée, avec un message clair --------------------------------
select throws_ok(
  $$select public.review_information_agent_fact_candidate(
      '89500000-0000-4000-8000-0000000000a1', '89500000-5000-4000-8000-000000000003', 'accepted', null)$$,
  '22023', 'Occupancy status cannot be displayed: only vacant, occupied or rented can be accepted.',
  'owner_occupied is refused: the registry never says who occupies'
);
select throws_ok(
  $$select public.review_information_agent_fact_candidate(
      '89500000-0000-4000-8000-0000000000a1', '89500000-5000-4000-8000-000000000004', 'accepted', null)$$,
  '22023', 'Occupancy status cannot be displayed: only vacant, occupied or rented can be accepted.',
  'squatted is refused as well'
);
select results_eq(
  $$select status from public.information_agent_fact_candidates
      where id in ('89500000-5000-4000-8000-000000000003', '89500000-5000-4000-8000-000000000004')$$,
  $$values ('pending'), ('pending')$$,
  'a refused acceptance leaves the fact to review (the administrator rejects it)'
);

-- Acceptation d'un champ tenu : le noyau n'écrit pas la fiche ---------------------------------------------------
select is(
  public.review_information_agent_fact_candidate(
    '89500000-0000-4000-8000-0000000000a1', '89500000-5000-4000-8000-000000000001', 'accepted', null)->>'status',
  'accepted',
  'the surface reply is accepted'
);
select results_eq(
  $$select surface_m2, app_surface_m2, app_surface_kind, surface_source, surface_evidence
      from public.auction_sales where id = '89500000-1000-4000-8000-000000000001'$$,
  $$values (40::numeric, 40::numeric, 'habitable', 'listing_text', 'Appartement de 40 m² habitables')$$,
  'the core leaves the surface columns to the registry: the listing is still shown'
);
select ok(
  (select (previous_values->>'surface_m2')::numeric = 40
          and new_values = '{"fact_registry": {"field_key": "property.surface_m2", "value": 54}}'::jsonb
     from public.information_agent_fact_publications
     where fact_id = '89500000-5000-4000-8000-000000000001')
  and (select raw_payload #>> '{information_agent_verified_facts,surface_m2,recipient_kind}' = 'source_lawyer'
         from public.auction_sales where id = '89500000-1000-4000-8000-000000000001'),
  'the journal says the value goes to the registry, and raw_payload keeps the trace read by the mention'
);
set constraints all immediate;
set constraints all deferred;
select ok(
  (select claim.field_key = 'property.surface_m2' and claim.value_jsonb = '54'::jsonb
          and claim.evidence_kind = 'manual_review' and claim.extractor_name = 'information_agent'
     from public.auction_fact_claims claim
     where claim.id = pg_temp.claim_of('89500000-5000-4000-8000-000000000001'))
  and not exists (
    select 1 from public.auction_fact_claim_decisions decision
    where decision.claim_id = pg_temp.claim_of('89500000-5000-4000-8000-000000000001')
  ),
  'the bridge creates the observation without comparing the sale, and without any decision yet'
);
select is(
  (select count(*)::integer from public.get_public_sale_lawyer_fact_sources(
     '89500000-1000-4000-8000-000000000001') where fact_key = 'surface_m2'),
  0,
  'before the decision, the listing value is shown without the lawyer mention'
);

-- La décision de l'administrateur, avec son jeton : la valeur est tenue -----------------------------------------
select pg_temp.remember_claim('surface', '89500000-5000-4000-8000-000000000001');
select pg_temp.sign_in();
set local role authenticated;
select lives_ok(
  $$insert into results select 'surface', public.accept_auction_fact_claim(
      (select claim_id from claims where label = 'surface'), 'single_lot')$$,
  'the signed-in administrator accepts the observation'
);
reset role;
select is(
  (select result->>'state' from results where label = 'surface'),
  'held',
  'the registry holds the surface'
);
select results_eq(
  $$select surface_m2, app_surface_m2, app_surface_kind, surface_source,
           held_fields #>> '{property.surface_m2,state}',
           (held_fields #>> '{property.surface_m2,listing,app_surface_m2}')::numeric
      from public.auction_sales where id = '89500000-1000-4000-8000-000000000001'$$,
  $$values (54::numeric, 54::numeric, 'built', 'fact_registry', 'held', 40::numeric)$$,
  'the sale shows the accepted value, and the listing block keeps the real listing value (40)'
);
select results_eq(
  $$select decision.decision, decision.actor_kind, decision.actor_id, decision.lot_attachment
      from public.auction_fact_claim_decisions decision
      where decision.claim_id = pg_temp.claim_of('89500000-5000-4000-8000-000000000001')$$,
  $$values ('accepted', 'admin', '89500000-0000-4000-8000-0000000000a1'::uuid, 'single_lot')$$,
  'the decision is in the journal of the registry, with its author'
);
select results_eq(
  $$select fact_key, received_on from public.get_public_sale_lawyer_fact_sources(
      '89500000-1000-4000-8000-000000000001')$$,
  $$values ('surface_m2', '2026-11-12'::date)$$,
  'the surface held by the registry carries the lawyer mention'
);

-- Le nombre de pièces, de même ----------------------------------------------------------------------------------
select is(
  public.review_information_agent_fact_candidate(
    '89500000-0000-4000-8000-0000000000a1', '89500000-5000-4000-8000-000000000002', 'accepted', null)->>'status',
  'accepted',
  'the room count reply is accepted'
);
select is(
  (select rooms_count from public.auction_sales where id = '89500000-1000-4000-8000-000000000001'),
  2,
  'the core leaves the room count to the registry'
);
set constraints all immediate;
set constraints all deferred;
select pg_temp.remember_claim('rooms', '89500000-5000-4000-8000-000000000002');
select pg_temp.sign_in();
set local role authenticated;
select lives_ok(
  $$insert into results select 'rooms', public.accept_auction_fact_claim(
      (select claim_id from claims where label = 'rooms'), 'single_lot')$$,
  'the administrator accepts the room count'
);
reset role;
select is(
  (select rooms_count from public.auction_sales where id = '89500000-1000-4000-8000-000000000001'),
  3,
  'the registry holds the room count'
);

-- La collecte réécrit la fiche avec l'annonce : les valeurs acceptées restent ----------------------------------
set local role service_role;
update public.auction_sales set
  surface_m2 = 40, app_surface_m2 = 40, app_surface_kind = 'habitable', surface_source = 'listing_text',
  surface_confidence = 0.6, rooms_count = 2, updated_at = statement_timestamp()
where id = '89500000-1000-4000-8000-000000000001';
reset role;
select results_eq(
  $$select surface_m2, app_surface_m2, surface_source, rooms_count
      from public.auction_sales where id = '89500000-1000-4000-8000-000000000001'$$,
  $$values (54::numeric, 54::numeric, 'fact_registry', 3)$$,
  'the collection rewrites the listing values: the accepted surface and room count stay'
);
select results_eq(
  $$select fact_key from public.get_public_sale_lawyer_fact_sources('89500000-1000-4000-8000-000000000001')$$,
  $$values ('rooms_count'), ('surface_m2')$$,
  'both values keep their mention after the collection'
);

-- Retirée au registre : l'annonce revient, la mention disparaît -------------------------------------------------
select pg_temp.sign_in();
set local role authenticated;
select lives_ok(
  $$insert into results select 'withdrawn', public.withdraw_auction_fact_claim(
      (select claim_id from claims where label = 'surface'), 'entry_error')$$,
  'the administrator withdraws the surface'
);
reset role;
select results_eq(
  $$select surface_m2, app_surface_m2, app_surface_kind, surface_source
      from public.auction_sales where id = '89500000-1000-4000-8000-000000000001'$$,
  $$values (40::numeric, 40::numeric, 'habitable', 'listing_text')$$,
  'withdrawn, the surface goes back to the listing value, not to the lawyer value'
);
select is(
  (select count(*)::integer from public.get_public_sale_lawyer_fact_sources(
     '89500000-1000-4000-8000-000000000001') where fact_key = 'surface_m2'),
  0,
  'and the surface loses its lawyer mention'
);

-- Champ que le registre ne tient pas : écriture du noyau, décision journalisée ---------------------------------
select is(
  public.review_information_agent_fact_candidate(
    '89500000-0000-4000-8000-0000000000a1', '89500000-5000-4000-8000-000000000005', 'accepted', null)->>'status',
  'accepted',
  'the starting price reply is accepted'
);
select is(
  (select starting_price_eur from public.auction_sales where id = '89500000-1000-4000-8000-000000000001'),
  95000::numeric,
  'the core writes a starting price as before: the registry does not hold it'
);
set constraints all immediate;
set constraints all deferred;
select pg_temp.remember_claim('price', '89500000-5000-4000-8000-000000000005');
select pg_temp.sign_in();
set local role authenticated;
select lives_ok(
  $$insert into results select 'price', public.accept_auction_fact_claim(
      (select claim_id from claims where label = 'price'), 'single_lot')$$,
  'its decision is recorded in the journal of the registry'
);
reset role;
select ok(
  (select result->'state' is null or result->'state' = 'null'::jsonb from results where label = 'price')
  and exists (
    select 1 from public.auction_fact_claim_decisions decision
    where decision.claim_id = pg_temp.claim_of('89500000-5000-4000-8000-000000000005')
      and decision.decision = 'accepted'
  ),
  'recorded, not held: no field state for a price, as planned for the fields outside the registry'
);

-- Pièce publiée : un libellé neutre, jamais le nom du fichier d'origine ----------------------------------------
insert into public.information_agent_evidence_assets (
  id, case_id, message_id, sale_id, storage_path, original_filename, mime_type, size_bytes, sha256,
  rights_status, metadata
) values (
  '89500000-6000-4000-8000-000000000001', '89500000-3000-4000-8000-000000000001',
  '89500000-4000-4000-8000-000000000001', '89500000-1000-4000-8000-000000000001',
  '89500000-3000-4000-8000-000000000001/89500000-4000-4000-8000-000000000001/att-1/pv.pdf',
  'PV_Me_Martin_saisie_Durand.pdf', 'application/pdf', 4096,
  'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
  'authorized',
  jsonb_build_object('redaction_verified_at', now(), 'redaction_verified_by', '89500000-0000-4000-8000-0000000000a1')
);
update public.information_agent_evidence_extractions
set status = 'completed', completed_at = now(), document_kind = 'pv_huissier'
where asset_id = '89500000-6000-4000-8000-000000000001';
insert into public.information_agent_fact_candidates (
  id, case_id, message_id, sale_id, fact_key, proposed_value, display_value, confidence, evidence_asset_id
) values (
  '89500000-5000-4000-8000-000000000006', '89500000-3000-4000-8000-000000000001',
  '89500000-4000-4000-8000-000000000001', '89500000-1000-4000-8000-000000000001', 'document',
  jsonb_build_object(
    'value', '89500000-6000-4000-8000-000000000001',
    'public_url', 'https://abcdef.supabase.co/storage/v1/object/public/information-agent-approved/89500000-1000-4000-8000-000000000001/89500000-6000-4000-8000-000000000001/piece-jointe.pdf',
    'public_path', '89500000-1000-4000-8000-000000000001/89500000-6000-4000-8000-000000000001/piece-jointe.pdf'
  ),
  'PV_Me_Martin_saisie_Durand.pdf', 0.9, '89500000-6000-4000-8000-000000000001'
);
select is(
  public.review_information_agent_fact_candidate_with_path(
    '89500000-0000-4000-8000-0000000000a1', '89500000-5000-4000-8000-000000000006', 'accepted', null,
    '89500000-1000-4000-8000-000000000001/89500000-6000-4000-8000-000000000001/piece-jointe.pdf')->>'status',
  'accepted',
  'the document reply is accepted'
);
select results_eq(
  $$select label from public.auction_documents where source_url = 'https://example.test/895/sale'$$,
  $$values ('Pièce transmise par l''avocat poursuivant le 12/11/2026 : procès-verbal descriptif'::text)$$,
  'the published label names the sender, the day of the reply and the type, never the original file name'
);

select * from finish();
rollback;
