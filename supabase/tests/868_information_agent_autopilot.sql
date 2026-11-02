-- 20261110230000 : pilote automatique de l'agent d'information (désactivé par défaut).
--   * réglages (ligne unique), journal en ajout seul sans adresse, identités exclues : RLS, aucun droit navigateur ;
--   * RPC d'administration (is_admin) : motif obligatoire, mode réel refusé sans attestation d'AIPD ni aller-retour
--     vérifié, arrêt d'urgence toujours permis, réactivation manuelle après un arrêt automatique ;
--   * filet SQL : une mission marquée trigger = 'autopilot' ne passe pas en « sending » hors du mode réel ;
--   * compteurs, purge de conservation (5 ans, 24 mois), mode d'envoi « autopilot », planification pg_cron.
begin;

select plan(51);

-- Structure et droits -------------------------------------------------------------------------------------------
select has_table('public', 'information_agent_autopilot_settings', 'the settings table exists');
select has_table('public', 'information_agent_autopilot_events', 'the events table exists');
select has_table('public', 'information_agent_autopilot_exclusions', 'the exclusions table exists');

select ok(
  (select bool_and(relrowsecurity) from pg_class where oid in (
    'public.information_agent_autopilot_settings'::regclass,
    'public.information_agent_autopilot_events'::regclass,
    'public.information_agent_autopilot_exclusions'::regclass))
  and not has_table_privilege('anon', 'public.information_agent_autopilot_events', 'SELECT')
  and not has_table_privilege('authenticated', 'public.information_agent_autopilot_events', 'SELECT')
  and not has_table_privilege('authenticated', 'public.information_agent_autopilot_settings', 'UPDATE')
  and not has_table_privilege('authenticated', 'public.information_agent_autopilot_exclusions', 'INSERT')
  and has_table_privilege('service_role', 'public.information_agent_autopilot_events', 'INSERT'),
  'RLS is on and no browser role reaches the three tables'
);

select ok(
  not has_function_privilege('anon', 'public.set_information_agent_autopilot_mode(text, text)', 'execute')
  and has_function_privilege('authenticated', 'public.set_information_agent_autopilot_mode(text, text)', 'execute')
  and not has_function_privilege('authenticated', 'public.record_information_agent_autopilot_event(text, uuid, jsonb)', 'execute')
  and not has_function_privilege('authenticated', 'public.record_information_agent_autopilot_auto_stop(text, jsonb, integer)', 'execute')
  and not has_function_privilege('authenticated', 'public.information_agent_autopilot_stats(timestamptz)', 'execute')
  and not has_function_privilege('authenticated', 'public.purge_information_agent_autopilot(timestamptz)', 'execute')
  and has_function_privilege('service_role', 'public.information_agent_autopilot_stats(timestamptz)', 'execute'),
  'administration RPCs are open to signed-in accounts (and check is_admin), service RPCs to the server only'
);

-- Valeurs par défaut ------------------------------------------------------------------------------------------------
select ok(
  (select mode = 'off' and not allow_licitor_decoded and not live_allowed and art14_rule_enabled and art14_max_age_days = 30
     and aipd_attested_at is null and acting_admin_id is null
   from public.information_agent_autopilot_settings),
  'the autopilot is off by default, cannot go live (lot 3 lock), Licitor addresses are excluded and the article 14 rule is on (30 days)'
);

select throws_ok(
  $$insert into public.information_agent_autopilot_settings (singleton) values (false)$$,
  '23514', null, 'the settings table keeps a single row'
);

-- Fixtures ---------------------------------------------------------------------------------------------------------
delete from public.operational_alerts where alert_key like 'information_agent.autopilot.%';
insert into auth.users (id) values ('86800000-0000-4000-8000-0000000000a1'), ('86800000-0000-4000-8000-0000000000a2');
insert into public.user_profiles (user_id, email, user_role) values
  ('86800000-0000-4000-8000-0000000000a1', 'autopilot-admin@example.test', 'admin'),
  ('86800000-0000-4000-8000-0000000000a2', 'autopilot-user@example.test', 'user')
on conflict (user_id) do update set user_role = excluded.user_role;

insert into public.tribunals (code, canonical_name, department, city)
values ('T868', 'Tribunal de test 868', '33', 'Bordeaux');
insert into public.auction_sales (id, source_name, source_url, status, tribunal_code)
values ('86800000-1000-4000-8000-000000000001', 'autopilot-pgtap', 'https://example.test/868', 'upcoming', 'T868');

-- Un compte qui n'est pas administrateur ---------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"86800000-0000-4000-8000-0000000000a2","role":"authenticated","aal":"aal2"}', true);

select throws_ok(
  $$select public.set_information_agent_autopilot_mode('simulation', 'Début de la simulation')$$,
  '42501', null, 'a non-admin account cannot change the mode'
);
select throws_ok(
  $$select public.stop_information_agent_autopilot('arrêt')$$,
  '42501', null, 'a non-admin account cannot stop the autopilot either'
);

-- Administrateur ----------------------------------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"86800000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal2"}', true);

select throws_ok(
  $$select public.set_information_agent_autopilot_mode('simulation', 'court')$$,
  '22023', null, 'a mode change without a reason of 8 characters is refused'
);
select throws_ok(
  $$select public.set_information_agent_autopilot_mode('turbo', 'Motif suffisant')$$,
  '22023', null, 'an unknown mode is refused'
);
select throws_ok(
  $$select public.set_information_agent_autopilot_mode('live', 'Passage en réel autorisé')$$,
  '55000', 'Mode réel non autorisé : les textes juridiques du lot 3 ne sont pas publiés.',
  'the real mode is refused by a direct RPC call while the lot 3 lock (live_allowed) is false'
);
-- Le verrou du lot 3 ne se lève que par migration : ici, le test le lève pour vérifier les autres conditions.
update public.information_agent_autopilot_settings set live_allowed = true;
select throws_ok(
  $$select public.set_information_agent_autopilot_mode('live', 'Passage en réel autorisé')$$,
  '55000', null, 'the real mode is refused without an AIPD attestation'
);

select is(
  (select mode from public.set_information_agent_autopilot_mode('simulation', 'Début de la simulation')),
  'simulation',
  'an administrator starts the simulation with a reason'
);
select ok(
  exists (
    select 1 from public.information_agent_autopilot_events
    where kind = 'mode_changed' and actor = '86800000-0000-4000-8000-0000000000a1'
      and reason = 'Début de la simulation' and before_values ->> 'mode' = 'off' and after_values ->> 'mode' = 'simulation'
  )
  and (select acting_admin_id = '86800000-0000-4000-8000-0000000000a1' and simulation_started_at is not null
       from public.information_agent_autopilot_settings),
  'the change is journalled (actor, before/after, reason) and the simulation clock starts'
);

select throws_ok(
  $$select public.set_information_agent_autopilot_mode('live', 'Passage en réel autorisé')$$,
  '55000', null, 'the real mode is still refused: no AIPD'
);
select is(
  (select aipd_version from public.attest_information_agent_aipd('AIPD-2026-11', 'AIPD signée le 02/11')),
  'AIPD-2026-11',
  'the AIPD attestation stores its version'
);
select throws_ok(
  $$select public.set_information_agent_autopilot_mode('live', 'Passage en réel autorisé')$$,
  '55000', null, 'the real mode is refused without a recent round trip verification'
);
-- Preuve de l'aller-retour : réponse de test reçue et routée vers un dossier de l'administrateur (adresse de son domaine).
insert into public.information_agent_cases (
  id, sale_id, created_by, status, recipient_email, normalized_recipient_email, subject, body_text, question_keys, missing_information, sent_at
) values (
  '86800000-3000-4000-8000-0000000000c1', '86800000-1000-4000-8000-000000000001', '86800000-0000-4000-8000-0000000000a1', 'sent', 'roundtrip-test@immojudis.com', 'roundtrip-test@immojudis.com', 'Message de test', 'Message de test de plus de vingt caractères.',
  array['documents'], array['documents'], now() - interval '2 hours'
);
insert into public.information_agent_missions (
  id, user_id, sale_id, case_id, status, recipient_email, subject, body_text, question_keys, missing_information, privacy_version
) values (
  '86800000-3000-4000-8000-0000000000c2', '86800000-0000-4000-8000-0000000000a1', '86800000-1000-4000-8000-000000000001', '86800000-3000-4000-8000-0000000000c1', 'sent', 'roundtrip-test@immojudis.com', 'Message de test', 'Message de test de plus de vingt caractères.',
  array['documents'], array['documents'], 'roundtrip-pgtap'
);
insert into public.information_agent_messages (
  id, mission_id, case_id, user_id, direction, message_kind, delivery_status, subject, body_text, received_at, provider_message_id, metadata
) values (
  '86800000-3000-4000-8000-0000000000c3', '86800000-3000-4000-8000-0000000000c2', '86800000-3000-4000-8000-0000000000c1', '86800000-0000-4000-8000-0000000000a1', 'inbound', 'reply', 'received', 'Re: Message de test', 'Réponse de test.', now() - interval '1 hour',
  'roundtrip-provider-868', '{"imported_manually": false, "sender_authentication": {"status": "pass"}, "sender_matches_recipient": true}'::jsonb
);

do $$
begin
  perform public.attest_information_agent_roundtrip('86800000-0000-4000-8000-0000000000a1');
end;
$$;
select is(
  (select mode from public.set_information_agent_autopilot_mode('live', 'Passage en réel autorisé')),
  'live',
  'with the AIPD and the round trip attested, an administrator can switch to the real mode'
);

-- Réglages -----------------------------------------------------------------------------------------------------------
select throws_ok(
  $$select public.update_information_agent_autopilot_settings('{"mode": "off"}', 'Réglage interdit ici')$$,
  '22023', null, 'the mode cannot be changed through the settings function'
);
select throws_ok(
  $$select public.update_information_agent_autopilot_settings('{"art14_max_age_days": 60}', 'x')$$,
  '22023', null, 'a settings change needs a reason'
);
select ok(
  (select art14_max_age_days = 60 and cap_total_override = 5
   from public.update_information_agent_autopilot_settings('{"art14_max_age_days": 60, "cap_total_override": 5}', 'Réglages de départ')),
  'settings change with a reason (values applied)'
);
-- Le journal est lu dans une instruction distincte : l'écriture de la fonction n'est pas visible dans son instruction.
select ok(
  exists (
    select 1 from public.information_agent_autopilot_events
    where kind = 'settings_changed' and before_values ->> 'art14_max_age_days' = '30' and after_values ->> 'art14_max_age_days' = '60'
  ),
  'the settings change is journalled with its before/after values'
);
select throws_ok(
  $$select public.update_information_agent_autopilot_settings('{"cap_total_override": 100}', 'Plafond trop haut')$$,
  '23514', null, 'the hard cap of 60 per day cannot be exceeded'
);

-- Arrêt d'urgence ---------------------------------------------------------------------------------------------------
select is(
  (select mode from public.stop_information_agent_autopilot()),
  'off',
  'the emergency stop is always allowed and needs no reason'
);
select ok(
  exists (select 1 from public.information_agent_autopilot_events where kind = 'emergency_stop' and before_values ->> 'mode' = 'live'),
  'the emergency stop is journalled'
);

-- Un motif contenant « @ » ne doit jamais empêcher l'arrêt d'urgence.
do $$
begin
  perform public.set_information_agent_autopilot_mode('simulation', 'Reprise pour le test du motif');
end;
$$;
select is(
  (select mode from public.stop_information_agent_autopilot('contact avocat@cabinet.example injoignable')),
  'off',
  'the emergency stop works even when the reason contains an @'
);
select ok(
  exists (select 1 from public.information_agent_autopilot_events
          where kind = 'emergency_stop' and reason like '%(at)%' and reason not like '%@%'),
  'the reason is journalled with the @ neutralised'
);

-- Journal en ajout seul -------------------------------------------------------------------------------------------------
select throws_ok(
  $$update public.information_agent_autopilot_events set reason = 'modifié'$$,
  '55000', null, 'the journal cannot be modified'
);
select throws_ok(
  $$delete from public.information_agent_autopilot_events$$,
  '55000', null, 'the journal cannot be deleted from'
);
select throws_ok(
  $$insert into public.information_agent_autopilot_events (kind, details) values ('skip', '{"contact": "avocat@cabinet.example"}')$$,
  '23514', null, 'a direct insert of an address in the journal is refused by the constraint'
);
select lives_ok(
  $$select public.record_information_agent_autopilot_event('skip', null, '{"contact": "avocat@cabinet.example"}')$$,
  'the service RPC neutralises an address instead of failing'
);
select ok(
  exists (select 1 from public.information_agent_autopilot_events where kind = 'skip' and details::text like '%(at)%')
  and not exists (select 1 from public.information_agent_autopilot_events where details::text like '%@%'),
  'the journal never holds an address'
);

-- Le journal, les attestations et les réglages ne s'écrivent que par les RPC : même service_role ne les modifie pas.
set local role service_role;
select throws_ok($$delete from public.information_agent_autopilot_events$$, '42501', null, 'service_role cannot delete journal rows');
select throws_ok($$update public.information_agent_autopilot_settings set mode = 'live'$$, '42501', null, 'service_role cannot write the settings directly');
select throws_ok($$delete from public.information_agent_roundtrip_attestations$$, '42501', null, 'service_role cannot delete attestations');
reset role;
select throws_ok($$truncate public.information_agent_autopilot_events$$, '55000', null, 'the journal cannot be truncated');
select ok(
  (public.purge_information_agent_autopilot(now() + interval '20 years') ->> 'information_agent_autopilot_events')::integer = 0
  and exists (select 1 from public.information_agent_autopilot_events),
  'the purge date cannot be pushed into the future to wipe recent journal rows'
);

-- Arrêt automatique et réactivation manuelle ---------------------------------------------------------------------------
do $$
begin
  perform public.record_information_agent_autopilot_event('send_error', null, '{"status": 500}');
  perform public.set_information_agent_autopilot_mode('simulation', 'Reprise de la simulation');
  perform public.record_information_agent_autopilot_auto_stop('complaint', '{"count": 1}');
end;
$$;
select ok(
  (select mode = 'off' and auto_stop_reason = 'complaint' and auto_stopped_at is not null
   from public.information_agent_autopilot_settings)
  and exists (select 1 from public.operational_alerts where alert_key = 'information_agent.autopilot.auto_stop' and status = 'open'),
  'an automatic stop switches the autopilot off, records the reason and opens a critical alert'
);
select throws_ok(
  $$select public.record_information_agent_autopilot_auto_stop('Plainte reçue', '{}')$$,
  '22023', null, 'the stop reason is a code, not free text'
);
do $$
begin
  perform public.set_information_agent_autopilot_mode('simulation', 'Réactivation après contrôle');
end;
$$;
select ok(
  (select auto_stopped_at is null and auto_stop_reason is null and mode = 'simulation' from public.information_agent_autopilot_settings)
  and exists (select 1 from public.operational_alerts where alert_key = 'information_agent.autopilot.auto_stop' and inactive_since is not null),
  'only a manual, journalled reactivation lifts an automatic stop and starts closing the alert (closing is deferred like every alert)'
);

-- Filet SQL ------------------------------------------------------------------------------------------------------------------
insert into public.information_agent_missions (
  id, user_id, sale_id, status, recipient_email, subject, body_text, question_keys, missing_information, privacy_version, metadata
) values
  ('86800000-3000-4000-8000-000000000001', '86800000-0000-4000-8000-0000000000a1', '86800000-1000-4000-8000-000000000001', 'draft',
   'auto@cabinet-pilote.example', 'Objet de test', 'Corps de test de plus de vingt caractères.', array['documents'],
   array['documents'], '868-pgtap', '{"trigger": "autopilot"}'),
  ('86800000-3000-4000-8000-000000000002', '86800000-0000-4000-8000-0000000000a1', '86800000-1000-4000-8000-000000000001', 'draft',
   'manuel@cabinet-pilote.example', 'Objet de test', 'Corps de test de plus de vingt caractères.', array['documents'],
   array['documents'], '868-pgtap', '{}'::jsonb);

select throws_ok(
  $$update public.information_agent_missions set status = 'sending', approved_at = now() where id = '86800000-3000-4000-8000-000000000001'$$,
  '23514', null, 'the SQL net refuses an autopilot send when the autopilot is not in the real mode'
);
select lives_ok(
  $$update public.information_agent_missions set status = 'sending', approved_at = now() where id = '86800000-3000-4000-8000-000000000002'$$,
  'a manual send is not affected by the autopilot mode'
);
insert into public.information_agent_missions (
  id, user_id, sale_id, status, recipient_email, subject, body_text, question_keys, missing_information, privacy_version, metadata
) values (
  '86800000-3000-4000-8000-000000000004', '86800000-0000-4000-8000-0000000000a1', '86800000-1000-4000-8000-000000000001', 'draft',
  'valide-a-la-main@cabinet-pilote.example', 'Objet de test', 'Corps de test de plus de vingt caractères.', array['documents'],
  array['documents'], '868-pgtap', '{"trigger": "manual"}'::jsonb
);
select lives_ok(
  $$update public.information_agent_missions set status = 'sending', approved_at = now() where id = '86800000-3000-4000-8000-000000000004'$$,
  'a draft of the autopilot approved by hand (trigger rewritten to manual) passes the SQL net outside the real mode'
);
update public.information_agent_autopilot_settings set mode = 'live';
select lives_ok(
  $$update public.information_agent_missions set status = 'sending', approved_at = now() where id = '86800000-3000-4000-8000-000000000001'$$,
  'an autopilot send passes the net when the autopilot is in the real mode'
);
update public.information_agent_autopilot_settings set mode = 'off';

-- Journal des envois, compteurs ------------------------------------------------------------------------------------------------
select lives_ok(
  $$insert into public.email_send_log (resend_email_id, template_key, category, mode, to_address, status, bounce_type)
    values ('868-a', 'agent_request', 'agent', 'autopilot', 'a1@example.test', 'delivered', null),
           ('868-b', 'agent_request', 'agent', 'autopilot', 'a2@example.test', 'bounced', 'permanent'),
           ('868-c', 'agent_request', 'agent', 'autopilot', 'a3@example.test', 'complained', null)$$,
  'the send log accepts the autopilot send mode'
);
select ok(
  (public.information_agent_autopilot_stats() ->> 'autopilot_total')::integer = 3
  and (public.information_agent_autopilot_stats() ->> 'first100_complaints')::integer = 1
  and (public.information_agent_autopilot_stats() ->> 'first30_permanent_bounces')::integer = 1
  and (public.information_agent_autopilot_stats() ->> 'consecutive_api_errors')::integer = 1
  and (public.information_agent_autopilot_stats() ->> 'sent_today_total')::integer >= 2,
  'the counters report autopilot sends, complaints, bounces, consecutive API errors and the day total (manual included)'
);

-- Exclusions et purge -----------------------------------------------------------------------------------------------------------
select is(
  public.record_information_agent_autopilot_exclusions(array['lawyer|bordeaux|dupont jean']),
  1,
  'a wrong-recipient identity is excluded from the autopilot'
);
insert into public.information_agent_autopilot_events (at, kind, details) values ('2020-01-01T00:00:00Z', 'run', '{}');
update public.information_agent_autopilot_exclusions set created_at = now() - interval '25 months';
select ok(
  (public.purge_information_agent_autopilot() ->> 'information_agent_autopilot_events')::integer >= 1,
  'the dedicated purge removes journal rows older than 5 years'
);
select ok(
  not exists (select 1 from public.information_agent_autopilot_events where at < now() - interval '5 years')
  and not exists (select 1 from public.information_agent_autopilot_exclusions)
  and (public.purge_information_agent_autopilot() ->> 'information_agent_autopilot_exclusions')::integer = 0,
  'the exclusions older than 24 months are gone too, and a second purge finds nothing (idempotent)'
);

-- Planification ------------------------------------------------------------------------------------------------------------------
select ok(
  exists (select 1 from cron.job where jobname = 'immojudis-information-agent-autopilot')
  and exists (select 1 from public.cron_lease where name = 'information-agent-autopilot')
  and position('settings.mode <> ''off''' in pg_get_functiondef(
    'app_private.invoke_information_agent_autopilot_endpoint()'::regprocedure)) > 0,
  'pg_cron runs the endpoint, the lease row exists and the HTTP call is skipped while the mode is off'
);

select * from finish();
rollback;
