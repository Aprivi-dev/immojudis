-- Couper l'interrupteur de l'essai (20261108130100) ne ferme que les nouveaux essais : un compte
-- dont l'adresse a été confirmée avant la coupure garde ses 7 jours ; un compte qui confirme après
-- la coupure n'a rien ; rétablir l'interrupteur remet tout à la règle normale.
begin;

select plan(17);

-- 01 confirmé il y a 2 jours (essai en cours) ; 02 confirmé il y a 8 jours (essai fini) ;
-- 03 non confirmé ; 04 confirmé après la coupure
insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data
) values
  ('c7710000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'run@close771.example.test', '', now() - interval '2 days',
   now() - interval '2 days', now(), '{}'::jsonb, '{}'::jsonb),
  ('c7710000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'old@close771.example.test', '', now() - interval '8 days',
   now() - interval '8 days', now(), '{}'::jsonb, '{}'::jsonb),
  ('c7710000-0000-4000-8000-000000000003', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'pending@close771.example.test', '', null,
   now() - interval '1 day', now(), '{}'::jsonb, '{}'::jsonb),
  ('c7710000-0000-4000-8000-000000000004', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'late@close771.example.test', '', null,
   now() - interval '1 day', now(), '{}'::jsonb, '{}'::jsonb);

-- Ouvert : la règle de l'essai ------------------------------------------------------------------------
update app_private.launch_offer set active = true where singleton;
select is(
  (select closed_at from app_private.launch_offer where singleton),
  null::timestamptz,
  'an open switch has no closing date'
);
select ok(
  app_private.has_active_analysis_access('c7710000-0000-4000-8000-000000000001'),
  'open switch: the running trial has the Analyse access'
);
select ok(
  not app_private.has_active_analysis_access('c7710000-0000-4000-8000-000000000002'),
  'open switch: the ended trial has none'
);
select is(
  (select gate_open from public.get_signup_trial('c7710000-0000-4000-8000-000000000001')),
  true,
  'open switch: the trial is open for the account'
);

-- Coupé : les essais en cours continuent ---------------------------------------------------------------
update app_private.launch_offer set active = false where singleton;
select isnt(
  (select closed_at from app_private.launch_offer where singleton),
  null::timestamptz,
  'cutting the switch records the closing date'
);
select ok(
  app_private.has_active_analysis_access('c7710000-0000-4000-8000-000000000001'),
  'cut switch: an account confirmed before the cut keeps its running trial'
);
select ok(
  app_private.launch_offer_confirmed_before_close('c7710000-0000-4000-8000-000000000001'),
  'cut switch: that account is flagged as confirmed before the cut'
);
select ok(
  not app_private.has_active_analysis_access('c7710000-0000-4000-8000-000000000002'),
  'cut switch: the trial that already ended stays ended'
);
select is(
  (select ends_at from public.get_signup_trial('c7710000-0000-4000-8000-000000000001')),
  (select email_confirmed_at + interval '7 days' from auth.users
   where id = 'c7710000-0000-4000-8000-000000000001'),
  'cut switch: the server still reads the end of the running trial'
);
select is(
  (select gate_open from public.get_signup_trial('c7710000-0000-4000-8000-000000000001')),
  true,
  'cut switch: the trial stays open for the account confirmed before the cut'
);

-- Confirmer après la coupure : pas d'essai ------------------------------------------------------------
select ok(
  not app_private.has_active_analysis_access('c7710000-0000-4000-8000-000000000003'),
  'cut switch: an account still unconfirmed has nothing'
);
update auth.users set email_confirmed_at = now() + interval '1 minute'
where id = 'c7710000-0000-4000-8000-000000000004';
select ok(
  not app_private.has_active_analysis_access('c7710000-0000-4000-8000-000000000004'),
  'cut switch: an account that confirms after the cut gets no trial'
);
select is(
  (select gate_open from public.get_signup_trial('c7710000-0000-4000-8000-000000000004')),
  false,
  'cut switch: the trial is closed for an account confirmed after the cut'
);

-- Rétablir ------------------------------------------------------------------------------------------------
update app_private.launch_offer set active = true where singleton;
select is(
  (select closed_at from app_private.launch_offer where singleton),
  null::timestamptz,
  'reopening clears the closing date'
);
select ok(
  app_private.has_active_analysis_access('c7710000-0000-4000-8000-000000000004'),
  'reopened: the account confirmed during the closure now has its trial'
);

-- Privilèges ----------------------------------------------------------------------------------------------
select ok(
  not has_function_privilege('anon', 'public.get_signup_trial(uuid)', 'execute')
  and not has_function_privilege('authenticated', 'public.get_signup_trial(uuid)', 'execute')
  and has_function_privilege('service_role', 'public.get_signup_trial(uuid)', 'execute'),
  'get_signup_trial is for the server only'
);
select ok(
  not has_function_privilege('anon', 'app_private.launch_offer_confirmed_before_close(uuid)', 'execute')
  and not has_function_privilege('authenticated', 'app_private.launch_offer_confirmed_before_close(uuid)', 'execute'),
  'the private helper is closed to the browser roles'
);

select * from finish();
rollback;
