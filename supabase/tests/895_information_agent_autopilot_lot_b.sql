-- Lot B du pilote automatique (état des lieux du 14/11/2026, validé le même jour) :
--   * 20261119100800 : public.mark_information_agent_autopilot_simulated fusionne la marque « simulé » dans le
--     metadata d'un brouillon du pilote, en une instruction, sans toucher aux autres clés ; refus contrôlés ;
--     SECURITY INVOKER, exécutable par service_role seul (T8) ;
--   * 20261119100810 : la règle de l'article 14 ne se désactive plus et son délai va de 1 à 90 jours (décision du
--     propriétaire du 14/11/2026), valeur par défaut 90, ligne existante inchangée ; l'arrêt d'urgence reste possible.
begin;

select plan(20);

-- Fixtures ---------------------------------------------------------------------------------------------------------
insert into auth.users (id) values ('89500000-0000-4000-8000-0000000000a1');
insert into public.user_profiles (user_id, email, user_role) values
  ('89500000-0000-4000-8000-0000000000a1', 'autopilot-lot-b@example.test', 'admin')
on conflict (user_id) do update set user_role = excluded.user_role;
insert into public.tribunals (code, canonical_name, department, city)
values ('T895', 'Tribunal de test 895', '33', 'Bordeaux');
insert into public.auction_sales (id, source_name, source_url, status, tribunal_code)
values ('89500000-1000-4000-8000-000000000001', 'autopilot-pgtap', 'https://example.test/895', 'upcoming', 'T895');
insert into public.information_agent_missions (
  id, user_id, sale_id, status, recipient_email, subject, body_text, question_keys, missing_information, privacy_version, metadata
) values
  ('89500000-3000-4000-8000-000000000001', '89500000-0000-4000-8000-0000000000a1', '89500000-1000-4000-8000-000000000001', 'draft',
   'pilote@cabinet-lot-b.example', 'Objet de test', 'Corps de test de plus de vingt caractères.', array['documents'],
   array['documents'], '895-pgtap', '{"trigger": "autopilot", "email_content_template_revision": 4, "contact_identity": {"role": "lawyer"}}'),
  ('89500000-3000-4000-8000-000000000002', '89500000-0000-4000-8000-0000000000a1', '89500000-1000-4000-8000-000000000001', 'draft',
   'admin@cabinet-lot-b.example', 'Objet de test', 'Corps de test de plus de vingt caractères.', array['documents'],
   array['documents'], '895-pgtap', '{"trigger": "manual"}'),
  ('89500000-3000-4000-8000-000000000003', '89500000-0000-4000-8000-0000000000a1', '89500000-1000-4000-8000-000000000001', 'cancelled',
   'annule@cabinet-lot-b.example', 'Objet de test', 'Corps de test de plus de vingt caractères.', array['documents'],
   array['documents'], '895-pgtap', '{"trigger": "autopilot"}');

-- T8 : marque « simulé » posée par la base ------------------------------------------------------------------------
select has_function(
  'public', 'mark_information_agent_autopilot_simulated', array['uuid'],
  'the function that marks a simulated draft exists'
);
select ok(
  (select not prosecdef and proconfig = array['search_path=""']
   from pg_proc where oid = 'public.mark_information_agent_autopilot_simulated(uuid)'::regprocedure),
  'it is SECURITY INVOKER with an empty search_path'
);
select ok(
  not has_function_privilege('anon', 'public.mark_information_agent_autopilot_simulated(uuid)', 'execute')
  and not has_function_privilege('authenticated', 'public.mark_information_agent_autopilot_simulated(uuid)', 'execute')
  and has_function_privilege('service_role', 'public.mark_information_agent_autopilot_simulated(uuid)', 'execute'),
  'only service_role (the autopilot executor) can call it'
);
select lives_ok(
  $$select public.mark_information_agent_autopilot_simulated('89500000-3000-4000-8000-000000000001')$$,
  'an autopilot draft is marked'
);
select is(
  (select metadata from public.information_agent_missions where id = '89500000-3000-4000-8000-000000000001'),
  '{"trigger": "autopilot", "email_content_template_revision": 4, "contact_identity": {"role": "lawyer"}, "autopilot_simulated": true}'::jsonb,
  'the mark is merged: every other metadata key is kept'
);
select lives_ok(
  $$select public.mark_information_agent_autopilot_simulated('89500000-3000-4000-8000-000000000001')$$,
  'marking twice is harmless'
);
-- Appel par l'exécuteur du pilote lui-même : SECURITY INVOKER, il lui faut ses propres droits sur la table.
set local role service_role;
select lives_ok(
  $$select public.mark_information_agent_autopilot_simulated('89500000-3000-4000-8000-000000000001')$$,
  'service_role (the autopilot executor) can mark a draft with its own rights'
);
reset role;
select throws_ok(
  $$select public.mark_information_agent_autopilot_simulated('89500000-3000-4000-8000-000000000002')$$,
  'P0002', null, 'a draft prepared by an administrator is refused'
);
select throws_ok(
  $$select public.mark_information_agent_autopilot_simulated('89500000-3000-4000-8000-000000000003')$$,
  'P0002', null, 'an autopilot mission that is no longer a draft is refused'
);
select throws_ok(
  $$select public.mark_information_agent_autopilot_simulated(null)$$,
  '22023', null, 'a missing identifier is refused'
);
select ok(
  (select metadata = '{"trigger": "manual"}'::jsonb from public.information_agent_missions
   where id = '89500000-3000-4000-8000-000000000002')
  and (select metadata = '{"trigger": "autopilot"}'::jsonb from public.information_agent_missions
   where id = '89500000-3000-4000-8000-000000000003'),
  'a refused call writes nothing'
);

-- J9 : article 14 non désactivable ; délai de 1 à 90 jours (décision du propriétaire du 14/11/2026) ---------------
select set_config('request.jwt.claims', '{"sub":"89500000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal2"}', true);

select throws_ok(
  $$select public.update_information_agent_autopilot_settings('{"art14_rule_enabled": false}', 'Couper l''article 14')$$,
  '23514', null, 'the article 14 rule can no longer be switched off'
);
-- Décision du propriétaire du 14/11/2026 : 90 jours au plus. La ligne existante n'est pas modifiée par la migration
-- (30, valeur posée par 20261110230000) ; seule la valeur par défaut de la colonne passe à 90.
select ok(
  (select art14_max_age_days = 30 from public.information_agent_autopilot_settings)
  and (select column_default = '90' from information_schema.columns
       where table_schema = 'public' and table_name = 'information_agent_autopilot_settings'
         and column_name = 'art14_max_age_days'),
  'the existing row keeps its 30 days; the column default becomes 90'
);
select throws_ok(
  $$select public.update_information_agent_autopilot_settings('{"art14_max_age_days": 91}', 'Délai trop long')$$,
  '23514', null, 'the article 14 delay cannot exceed 90 days'
);
select throws_ok(
  $$select public.update_information_agent_autopilot_settings('{"art14_max_age_days": 0}', 'Délai trop court')$$,
  '23514', null, 'the article 14 delay is at least one day'
);
select ok(
  (select art14_rule_enabled and art14_max_age_days = 90
   from public.update_information_agent_autopilot_settings('{"art14_max_age_days": 90}', 'Délai porté à 90 jours')),
  'the owner can set the delay to 90 days through the settings function'
);
select ok(
  (select art14_rule_enabled and art14_max_age_days = 20
   from public.update_information_agent_autopilot_settings('{"art14_max_age_days": 20, "art14_rule_enabled": true}', 'Délai réduit à 20 jours')),
  'a delay within 1 to 90 days is applied, the rule stays on'
);
select throws_ok(
  $$update public.information_agent_autopilot_settings set art14_rule_enabled = false$$,
  '23514', null, 'the constraint also refuses a direct write'
);
select is(
  (select mode from public.stop_information_agent_autopilot('Arrêt après le réglage')),
  'off',
  'the emergency stop still works on the constrained row'
);
select ok(
  (select pg_catalog.bool_and(convalidated) from pg_constraint
   where conrelid = 'public.information_agent_autopilot_settings'::regclass
     and conname in ('information_agent_autopilot_settings_art14_max_age_days_check',
                     'information_agent_autopilot_settings_art14_rule_always_on')
   having pg_catalog.count(*) = 2),
  'both article 14 constraints exist and are validated'
);

select * from finish();
rollback;
