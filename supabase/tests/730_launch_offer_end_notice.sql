-- Préavis de fin de l'offre de lancement (migration 20261102140000, n° 74) :
--   * la date de fin annoncée vit dans la configuration de l'offre et ne coupe rien ;
--   * une date passée est refusée, null l'efface ;
--   * la file ne retient que les comptes qui n'ont l'accès Analyse que grâce à l'offre, non désinscrits ;
--   * un préavis (compte, date) n'est réservé qu'une fois ; reprise après échec, trois essais, 23 h ;
--   * rien n'est accessible au navigateur ; la purge garde 12 mois au minimum.
-- Les écritures sont annulées en fin de test.
begin;

select plan(29);

-- Fixtures -------------------------------------------------------------------------------------
-- 01, 02 : comptes gratuits confirmés (destinataires) ; 03 : premium ; 04 : administrateur ;
-- 05 : abonné Analyse ; 06 : email non confirmé ; 07 : désinscrit ; 08 : déjà prévenu ;
-- 09 : envoi échoué ; 10 : réservé il y a 10 minutes ; 11 : réservé il y a 3 h (abandonné) ;
-- 12 : trois essais échoués.
insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data
)
select
  ('c7300000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
  '00000000-0000-0000-0000-000000000000',
  'authenticated',
  'authenticated',
  'end-notice-' || n || '@example.test',
  '',
  case when n = 6 then null else now() end,
  now(), now(), '{}'::jsonb, '{}'::jsonb
from generate_series(1, 12) n;

update public.user_profiles set account_tier = 'premium'
where user_id = 'c7300000-0000-4000-8000-000000000003';
update public.user_profiles set user_role = 'admin'
where user_id = 'c7300000-0000-4000-8000-000000000004';
insert into public.user_subscriptions (user_id, plan_code, status, current_period_end)
values ('c7300000-0000-4000-8000-000000000005', 'analyse', 'active', now() + interval '30 days');

-- Structure et droits ---------------------------------------------------------------------------
select has_column('app_private', 'launch_offer', 'ends_on', 'the announced end date lives in the launch offer configuration');
select has_table('public', 'launch_offer_end_notices', 'the notice journal exists');
select has_table('public', 'launch_offer_end_notice_optouts', 'the opt-out list exists');
select ok(
  (select relrowsecurity from pg_class where oid = 'public.launch_offer_end_notices'::regclass)
  and (select relrowsecurity from pg_class where oid = 'public.launch_offer_end_notice_optouts'::regclass),
  'row level security is enabled on both tables'
);
select ok(
  not has_table_privilege('anon', 'public.launch_offer_end_notices', 'SELECT')
  and not has_table_privilege('authenticated', 'public.launch_offer_end_notices', 'SELECT')
  and not has_table_privilege('authenticated', 'public.launch_offer_end_notices', 'INSERT')
  and not has_table_privilege('anon', 'public.launch_offer_end_notice_optouts', 'SELECT')
  and not has_table_privilege('authenticated', 'public.launch_offer_end_notice_optouts', 'INSERT')
  and has_table_privilege('service_role', 'public.launch_offer_end_notices', 'INSERT')
  and has_table_privilege('service_role', 'public.launch_offer_end_notice_optouts', 'INSERT'),
  'no browser role reads or writes the journal and the opt-out list; the server does'
);
select ok(
  not has_function_privilege('anon', 'public.get_launch_offer_config()', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.get_launch_offer_config()', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.set_launch_offer_end(date, uuid)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.get_launch_offer_end_queue(date, integer, timestamptz)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.claim_launch_offer_end_notice(uuid, date, timestamptz)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.purge_launch_offer_end_notices(interval)', 'EXECUTE')
  and has_function_privilege('service_role', 'public.get_launch_offer_config()', 'EXECUTE')
  and has_function_privilege('service_role', 'public.set_launch_offer_end(date, uuid)', 'EXECUTE')
  and has_function_privilege('service_role', 'public.get_launch_offer_end_queue(date, integer, timestamptz)', 'EXECUTE')
  and has_function_privilege('service_role', 'public.claim_launch_offer_end_notice(uuid, date, timestamptz)', 'EXECUTE')
  and has_function_privilege('service_role', 'public.purge_launch_offer_end_notices(interval)', 'EXECUTE'),
  'every function is for the server (service role) only'
);
select is(
  (select bool_and(p.prosecdef and p.proconfig = array['search_path=""'])
   from pg_proc p
   where p.oid in (
     'public.get_launch_offer_config()'::regprocedure,
     'public.set_launch_offer_end(date, uuid)'::regprocedure,
     'public.get_launch_offer_end_queue(date, integer, timestamptz)'::regprocedure
   )),
  true,
  'the security definer functions have an empty search_path'
);

-- La date de fin : annoncée, jamais appliquée toute seule --------------------------------------------
select is(
  (public.get_launch_offer_config() ->> 'ends_on'),
  null,
  'no end date until the administrator records one'
);
select throws_ok(
  $$select public.set_launch_offer_end(((statement_timestamp() at time zone 'Europe/Paris')::date - 1), null)$$,
  '22023',
  null,
  'a past end date is refused'
);
select is(
  (public.set_launch_offer_end(
     (statement_timestamp() at time zone 'Europe/Paris')::date + 45,
     'c7300000-0000-4000-8000-000000000004'
   ) ->> 'ends_on')::date,
  (statement_timestamp() at time zone 'Europe/Paris')::date + 45,
  'the end date is recorded and returned'
);
select is(
  (select updated_by from app_private.launch_offer where singleton),
  'c7300000-0000-4000-8000-000000000004'::uuid,
  'the administrator who recorded it is kept'
);
select is(
  (public.get_launch_offer_config() ->> 'active')::boolean and app_private.launch_offer_active(),
  true,
  'recording an end date does not cut the offer'
);
select is(
  (public.set_launch_offer_end((statement_timestamp() at time zone 'Europe/Paris')::date, null)
     ->> 'ends_on')::date,
  (statement_timestamp() at time zone 'Europe/Paris')::date,
  'today is accepted, and the offer stays active until it is cut by hand'
);
select is(app_private.launch_offer_active(), true, 'the offer is still active on its announced end day');
select is(
  public.set_launch_offer_end(null, null) ->> 'ends_on',
  null,
  'null clears the end date'
);

-- La file ---------------------------------------------------------------------------------------------
insert into public.launch_offer_end_notice_optouts (user_id)
values ('c7300000-0000-4000-8000-000000000007');

insert into public.launch_offer_end_notices (user_id, ends_on, status, attempts, created_at, updated_at, sent_at)
select
  ('c7300000-0000-4000-8000-' || lpad(f.n::text, 12, '0'))::uuid,
  (statement_timestamp() at time zone 'Europe/Paris')::date + 45,
  f.status, f.attempts, f.created, f.updated,
  case when f.status = 'sent' then now() end
from (
  values
    (8, 'sent', 1, now() - interval '1 day', now() - interval '1 day'),
    (9, 'failed', 1, now() - interval '2 hours', now() - interval '2 hours'),
    (10, 'pending', 1, now() - interval '10 minutes', now() - interval '10 minutes'),
    (11, 'pending', 1, now() - interval '3 hours', now() - interval '3 hours'),
    (12, 'failed', 3, now() - interval '2 hours', now() - interval '1 hour')
) as f(n, status, attempts, created, updated);

select is(
  (select array_agg(right(r #>> '{}', 2) order by ord)
     from jsonb_array_elements(
            public.get_launch_offer_end_queue((statement_timestamp() at time zone 'Europe/Paris')::date + 45, 200)
              -> 'recipients'
          ) with ordinality as t(r, ord)),
  array['01', '02', '09', '11'],
  'recipients: free confirmed accounts never tried first, then the retryable ones; premium, admin, subscriber, unconfirmed, opted-out, notified, in progress and exhausted are out'
);
select is(
  (public.get_launch_offer_end_queue((statement_timestamp() at time zone 'Europe/Paris')::date + 45, 200) ->> 'total')::integer,
  4,
  'total counts the sendable accounts'
);
select is(
  (select (q ->> 'opted_out')::integer || '/' || (q ->> 'notified') || '/' || (q ->> 'in_progress') || '/' || (q ->> 'needs_review')
     from (select public.get_launch_offer_end_queue((statement_timestamp() at time zone 'Europe/Paris')::date + 45, 200) as q) s),
  '1/1/1/1',
  'opted out, notified, in progress and to review are counted apart'
);
select is(
  (select jsonb_array_length(public.get_launch_offer_end_queue((statement_timestamp() at time zone 'Europe/Paris')::date + 45, 2) -> 'recipients')),
  2,
  'the limit bounds the batch'
);
select is(
  (public.get_launch_offer_end_queue((statement_timestamp() at time zone 'Europe/Paris')::date + 90, 200) ->> 'total')::integer,
  7,
  'a different announced date starts again for every audience account except the opted-out one'
);

-- Réservation -------------------------------------------------------------------------------------------
select is(
  public.claim_launch_offer_end_notice('c7300000-0000-4000-8000-000000000001', date '2099-01-01'),
  true,
  'the first claim of a notice may send'
);
select is(
  public.claim_launch_offer_end_notice('c7300000-0000-4000-8000-000000000001', date '2099-01-01'),
  false,
  'a notice just reserved is not reserved again (never two emails)'
);
select is(
  public.claim_launch_offer_end_notice('c7300000-0000-4000-8000-000000000008', (statement_timestamp() at time zone 'Europe/Paris')::date + 45),
  false,
  'a notice already sent is never reserved again'
);
select is(
  public.claim_launch_offer_end_notice('c7300000-0000-4000-8000-000000000009', (statement_timestamp() at time zone 'Europe/Paris')::date + 45)
  and public.claim_launch_offer_end_notice('c7300000-0000-4000-8000-000000000011', (statement_timestamp() at time zone 'Europe/Paris')::date + 45),
  true,
  'a failed notice and one abandoned for over an hour can be taken again'
);
select is(
  public.claim_launch_offer_end_notice('c7300000-0000-4000-8000-000000000012', (statement_timestamp() at time zone 'Europe/Paris')::date + 45),
  false,
  'three attempts at most'
);
select is(
  public.claim_launch_offer_end_notice('c7300000-0000-4000-8000-000000000007', date '2099-01-01'),
  false,
  'an opted-out account is never reserved'
);

-- Purge et suppression du compte ---------------------------------------------------------------------------
insert into public.launch_offer_end_notices (user_id, ends_on, status, created_at, updated_at)
values ('c7300000-0000-4000-8000-000000000002', date '2024-01-01', 'sent', now() - interval '30 months', now() - interval '30 months');
select throws_ok(
  $$select public.purge_launch_offer_end_notices(interval '6 months')$$,
  'P0001',
  null,
  'the journal is kept 12 months at least'
);
select is(public.purge_launch_offer_end_notices(), 1, 'the purge removes only the notices older than 24 months');
delete from auth.users where id = 'c7300000-0000-4000-8000-000000000007';
select is(
  (select count(*) from public.launch_offer_end_notice_optouts where user_id = 'c7300000-0000-4000-8000-000000000007'),
  0::bigint,
  'deleting the account deletes its opt-out'
);

select * from finish();
rollback;
