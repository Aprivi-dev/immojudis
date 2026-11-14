-- 20261114100000 : noyau de publication de l'agent d'information (proposition 4).
--   * la RPC administrateur garde ses contrôles, ses effets et ses retours, clé par clé ;
--   * chaque publication écrit une ligne de journal : valeurs et provenance précédentes, nouvelles valeurs,
--     auteur réel ('admin'), pas de version de politique ; raw_payload reçoit publication_mode et received_at ;
--   * le journal est fermé aux rôles de l'API (lecture seule pour service_role) ;
--   * le noyau n'est exécutable par aucun rôle de l'API ; 'auto' est refusé par le verrou de l'étape 3
--     (20261115100000, test 880) et aucune fonction ne l'écrit ; le pont vers auction_fact_claims refuse en
--     plus une publication 'auto' (vérifié ici verrou levé) ;
--   * pour 'admin', la claim du pont est identique à aujourd'hui.
begin;

-- Dates comparées dans un fuseau fixe : la session de la CI n'en change pas le jour.
set local timezone = 'UTC';

select plan(59);

-- Structure et droits -------------------------------------------------------------------------------------------
select has_table('public', 'information_agent_fact_publications', 'the publication journal exists');

select ok(
  (select relrowsecurity from pg_class where oid = 'public.information_agent_fact_publications'::regclass)
  and not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'information_agent_fact_publications'
  ),
  'the journal has RLS on and no policy'
);

select ok(
  not has_table_privilege('anon', 'public.information_agent_fact_publications', 'SELECT')
  and not has_table_privilege('authenticated', 'public.information_agent_fact_publications', 'SELECT')
  and not has_table_privilege('authenticated', 'public.information_agent_fact_publications', 'INSERT')
  and has_table_privilege('service_role', 'public.information_agent_fact_publications', 'SELECT')
  and not has_table_privilege('service_role', 'public.information_agent_fact_publications', 'INSERT')
  and not has_table_privilege('service_role', 'public.information_agent_fact_publications', 'UPDATE')
  and not has_table_privilege('service_role', 'public.information_agent_fact_publications', 'DELETE'),
  'browser roles cannot reach the journal; the server reads it but never writes, updates or deletes'
);

select has_function(
  'app_private',
  'apply_information_agent_fact',
  array['uuid', 'text', 'uuid', 'text'],
  'the shared publication core exists'
);

select ok(
  (select prosecdef and proconfig @> array['search_path=""']::text[]
     from pg_proc where oid = 'app_private.apply_information_agent_fact(uuid,text,uuid,text)'::regprocedure)
  and not has_function_privilege('anon', 'app_private.apply_information_agent_fact(uuid,text,uuid,text)', 'execute')
  and not has_function_privilege('authenticated', 'app_private.apply_information_agent_fact(uuid,text,uuid,text)', 'execute')
  and not has_function_privilege('service_role', 'app_private.apply_information_agent_fact(uuid,text,uuid,text)', 'execute'),
  'the core is security definer with an empty search_path and no API role can execute it'
);

select is(
  (select array_agg(p.pronamespace::regnamespace::text || '.' || p.proname order by p.proname)
     from pg_proc p
     where p.prosrc ilike '%apply_information_agent_fact%'
       and p.oid <> 'app_private.apply_information_agent_fact(uuid,text,uuid,text)'::regprocedure),
  array['public.review_information_agent_fact_candidate']::text[],
  'the administrator review RPC is the only function that calls the core'
);

select ok(
  (select prosrc ~ 'apply_information_agent_fact\(p_fact_id, ''admin'', p_reviewer_id, null\)'
          and prosrc !~ '''auto'''
     from pg_proc where oid = 'public.review_information_agent_fact_candidate(uuid,uuid,text,text)'::regprocedure),
  'the review RPC publishes as the reviewing administrator, never as auto'
);

select ok(
  (select prosrc ~ 'Administrator review is required'
     from pg_proc where oid = 'public.review_information_agent_fact_candidate(uuid,uuid,text,text)'::regprocedure)
  and not has_function_privilege('authenticated', 'public.review_information_agent_fact_candidate(uuid,uuid,text,text)', 'execute')
  and not has_function_privilege('anon', 'public.review_information_agent_fact_candidate(uuid,uuid,text,text)', 'execute'),
  'the public review RPC still requires an administrator and stays closed to browser roles'
);

-- Contrainte du journal : 'auto' prévu, mais encadré ----------------------------------------------------------
insert into auth.users (id) values
  ('87800000-0000-4000-8000-0000000000a1'),
  ('87800000-0000-4000-8000-0000000000a2'),
  ('87800000-0000-4000-8000-0000000000a3');
insert into public.user_profiles (user_id, email, user_role) values
  ('87800000-0000-4000-8000-0000000000a1', 'publication-admin-878@example.test', 'admin'),
  ('87800000-0000-4000-8000-0000000000a2', 'publication-user-878@example.test', 'user'),
  ('87800000-0000-4000-8000-0000000000a3', 'publication-admin2-878@example.test', 'admin')
on conflict (user_id) do update set user_role = excluded.user_role;

insert into public.auction_sales (
  id, source_name, source_url, status, sale_date, city, property_type, starting_price_eur,
  raw_payload, sale_procedure, sale_venue_type,
  surface_m2, app_surface_m2, app_surface_kind, surface_source, surface_confidence, surface_evidence,
  land_surface_m2, rooms_count, bedrooms_count, occupancy_status
) values (
  '87800000-1000-4000-8000-000000000001', 'licitor', 'https://example.test/878/sale', 'upcoming',
  current_timestamp + interval '20 days', 'Alphaville', 'apartment', 90000,
  '{}'::jsonb, '{}'::jsonb, 'tribunal',
  40, 40, 'habitable', 'listing_text', 0.6, 'Appartement de 40 m² habitables',
  100, 2, 1, 'unknown'
);

-- Depuis 20261115100000, la contrainte information_agent_fact_publications_auto_locked refuse 'auto' jusqu'à
-- l'étape 6 (voir le test 880) : la forme d'une ligne 'auto' reste prévue par la contrainte de l'auteur.
select throws_ok(
  $$insert into public.information_agent_fact_publications (
      fact_id, sale_id, fact_key, actor_kind, actor_id, policy_version, recipient_kind
    ) values (
      '87800000-9000-4000-8000-000000000001', '87800000-1000-4000-8000-000000000001',
      'rooms_count', 'auto', null, 'politique-test-1', 'source_lawyer'
    )$$,
  '23514',
  'new row for relation "information_agent_fact_publications" violates check constraint "information_agent_fact_publications_auto_locked"',
  'an automatic publication is locked until step 6, even with a policy version and no person'
);
select throws_ok(
  $$insert into public.information_agent_fact_publications (
      fact_id, sale_id, fact_key, actor_kind, actor_id, policy_version, recipient_kind
    ) values (
      '87800000-9000-4000-8000-000000000002', '87800000-1000-4000-8000-000000000001',
      'rooms_count', 'auto', '87800000-0000-4000-8000-0000000000a1', 'politique-test-1', 'source_lawyer'
    )$$,
  '23514', null, 'an automatic publication cannot name a person'
);
select throws_ok(
  $$insert into public.information_agent_fact_publications (
      fact_id, sale_id, fact_key, actor_kind, actor_id, policy_version, recipient_kind
    ) values (
      '87800000-9000-4000-8000-000000000003', '87800000-1000-4000-8000-000000000001',
      'rooms_count', 'admin', '87800000-0000-4000-8000-0000000000a1', 'politique-test-1', 'source_lawyer'
    )$$,
  '23514', null, 'an administrator publication has no policy version'
);
select throws_ok(
  $$insert into public.information_agent_fact_publications (
      fact_id, sale_id, fact_key, actor_kind, policy_version, recipient_kind
    ) values (
      '87800000-9000-4000-8000-000000000004', '87800000-1000-4000-8000-000000000001',
      'rooms_count', 'robot', 'politique-test-1', 'source_lawyer'
    )$$,
  '23514', null, 'only admin and auto are known actors'
);
select throws_ok(
  $$insert into public.information_agent_fact_publications (
      fact_id, sale_id, fact_key, actor_kind, actor_id, recipient_kind
    ) values (
      '87800000-9000-4000-8000-000000000005', '87800000-1000-4000-8000-000000000001',
      'rooms_count', 'admin', '87800000-0000-4000-8000-0000000000a1', 'greffe'
    )$$,
  '23514', null, 'the recipient of the case is one of the three known kinds'
);
delete from public.information_agent_fact_publications
where fact_id = '87800000-9000-4000-8000-000000000001';

-- Jeu d'essai : un dossier, une réponse reçue, des faits candidats -----------------------------------------------
-- Le pont vers auction_fact_claims est un déclencheur différé (il passe après l'écriture de la fiche, avant
-- la validation de la transaction). Le test le déclenche avec « set constraints all immediate » après les
-- publications, puis revient au mode différé.
-- Lot C : retenue coupée, ce fichier éprouve la branche de repli du noyau ; le chemin réel est couvert par 900.
update public.auction_fact_fields set hold_enabled = false where hold_enabled;

insert into public.information_agent_cases (
  id, sale_id, created_by, status, recipient_kind, recipient_email, normalized_recipient_email, subject,
  body_text, question_keys, missing_information, sent_at, replied_at
) values (
  '87800000-3000-4000-8000-000000000001', '87800000-1000-4000-8000-000000000001',
  '87800000-0000-4000-8000-0000000000a1', 'replied', 'source_lawyer', 'avocat-878@example.test',
  'avocat-878@example.test',
  'Demande d''informations', 'Merci de nous transmettre les informations manquantes.',
  array['surface'], array['surface'], now() - interval '3 days', now() - interval '2 days'
);
insert into public.information_agent_missions (
  id, user_id, sale_id, case_id, status, recipient_email, subject, body_text, question_keys,
  missing_information, privacy_version
) values (
  '87800000-2000-4000-8000-000000000001', '87800000-0000-4000-8000-0000000000a1',
  '87800000-1000-4000-8000-000000000001', '87800000-3000-4000-8000-000000000001', 'sent',
  'avocat-878@example.test', 'Demande d''informations',
  'Merci de nous transmettre les informations manquantes.', array['surface'], array['surface'], '878-pgtap'
);
insert into public.information_agent_messages (
  id, mission_id, case_id, user_id, direction, message_kind, delivery_status, subject, body_text,
  received_at, provider_message_id, metadata
) values (
  '87800000-4000-4000-8000-000000000001', '87800000-2000-4000-8000-000000000001',
  '87800000-3000-4000-8000-000000000001', '87800000-0000-4000-8000-0000000000a1',
  'inbound', 'reply', 'received', 'Re: Demande d''informations', 'Voici les informations demandées.',
  '2026-11-12 09:30:00+01', 'publication-provider-878',
  '{"imported_manually": false, "sender_authentication": {"status": "pass"}, "sender_matches_recipient": true}'::jsonb
);

insert into public.information_agent_fact_candidates (
  id, case_id, message_id, sale_id, fact_key, proposed_value, display_value, evidence_excerpt, confidence
)
select
  fixture.id::uuid,
  '87800000-3000-4000-8000-000000000001',
  '87800000-4000-4000-8000-000000000001',
  '87800000-1000-4000-8000-000000000001',
  fixture.fact_key,
  jsonb_build_object('value', fixture.value),
  fixture.display_value,
  fixture.excerpt,
  0.9
from (
  values
    ('87800000-5000-4000-8000-000000000001', 'surface_m2', '54', '54 m²', 'La surface habitable est de 54 m².'),
    ('87800000-5000-4000-8000-000000000002', 'land_surface_m2', '300', '300 m²', null),
    ('87800000-5000-4000-8000-000000000003', 'rooms_count', '3', '3 pièces', null),
    ('87800000-5000-4000-8000-000000000004', 'occupancy_status', 'vacant', 'Libre', null),
    ('87800000-5000-4000-8000-000000000005', 'starting_price_eur', '95000', '95 000 €', null),
    ('87800000-5000-4000-8000-000000000006', 'sale_date', (current_date + 30)::text, 'Date de vente', null),
    ('87800000-5000-4000-8000-000000000007', 'property_type', 'house', 'Maison', null),
    ('87800000-5000-4000-8000-000000000008', 'visit_information', 'Visite le 20 à 10 h', 'Visite le 20 à 10 h', null),
    ('87800000-5000-4000-8000-000000000009', 'surface_m2', '56', '56 m²', 'Après mesurage : 56 m².'),
    ('87800000-5000-4000-8000-000000000010', 'rooms_count', '4', '4 pièces', null),
    ('87800000-5000-4000-8000-000000000012', 'occupancy_status', 'rented', 'Loué', null)
) as fixture(id, fact_key, value, display_value, excerpt);

-- Contrôles inchangés -----------------------------------------------------------------------------------------
select throws_ok(
  $$select public.review_information_agent_fact_candidate(
      '87800000-0000-4000-8000-0000000000a2', '87800000-5000-4000-8000-000000000001', 'accepted', null)$$,
  '42501', 'Administrator review is required.',
  'a non-administrator still cannot review a fact'
);
select throws_ok(
  $$select public.review_information_agent_fact_candidate(
      '87800000-0000-4000-8000-0000000000a1', '87800000-5000-4000-8000-000000000001', 'maybe', null)$$,
  '22023', 'Invalid fact review decision.',
  'an unknown decision is still refused'
);

-- Surface : même retour, mêmes colonnes, provenance précédente au journal ------------------------------------
select is(
  public.review_information_agent_fact_candidate(
    '87800000-0000-4000-8000-0000000000a1', '87800000-5000-4000-8000-000000000001', 'accepted', null),
  jsonb_build_object(
    'fact_id', '87800000-5000-4000-8000-000000000001'::uuid, 'status', 'accepted',
    'sale_id', '87800000-1000-4000-8000-000000000001'::uuid,
    'valuation_queued', true, 'description_queued', true
  ),
  'accepting a surface returns the same answer as before'
);
select ok(
  (select surface_m2 = 54 and app_surface_m2 = 54
          and app_surface_kind = 'information_agent_verified' and surface_source = 'information_agent_verified'
          and surface_confidence = 0.9 and surface_evidence = 'La surface habitable est de 54 m².'
     from public.auction_sales where id = '87800000-1000-4000-8000-000000000001'),
  'the surface columns are written exactly as before'
);
select ok(
  (select entry->>'publication_mode' = 'manual'
          and (entry->>'received_at')::timestamptz = '2026-11-12 09:30:00+01'::timestamptz
          and entry->>'fact_id' = '87800000-5000-4000-8000-000000000001'
          and entry->>'source' = 'professional_email'
          and entry->>'recipient_kind' = 'source_lawyer'
          and entry->>'reviewed_at' is not null
          and entry->'value'->>'value' = '54'
     from (select raw_payload->'information_agent_verified_facts'->'surface_m2' as entry
             from public.auction_sales where id = '87800000-1000-4000-8000-000000000001') verified),
  'raw_payload keeps the verified fact and adds publication_mode manual and the reception date'
);
select ok(
  (select actor_kind = 'admin' and actor_id = '87800000-0000-4000-8000-0000000000a1' and policy_version is null
          and fact_key = 'surface_m2' and sale_id = '87800000-1000-4000-8000-000000000001'
          and response_received_at = '2026-11-12 09:30:00+01'::timestamptz
          and recipient_kind = 'source_lawyer'
     from public.information_agent_fact_publications
     where fact_id = '87800000-5000-4000-8000-000000000001'),
  'the journal names the real author: the administrator, without policy version'
);
select ok(
  (select (previous_values->>'surface_m2')::numeric = 40 and (previous_values->>'app_surface_m2')::numeric = 40
          and (new_values->>'surface_m2')::numeric = 54 and (new_values->>'app_surface_m2')::numeric = 54
     from public.information_agent_fact_publications
     where fact_id = '87800000-5000-4000-8000-000000000001'),
  'the journal keeps the previous and new surface values'
);
select ok(
  (select previous_provenance->>'surface_source' = 'listing_text'
          and previous_provenance->>'app_surface_kind' = 'habitable'
          and (previous_provenance->>'surface_confidence')::numeric = 0.6
          and previous_provenance->>'surface_evidence' = 'Appartement de 40 m² habitables'
          and previous_provenance->'verified_fact' = 'null'::jsonb
     from public.information_agent_fact_publications
     where fact_id = '87800000-5000-4000-8000-000000000001'),
  'the journal keeps the previous surface provenance'
);
set constraints all immediate;
set constraints all deferred;
select ok(
  (select resolution_actor_type = 'human' and resolution_actor_id = '87800000-0000-4000-8000-0000000000a1'
          and created_by = '87800000-0000-4000-8000-0000000000a1' and evidence_kind = 'manual_review'
          and resolution_note = 'Réponse reçue et validée par un administrateur.'
          and claim_status = 'accepted' and field_key in ('property.surface_m2')
     from public.auction_fact_claims
     where evidence_locator->>'information_agent_fact_id' = '87800000-5000-4000-8000-000000000001'),
  'the fact claim of an administrator decision is unchanged'
);

-- Autres clés à colonne -------------------------------------------------------------------------------------------
select is(
  public.review_information_agent_fact_candidate(
    '87800000-0000-4000-8000-0000000000a3', '87800000-5000-4000-8000-000000000002', 'accepted', null)->>'status',
  'accepted',
  'land surface accepted'
);
select ok(
  (select s.land_surface_m2 = 300 and (p.previous_values->>'land_surface_m2')::numeric = 100
          and (p.new_values->>'land_surface_m2')::numeric = 300
     from public.auction_sales s
     join public.information_agent_fact_publications p on p.sale_id = s.id
     where s.id = '87800000-1000-4000-8000-000000000001'
       and p.fact_id = '87800000-5000-4000-8000-000000000002'),
  'land surface written, previous value journalled'
);

select is(
  public.review_information_agent_fact_candidate(
    '87800000-0000-4000-8000-0000000000a1', '87800000-5000-4000-8000-000000000003', 'accepted',
    'Confirmé par le cabinet'),
  jsonb_build_object(
    'fact_id', '87800000-5000-4000-8000-000000000003'::uuid, 'status', 'accepted',
    'sale_id', '87800000-1000-4000-8000-000000000001'::uuid,
    'valuation_queued', true, 'description_queued', true
  ),
  'room count accepted with the same answer'
);
select ok(
  (select s.rooms_count = 3 and (p.previous_values->>'rooms_count')::integer = 2
          and (p.new_values->>'rooms_count')::integer = 3
     from public.auction_sales s
     join public.information_agent_fact_publications p on p.sale_id = s.id
     where s.id = '87800000-1000-4000-8000-000000000001'
       and p.fact_id = '87800000-5000-4000-8000-000000000003'),
  'room count written, previous value journalled'
);
set constraints all immediate;
set constraints all deferred;
select is(
  (select resolution_note from public.auction_fact_claims
     where evidence_locator->>'information_agent_fact_id' = '87800000-5000-4000-8000-000000000003'),
  'Confirmé par le cabinet',
  'the administrator note still becomes the claim note'
);

select is(
  public.review_information_agent_fact_candidate(
    '87800000-0000-4000-8000-0000000000a1', '87800000-5000-4000-8000-000000000004', 'accepted', null)->>'status',
  'accepted',
  'occupancy accepted'
);
select ok(
  (select s.occupancy_status = 'vacant' and p.previous_values->>'occupancy_status' = 'unknown'
          and p.new_values->>'occupancy_status' = 'vacant'
     from public.auction_sales s
     join public.information_agent_fact_publications p on p.sale_id = s.id
     where s.id = '87800000-1000-4000-8000-000000000001'
       and p.fact_id = '87800000-5000-4000-8000-000000000004'),
  'occupancy written, previous value journalled'
);

select is(
  public.review_information_agent_fact_candidate(
    '87800000-0000-4000-8000-0000000000a1', '87800000-5000-4000-8000-000000000005', 'accepted', null)->>'status',
  'accepted',
  'starting price accepted'
);
select ok(
  (select s.starting_price_eur = 95000 and (p.previous_values->>'starting_price_eur')::numeric = 90000
          and (p.new_values->>'starting_price_eur')::numeric = 95000
     from public.auction_sales s
     join public.information_agent_fact_publications p on p.sale_id = s.id
     where s.id = '87800000-1000-4000-8000-000000000001'
       and p.fact_id = '87800000-5000-4000-8000-000000000005'),
  'an administrator can still overwrite a different starting price; the previous one is journalled'
);

select is(
  public.review_information_agent_fact_candidate(
    '87800000-0000-4000-8000-0000000000a1', '87800000-5000-4000-8000-000000000006', 'accepted', null),
  jsonb_build_object(
    'fact_id', '87800000-5000-4000-8000-000000000006'::uuid, 'status', 'accepted',
    'sale_id', '87800000-1000-4000-8000-000000000001'::uuid,
    'valuation_queued', false, 'description_queued', true
  ),
  'sale date accepted without a valuation, as before'
);
select ok(
  (select s.sale_date::date = current_date + 30
          and (p.previous_values->>'sale_date')::timestamptz::date = (current_date + 20)
          and p.new_values->>'sale_date' = (current_date + 30)::text
     from public.auction_sales s
     join public.information_agent_fact_publications p on p.sale_id = s.id
     where s.id = '87800000-1000-4000-8000-000000000001'
       and p.fact_id = '87800000-5000-4000-8000-000000000006'),
  'sale date written, previous date journalled'
);

select is(
  public.review_information_agent_fact_candidate(
    '87800000-0000-4000-8000-0000000000a1', '87800000-5000-4000-8000-000000000007', 'accepted', null)->>'status',
  'accepted',
  'property type accepted'
);
select ok(
  (select s.property_type = 'house' and p.previous_values->>'property_type' = 'apartment'
          and p.new_values->>'property_type' = 'house'
     from public.auction_sales s
     join public.information_agent_fact_publications p on p.sale_id = s.id
     where s.id = '87800000-1000-4000-8000-000000000001'
       and p.fact_id = '87800000-5000-4000-8000-000000000007'),
  'property type written, previous value journalled'
);

-- Clé sans colonne : seule la trace de raw_payload, sans texte du message au journal -------------------------
select is(
  public.review_information_agent_fact_candidate(
    '87800000-0000-4000-8000-0000000000a1', '87800000-5000-4000-8000-000000000008', 'accepted', null),
  jsonb_build_object(
    'fact_id', '87800000-5000-4000-8000-000000000008'::uuid, 'status', 'accepted',
    'sale_id', '87800000-1000-4000-8000-000000000001'::uuid,
    'valuation_queued', false, 'description_queued', true
  ),
  'visit information accepted with the same answer'
);
set constraints all immediate;
set constraints all deferred;
select ok(
  (select previous_values = '{}'::jsonb and new_values = '{}'::jsonb
     from public.information_agent_fact_publications
     where fact_id = '87800000-5000-4000-8000-000000000008')
  and (select raw_payload->'information_agent_verified_facts'->'visit_information'->>'display_value'
         = 'Visite le 20 à 10 h'
       from public.auction_sales where id = '87800000-1000-4000-8000-000000000001')
  and not exists (
    select 1 from public.auction_fact_claims
    where evidence_locator->>'information_agent_fact_id' = '87800000-5000-4000-8000-000000000008'
  ),
  'free text stays in raw_payload only: no journal value, no fact claim'
);

-- Une seconde surface : la provenance précédente vient de l'agent, l'extrait du message n'est pas recopié ------
select is(
  public.review_information_agent_fact_candidate(
    '87800000-0000-4000-8000-0000000000a1', '87800000-5000-4000-8000-000000000009', 'accepted', null)->>'status',
  'accepted',
  'a second surface is accepted (administrator overwrite unchanged)'
);
select ok(
  (select (previous_values->>'surface_m2')::numeric = 54
          and previous_provenance->>'surface_source' = 'information_agent_verified'
          and previous_provenance->'surface_evidence' = 'null'::jsonb
          and (previous_provenance->>'surface_evidence_withheld')::boolean
          and previous_provenance->'verified_fact'->>'fact_id' = '87800000-5000-4000-8000-000000000001'
          and previous_provenance->'verified_fact'->>'publication_mode' = 'manual'
          and not (previous_provenance->'verified_fact' ? 'display_value')
          and not (previous_provenance->'verified_fact' ? 'value')
     from public.information_agent_fact_publications
     where fact_id = '87800000-5000-4000-8000-000000000009'),
  'the previous provenance points at the earlier fact without copying its message excerpt'
);
select ok(
  not exists (
    select 1 from public.information_agent_fact_publications publication
    where publication.sale_id = '87800000-1000-4000-8000-000000000001'
      and (
        publication::text ~* '(avocat-878@example\.test|La surface habitable est de 54|Après mesurage|Voici les informations|Demande d''informations)'
      )
  ),
  'no email address, message excerpt, subject or body is stored in the journal'
);

-- Refus et relecture déjà faite : aucun effet de publication ---------------------------------------------------
select is(
  public.review_information_agent_fact_candidate(
    '87800000-0000-4000-8000-0000000000a1', '87800000-5000-4000-8000-000000000010', 'rejected', 'Hors lot'),
  jsonb_build_object('fact_id', '87800000-5000-4000-8000-000000000010'::uuid, 'status', 'rejected'),
  'a rejection returns the same answer as before'
);
select ok(
  not exists (
    select 1 from public.information_agent_fact_publications
    where fact_id = '87800000-5000-4000-8000-000000000010'
  )
  and (select rooms_count = 3 from public.auction_sales where id = '87800000-1000-4000-8000-000000000001'),
  'a rejection publishes nothing'
);
select throws_ok(
  $$select public.review_information_agent_fact_candidate(
      '87800000-0000-4000-8000-0000000000a1', '87800000-5000-4000-8000-000000000001', 'accepted', null)$$,
  '55000', 'Information agent fact was already reviewed.',
  'a fact cannot be reviewed twice'
);

-- Pièce jointe (photo) : même chemin, même noyau --------------------------------------------------------------
insert into public.information_agent_evidence_assets (
  id, case_id, message_id, sale_id, storage_path, original_filename, mime_type, size_bytes, sha256,
  rights_status, metadata
) values (
  '87800000-6000-4000-8000-000000000001', '87800000-3000-4000-8000-000000000001',
  '87800000-4000-4000-8000-000000000001', '87800000-1000-4000-8000-000000000001',
  '87800000-3000-4000-8000-000000000001/87800000-4000-4000-8000-000000000001/att-1/photo.jpg',
  'photo.jpg', 'image/jpeg', 2048,
  'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  'authorized',
  jsonb_build_object('redaction_verified_at', now(), 'redaction_verified_by', '87800000-0000-4000-8000-0000000000a1')
);
update public.information_agent_evidence_extractions
set status = 'completed', completed_at = now()
where asset_id = '87800000-6000-4000-8000-000000000001';
insert into public.information_agent_fact_candidates (
  id, case_id, message_id, sale_id, fact_key, proposed_value, display_value, confidence, evidence_asset_id
) values (
  '87800000-5000-4000-8000-000000000011', '87800000-3000-4000-8000-000000000001',
  '87800000-4000-4000-8000-000000000001', '87800000-1000-4000-8000-000000000001', 'photo',
  jsonb_build_object(
    'value', '87800000-6000-4000-8000-000000000001',
    'public_url', 'https://abcdef.supabase.co/storage/v1/object/public/information-agent-approved/87800000-1000-4000-8000-000000000001/87800000-6000-4000-8000-000000000001/photo.jpg',
    'public_path', '87800000-1000-4000-8000-000000000001/87800000-6000-4000-8000-000000000001/photo.jpg'
  ),
  'photo.jpg', 0.9, '87800000-6000-4000-8000-000000000001'
);
select is(
  public.review_information_agent_fact_candidate_with_path(
    '87800000-0000-4000-8000-0000000000a1', '87800000-5000-4000-8000-000000000011', 'accepted', null,
    '87800000-1000-4000-8000-000000000001/87800000-6000-4000-8000-000000000001/photo.jpg'),
  jsonb_build_object(
    'fact_id', '87800000-5000-4000-8000-000000000011'::uuid, 'status', 'accepted',
    'sale_id', '87800000-1000-4000-8000-000000000001'::uuid,
    'valuation_queued', false, 'description_queued', true
  ),
  'the path-bound variant goes through the same core with the same answer'
);
select ok(
  (select raw_payload->'source_images' @> jsonb_build_array(
            'https://abcdef.supabase.co/storage/v1/object/public/information-agent-approved/87800000-1000-4000-8000-000000000001/87800000-6000-4000-8000-000000000001/photo.jpg')
     from public.auction_sales where id = '87800000-1000-4000-8000-000000000001')
  and (select review_status = 'accepted' from public.information_agent_evidence_assets
         where id = '87800000-6000-4000-8000-000000000001')
  and (select actor_kind = 'admin' and previous_values ? 'raw_payload.source_images'
         from public.information_agent_fact_publications
         where fact_id = '87800000-5000-4000-8000-000000000011'),
  'the photo is published as before and journalled'
);

-- Le noyau : ses propres gardes (appel direct par le propriétaire, comme le ferait une RPC SECURITY DEFINER) ---
select throws_ok(
  $$select app_private.apply_information_agent_fact(
      '87800000-5000-4000-8000-000000000001', 'admin', '87800000-0000-4000-8000-0000000000a1', null)$$,
  '55000', 'Information agent fact was already published.',
  'a fact is published once'
);
select throws_ok(
  $$select app_private.apply_information_agent_fact(
      '87800000-5000-4000-8000-000000000010', 'admin', '87800000-0000-4000-8000-0000000000a1', null)$$,
  '55000', 'Only an accepted information agent fact can be published.',
  'a rejected fact cannot be published'
);
select throws_ok(
  $$select app_private.apply_information_agent_fact(
      '87800000-5000-4000-8000-000000000001', 'admin', '87800000-0000-4000-8000-0000000000a2', null)$$,
  '42501', 'Administrator review is required.',
  'the core refuses a non-administrator author'
);
select throws_ok(
  $$select app_private.apply_information_agent_fact(
      '87800000-5000-4000-8000-000000000001', 'admin', '87800000-0000-4000-8000-0000000000a1', 'politique-1')$$,
  '22023', null,
  'an administrator publication carries no policy version'
);
select throws_ok(
  $$select app_private.apply_information_agent_fact(
      '87800000-5000-4000-8000-000000000001', 'auto', null, 'politique-1')$$,
  '55000', 'A fact reviewed by a person cannot be published automatically.',
  'a fact reviewed by an administrator cannot be relabelled as automatic'
);

-- Le pont refuse une publication 'auto' au lieu d'écrire « validée par un administrateur » -------------------
-- Le verrou de l'étape 3 (20261115100000) refuse déjà toute ligne 'auto' ; le test le lève ici, dans sa
-- transaction annulée à la fin, pour vérifier le refus du pont seul (seconde barrière).
alter table public.information_agent_fact_publications
  drop constraint information_agent_fact_publications_auto_locked;
insert into public.information_agent_fact_publications (
  fact_id, sale_id, fact_key, actor_kind, actor_id, policy_version, recipient_kind
) values (
  '87800000-5000-4000-8000-000000000012', '87800000-1000-4000-8000-000000000001',
  'occupancy_status', 'auto', null, 'politique-test-1', 'source_lawyer'
);
-- Les publications précédentes passent le pont maintenant ; la mise à jour suivante le déclenche à sa fin.
set constraints all immediate;
select throws_ok(
  $$update public.information_agent_fact_candidates
    set status = 'accepted', reviewed_by = '87800000-0000-4000-8000-0000000000a1', reviewed_at = now()
    where id = '87800000-5000-4000-8000-000000000012'$$,
  '55000', 'Automatic information-agent publications have no fact-claim provenance yet.',
  'the claim bridge derives its author from the journal and never labels an automatic publication as an administrator decision'
);

-- Les rôles de l'API ne modifient pas le journal, et n'appellent pas le noyau --------------------------------
set local role service_role;
select ok(
  (select count(*) from public.information_agent_fact_publications
     where sale_id = '87800000-1000-4000-8000-000000000001') >= 10,
  'the server role reads the journal'
);
select throws_ok(
  $$update public.information_agent_fact_publications set actor_kind = 'auto', actor_id = null, policy_version = 'x'$$,
  '42501', null, 'the server role cannot modify the journal'
);
select throws_ok(
  $$delete from public.information_agent_fact_publications$$,
  '42501', null, 'the server role cannot delete the journal'
);
select throws_ok(
  $$insert into public.information_agent_fact_publications (fact_id, sale_id, fact_key, actor_kind, policy_version)
    values (gen_random_uuid(), '87800000-1000-4000-8000-000000000001', 'rooms_count', 'auto', 'politique-1')$$,
  '42501', null, 'the server role cannot write an automatic publication by hand'
);
select throws_ok(
  $$select app_private.apply_information_agent_fact(
      '87800000-5000-4000-8000-000000000004', 'auto', null, 'politique-1')$$,
  '42501', null, 'the server role cannot call the core'
);
reset role;

set local role authenticated;
select throws_ok(
  $$select count(*) from public.information_agent_fact_publications$$,
  '42501', null, 'a signed-in account cannot read the journal'
);
reset role;

-- Suppression du compte d'un administrateur : sa publication reste, sans identité ----------------------------
set constraints all immediate;
delete from auth.users where id = '87800000-0000-4000-8000-0000000000a3';
select ok(
  (select actor_kind = 'admin' and actor_id is null and recipient_kind = 'source_lawyer'
          and (new_values->>'land_surface_m2')::numeric = 300
     from public.information_agent_fact_publications
     where fact_id = '87800000-5000-4000-8000-000000000002'),
  'a deleted administrator account leaves the publication with no identity (actor_id set to null)'
);

select ok(
  (select prosrc ~ '''document_type'', document\.document_type'
          and prosrc ~ '''file_path'', document\.file_path'
          and prosrc !~ 'document\.(label|sha256|raw_payload|download_status|extraction_status)'
     from pg_proc
     where oid = 'app_private.apply_information_agent_fact(uuid,text,uuid,text)'::regprocedure),
  'a replaced document keeps only its type and path in the journal (no file name, no raw content)'
);

select * from finish();
rollback;
