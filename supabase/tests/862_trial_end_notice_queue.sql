-- File d'envoi de l'email de fin d'essai à J+5 (20261110180200) : service_role seul ; seuls les comptes
-- dont l'essai se termine dans les 2 jours (et pas dans les 6 heures) y entrent ; désinscrits, abonnés,
-- administrateurs et comptes déjà prévenus en sont exclus ; aucune adresse ne sort. Les nombres sont
-- comparés à un relevé pris avant les données de test (écarts).
begin;

select plan(9);

-- Structure et droits ------------------------------------------------------------------------------
select ok(
  not has_function_privilege('anon', 'public.get_trial_end_notice_queue(integer, timestamptz)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.get_trial_end_notice_queue(integer, timestamptz)', 'EXECUTE')
  and has_function_privilege('service_role', 'public.get_trial_end_notice_queue(integer, timestamptz)', 'EXECUTE'),
  'the queue is for the server (service role) only'
);
select is(
  (select p.prosecdef and p.provolatile = 's' and p.proconfig = array['search_path=""']
     from pg_proc p where p.oid = 'public.get_trial_end_notice_queue(integer, timestamptz)'::regprocedure),
  true,
  'the queue is stable, security definer and has an empty search_path'
);
set local role authenticated;
set local "request.jwt.claims" = '{"sub":"c8620000-0000-4000-8000-000000000001","role":"authenticated"}';
select throws_ok(
  $$select public.get_trial_end_notice_queue()$$, '42501', null,
  'a signed-in account cannot read the queue'
);
reset role;

update app_private.launch_offer set active = true where singleton;

create temporary table pgtap_862_queue (label text, body jsonb) on commit drop;
grant all on table pgtap_862_queue to public;
insert into pgtap_862_queue select 'before', public.get_trial_end_notice_queue(200);

-- Données de test ------------------------------------------------------------------------------------
--   1 confirmé il y a 5 jours et 1 h : fin d'essai dans 1 jour 23 h, dans la file ;
--   2 confirmé il y a 4 jours : fin dans 3 jours, pas encore ;
--   3 confirmé il y a 6 jours 20 h : fin dans 4 h, trop tard ;
--   4 comme 1 mais désinscrit ; 5 comme 1 mais abonné Analyse ; 6 comme 1 mais déjà prévenu ;
--   7 comme 1 mais administrateur ; 8 comme 1 mais adresse non confirmée.
insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data
) values
  ('c8620000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'trialend-one@trialend.example.test', '', now() - interval '5 days 1 hour',
   now() - interval '6 days', now(), '{}'::jsonb, '{}'::jsonb),
  ('c8620000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'trialend-two@trialend.example.test', '', now() - interval '4 days',
   now() - interval '6 days', now(), '{}'::jsonb, '{}'::jsonb),
  ('c8620000-0000-4000-8000-000000000003', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'trialend-three@trialend.example.test', '', now() - interval '6 days 20 hours',
   now() - interval '7 days', now(), '{}'::jsonb, '{}'::jsonb),
  ('c8620000-0000-4000-8000-000000000004', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'trialend-four@trialend.example.test', '', now() - interval '5 days 1 hour',
   now() - interval '6 days', now(), '{}'::jsonb, '{}'::jsonb),
  ('c8620000-0000-4000-8000-000000000005', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'trialend-five@trialend.example.test', '', now() - interval '5 days 1 hour',
   now() - interval '6 days', now(), '{}'::jsonb, '{}'::jsonb),
  ('c8620000-0000-4000-8000-000000000006', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'trialend-six@trialend.example.test', '', now() - interval '5 days 1 hour',
   now() - interval '6 days', now(), '{}'::jsonb, '{}'::jsonb),
  ('c8620000-0000-4000-8000-000000000007', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'trialend-seven@trialend.example.test', '', now() - interval '5 days 1 hour',
   now() - interval '6 days', now(), '{}'::jsonb, '{}'::jsonb),
  ('c8620000-0000-4000-8000-000000000008', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'trialend-eight@trialend.example.test', '', null,
   now() - interval '6 days', now(), '{}'::jsonb, '{}'::jsonb);

update public.user_profiles set user_role = 'admin'
where user_id = 'c8620000-0000-4000-8000-000000000007';

insert into public.launch_offer_end_notice_optouts (user_id)
values ('c8620000-0000-4000-8000-000000000004');

insert into public.user_subscriptions (user_id, plan_code, status, current_period_end)
values ('c8620000-0000-4000-8000-000000000005', 'analyse', 'active', now() + interval '30 days');

insert into public.launch_offer_end_notices (user_id, ends_on, status, attempts, sent_at)
values (
  'c8620000-0000-4000-8000-000000000006',
  (app_private.signup_trial_ends_at('c8620000-0000-4000-8000-000000000006') at time zone 'Europe/Paris')::date,
  'sent', 1, now()
);

create temporary table pgtap_862_after on commit drop as
select public.get_trial_end_notice_queue(200) as body;

create function pg_temp.delta(p_key text)
returns bigint
language sql
as $$
  select (select (a.body ->> p_key)::bigint from pgtap_862_after a)
       - (select (b.body ->> p_key)::bigint from pgtap_862_queue b where b.label = 'before');
$$;

-- Les chiffres -----------------------------------------------------------------------------------------
select is(
  array[pg_temp.delta('audience'), pg_temp.delta('opted_out'), pg_temp.delta('notified'), pg_temp.delta('total')],
  array[3::bigint, 1, 1, 1],
  'in the window: the account, the unsubscribed one and the already notified one; only the first is to send'
);
select is(
  (select array_agg(r ->> 'user_id')
     from pgtap_862_after a, jsonb_array_elements(a.body -> 'recipients') r
    where (r ->> 'user_id') like 'c8620000-%'),
  array['c8620000-0000-4000-8000-000000000001'],
  'only the account 5 days after its confirmation is to be written to (not too early, not too late, no subscriber, no administrator)'
);
select is(
  (select (r ->> 'ends_on')::date
     from pgtap_862_after a, jsonb_array_elements(a.body -> 'recipients') r
    where (r ->> 'user_id') = 'c8620000-0000-4000-8000-000000000001'),
  (app_private.signup_trial_ends_at('c8620000-0000-4000-8000-000000000001') at time zone 'Europe/Paris')::date,
  'the journal key is the Paris day of the end of the trial of the account'
);

-- Une fois réservé, le compte sort de la file (même clé que le journal) ----------------------------------
select ok(
  public.claim_launch_offer_end_notice(
    'c8620000-0000-4000-8000-000000000001',
    (app_private.signup_trial_ends_at('c8620000-0000-4000-8000-000000000001') at time zone 'Europe/Paris')::date
  ),
  'the notice can be claimed once'
);
select is(
  (select count(*)::integer
     from jsonb_array_elements(public.get_trial_end_notice_queue(200) -> 'recipients') r
    where (r ->> 'user_id') = 'c8620000-0000-4000-8000-000000000001'),
  0,
  'a claimed account is no longer to send while its claim is recent'
);
select is(
  (select body::text ~ '(@trialend|example\.test)' from pgtap_862_after),
  false,
  'no email address in the answer'
);

select * from finish();
rollback;
