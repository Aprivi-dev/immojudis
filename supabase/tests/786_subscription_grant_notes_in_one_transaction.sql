-- 20261108190000 (revue du 28/10/2026, n° 4) : le motif d'une prolongation d'essai ou d'une attribution manuelle
-- s'écrit dans la même transaction que la ligne d'abonnement, hors de la ligne lisible par le compte.
--   * extend_trial_with_note : « written » (ligne + motif) ou « changed » (updated_at différent, ligne déjà là :
--     rien n'est écrit, pas de motif orphelin) ;
--   * grant_manual_subscription : ligne + motif facultatif dans app_private.manual_grant_notes ;
--   * tables et fonctions fermées au navigateur ; les motifs partent avec le compte.
begin;

select plan(19);

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data
) values
  ('c7860000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'one@note786.example.test', '', now(), now(), now(), '{}'::jsonb, '{}'::jsonb),
  ('c7860000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'two@note786.example.test', '', now(), now(), now(), '{}'::jsonb, '{}'::jsonb);

-- Droits ---------------------------------------------------------------------------------------------------------
select ok(
  (select relrowsecurity from pg_class where oid = 'app_private.manual_grant_notes'::regclass)
  and not has_table_privilege('anon', 'app_private.manual_grant_notes', 'select')
  and not has_table_privilege('authenticated', 'app_private.manual_grant_notes', 'select')
  and not has_table_privilege('authenticated', 'app_private.manual_grant_notes', 'insert'),
  'the manual grant notes table has RLS and no right for the browser roles'
);
select ok(
  not has_function_privilege('anon', 'public.extend_trial_with_note(uuid, uuid, timestamptz, text, jsonb, timestamptz)', 'execute')
  and not has_function_privilege('authenticated', 'public.extend_trial_with_note(uuid, uuid, timestamptz, text, jsonb, timestamptz)', 'execute')
  and has_function_privilege('service_role', 'public.extend_trial_with_note(uuid, uuid, timestamptz, text, jsonb, timestamptz)', 'execute'),
  'only service_role extends a trial with its note'
);
select ok(
  not has_function_privilege('anon', 'public.grant_manual_subscription(uuid, uuid, text, text, timestamptz, jsonb, text)', 'execute')
  and not has_function_privilege('authenticated', 'public.grant_manual_subscription(uuid, uuid, text, text, timestamptz, jsonb, text)', 'execute')
  and has_function_privilege('service_role', 'public.grant_manual_subscription(uuid, uuid, text, text, timestamptz, jsonb, text)', 'execute'),
  'only service_role grants a subscription by hand'
);

-- Prolongation d'essai ---------------------------------------------------------------------------------------------
select is(
  public.extend_trial_with_note(
    'c7860000-0000-4000-8000-000000000001', 'c7860000-0000-4000-8000-0000000000aa',
    now() + interval '14 days', '  Demande reçue par email  ', '{"manual_grant": {"note_recorded": true}}'::jsonb, null
  ),
  'written',
  'a first extension writes the row and the reason'
);
select ok(
  (select count(*) = 1 and bool_and(status = 'trialing' and plan_code = 'analyse')
     from public.user_subscriptions where user_id = 'c7860000-0000-4000-8000-000000000001')
  and (select note from app_private.trial_extension_notes
        where user_id = 'c7860000-0000-4000-8000-000000000001') = 'Demande reçue par email',
  'the row is a trial and the reason is stored trimmed'
);
select is(
  public.extend_trial_with_note(
    'c7860000-0000-4000-8000-000000000001', 'c7860000-0000-4000-8000-0000000000aa',
    now() + interval '30 days', 'Autre motif', '{}'::jsonb, null
  ),
  'changed',
  'a first row is refused when one appeared in the meantime'
);
select is(
  public.extend_trial_with_note(
    'c7860000-0000-4000-8000-000000000001', 'c7860000-0000-4000-8000-0000000000aa',
    now() + interval '30 days', 'Motif périmé', '{}'::jsonb, '2000-01-01T00:00:00Z'
  ),
  'changed',
  'an update whose updated_at is not the one read is refused'
);
select is(
  (select count(*) from app_private.trial_extension_notes where user_id = 'c7860000-0000-4000-8000-000000000001'),
  1::bigint,
  'a refused extension leaves no orphan reason'
);
select is(
  public.extend_trial_with_note(
    'c7860000-0000-4000-8000-000000000001', 'c7860000-0000-4000-8000-0000000000aa',
    now() + interval '30 days', 'Deuxième prolongation', '{}'::jsonb,
    (select updated_at from public.user_subscriptions where user_id = 'c7860000-0000-4000-8000-000000000001')
  ),
  'written',
  'an update with the updated_at read is written'
);
select is(
  (select count(*) from app_private.trial_extension_notes where user_id = 'c7860000-0000-4000-8000-000000000001'),
  2::bigint,
  'each written extension keeps its reason'
);
select throws_ok(
  $$select public.extend_trial_with_note(
      'c7860000-0000-4000-8000-000000000002', 'c7860000-0000-4000-8000-0000000000aa',
      now() + interval '14 days', '  ', '{}'::jsonb, null
    )$$,
  '22023',
  'A trial extension needs a reason.',
  'a blank reason is refused'
);
select is(
  (select count(*) from public.user_subscriptions where user_id = 'c7860000-0000-4000-8000-000000000002'),
  0::bigint,
  'a refused reason writes no row'
);

-- Attribution manuelle -----------------------------------------------------------------------------------------------
update public.user_subscriptions
   set stripe_customer_id = 'cus_pgtap_786'
 where user_id = 'c7860000-0000-4000-8000-000000000001';
select lives_ok(
  $$select public.grant_manual_subscription(
      'c7860000-0000-4000-8000-000000000001', 'c7860000-0000-4000-8000-0000000000aa',
      'analyse', 'active', null, '{"manual_grant": {"source": "admin"}}'::jsonb, 'Geste commercial'
    )$$,
  'a manual grant with a reason is written'
);
select ok(
  (select status = 'active' and stripe_customer_id = 'cus_pgtap_786' and not (metadata -> 'manual_grant' ? 'note')
     from public.user_subscriptions where user_id = 'c7860000-0000-4000-8000-000000000001')
  and (select note from app_private.manual_grant_notes
        where user_id = 'c7860000-0000-4000-8000-000000000001') = 'Geste commercial',
  'the row keeps its Stripe identifier and carries no note, the reason is in the private table'
);
select lives_ok(
  $$select public.grant_manual_subscription(
      'c7860000-0000-4000-8000-000000000002', 'c7860000-0000-4000-8000-0000000000aa',
      'decouverte', 'active', null, '{}'::jsonb, null
    )$$,
  'a manual grant without a reason is written'
);
select is(
  (select count(*) from app_private.manual_grant_notes where user_id = 'c7860000-0000-4000-8000-000000000002'),
  0::bigint,
  'no reason, no note row'
);
select throws_ok(
  $$select public.grant_manual_subscription(
      'c7860000-0000-4000-8000-000000000002', 'c7860000-0000-4000-8000-0000000000aa',
      'analyse', 'active', null, '{}'::jsonb, 'ab'
    )$$,
  '22023',
  'A manual grant reason needs at least 3 characters.',
  'a reason that is too short is refused'
);
select is(
  (select plan_code from public.user_subscriptions where user_id = 'c7860000-0000-4000-8000-000000000002'),
  'decouverte',
  'a refused reason leaves the row as it was'
);

-- Suppression du compte ------------------------------------------------------------------------------------------------
delete from auth.users where id in (
  'c7860000-0000-4000-8000-000000000001', 'c7860000-0000-4000-8000-000000000002'
);
select is(
  (select count(*) from app_private.manual_grant_notes) + (select count(*) from app_private.trial_extension_notes),
  0::bigint,
  'the reasons leave with the account'
);

select * from finish();
rollback;
