-- 20261211100000 : publication automatique des informations reçues, arbitrée par Claude Haiku (étape 6, décision du
-- propriétaire du 27/11/2026).
--   * verrous levés, remplacés par des contraintes de forme (une ligne automatique a une seule forme) ;
--   * verdicts de Haiku : table fermée, en ajout seul, écrits seulement pour la valeur du fait ;
--   * publication : seul chemin 'auto', réservé au serveur, mode relu sous verrou, contrôles de sécurité redits en
--     base, plafonds, puis fait accepté, journal des publications, observation, décision automatique du registre,
--     fiche tenue et décision « published », dans une seule transaction ;
--   * arrêt d'urgence effectif ; retrait par le chemin existant d'un administrateur.
begin;

set local timezone = 'UTC';

select plan(67);

-- Structure et droits -------------------------------------------------------------------------------------------
select has_table('public', 'information_agent_auto_publication_arbitrations', 'the verdict table exists');

select ok(
  (select relrowsecurity from pg_class
   where oid = 'public.information_agent_auto_publication_arbitrations'::regclass)
  and not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'information_agent_auto_publication_arbitrations'
  ),
  'RLS is on and no policy opens the verdict table'
);

select is(
  (
    select coalesce(array_agg(format('%s %s', grantee, priv) order by grantee, priv), array[]::text[])
    from unnest(array['anon', 'authenticated', 'service_role']) as roles(grantee)
    cross join unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'TRIGGER', 'REFERENCES']) as privileges(priv)
    where has_table_privilege(grantee, 'public.information_agent_auto_publication_arbitrations', priv)
  ),
  array['service_role SELECT']::text[],
  'the API roles hold no privilege on the verdicts, except SELECT for the server'
);

select ok(
  has_function_privilege('service_role', 'public.publish_information_agent_fact_auto(uuid, text, text, text)', 'execute')
  and not has_function_privilege('authenticated', 'public.publish_information_agent_fact_auto(uuid, text, text, text)', 'execute')
  and not has_function_privilege('anon', 'public.publish_information_agent_fact_auto(uuid, text, text, text)', 'execute')
  and has_function_privilege('service_role', 'public.record_information_agent_auto_publication_arbitration(uuid, numeric, text, boolean, text, numeric, text, text, text)', 'execute')
  and not has_function_privilege('authenticated', 'public.record_information_agent_auto_publication_arbitration(uuid, numeric, text, boolean, text, numeric, text, text, text)', 'execute')
  and not has_function_privilege('anon', 'public.record_information_agent_auto_publication_arbitration(uuid, numeric, text, boolean, text, numeric, text, text, text)', 'execute'),
  'the publication and verdict RPCs are open to the server only'
);

select ok(
  has_function_privilege('service_role', 'public.list_information_agent_facts_to_arbitrate(text, integer)', 'execute')
  and not has_function_privilege('authenticated', 'public.list_information_agent_facts_to_arbitrate(text, integer)', 'execute')
  and not has_function_privilege('anon', 'public.list_information_agent_facts_to_arbitrate(text, integer)', 'execute')
  and has_function_privilege('service_role', 'public.record_information_agent_auto_publication_decision(uuid, text, text, text[], text)', 'execute')
  and not has_function_privilege('authenticated', 'public.record_information_agent_auto_publication_decision(uuid, text, text, text[], text)', 'execute')
  and not has_function_privilege('anon', 'public.record_information_agent_auto_publication_decision(uuid, text, text, text[], text)', 'execute'),
  'the list of facts to judge and the decision journal RPC are open to the server only (never to authenticated)'
);

select ok(
  not has_function_privilege('service_role', 'app_private.accept_information_agent_claim_automatically(uuid, text)', 'execute')
  and not has_function_privilege('authenticated', 'app_private.accept_information_agent_claim_automatically(uuid, text)', 'execute')
  and not has_function_privilege('anon', 'app_private.accept_information_agent_claim_automatically(uuid, text)', 'execute')
  and not has_function_privilege('service_role', 'app_private.write_information_agent_auto_publication_decision(uuid, uuid, uuid, text, text, text, text[], text)', 'execute'),
  'the automatic registry decision and the journal writer are callable by no API role'
);

select ok(
  not exists (
    select 1 from pg_constraint
    where conname in (
      'information_agent_auto_publication_settings_auto_locked',
      'information_agent_fact_publications_auto_locked',
      'auction_fact_claim_decisions_auto_locked',
      'auction_fact_claim_decisions_accepted_by_admin'
    )
  ),
  'the four automatic publication locks are lifted'
);

select is(
  (select array_agg(conname::text order by conname) from pg_constraint
   where conname in (
     'information_agent_fact_publications_auto_shape',
     'auction_fact_claim_decisions_auto_shape',
     'auction_fact_claim_decisions_accepted_by_admin_or_auto',
     'auction_fact_claim_decisions_policy_check'
   ) and convalidated),
  array[
    'auction_fact_claim_decisions_accepted_by_admin_or_auto',
    'auction_fact_claim_decisions_auto_shape',
    'auction_fact_claim_decisions_policy_check',
    'information_agent_fact_publications_auto_shape'
  ]::name[]::text[],
  'the shape constraints replace them'
);

-- Fixtures ---------------------------------------------------------------------------------------------------------
insert into auth.users (id) values ('92400000-0000-4000-8000-0000000000a1');
insert into public.user_profiles (user_id, email, user_role) values
  ('92400000-0000-4000-8000-0000000000a1', 'auto-publication-admin-924@example.test', 'admin')
on conflict (user_id) do update set user_role = excluded.user_role;

insert into public.auction_sales (
  id, source_name, source_url, status, sale_date, city, property_type, starting_price_eur,
  raw_payload, sale_procedure, sale_venue_type, quality_flags
) values
  ('92400000-1000-4000-8000-000000000001', 'licitor', 'https://example.test/924/sale-1', 'upcoming',
   current_timestamp + interval '20 days', 'Alphaville', 'house', 90000,
   '{}'::jsonb, '{}'::jsonb, 'tribunal', '[]'::jsonb),
  ('92400000-1000-4000-8000-000000000002', 'licitor', 'https://example.test/924/sale-2', 'upcoming',
   current_timestamp + interval '20 days', 'Alphaville', 'apartment', 90000,
   '{}'::jsonb, '{}'::jsonb, 'tribunal', '["multi_lot_sale"]'::jsonb),
  ('92400000-1000-4000-8000-000000000003', 'licitor', 'https://example.test/924/sale-3', 'upcoming',
   current_timestamp + interval '20 days', 'Alphaville', 'house', 90000,
   '{}'::jsonb, '{}'::jsonb, 'tribunal', '[]'::jsonb);

insert into public.information_agent_cases (
  id, sale_id, created_by, status, recipient_kind, recipient_email, normalized_recipient_email, subject,
  body_text, question_keys, missing_information, sent_at, replied_at
) values
  ('92400000-3000-4000-8000-000000000001', '92400000-1000-4000-8000-000000000001',
   '92400000-0000-4000-8000-0000000000a1', 'review', 'source_lawyer', 'avocat-924@example.test',
   'avocat-924@example.test', 'Demande d''informations', 'Merci de nous transmettre la surface.',
   array['surface'], array['surface'], now() - interval '3 days', now() - interval '2 days'),
  ('92400000-3000-4000-8000-000000000002', '92400000-1000-4000-8000-000000000002',
   '92400000-0000-4000-8000-0000000000a1', 'review', 'source_lawyer', 'avocat-924b@example.test',
   'avocat-924b@example.test', 'Demande d''informations', 'Merci de nous transmettre la surface.',
   array['surface'], array['surface'], now() - interval '3 days', now() - interval '2 days'),
  ('92400000-3000-4000-8000-000000000003', '92400000-1000-4000-8000-000000000003',
   '92400000-0000-4000-8000-0000000000a1', 'review', 'source_lawyer', 'avocat-924c@example.test',
   'avocat-924c@example.test', 'Demande d''informations', 'Merci de nous transmettre la surface.',
   array['surface'], array['surface'], now() - interval '3 days', now() - interval '2 days');

insert into public.information_agent_missions (
  id, user_id, sale_id, case_id, status, recipient_email, subject, body_text, question_keys,
  missing_information, privacy_version
) values
  ('92400000-2000-4000-8000-000000000001', '92400000-0000-4000-8000-0000000000a1',
   '92400000-1000-4000-8000-000000000001', '92400000-3000-4000-8000-000000000001', 'sent',
   'avocat-924@example.test', 'Demande d''informations', 'Merci de nous transmettre la surface.',
   array['surface'], array['surface'], '924-pgtap'),
  ('92400000-2000-4000-8000-000000000002', '92400000-0000-4000-8000-0000000000a1',
   '92400000-1000-4000-8000-000000000002', '92400000-3000-4000-8000-000000000002', 'sent',
   'avocat-924b@example.test', 'Demande d''informations', 'Merci de nous transmettre la surface.',
   array['surface'], array['surface'], '924-pgtap'),
  ('92400000-2000-4000-8000-000000000003', '92400000-0000-4000-8000-0000000000a1',
   '92400000-1000-4000-8000-000000000003', '92400000-3000-4000-8000-000000000003', 'sent',
   'avocat-924c@example.test', 'Demande d''informations', 'Merci de nous transmettre la surface.',
   array['surface'], array['surface'], '924-pgtap');

insert into public.information_agent_messages (
  id, mission_id, case_id, user_id, direction, message_kind, delivery_status, subject, body_text,
  received_at, provider_message_id, metadata
) values
  ('92400000-4000-4000-8000-000000000001', '92400000-2000-4000-8000-000000000001',
   '92400000-3000-4000-8000-000000000001', '92400000-0000-4000-8000-0000000000a1',
   'inbound', 'reply', 'received', 'Re: Demande d''informations',
   'La maison fait 120 m², 5 pièces, terrain de 800 m².',
   now() - interval '2 days', 'auto-publication-provider-924-1',
   '{"imported_manually": false, "sender_matches_recipient": true, "sender_authentication": {"status": "pass", "dkim": "pass", "dmarc": "pass"}, "inbound_processing": {"status": "review", "reason": "candidate_or_attachment_review"}}'::jsonb),
  -- Même dossier, mais DKIM absent : jamais publié.
  ('92400000-4000-4000-8000-000000000002', '92400000-2000-4000-8000-000000000001',
   '92400000-3000-4000-8000-000000000001', '92400000-0000-4000-8000-0000000000a1',
   'inbound', 'reply', 'received', 'Re: Demande d''informations', 'Précision : 120 m².',
   now() - interval '1 day', 'auto-publication-provider-924-2',
   '{"imported_manually": false, "sender_matches_recipient": true, "sender_authentication": {"status": "fail", "dkim": "fail", "dmarc": "pass"}, "inbound_processing": {"status": "completed"}}'::jsonb),
  ('92400000-4000-4000-8000-000000000003', '92400000-2000-4000-8000-000000000002',
   '92400000-3000-4000-8000-000000000002', '92400000-0000-4000-8000-0000000000a1',
   'inbound', 'reply', 'received', 'Re: Demande d''informations', 'Le lot fait 40 m².',
   now() - interval '2 days', 'auto-publication-provider-924-3',
   '{"imported_manually": false, "sender_matches_recipient": true, "sender_authentication": {"status": "pass", "dkim": "pass", "dmarc": "pass"}}'::jsonb),
  ('92400000-4000-4000-8000-000000000004', '92400000-2000-4000-8000-000000000003',
   '92400000-3000-4000-8000-000000000003', '92400000-0000-4000-8000-0000000000a1',
   'inbound', 'reply', 'received', 'Re: Demande d''informations', 'La maison fait 95 m² et compte 4 pièces.',
   now() - interval '2 days', 'auto-publication-provider-924-4',
   '{"imported_manually": false, "sender_matches_recipient": true, "sender_authentication": {"status": "pass", "dkim": "pass", "dmarc": "pass"}, "inbound_processing": {"status": "completed"}}'::jsonb);

insert into public.information_agent_fact_candidates (
  id, case_id, message_id, sale_id, fact_key, proposed_value, display_value, evidence_excerpt, confidence,
  status
) values
  ('92400000-5000-4000-8000-000000000001', '92400000-3000-4000-8000-000000000001',
   '92400000-4000-4000-8000-000000000001', '92400000-1000-4000-8000-000000000001', 'surface_m2',
   '{"value": 120}'::jsonb, '120 m²', 'La maison fait 120 m²', 0.9, 'pending'),
  ('92400000-5000-4000-8000-000000000002', '92400000-3000-4000-8000-000000000001',
   '92400000-4000-4000-8000-000000000001', '92400000-1000-4000-8000-000000000001', 'rooms_count',
   '{"value": "5"}'::jsonb, '5 pièces', '5 pièces', 0.9, 'pending'),
  ('92400000-5000-4000-8000-000000000003', '92400000-3000-4000-8000-000000000001',
   '92400000-4000-4000-8000-000000000001', '92400000-1000-4000-8000-000000000001', 'land_surface_m2',
   '{"value": 800}'::jsonb, '800 m²', 'terrain de 800 m²', 0.9, 'pending'),
  ('92400000-5000-4000-8000-000000000004', '92400000-3000-4000-8000-000000000001',
   '92400000-4000-4000-8000-000000000002', '92400000-1000-4000-8000-000000000001', 'surface_m2',
   '{"value": 120}'::jsonb, '120 m²', 'Précision : 120 m²', 0.9, 'pending'),
  ('92400000-5000-4000-8000-000000000005', '92400000-3000-4000-8000-000000000002',
   '92400000-4000-4000-8000-000000000003', '92400000-1000-4000-8000-000000000002', 'surface_m2',
   '{"value": 40}'::jsonb, '40 m²', 'Le lot fait 40 m²', 0.9, 'pending'),
  ('92400000-5000-4000-8000-000000000006', '92400000-3000-4000-8000-000000000003',
   '92400000-4000-4000-8000-000000000004', '92400000-1000-4000-8000-000000000003', 'surface_m2',
   '{"value": 95}'::jsonb, '95 m²', 'La maison fait 95 m²', 0.9, 'pending'),
  ('92400000-5000-4000-8000-000000000007', '92400000-3000-4000-8000-000000000003',
   '92400000-4000-4000-8000-000000000004', '92400000-1000-4000-8000-000000000003', 'rooms_count',
   '{"value": 4}'::jsonb, '4 pièces', '4 pièces', 0.9, 'pending');

-- Mode « off » : rien n'est écrit ----------------------------------------------------------------------------------
select is(
  public.publish_information_agent_fact_auto(
    '92400000-5000-4000-8000-000000000001', 'surface_m2', 'auto_publication_v2', 'auto_publication_arbiter_v1') ->> 'status',
  'inactive',
  'in off mode the publication RPC writes nothing'
);
select is(
  public.record_information_agent_auto_publication_arbitration(
    '92400000-5000-4000-8000-000000000001', 120, 'completed', true, 'clear_statement', 0.9,
    'claude-haiku-5-5', 'auto_publication_arbiter_v1', null),
  false,
  'in off mode no verdict is recorded'
);

-- L'administrateur passe en automatique, avec son jeton -----------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"92400000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal1"}', true);
select is(
  (select mode from public.set_information_agent_auto_publication_mode('auto')),
  'auto',
  'an administrator switches to automatic publication (no 55000 lock any more)'
);
select ok(
  exists (
    select 1 from public.information_agent_auto_publication_mode_changes
    where actor_id = '92400000-0000-4000-8000-0000000000a1' and previous_mode = 'off' and new_mode = 'auto'
  ),
  'the switch is traced'
);
select set_config('request.jwt.claims', '', true);
set local role service_role;
select throws_ok(
  $$select public.set_information_agent_auto_publication_mode('off')$$,
  '42501', null, 'the server role cannot change the mode'
);
reset role;

-- Faits à juger : filtrés en base (aucun appel de Haiku pour un fait que les conditions structurelles écartent) ------
select is(
  (select array_agg(right(fact_id::text, 1) order by fact_id)
   from public.list_information_agent_facts_to_arbitrate('auto_publication_arbiter_v1', 50)),
  array['1', '2', '3', '6', '7'],
  'the facts to judge exclude a message without DKIM (4) and a multi-lot sale (5)'
);

-- Verdicts ------------------------------------------------------------------------------------------------------
select throws_ok(
  $$select public.record_information_agent_auto_publication_arbitration(
      '92400000-5000-4000-8000-000000000001', 130, 'completed', true, 'clear_statement', 0.9,
      'claude-haiku-5-5', 'auto_publication_arbiter_v1', null)$$,
  '22023', 'The verdict does not match the value of the fact.',
  'a verdict never carries another value than the one of the fact'
);
select throws_ok(
  $$select public.record_information_agent_auto_publication_arbitration(
      '92400000-5000-4000-8000-000000000001', 120, 'invalid_output', true, null, null,
      'claude-haiku-5-5', 'auto_publication_arbiter_v1', 'ARBITER_OUTPUT_INVALID')$$,
  '23514', null,
  'an invalid output can never say publish'
);
select throws_ok(
  $$select public.record_information_agent_auto_publication_arbitration(
      '92400000-5000-4000-8000-000000000001', 120, 'completed', true, 'ambiguous', 0.9,
      'claude-haiku-5-5', 'auto_publication_arbiter_v1', null)$$,
  '23514', null,
  'a reason code outside the closed list is refused'
);

-- Sans verdict : relecture, rien de publié --------------------------------------------------------------------------
select is(
  public.publish_information_agent_fact_auto(
    '92400000-5000-4000-8000-000000000001', 'surface_m2', 'auto_publication_v2', 'auto_publication_arbiter_v1') -> 'reasons',
  '["arbiter_pending"]'::jsonb,
  'without a verdict the fact goes to review'
);
select ok(
  (select status = 'pending' from public.information_agent_fact_candidates
   where id = '92400000-5000-4000-8000-000000000001')
  and exists (
    select 1 from public.information_agent_auto_publication_decisions
    where fact_id = '92400000-5000-4000-8000-000000000001' and mode = 'auto' and outcome = 'review'
      and reasons = '{arbiter_pending}'
  ),
  'the review is recorded and the fact stays pending'
);

select is(
  public.record_information_agent_auto_publication_arbitration(
    '92400000-5000-4000-8000-000000000001', 120, 'completed', true, 'clear_statement', 0.92,
    'claude-haiku-5-5', 'auto_publication_arbiter_v1', null),
  true,
  'a verdict for the value of the fact is recorded'
);
select is(
  public.record_information_agent_auto_publication_arbitration(
    '92400000-5000-4000-8000-000000000002', 5, 'completed', true, 'clear_statement', 0.9,
    'claude-haiku-5-5', 'auto_publication_arbiter_v1', null),
  true,
  'a string value of the fact ("5") is read as the number 5'
);
select public.record_information_agent_auto_publication_arbitration(
  '92400000-5000-4000-8000-000000000003', 800, 'completed', true, 'clear_statement', 0.9,
  'claude-haiku-5-5', 'auto_publication_arbiter_v1', null);
select public.record_information_agent_auto_publication_arbitration(
  '92400000-5000-4000-8000-000000000004', 120, 'completed', true, 'clear_statement', 0.9,
  'claude-haiku-5-5', 'auto_publication_arbiter_v1', null);
select public.record_information_agent_auto_publication_arbitration(
  '92400000-5000-4000-8000-000000000005', 40, 'completed', true, 'clear_statement', 0.9,
  'claude-haiku-5-5', 'auto_publication_arbiter_v1', null);

select throws_ok(
  $$update public.information_agent_auto_publication_arbitrations set publish = false$$,
  '55000', null, 'the verdicts are append-only'
);

-- Verdicts passagers refaits au plus 3 fois, une heure au moins après ; verdict final jamais refait -------------------
select public.record_information_agent_auto_publication_arbitration(
  '92400000-5000-4000-8000-000000000006', 95, 'unavailable', false, null, null,
  'claude-haiku-5-5', 'auto_publication_arbiter_v1', 'ARBITER_PROVIDER_ERROR');
insert into public.information_agent_auto_publication_arbitrations (
  fact_id, case_id, message_id, sale_id, fact_key, value, status, model, prompt_version, error_code, recorded_at
) values (
  '92400000-5000-4000-8000-000000000007', '92400000-3000-4000-8000-000000000003',
  '92400000-4000-4000-8000-000000000004', '92400000-1000-4000-8000-000000000003', 'rooms_count', 4,
  'unavailable', 'claude-haiku-5-5', 'auto_publication_arbiter_v1', 'ARBITER_PROVIDER_ERROR', now() - interval '2 hours'
);
select is(
  (select array_agg(right(fact_id::text, 1) order by fact_id)
   from public.list_information_agent_facts_to_arbitrate('auto_publication_arbiter_v1', 50)),
  array['7'],
  'judged facts are not judged again; a provider error is retried after an hour, not before'
);
insert into public.information_agent_auto_publication_arbitrations (
  fact_id, case_id, message_id, sale_id, fact_key, value, status, model, prompt_version, error_code, recorded_at
) select '92400000-5000-4000-8000-000000000007', '92400000-3000-4000-8000-000000000003',
  '92400000-4000-4000-8000-000000000004', '92400000-1000-4000-8000-000000000003', 'rooms_count', 4,
  'invalid_output', 'claude-haiku-5-5', 'auto_publication_arbiter_v1', 'ARBITER_OUTPUT_INVALID',
  now() - interval '3 hours' * step
from generate_series(1, 2) as steps(step);
select is(
  (select count(*) from public.list_information_agent_facts_to_arbitrate('auto_publication_arbiter_v1', 50)),
  0::bigint,
  'after three transient verdicts the fact is not judged again (human review)'
);
select is(
  (select array_agg(right(fact_id::text, 1) order by fact_id)
   from public.list_information_agent_facts_to_arbitrate('auto_publication_arbiter_v2', 50)),
  array['1', '2', '3', '6', '7'],
  'a new prompt version judges every fact again'
);

-- Analyses du message pas finies : rien n'est publié (une pièce jointe peut contredire le corps) -------------------------
insert into public.information_agent_evidence_assets (
  id, case_id, message_id, sale_id, storage_path, original_filename, mime_type, size_bytes, sha256
) values (
  '92400000-6000-4000-8000-000000000001', '92400000-3000-4000-8000-000000000001',
  '92400000-4000-4000-8000-000000000001', '92400000-1000-4000-8000-000000000001',
  '92400000-3000-4000-8000-000000000001/92400000-4000-4000-8000-000000000001/att-1/carrez.pdf',
  'carrez.pdf', 'application/pdf', 4096,
  'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'
);
select is(
  public.publish_information_agent_fact_auto(
    '92400000-5000-4000-8000-000000000001', 'surface_m2', 'auto_publication_v2', 'auto_publication_arbiter_v1') -> 'reasons',
  '["evidence_pending"]'::jsonb,
  'a queued attachment analysis of the message keeps the fact in review'
);
update public.information_agent_evidence_extractions
set status = 'failed', attempts = 1
where asset_id = '92400000-6000-4000-8000-000000000001';
select is(
  public.publish_information_agent_fact_auto(
    '92400000-5000-4000-8000-000000000001', 'surface_m2', 'auto_publication_v2', 'auto_publication_arbiter_v1') -> 'reasons',
  '["evidence_pending"]'::jsonb,
  'a failed analysis with attempts left still keeps the fact in review'
);
select ok(
  not exists (
    select 1 from public.list_information_agent_facts_to_arbitrate('auto_publication_arbiter_v2', 50)
    where message_id = '92400000-4000-4000-8000-000000000001'
  ),
  'Haiku is not called for a fact whose message analysis is not finished'
);
update public.information_agent_evidence_extractions
set status = 'failed', attempts = 3
where asset_id = '92400000-6000-4000-8000-000000000001';

-- Autres contrôles redits en base ---------------------------------------------------------------------------------------
select is(
  public.publish_information_agent_fact_auto(
    '92400000-5000-4000-8000-000000000001', 'surface_m2', 'auto_publication_v2', 'auto_publication_arbiter_v2') -> 'reasons',
  '["arbiter_pending"]'::jsonb,
  'a verdict of another prompt version than the current one does not publish'
);
update public.information_agent_cases set sent_at = now() - interval '40 days'
where id = '92400000-3000-4000-8000-000000000001';
select is(
  public.publish_information_agent_fact_auto(
    '92400000-5000-4000-8000-000000000001', 'surface_m2', 'auto_publication_v2', 'auto_publication_arbiter_v1') -> 'reasons',
  '["reply_outside_window"]'::jsonb,
  'a reply received 30 days or more after the request is not published'
);
update public.information_agent_cases set sent_at = now() - interval '3 days'
where id = '92400000-3000-4000-8000-000000000001';
update public.information_agent_messages
set metadata = jsonb_set(metadata, '{inbound_processing}', '{"status": "review", "reason": "possible_opposition"}')
where id = '92400000-4000-4000-8000-000000000002';
select is(
  public.publish_information_agent_fact_auto(
    '92400000-5000-4000-8000-000000000001', 'surface_m2', 'auto_publication_v2', 'auto_publication_arbiter_v1') -> 'reasons',
  '["other_message_in_case"]'::jsonb,
  'another reply of the case in review for a possible opposition blocks the publication'
);
update public.information_agent_messages
set metadata = jsonb_set(metadata, '{inbound_processing}', '{"status": "completed"}')
  || '{"admin_handled_action": "record_opposition"}'::jsonb
where id = '92400000-4000-4000-8000-000000000002';
select is(
  public.publish_information_agent_fact_auto(
    '92400000-5000-4000-8000-000000000001', 'surface_m2', 'auto_publication_v2', 'auto_publication_arbiter_v1') -> 'reasons',
  '["other_message_in_case"]'::jsonb,
  'another reply of the case handled as an opposition blocks the publication'
);
update public.information_agent_messages
set metadata = metadata - 'admin_handled_action'
where id = '92400000-4000-4000-8000-000000000002';

-- Publication -----------------------------------------------------------------------------------------------------
select is(
  public.publish_information_agent_fact_auto(
    '92400000-5000-4000-8000-000000000001', 'surface_m2', 'auto_publication_v2', 'auto_publication_arbiter_v1') ->> 'status',
  'published',
  'a clean body fact with a publish verdict is published'
);
select ok(
  (select status = 'accepted' and reviewed_by is null and reviewed_at is not null
   from public.information_agent_fact_candidates where id = '92400000-5000-4000-8000-000000000001'),
  'the fact is accepted without a reviewer'
);
select ok(
  exists (
    select 1 from public.information_agent_fact_publications
    where fact_id = '92400000-5000-4000-8000-000000000001' and actor_kind = 'auto' and actor_id is null
      and policy_version = 'auto_publication_v2' and recipient_kind = 'source_lawyer'
  ),
  'the publication journal names the automatic author and the policy version'
);
select ok(
  exists (
    select 1 from public.auction_fact_claims claim
    where claim.evidence_locator ->> 'information_agent_fact_id' = '92400000-5000-4000-8000-000000000001'
      and claim.evidence_kind = 'professional_email' and claim.extractor_name = 'information_agent'
      and claim.resolution_actor_type = 'agent' and claim.created_by is null
  ),
  'the bridge creates an observation of a professional email, without a human author'
);
select ok(
  exists (
    select 1 from public.auction_fact_claim_decisions decision
    where decision.information_agent_fact_id = '92400000-5000-4000-8000-000000000001'
      and decision.decision = 'accepted' and decision.actor_kind = 'system' and decision.actor_id is null
      and decision.publication_mode = 'auto' and decision.policy_version = 'auto_publication_v2'
      and decision.lot_attachment = 'single_lot' and decision.recipient_kind = 'source_lawyer'
  ),
  'the registry journal carries the automatic acceptance'
);
select is(
  (select surface_m2 from public.auction_sales where id = '92400000-1000-4000-8000-000000000001'),
  120::numeric,
  'the projection writes the value on the sale'
);
select ok(
  exists (
    select 1 from public.information_agent_auto_publication_decisions
    where fact_id = '92400000-5000-4000-8000-000000000001' and mode = 'auto' and outcome = 'published'
      and reasons = '{}' and policy_version = 'auto_publication_v2'
  ),
  'the engine journal records the publication'
);

-- Second appel (réponse perdue) : rien n'est réécrit ; le journal refuse une relecture après coup ------------------------
select is(
  public.publish_information_agent_fact_auto(
    '92400000-5000-4000-8000-000000000001', 'surface_m2', 'auto_publication_v2', 'auto_publication_arbiter_v1') ->> 'status',
  'already_published',
  'a second call after the publication says already published'
);
select is(
  public.record_information_agent_auto_publication_decision(
    '92400000-5000-4000-8000-000000000001', 'surface_m2', 'review', '{publication_failed}', 'auto_publication_v2'),
  false,
  'no review is recorded for a fact that is no longer pending'
);
select is(
  (select array_agg(outcome order by decided_at desc, id desc)
   from public.information_agent_auto_publication_decisions
   where fact_id = '92400000-5000-4000-8000-000000000001' and outcome <> 'review'),
  array['published'],
  'the fact keeps a single publication and nothing after it'
);
select is(
  (select count(*) from public.auction_fact_claim_decisions
   where information_agent_fact_id = '92400000-5000-4000-8000-000000000001'),
  1::bigint,
  'the registry holds a single automatic decision'
);

-- Contrôles de sécurité redits en base ---------------------------------------------------------------------------------
select ok(
  (public.publish_information_agent_fact_auto(
    '92400000-5000-4000-8000-000000000004', 'surface_m2', 'auto_publication_v2', 'auto_publication_arbiter_v1') -> 'reasons')
    ?& array['sender_not_authenticated', 'field_not_empty'],
  'a message without DKIM is never published, and the field is no longer empty'
);
select ok(
  (public.publish_information_agent_fact_auto(
    '92400000-5000-4000-8000-000000000005', 'surface_m2', 'auto_publication_v2', 'auto_publication_arbiter_v1') -> 'reasons')
    ? 'multi_lot_sale',
  'a multi-lot sale is never published automatically'
);

-- Plafond de 2 par dossier -----------------------------------------------------------------------------------------
select is(
  public.publish_information_agent_fact_auto(
    '92400000-5000-4000-8000-000000000002', 'rooms_count', 'auto_publication_v2', 'auto_publication_arbiter_v1') ->> 'status',
  'published',
  'a second fact of the case is published'
);
select is(
  public.publish_information_agent_fact_auto(
    '92400000-5000-4000-8000-000000000003', 'land_surface_m2', 'auto_publication_v2', 'auto_publication_arbiter_v1') -> 'reasons',
  '["case_cap_reached"]'::jsonb,
  'the third fact of the same case waits for review (2 per case)'
);

-- Une publication 'published' ne s'écrit pas par la RPC de journal ---------------------------------------------------
select throws_ok(
  $$select public.record_information_agent_auto_publication_decision(
      '92400000-5000-4000-8000-000000000003', 'land_surface_m2', 'published', '{}', 'auto_publication_v2')$$,
  '22023', null, 'the journal RPC never writes a publication'
);
select throws_ok(
  $$select public.record_information_agent_auto_publication_decision(
      '92400000-5000-4000-8000-000000000003', 'land_surface_m2', 'would_publish', '{}', 'auto_publication_v2')$$,
  '22023', null, 'nor a simulated publication in automatic mode'
);

-- Formes refusées dans le registre --------------------------------------------------------------------------------------
select throws_ok(
  $$insert into public.auction_fact_claim_decisions (
      claim_id, sale_id, field_key, decision, lot_attachment, actor_kind, actor_id, publication_mode, policy_version
    ) select claim.id, claim.auction_sale_id, claim.field_key, 'rejected', 'single_lot', 'admin',
        '92400000-0000-4000-8000-0000000000a1', 'auto', 'auto_publication_v2'
      from public.auction_fact_claims claim
      where claim.evidence_locator ->> 'information_agent_fact_id' = '92400000-5000-4000-8000-000000000002'$$,
  '23514', null, 'an automatic decision is an acceptance by the system, nothing else'
);
select throws_ok(
  $$insert into public.auction_fact_claim_decisions (
      claim_id, sale_id, field_key, decision, lot_attachment, actor_kind
    ) select claim.id, claim.auction_sale_id, claim.field_key, 'accepted', 'single_lot', 'system'
      from public.auction_fact_claims claim
      where claim.evidence_locator ->> 'information_agent_fact_id' = '92400000-5000-4000-8000-000000000002'$$,
  '23514', null, 'the system never accepts outside an automatic publication'
);
select throws_ok(
  $$select app_private.accept_information_agent_claim_automatically(claim.id, 'auto_publication_v2')
      from public.auction_fact_claims claim
      where claim.evidence_locator ->> 'information_agent_fact_id' = '92400000-5000-4000-8000-000000000002'$$,
  '55000', 'already_decided', 'the automatic decision only accepts a claim never decided before'
);
select throws_ok(
  $$select app_private.apply_information_agent_fact(
      '92400000-5000-4000-8000-000000000002', 'auto', '92400000-0000-4000-8000-0000000000a1', 'auto_publication_v2')$$,
  '22023', null, 'the core still refuses an automatic publication that names a person'
);

-- Refus de Haiku, refus après un accord, autre valeur, plafond du jour -----------------------------------------------------
select public.record_information_agent_auto_publication_arbitration(
  '92400000-5000-4000-8000-000000000006', 95, 'completed', false, 'conditional_or_approximate', 0.8,
  'claude-haiku-5-5', 'auto_publication_arbiter_v1', null);
select is(
  public.publish_information_agent_fact_auto(
    '92400000-5000-4000-8000-000000000006', 'surface_m2', 'auto_publication_v2', 'auto_publication_arbiter_v1') -> 'reasons',
  '["arbiter_declined"]'::jsonb,
  'a refusal of Haiku is never published'
);
select public.record_information_agent_auto_publication_arbitration(
  '92400000-5000-4000-8000-000000000007', 4, 'completed', true, 'clear_statement', 0.9,
  'claude-haiku-5-5', 'auto_publication_arbiter_v1', null);
select public.record_information_agent_auto_publication_arbitration(
  '92400000-5000-4000-8000-000000000007', 4, 'completed', false, 'unclear_or_ambiguous', 0.6,
  'claude-haiku-5-5', 'auto_publication_arbiter_v1', null);
select is(
  public.publish_information_agent_fact_auto(
    '92400000-5000-4000-8000-000000000007', 'rooms_count', 'auto_publication_v2', 'auto_publication_arbiter_v1') -> 'reasons',
  '["arbiter_declined"]'::jsonb,
  'the latest verdict wins: a refusal after an agreement is not published'
);
select public.record_information_agent_auto_publication_arbitration(
  '92400000-5000-4000-8000-000000000006', 95, 'completed', true, 'clear_statement', 0.9,
  'claude-haiku-5-5', 'auto_publication_arbiter_v1', null);
update public.information_agent_fact_candidates set proposed_value = '{"value": 96}'::jsonb
where id = '92400000-5000-4000-8000-000000000006';
select is(
  public.publish_information_agent_fact_auto(
    '92400000-5000-4000-8000-000000000006', 'surface_m2', 'auto_publication_v2', 'auto_publication_arbiter_v1') -> 'reasons',
  '["arbiter_value_mismatch"]'::jsonb,
  'a verdict given for another value never publishes the current one'
);
update public.information_agent_fact_candidates set proposed_value = '{"value": 95}'::jsonb
where id = '92400000-5000-4000-8000-000000000006';
-- Dix publications déjà faites aujourd'hui (heure de Paris), dans d'autres dossiers.
insert into public.information_agent_auto_publication_decisions (
  mode, policy_version, fact_id, case_id, sale_id, fact_key, outcome, reasons
) select 'auto', 'auto_publication_v2', gen_random_uuid(), gen_random_uuid(),
  '92400000-1000-4000-8000-000000000002', 'surface_m2', 'published', '{}'::text[]
from generate_series(1, 10);
select is(
  public.publish_information_agent_fact_auto(
    '92400000-5000-4000-8000-000000000006', 'surface_m2', 'auto_publication_v2', 'auto_publication_arbiter_v1') -> 'reasons',
  '["daily_cap_reached"]'::jsonb,
  'the eleventh publication of the day waits for review (10 per day)'
);
select is(
  (select status from public.information_agent_fact_candidates where id = '92400000-5000-4000-8000-000000000006'),
  'pending',
  'the fact over the daily cap stays pending'
);

-- L'observation automatique porte la vente et la valeur du fait ------------------------------------------------------------
update public.information_agent_fact_candidates set proposed_value = '{"value": "6"}'::jsonb
where id = '92400000-5000-4000-8000-000000000002';
select throws_ok(
  $$select app_private.accept_information_agent_claim_automatically(claim.id, 'auto_publication_v2')
      from public.auction_fact_claims claim
      where claim.evidence_locator ->> 'information_agent_fact_id' = '92400000-5000-4000-8000-000000000002'$$,
  '55000', 'claim_does_not_match_fact', 'the automatic decision refuses a claim whose value is not the fact one'
);
update public.information_agent_fact_candidates set proposed_value = '{"value": "5"}'::jsonb
where id = '92400000-5000-4000-8000-000000000002';

-- Opposition du contact -----------------------------------------------------------------------------------------------
insert into public.information_agent_contacts (email, opposition_status, opposed_at)
values ('avocat-924@example.test', 'opposed', now());
select ok(
  (public.publish_information_agent_fact_auto(
    '92400000-5000-4000-8000-000000000003', 'land_surface_m2', 'auto_publication_v2', 'auto_publication_arbiter_v1') -> 'reasons')
    ? 'contact_opposed',
  'an opposed contact is never published'
);

-- Retrait par le chemin existant (administrateur, jeton) -----------------------------------------------------------------
-- L'observation est lue avant de prendre le rôle du navigateur (qui ne lit pas le registre).
select set_config('test924.claim', (
  select claim.id::text from public.auction_fact_claims claim
  where claim.evidence_locator ->> 'information_agent_fact_id' = '92400000-5000-4000-8000-000000000001'
), true) is not null as claim_found;
select set_config('request.jwt.claims', '{"sub":"92400000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal1"}', true);
set local role authenticated;
select lives_ok(
  $$select public.withdraw_auction_fact_claim(current_setting('test924.claim')::uuid, 'other')$$,
  'an administrator withdraws an automatic publication with the existing withdrawal'
);
reset role;
select is(
  (select decision.decision || ':' || decision.publication_mode
   from public.auction_fact_claim_decisions decision
   where decision.information_agent_fact_id = '92400000-5000-4000-8000-000000000001'
   order by decision.seq desc limit 1),
  'withdrawn:manual',
  'the withdrawal is the latest decision, made by a person'
);
select is(
  (select surface_m2 from public.auction_sales where id = '92400000-1000-4000-8000-000000000001'),
  null::numeric,
  'the withdrawal releases the value from the sale'
);

-- Arrêt d'urgence ----------------------------------------------------------------------------------------------------
select is(
  (select mode from public.stop_information_agent_auto_publication()),
  'off',
  'the emergency stop switches the mode off'
);
select set_config('request.jwt.claims', '', true);
delete from public.information_agent_contacts where normalized_email = 'avocat-924@example.test';
select is(
  public.publish_information_agent_fact_auto(
    '92400000-5000-4000-8000-000000000003', 'land_surface_m2', 'auto_publication_v2', 'auto_publication_arbiter_v1') ->> 'status',
  'inactive',
  'after the emergency stop nothing is published'
);
select is(
  (select status from public.information_agent_fact_candidates where id = '92400000-5000-4000-8000-000000000003'),
  'pending',
  'the stopped fact stays pending'
);

-- Le moteur relit le mode sous verrou partagé avant toute écriture ---------------------------------------------------
select ok(
  (select prosrc ~* 'information_agent_auto_publication_settings settings\s+where settings\.singleton\s+for share'
          and position('for share' in prosrc) < position('apply_information_agent_fact' in prosrc)
     from pg_proc where oid = 'public.publish_information_agent_fact_auto(uuid, text, text, text)'::regprocedure),
  'the publication reads the mode under a shared lock before the core'
);

select * from finish();
rollback;
