-- Page admin « Pilotage » (migration 20261031100500, chantier R1 point 7) : snapshot.launch_offer_accounts
-- compte les comptes servis par l'offre de lancement avec la règle canonique
-- app_private.launch_offer_account_eligible (email confirmé, domaine non jetable, plus ancien compte
-- confirmé de son adresse canonique), sans ceux qui ont déjà un droit durable (administrateur, premium,
-- abonnement Analyse en cours). Les chiffres sont comparés à un relevé pris avant les données de test.
begin;

select plan(8);

select ok(
  not has_function_privilege('anon', 'public.admin_pilotage_summary(timestamptz)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.admin_pilotage_summary(timestamptz)', 'EXECUTE')
  and has_function_privilege('service_role', 'public.admin_pilotage_summary(timestamptz)', 'EXECUTE'),
  'the summary is still for the server (service role) only'
);
select ok(
  (select p.prosecdef and p.provolatile = 's' and p.proconfig = array['search_path=""']
     from pg_proc p where p.oid = 'public.admin_pilotage_summary(timestamptz)'::regprocedure),
  'the summary is stable, security definer and has an empty search_path'
);
select ok(
  pg_get_functiondef('public.admin_pilotage_summary(timestamptz)'::regprocedure)
    ~ 'launch_offer_account_eligible\(account\.id\)',
  'the offer accounts use the canonical eligibility function'
);

update app_private.launch_offer set active = true;

create temporary table pgtap_655_summary (
  case_name text primary key,
  summary jsonb
) on commit drop;

insert into pgtap_655_summary
select 'before', public.admin_pilotage_summary(statement_timestamp());

-- Données de test --------------------------------------------------------------------------------------
--   1 a+1@ (confirmé il y a 3 jours)  : le plus ancien de son adresse canonique : servi par l'offre
--   2 a+2@ (confirmé il y a 2 jours)  : même boîte (+tag) : pas servi
--   3 adresse d'un domaine jetable    : pas servi
--   4 c@ (confirmé)                   : servi
--   5 d@ (non confirmé)               : pas servi
--   6 administrateur confirmé         : droit durable
--   7 abonné Analyse confirmé         : droit durable
insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data
) values
  ('c6550000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'a+1@pilot655.example.test', '', now() - interval '3 days',
   now() - interval '4 days', now(), '{}'::jsonb, '{}'::jsonb),
  ('c6550000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'a+2@pilot655.example.test', '', now() - interval '2 days',
   now() - interval '3 days', now(), '{}'::jsonb, '{}'::jsonb),
  ('c6550000-0000-4000-8000-000000000003', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'pilot655@mailinator.com', '', now() - interval '1 day',
   now() - interval '2 days', now(), '{}'::jsonb, '{}'::jsonb),
  ('c6550000-0000-4000-8000-000000000004', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'c@pilot655.example.test', '', now() - interval '1 day',
   now() - interval '2 days', now(), '{}'::jsonb, '{}'::jsonb),
  ('c6550000-0000-4000-8000-000000000005', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'd@pilot655.example.test', '', null,
   now() - interval '2 days', now(), '{}'::jsonb, '{}'::jsonb),
  ('c6550000-0000-4000-8000-000000000006', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'admin@pilot655.example.test', '', now() - interval '1 day',
   now() - interval '2 days', now(), '{}'::jsonb, '{}'::jsonb),
  ('c6550000-0000-4000-8000-000000000007', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'paid@pilot655.example.test', '', now() - interval '1 day',
   now() - interval '2 days', now(), '{}'::jsonb, '{}'::jsonb);

update public.user_profiles set user_role = 'admin'
where user_id = 'c6550000-0000-4000-8000-000000000006';

insert into public.user_subscriptions (user_id, plan_code, status, current_period_end)
values ('c6550000-0000-4000-8000-000000000007', 'analyse', 'active', now() + interval '30 days');

insert into pgtap_655_summary
select 'after', public.admin_pilotage_summary(statement_timestamp());

create function pg_temp.delta(p_path text[]) returns integer
language sql stable as $$
  select ((select summary from pgtap_655_summary where case_name = 'after') #>> p_path)::integer
       - ((select summary from pgtap_655_summary where case_name = 'before') #>> p_path)::integer;
$$;

select is(
  pg_temp.delta('{snapshot,accounts_confirmed}'),
  5,
  'accounts confirmed (without the administrator): the old rule counted all of them as served by the offer'
);
select is(
  pg_temp.delta('{snapshot,launch_offer_accounts}'),
  2,
  'served by the offer: the oldest confirmed account of an address and the plain account, not the +tag duplicate, the disposable domain, the unconfirmed account, the subscriber or the administrator'
);
select is(
  (select summary #>> '{snapshot,launch_offer_active}' from pgtap_655_summary where case_name = 'after'),
  'true',
  'the offer switch is reported as active'
);

update app_private.launch_offer set active = false;
select is(
  (public.admin_pilotage_summary(statement_timestamp()) #>> '{snapshot,launch_offer_accounts}'),
  '0',
  'with the offer cut, nobody is under it'
);
select is(
  (public.admin_pilotage_summary(statement_timestamp()) #>> '{snapshot,launch_offer_active}'),
  'false',
  'and the switch is reported as cut'
);

select * from finish();
rollback;
