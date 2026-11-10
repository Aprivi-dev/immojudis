-- 20261115100000 : moteur « publier ou relire » en simulation (propositions 6 et 7).
--   * réglage à ligne unique, 'off' par défaut, mode 'auto' verrouillé (contrainte ET refus de la RPC) ;
--   * changement de mode réservé à un administrateur et tracé (qui, quand, ancien et nouveau mode) ;
--   * arrêt d'urgence : un geste, effet immédiat (plus aucune décision écrite) ;
--   * journal des décisions en ajout seul, fermé aux rôles de l'API, motifs en liste fermée, champs en liste
--     fermée ; il suit la vente ;
--   * aucun chemin ne publie : la base refuse toute publication 'auto' (verrou du journal des publications),
--     même par un appel direct du noyau.
begin;

set local timezone = 'UTC';

select plan(52);

-- Structure et droits -------------------------------------------------------------------------------------------
select has_table('public', 'information_agent_auto_publication_settings', 'the settings table exists');
select has_table('public', 'information_agent_auto_publication_mode_changes', 'the mode trail exists');
select has_table('public', 'information_agent_auto_publication_decisions', 'the decision journal exists');

select ok(
  (select bool_and(relrowsecurity) from pg_class where oid in (
    'public.information_agent_auto_publication_settings'::regclass,
    'public.information_agent_auto_publication_mode_changes'::regclass,
    'public.information_agent_auto_publication_decisions'::regclass))
  and not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename in (
      'information_agent_auto_publication_settings',
      'information_agent_auto_publication_mode_changes',
      'information_agent_auto_publication_decisions')
  ),
  'RLS is on and no policy opens the three tables'
);

select is(
  (
    select coalesce(array_agg(format('%s %s %s', grantee, tbl, priv) order by grantee, tbl, priv), array[]::text[])
    from unnest(array['anon', 'authenticated', 'service_role']) as roles(grantee)
    cross join unnest(array[
      'public.information_agent_auto_publication_settings',
      'public.information_agent_auto_publication_mode_changes',
      'public.information_agent_auto_publication_decisions'
    ]) as tables(tbl)
    cross join unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'TRIGGER', 'REFERENCES']) as privileges(priv)
    where has_table_privilege(grantee, tbl, priv)
  ),
  array[
    'service_role public.information_agent_auto_publication_decisions SELECT',
    'service_role public.information_agent_auto_publication_mode_changes SELECT',
    'service_role public.information_agent_auto_publication_settings SELECT'
  ]::text[],
  'the API roles hold no privilege on the three tables, except SELECT for the server'
);

select ok(
  not has_function_privilege('anon', 'public.set_information_agent_auto_publication_mode(text)', 'execute')
  and has_function_privilege('authenticated', 'public.set_information_agent_auto_publication_mode(text)', 'execute')
  and has_function_privilege('authenticated', 'public.stop_information_agent_auto_publication()', 'execute')
  and not has_function_privilege('authenticated', 'public.record_information_agent_auto_publication_decision(uuid, text, text, text[], text)', 'execute')
  and not has_function_privilege('anon', 'public.record_information_agent_auto_publication_decision(uuid, text, text, text[], text)', 'execute')
  and has_function_privilege('service_role', 'public.record_information_agent_auto_publication_decision(uuid, text, text, text[], text)', 'execute'),
  'administration RPCs are open to signed-in accounts (they check is_admin), the decision RPC to the server only'
);

-- Valeur par défaut et verrous ---------------------------------------------------------------------------------------
select is(
  (select mode from public.information_agent_auto_publication_settings),
  'off',
  'the mode is off by default'
);
select throws_ok(
  $$insert into public.information_agent_auto_publication_settings (singleton) values (false)$$,
  '23514', null, 'the settings table keeps a single row'
);
select throws_ok(
  $$update public.information_agent_auto_publication_settings set mode = 'auto'$$,
  '23514',
  'new row for relation "information_agent_auto_publication_settings" violates check constraint "information_agent_auto_publication_settings_auto_locked"',
  'the auto mode cannot be stored, even by a direct write of the owner (lock constraint)'
);
select is(
  (select pg_get_constraintdef(oid) from pg_constraint
   where conrelid = 'public.information_agent_auto_publication_settings'::regclass
     and conname = 'information_agent_auto_publication_settings_auto_locked'),
  'CHECK ((mode <> ''auto''::text))',
  'the mode lock has its exact definition (a constraint of the same name that checks nothing would fail)'
);
select is(
  (select pg_get_constraintdef(oid) from pg_constraint
   where conrelid = 'public.information_agent_fact_publications'::regclass
     and conname = 'information_agent_fact_publications_auto_locked'),
  'CHECK ((actor_kind <> ''auto''::text))',
  'the publication lock has its exact definition'
);

-- Fixtures ---------------------------------------------------------------------------------------------------------
insert into auth.users (id) values
  ('88000000-0000-4000-8000-0000000000a1'),
  ('88000000-0000-4000-8000-0000000000a2');
insert into public.user_profiles (user_id, email, user_role) values
  ('88000000-0000-4000-8000-0000000000a1', 'auto-publication-admin-880@example.test', 'admin'),
  ('88000000-0000-4000-8000-0000000000a2', 'auto-publication-user-880@example.test', 'user')
on conflict (user_id) do update set user_role = excluded.user_role;

-- Même forme de vente que le test 878, où le noyau publie le nombre de pièces.
insert into public.auction_sales (
  id, source_name, source_url, status, sale_date, city, property_type, starting_price_eur,
  raw_payload, sale_procedure, sale_venue_type
) values
  ('88000000-1000-4000-8000-000000000001', 'licitor', 'https://example.test/880/sale', 'upcoming',
   current_timestamp + interval '20 days', 'Alphaville', 'apartment', 90000,
   '{}'::jsonb, '{}'::jsonb, 'tribunal'),
  ('88000000-1000-4000-8000-000000000002', 'licitor', 'https://example.test/880/sale-2', 'upcoming',
   current_timestamp + interval '20 days', 'Alphaville', 'apartment', 90000,
   '{}'::jsonb, '{}'::jsonb, 'tribunal');
insert into public.information_agent_cases (
  id, sale_id, created_by, status, recipient_kind, recipient_email, normalized_recipient_email, subject,
  body_text, question_keys, missing_information, sent_at, replied_at
) values (
  '88000000-3000-4000-8000-000000000001', '88000000-1000-4000-8000-000000000001',
  '88000000-0000-4000-8000-0000000000a1', 'replied', 'source_lawyer', 'avocat-880@example.test',
  'avocat-880@example.test', 'Demande d''informations', 'Merci de nous transmettre la surface.',
  array['surface'], array['surface'], now() - interval '3 days', now() - interval '2 days'
);
insert into public.information_agent_missions (
  id, user_id, sale_id, case_id, status, recipient_email, subject, body_text, question_keys,
  missing_information, privacy_version
) values (
  '88000000-2000-4000-8000-000000000001', '88000000-0000-4000-8000-0000000000a1',
  '88000000-1000-4000-8000-000000000001', '88000000-3000-4000-8000-000000000001', 'sent',
  'avocat-880@example.test', 'Demande d''informations', 'Merci de nous transmettre la surface.',
  array['surface'], array['surface'], '880-pgtap'
);
insert into public.information_agent_messages (
  id, mission_id, case_id, user_id, direction, message_kind, delivery_status, subject, body_text,
  received_at, provider_message_id, metadata
) values (
  '88000000-4000-4000-8000-000000000001', '88000000-2000-4000-8000-000000000001',
  '88000000-3000-4000-8000-000000000001', '88000000-0000-4000-8000-0000000000a1',
  'inbound', 'reply', 'received', 'Re: Demande d''informations', 'La surface habitable est de 54 m².',
  now() - interval '2 days', 'auto-publication-provider-880',
  '{"imported_manually": false, "sender_matches_recipient": true}'::jsonb
);
insert into public.information_agent_fact_candidates (
  id, case_id, message_id, sale_id, fact_key, proposed_value, display_value, evidence_excerpt, confidence,
  status
) values
  ('88000000-5000-4000-8000-000000000001', '88000000-3000-4000-8000-000000000001',
   '88000000-4000-4000-8000-000000000001', '88000000-1000-4000-8000-000000000001', 'surface_m2',
   '{"value": 54}'::jsonb, '54 m²', 'La surface habitable est de 54 m².', 0.9, 'pending'),
  ('88000000-5000-4000-8000-000000000002', '88000000-3000-4000-8000-000000000001',
   '88000000-4000-4000-8000-000000000001', '88000000-1000-4000-8000-000000000001', 'occupancy_status',
   '{"value": "vacant"}'::jsonb, 'Libre', 'Le bien est libre.', 0.9, 'pending'),
  -- Fait « accepté » sans relecteur : la seule forme qu'une publication automatique pourrait prendre.
  ('88000000-5000-4000-8000-000000000003', '88000000-3000-4000-8000-000000000001',
   '88000000-4000-4000-8000-000000000001', '88000000-1000-4000-8000-000000000001', 'rooms_count',
   '{"value": 3}'::jsonb, '3 pièces', 'L''appartement compte 3 pièces.', 0.9, 'accepted');

-- Aucun chemin ne publie : le noyau appelé directement avec 'auto' échoue et n'écrit rien ---------------------
select throws_ok(
  $$select app_private.apply_information_agent_fact(
      '88000000-5000-4000-8000-000000000003', 'auto', null, 'auto_publication_v1')$$,
  '23514',
  'new row for relation "information_agent_fact_publications" violates check constraint "information_agent_fact_publications_auto_locked"',
  'a direct call of the publication core with auto fails on the lock'
);
select ok(
  (select rooms_count is null
          and not coalesce(raw_payload ? 'information_agent_verified_facts', false)
     from public.auction_sales where id = '88000000-1000-4000-8000-000000000001')
  and not exists (
    select 1 from public.information_agent_fact_publications
    where fact_id = '88000000-5000-4000-8000-000000000003'
  ),
  'the failed automatic call left neither the sale nor the journal changed'
);
select ok(
  (select prosrc ~ 'Automatic information-agent publications have no fact-claim provenance yet'
     from pg_proc where oid = 'app_private.bridge_accepted_information_agent_fact_claim()'::regprocedure),
  'the claim bridge still refuses auto as a second barrier'
);

-- Mode off : rien n'est écrit -----------------------------------------------------------------------------------
select is(
  public.record_information_agent_auto_publication_decision(
    '88000000-5000-4000-8000-000000000001', 'surface_m2', 'would_publish', '{}', 'auto_publication_v1'
  ),
  false,
  'in off mode no decision is recorded'
);

-- Le rôle de service ne contourne rien --------------------------------------------------------------------------
select set_config('request.jwt.claims', '', true);
set local role service_role;
select throws_ok(
  $$insert into public.information_agent_auto_publication_decisions (
      mode, policy_version, fact_id, case_id, sale_id, fact_key, outcome, reasons
    ) values (
      'simulation', 'auto_publication_v1', '88000000-5000-4000-8000-000000000001',
      '88000000-3000-4000-8000-000000000001', '88000000-1000-4000-8000-000000000001', 'surface_m2',
      'would_publish', '{}'
    )$$,
  '42501', null, 'the server role cannot write a decision directly'
);
select throws_ok(
  $$update public.information_agent_auto_publication_settings set mode = 'simulation'$$,
  '42501', null, 'the server role cannot change the mode directly'
);
select throws_ok(
  $$select public.set_information_agent_auto_publication_mode('simulation')$$,
  '42501', null, 'the server role is not an administrator: the mode RPC refuses it'
);
select throws_ok(
  $$select public.stop_information_agent_auto_publication()$$,
  '42501', null, 'the server role is not an administrator: the stop RPC refuses it'
);
reset role;

-- Un compte qui n'est pas administrateur ---------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"88000000-0000-4000-8000-0000000000a2","role":"authenticated","aal":"aal2"}', true);
select throws_ok(
  $$select public.set_information_agent_auto_publication_mode('simulation')$$,
  '42501', null, 'a non-admin account cannot change the mode'
);
select throws_ok(
  $$select public.stop_information_agent_auto_publication()$$,
  '42501', null, 'a non-admin account cannot stop either'
);

-- Administrateur ----------------------------------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"88000000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal2"}', true);
select throws_ok(
  $$select public.set_information_agent_auto_publication_mode('auto')$$,
  '55000', null, 'the auto mode is refused by the RPC, even for an administrator'
);
select throws_ok(
  $$select public.set_information_agent_auto_publication_mode('turbo')$$,
  '22023', null, 'an unknown mode is refused'
);
select is(
  (select mode from public.set_information_agent_auto_publication_mode('simulation')),
  'simulation',
  'an administrator starts the simulation'
);
select ok(
  exists (
    select 1 from public.information_agent_auto_publication_mode_changes
    where actor_id = '88000000-0000-4000-8000-0000000000a1'
      and previous_mode = 'off' and new_mode = 'simulation' and not emergency_stop
      and changed_at is not null
  ),
  'the change is traced: who, when, previous and new mode'
);

-- Simulation : décisions écrites -------------------------------------------------------------------------------------
select is(
  public.record_information_agent_auto_publication_decision(
    '88000000-5000-4000-8000-000000000001', 'surface_m2', 'would_publish', '{}', 'auto_publication_v1'
  ),
  true,
  'in simulation a decision is recorded'
);
select ok(
  (select case_id = '88000000-3000-4000-8000-000000000001' and sale_id = '88000000-1000-4000-8000-000000000001'
          and mode = 'simulation' and outcome = 'would_publish' and reasons = '{}'::text[]
     from public.information_agent_auto_publication_decisions
     where fact_id = '88000000-5000-4000-8000-000000000001'),
  'the case and the sale are read from the fact, never supplied by the caller'
);
select is(
  public.record_information_agent_auto_publication_decision(
    '88000000-5000-4000-8000-000000000001', 'surface_m2', 'would_publish', '{}', 'auto_publication_v1'
  ),
  false,
  'an identical decision is not written twice'
);
select is(
  public.record_information_agent_auto_publication_decision(
    '88000000-5000-4000-8000-000000000001', 'surface_m2', 'review', array['daily_cap_reached'], 'auto_publication_v1'
  ),
  true,
  'a changed decision is appended'
);
select is(
  public.record_information_agent_auto_publication_decision(
    '88000000-5000-4000-8000-0000000000ff', 'surface_m2', 'review', array['input_unreadable'], 'auto_publication_v1'
  ),
  false,
  'a fact that disappeared since the read is skipped without error'
);
select throws_ok(
  $$select public.record_information_agent_auto_publication_decision(
      '88000000-5000-4000-8000-000000000002', 'occupancy_status', 'would_publish', '{}', 'auto_publication_v1'
    )$$,
  '23514', null, 'a field outside the closed list can never be marked « would publish »'
);
select throws_ok(
  $$select public.record_information_agent_auto_publication_decision(
      '88000000-5000-4000-8000-000000000002', 'occupancy_status', 'review',
      array['Le bien est occupé par M. Martin'], 'auto_publication_v1'
    )$$,
  '23514', null, 'reasons are codes only: no free text from the message'
);
select throws_ok(
  $$select public.record_information_agent_auto_publication_decision(
      '88000000-5000-4000-8000-000000000002', 'occupancy_status', 'review',
      array['occupe_par_jean_dupont'], 'auto_publication_v1'
    )$$,
  '23514', null, 'reasons come from a closed list: a snake_case name is refused'
);
select throws_ok(
  $$select public.record_information_agent_auto_publication_decision(
      '88000000-5000-4000-8000-000000000002', 'occupancy_status', 'review', array['a,b'], 'auto_publication_v1'
    )$$,
  '23514', null, 'a reason with a comma is refused'
);
select throws_ok(
  $$select public.record_information_agent_auto_publication_decision(
      '88000000-5000-4000-8000-000000000002', 'occupancy_status', 'review', array[''], 'auto_publication_v1'
    )$$,
  '23514', null, 'an empty reason is refused'
);
select throws_ok(
  $$select public.record_information_agent_auto_publication_decision(
      '88000000-5000-4000-8000-000000000002', 'occupancy_status', 'review', array['avocat@example.test'],
      'auto_publication_v1'
    )$$,
  '23514', null, 'no email address in the journal'
);
select throws_ok(
  $$select public.record_information_agent_auto_publication_decision(
      '88000000-5000-4000-8000-000000000001', 'rooms_count', 'review', array['field_not_eligible'],
      'auto_publication_v1'
    )$$,
  '22023', null, 'the key must be the key of the fact'
);

-- Ajout seul ---------------------------------------------------------------------------------------------------------
select throws_ok(
  $$update public.information_agent_auto_publication_decisions set outcome = 'review', reasons = array['field_not_empty']$$,
  '55000', 'Le journal de la publication automatique est en ajout seul.',
  'a decision cannot be updated, even by the owner'
);
select throws_ok(
  $$delete from public.information_agent_auto_publication_decisions$$,
  '55000', 'Le journal de la publication automatique est en ajout seul.',
  'a decision cannot be deleted while its sale exists'
);
select throws_ok(
  $$truncate public.information_agent_auto_publication_decisions$$,
  '55000', 'Le journal de la publication automatique est en ajout seul.',
  'the decision journal cannot be truncated'
);
select throws_ok(
  $$update public.information_agent_auto_publication_mode_changes set new_mode = 'off'$$,
  '55000', 'Le journal de la publication automatique est en ajout seul.',
  'the mode trail cannot be updated'
);
select throws_ok(
  $$delete from public.information_agent_auto_publication_mode_changes$$,
  '55000', 'Le journal de la publication automatique est en ajout seul.',
  'the mode trail cannot be deleted'
);
select throws_ok(
  $$truncate public.information_agent_auto_publication_mode_changes$$,
  '55000', 'Le journal de la publication automatique est en ajout seul.',
  'the mode trail cannot be truncated'
);

-- Arrêt d'urgence ---------------------------------------------------------------------------------------------------
select is(
  (select mode from public.stop_information_agent_auto_publication()),
  'off',
  'the emergency stop sets the mode to off in one call'
);
select ok(
  exists (
    select 1 from public.information_agent_auto_publication_mode_changes
    where previous_mode = 'simulation' and new_mode = 'off' and emergency_stop
      and actor_id = '88000000-0000-4000-8000-0000000000a1'
  ),
  'the stop is traced'
);
select is(
  public.record_information_agent_auto_publication_decision(
    '88000000-5000-4000-8000-000000000001', 'surface_m2', 'would_publish', '{}', 'auto_publication_v1'
  ),
  false,
  'the stop takes effect immediately: no further decision is recorded'
);
select is(
  (select mode from public.stop_information_agent_auto_publication()),
  'off',
  'the emergency stop is always allowed, even when already off'
);

-- Aucune fonction n'appelle le noyau avec 'auto' --------------------------------------------------------------------
select ok(
  not exists (
    select 1 from pg_proc
    where prokind = 'f'
      and pronamespace in ('public'::regnamespace, 'app_private'::regnamespace)
      and oid <> 'app_private.apply_information_agent_fact(uuid,text,uuid,text)'::regprocedure
      and prosrc ~* 'apply_information_agent_fact"?\s*\([^)]*''auto'''
  ),
  'no function calls the publication core with auto'
);

-- Le journal suit la vente : seule suppression admise --------------------------------------------------------------
select set_config('request.jwt.claims', '', true);
insert into public.information_agent_auto_publication_decisions (
  mode, policy_version, fact_id, case_id, sale_id, fact_key, outcome, reasons
) values (
  'simulation', 'auto_publication_v1', '88000000-5000-4000-8000-0000000000f2',
  '88000000-3000-4000-8000-0000000000f2', '88000000-1000-4000-8000-000000000002', 'surface_m2',
  'review', array['field_not_empty']
);
-- Une vente ne se supprime qu'avec son pont vers l'Outcome Graph (même préparation que le test 372).
select lives_ok(
  $$select * from public.bridge_auction_sales_to_outcome_graph()$$,
  'the deletion fixture has the required Outcome Graph bridge'
);
select lives_ok(
  $$delete from public.auction_sales where id = '88000000-1000-4000-8000-000000000002'$$,
  'deleting a sale is not blocked by the append-only journal'
);
select is(
  (select count(*)::integer from public.information_agent_auto_publication_decisions
   where sale_id = '88000000-1000-4000-8000-000000000002'),
  0,
  'the decisions of the deleted sale are gone'
);
select ok(
  exists (
    select 1 from public.information_agent_auto_publication_decisions
    where sale_id = '88000000-1000-4000-8000-000000000001'
  ),
  'the decisions of the other sale are kept'
);

select * from finish();
rollback;
