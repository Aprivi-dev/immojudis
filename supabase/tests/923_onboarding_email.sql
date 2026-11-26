-- Email unique de prise en main (20261210100200) :
--   * journal et liste d'exclusion fermés au navigateur (RLS, aucun droit pour anon ni authenticated) ;
--   * la file ne garde que les comptes confirmés, créés il y a 24 à 72 heures, sans accès Analyse, sans
--     déblocage ni achat, non administrateurs, non désinscrits, jamais prévenus ; elle rend le département
--     de la plus ancienne alerte active ;
--   * la réservation n'est prise qu'une fois par compte (clé = le compte), relit l'audience, et reprend un
--     échec trois fois au plus dans les 23 heures ;
--   * la purge garde 12 mois au minimum ; aucune adresse ne sort.
-- Les nombres sont comparés à un relevé pris avant les données de test (écarts). Tout est annulé en fin
-- de test.
begin;

select plan(25);

-- Structure et droits ------------------------------------------------------------------------------
select has_table('public', 'onboarding_email_notices', 'the onboarding email journal exists');
select has_table('public', 'onboarding_email_optouts', 'the onboarding email opt-out list exists');
select col_is_pk('public', 'onboarding_email_notices', 'user_id', 'the journal key is the account: one message per account');
select ok(
  (select relrowsecurity from pg_class where oid = 'public.onboarding_email_notices'::regclass)
  and (select relrowsecurity from pg_class where oid = 'public.onboarding_email_optouts'::regclass),
  'row level security is enabled on both tables'
);
select ok(
  not has_table_privilege('anon', 'public.onboarding_email_notices', 'SELECT')
  and not has_table_privilege('authenticated', 'public.onboarding_email_notices', 'SELECT')
  and not has_table_privilege('authenticated', 'public.onboarding_email_notices', 'INSERT')
  and not has_table_privilege('authenticated', 'public.onboarding_email_notices', 'UPDATE')
  and not has_table_privilege('anon', 'public.onboarding_email_optouts', 'SELECT')
  and not has_table_privilege('authenticated', 'public.onboarding_email_optouts', 'SELECT')
  and not has_table_privilege('authenticated', 'public.onboarding_email_optouts', 'INSERT')
  and not has_table_privilege('authenticated', 'public.onboarding_email_optouts', 'DELETE')
  and has_table_privilege('service_role', 'public.onboarding_email_notices', 'INSERT')
  and has_table_privilege('service_role', 'public.onboarding_email_optouts', 'INSERT'),
  'no browser role reads or writes the journal and the opt-out list; the server does'
);
select ok(
  not has_function_privilege('anon', 'public.get_onboarding_email_queue(integer, timestamptz)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.get_onboarding_email_queue(integer, timestamptz)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.claim_onboarding_email(uuid, timestamptz)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.claim_onboarding_email(uuid, timestamptz)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.purge_onboarding_email_notices(interval)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.purge_onboarding_email_notices(interval)', 'EXECUTE')
  and not has_function_privilege('anon', 'app_private.onboarding_email_eligible(uuid, timestamptz)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'app_private.onboarding_email_eligible(uuid, timestamptz)', 'EXECUTE')
  and has_function_privilege('service_role', 'public.get_onboarding_email_queue(integer, timestamptz)', 'EXECUTE')
  and has_function_privilege('service_role', 'public.claim_onboarding_email(uuid, timestamptz)', 'EXECUTE')
  and has_function_privilege('service_role', 'public.purge_onboarding_email_notices(interval)', 'EXECUTE')
  and has_function_privilege('service_role', 'app_private.onboarding_email_eligible(uuid, timestamptz)', 'EXECUTE'),
  'the queue, the claim, the rule and the purge are for the server (service role) only'
);
select is(
  (select bool_and(p.proconfig = array['search_path=""'])
     from pg_proc p
    where p.oid in (
      'public.get_onboarding_email_queue(integer, timestamptz)'::regprocedure,
      'public.claim_onboarding_email(uuid, timestamptz)'::regprocedure,
      'public.purge_onboarding_email_notices(interval)'::regprocedure,
      'app_private.onboarding_email_eligible(uuid, timestamptz)'::regprocedure
    )),
  true,
  'every function has an empty search_path'
);
set local role authenticated;
set local "request.jwt.claims" = '{"sub":"c9230000-0000-4000-8000-000000000001","role":"authenticated"}';
select throws_ok(
  $$select public.get_onboarding_email_queue()$$, '42501', null,
  'a signed-in account cannot read the queue'
);
reset role;

-- Sans essai en cours : l'offre de lancement est coupée, sans date de coupure (aucun compte ne garde
-- d'essai). Annulé avec le reste en fin de test.
update app_private.launch_offer set active = false, closed_at = null where singleton;

create temporary table pgtap_923_queue (label text, body jsonb) on commit drop;
grant all on table pgtap_923_queue to public;
insert into pgtap_923_queue select 'before', public.get_onboarding_email_queue(200);

-- Données de test ------------------------------------------------------------------------------------
--   1 créé il y a 30 h, confirmé : dans la file (alerte active en 33, alerte plus ancienne inactive en 13) ;
--   2 créé il y a 12 h : trop tôt ;          3 créé il y a 80 h : trop tard ;
--   4 comme 1, désinscrit ;                  5 comme 1, abonné Analyse ;
--   6 comme 1, déjà prévenu ;                7 comme 1, administrateur ;
--   8 comme 1, adresse non confirmée ;       9 comme 1, a débloqué une vente ;
--  10 comme 1, a acheté une vente ;         11 comme 1, sans alerte (catalogue entier) ;
--  12 comme 1, compte premium.
insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data
)
select
  ('c9230000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
  '00000000-0000-0000-0000-000000000000',
  'authenticated',
  'authenticated',
  'onboarding-' || n || '@onboarding.example.test',
  '',
  case when n = 8 then null else now() - interval '20 hours' end,
  case n
    when 2 then now() - interval '12 hours'
    when 3 then now() - interval '80 hours'
    else now() - interval '30 hours'
  end,
  now(), '{}'::jsonb, '{}'::jsonb
from generate_series(1, 12) n;

update public.user_profiles set user_role = 'admin'
where user_id = 'c9230000-0000-4000-8000-000000000007';
update public.user_profiles set account_tier = 'premium'
where user_id = 'c9230000-0000-4000-8000-000000000012';

insert into public.onboarding_email_optouts (user_id)
values ('c9230000-0000-4000-8000-000000000004');

insert into public.user_subscriptions (user_id, plan_code, status, current_period_end)
values ('c9230000-0000-4000-8000-000000000005', 'analyse', 'active', now() + interval '30 days');

insert into public.onboarding_email_notices (user_id, status, attempts, sent_at)
values ('c9230000-0000-4000-8000-000000000006', 'sent', 1, now() - interval '1 hour');

insert into public.user_sale_unlocks (user_id, sale_id, unlocked_at, source)
values ('c9230000-0000-4000-8000-000000000009', null, now() - interval '2 hours', 'free');

insert into public.sale_unlock_purchases (user_id, amount_cents, currency)
values ('c9230000-0000-4000-8000-000000000010', 100, 'eur');

insert into public.user_alerts (user_id, name, department, alert_frequency, is_active, created_at)
values
  ('c9230000-0000-4000-8000-000000000001', 'Ancienne alerte', '13', 'weekly', false, now() - interval '29 hours'),
  ('c9230000-0000-4000-8000-000000000001', 'Alerte active', '33', 'weekly', true, now() - interval '28 hours');

create temporary table pgtap_923_after on commit drop as
select public.get_onboarding_email_queue(200) as body;

create function pg_temp.delta(p_key text)
returns bigint
language sql
as $$
  select (select (a.body ->> p_key)::bigint from pgtap_923_after a)
       - (select (b.body ->> p_key)::bigint from pgtap_923_queue b where b.label = 'before');
$$;

create function pg_temp.recipient(p_user_id uuid)
returns jsonb
language sql
as $$
  select r
  from jsonb_array_elements(public.get_onboarding_email_queue(200) -> 'recipients') r
  where (r ->> 'user_id')::uuid = p_user_id;
$$;

-- La file ------------------------------------------------------------------------------------------
select is(
  array[pg_temp.delta('audience'), pg_temp.delta('opted_out'), pg_temp.delta('notified'), pg_temp.delta('total')],
  array[4::bigint, 1, 1, 2],
  'in the audience: accounts 1, 4 (unsubscribed), 6 (already notified) and 11; only 1 and 11 are to send'
);
select is(
  (select array_agg(r ->> 'user_id' order by r ->> 'user_id')
     from pgtap_923_after a, jsonb_array_elements(a.body -> 'recipients') r
    where (r ->> 'user_id') like 'c9230000-%'),
  array['c9230000-0000-4000-8000-000000000001', 'c9230000-0000-4000-8000-000000000011'],
  'too early, too late, subscriber, premium, administrator, unconfirmed, unlocked or bought: never in the queue'
);
select is(
  (select r ->> 'department'
     from pgtap_923_after a, jsonb_array_elements(a.body -> 'recipients') r
    where (r ->> 'user_id') = 'c9230000-0000-4000-8000-000000000001'),
  '33',
  'the department is that of the oldest ACTIVE alert of the account'
);
select ok(
  (select (r ? 'department') and r -> 'department' = 'null'::jsonb
     from pgtap_923_after a, jsonb_array_elements(a.body -> 'recipients') r
    where (r ->> 'user_id') = 'c9230000-0000-4000-8000-000000000011'),
  'without an active alert, the department is null (whole catalogue)'
);
select is(
  (select body::text ~ '(@onboarding|example\.test)' from pgtap_923_after),
  false,
  'no email address in the answer'
);

-- La réservation -------------------------------------------------------------------------------------
select ok(
  public.claim_onboarding_email('c9230000-0000-4000-8000-000000000001'),
  'the message of an account in the audience can be claimed'
);
select ok(
  not public.claim_onboarding_email('c9230000-0000-4000-8000-000000000001'),
  'a second claim of the same account is refused: one message per account'
);
select is(
  pg_temp.recipient('c9230000-0000-4000-8000-000000000001'),
  null,
  'a claimed account is no longer to send while its claim is recent'
);
select ok(
  not public.claim_onboarding_email('c9230000-0000-4000-8000-000000000002')
  and not public.claim_onboarding_email('c9230000-0000-4000-8000-000000000003')
  and not public.claim_onboarding_email('c9230000-0000-4000-8000-000000000004')
  and not public.claim_onboarding_email('c9230000-0000-4000-8000-000000000005')
  and not public.claim_onboarding_email('c9230000-0000-4000-8000-000000000006')
  and not public.claim_onboarding_email('c9230000-0000-4000-8000-000000000007')
  and not public.claim_onboarding_email('c9230000-0000-4000-8000-000000000009')
  and not public.claim_onboarding_email('c9230000-0000-4000-8000-000000000010')
  and not public.claim_onboarding_email('c9230000-0000-4000-8000-000000000012'),
  'the claim reads the audience again: no claim outside the window, for an unsubscribed, notified, Analyse, administrator, unlocking or buying account'
);
select is(
  (select count(*)::integer from public.onboarding_email_notices
    where user_id in (
      'c9230000-0000-4000-8000-000000000002', 'c9230000-0000-4000-8000-000000000004',
      'c9230000-0000-4000-8000-000000000009', 'c9230000-0000-4000-8000-000000000010'
    )),
  0,
  'a refused claim writes nothing to the journal'
);

-- Un compte qui débloque une vente entre la lecture de la file et l'envoi n'est pas écrit.
insert into public.user_sale_unlocks (user_id, sale_id, unlocked_at, source)
values ('c9230000-0000-4000-8000-000000000011', null, now(), 'free');
select ok(
  not public.claim_onboarding_email('c9230000-0000-4000-8000-000000000011'),
  'an account that unlocked a sale after the queue was read is not claimed'
);

-- Reprise d'un échec ---------------------------------------------------------------------------------
update public.onboarding_email_notices
   set status = 'failed', error = 'send_failed', attempts = 1, created_at = now() - interval '2 hours'
 where user_id = 'c9230000-0000-4000-8000-000000000001';
select ok(
  public.claim_onboarding_email('c9230000-0000-4000-8000-000000000001'),
  'a failed send is taken up again within 23 hours'
);
select ok(
  (select attempts = 2 and status = 'pending' and error is null
     from public.onboarding_email_notices
    where user_id = 'c9230000-0000-4000-8000-000000000001'),
  'the take-up is a second attempt, pending again, without its error code'
);
update public.onboarding_email_notices
   set status = 'failed', error = 'send_failed', attempts = 3
 where user_id = 'c9230000-0000-4000-8000-000000000001';
select ok(
  not public.claim_onboarding_email('c9230000-0000-4000-8000-000000000001'),
  'never more than three attempts'
);
update public.onboarding_email_notices
   set attempts = 1, created_at = now() - interval '24 hours'
 where user_id = 'c9230000-0000-4000-8000-000000000001';
select ok(
  not public.claim_onboarding_email('c9230000-0000-4000-8000-000000000001')
  and pg_temp.recipient('c9230000-0000-4000-8000-000000000001') is null
  and (public.get_onboarding_email_queue(200) ->> 'needs_review')::bigint
      >= 1,
  'a failure older than 23 hours is never replayed: it is counted in needs_review'
);

-- Purge ---------------------------------------------------------------------------------------------------
select throws_ok(
  $$select public.purge_onboarding_email_notices(interval '6 months')$$,
  'P0001', null,
  'the journal is never kept less than 12 months'
);
update public.onboarding_email_notices
   set created_at = now() - interval '25 months'
 where user_id = 'c9230000-0000-4000-8000-000000000006';
select is(
  public.purge_onboarding_email_notices(),
  1,
  'the purge removes only the lines older than 24 months'
);

select * from finish();
rollback;
