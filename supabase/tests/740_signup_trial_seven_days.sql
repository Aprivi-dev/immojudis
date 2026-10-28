-- Essai gratuit de 7 jours à l'inscription (20261103100000) : l'éligibilité de l'offre de lancement
-- dure 7 jours à compter de la confirmation de l'adresse email ; la fin reste lisible côté serveur
-- une fois passée ; un abonné garde son accès ; les garde-fous d'avant (adresse confirmée, une fois
-- par adresse canonique) sont conservés.
begin;

select plan(16);

-- 01 confirmé il y a 2 jours ; 02 confirmé il y a 8 jours ; 03 non confirmé
-- 04 confirmé il y a 8 jours, abonné Analyse ; 05 même adresse canonique que 01, confirmé après
insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data
) values
  ('c7400000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'trial-new@trial.example.test', '', now() - interval '2 days',
   now() - interval '2 days', now(), '{}'::jsonb, '{}'::jsonb),
  ('c7400000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'trial-old@trial.example.test', '', now() - interval '8 days',
   now() - interval '8 days', now(), '{}'::jsonb, '{}'::jsonb),
  ('c7400000-0000-4000-8000-000000000003', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'trial-pending@trial.example.test', '', null,
   now() - interval '1 day', now(), '{}'::jsonb, '{}'::jsonb),
  ('c7400000-0000-4000-8000-000000000004', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'trial-paid@trial.example.test', '', now() - interval '8 days',
   now() - interval '8 days', now(), '{}'::jsonb, '{}'::jsonb),
  ('c7400000-0000-4000-8000-000000000005', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'trial-new+2@trial.example.test', '', now() - interval '1 day',
   now() - interval '1 day', now(), '{}'::jsonb, '{}'::jsonb);

insert into public.user_subscriptions (user_id, plan_code, status, current_period_end)
values ('c7400000-0000-4000-8000-000000000004', 'analyse', 'active', now() + interval '30 days');

update app_private.launch_offer set active = true where singleton;

-- Fin de l'essai --------------------------------------------------------------------------------
select is(
  app_private.signup_trial_ends_at('c7400000-0000-4000-8000-000000000001'),
  (select email_confirmed_at + interval '7 days' from auth.users where id = 'c7400000-0000-4000-8000-000000000001'),
  'the trial ends 7 days after the email confirmation'
);
select is(
  public.get_signup_trial_end('c7400000-0000-4000-8000-000000000002'),
  (select email_confirmed_at + interval '7 days' from auth.users where id = 'c7400000-0000-4000-8000-000000000002'),
  'an ended trial keeps its end date, readable by the server'
);
select is(
  app_private.signup_trial_ends_at('c7400000-0000-4000-8000-000000000003'),
  null::timestamptz,
  'an unconfirmed account has no trial'
);
select is(
  app_private.signup_trial_ends_at('c7400000-0000-4000-8000-000000000005'),
  null::timestamptz,
  'a second account of the same canonical address has no trial'
);
select is(app_private.signup_trial_ends_at(null), null::timestamptz, 'no user, no trial');

-- Éligibilité et accès Analyse ------------------------------------------------------------------
select ok(
  app_private.launch_offer_account_eligible('c7400000-0000-4000-8000-000000000001'),
  'an account confirmed 2 days ago is in its trial'
);
select ok(
  not app_private.launch_offer_account_eligible('c7400000-0000-4000-8000-000000000002'),
  'an account confirmed 8 days ago is past its trial'
);
select ok(
  app_private.has_active_analysis_access('c7400000-0000-4000-8000-000000000001'),
  'the trial opens the Analyse access'
);
select ok(
  not app_private.has_active_analysis_access('c7400000-0000-4000-8000-000000000002'),
  'after the trial the account is back to Découverte'
);
select ok(
  app_private.has_active_analysis_access('c7400000-0000-4000-8000-000000000004'),
  'a subscriber keeps the Analyse access after the trial'
);
select ok(
  not app_private.has_standing_analysis_access('c7400000-0000-4000-8000-000000000001'),
  'the trial is not a standing access (separate global caps still apply)'
);

update app_private.launch_offer set active = false where singleton;
select ok(
  app_private.has_active_analysis_access('c7400000-0000-4000-8000-000000000001'),
  'cutting the switch keeps a trial that was already running (20261108130100)'
);
update app_private.launch_offer set active = true where singleton;

-- Privilèges ------------------------------------------------------------------------------------
select ok(
  not has_function_privilege('anon', 'public.get_signup_trial_end(uuid)', 'execute'),
  'anon cannot read a trial end'
);
select ok(
  not has_function_privilege('authenticated', 'public.get_signup_trial_end(uuid)', 'execute'),
  'authenticated cannot read a trial end'
);
select ok(
  has_function_privilege('service_role', 'public.get_signup_trial_end(uuid)', 'execute'),
  'service_role reads the trial end'
);
select ok(
  not has_function_privilege('authenticated', 'app_private.signup_trial_ends_at(uuid)', 'execute'),
  'the private trial function is closed to authenticated'
);

select * from finish();
rollback;
