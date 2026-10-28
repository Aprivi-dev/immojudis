-- Usage par compte pour la vue admin « Inscriptions » (migration 20261108180300) :
--   * la fonction est pour le serveur seul (service_role), SECURITY DEFINER à search_path vide ;
--   * un compte sans aucune trace est rendu avec des zéros ;
--   * déblocages, plafonds enregistrés, favoris et fiches (valeur de référence servie) sont comptés par compte ;
--   * les administrateurs ne sont pas rendus ;
--   * la fin d'essai vient de la règle unique app_private.signup_trial_ends_at.
begin;

select plan(9);

select ok(
  not has_function_privilege('anon', 'public.admin_signup_usage()', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.admin_signup_usage()', 'EXECUTE')
  and has_function_privilege('service_role', 'public.admin_signup_usage()', 'EXECUTE'),
  'the usage is for the server (service role) only'
);
select is(
  (select p.prosecdef and p.provolatile = 's' and p.proconfig = array['search_path=""']
     from pg_proc p where p.oid = 'public.admin_signup_usage()'::regprocedure),
  true,
  'it is stable, security definer and has an empty search_path'
);
set local role authenticated;
select throws_ok(
  $$select * from public.admin_signup_usage()$$, '42501', null,
  'a signed-in account cannot read the usage'
);
reset role;

-- Données de test ------------------------------------------------------------------------------------
--   compte 1 : rien fait ; compte 2 : 1 déblocage, 2 favoris dont 1 avec plafond enregistré, 2 fiches
--   servies sur 2 ventes (dont une deux jours de suite : une seule vente distincte) ; compte 3 : administrateur.
insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data
) values
  ('c7820000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'usage-idle@example.test', '', now(), now(), now(),
   '{}'::jsonb, '{}'::jsonb),
  ('c7820000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'usage-active@example.test', '', now(), now(), now(),
   '{}'::jsonb, '{}'::jsonb),
  ('c7820000-0000-4000-8000-000000000003', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'usage-admin@example.test', '', now(), now(), now(),
   '{}'::jsonb, '{}'::jsonb);

update public.user_profiles set user_role = 'admin'
where user_id = 'c7820000-0000-4000-8000-000000000003';

insert into public.auction_sales (id, source_name, source_url, title, status, sale_date)
values
  ('c7820000-1000-4000-8000-00000000000a', 'usage-782', 'https://example.test/u782/a',
   'Usage sale A', 'upcoming', '2099-01-01 12:00:00Z'),
  ('c7820000-1000-4000-8000-00000000000b', 'usage-782', 'https://example.test/u782/b',
   'Usage sale B', 'upcoming', '2099-01-02 12:00:00Z');

insert into public.user_sale_unlocks (user_id, sale_id)
values ('c7820000-0000-4000-8000-000000000002', 'c7820000-1000-4000-8000-00000000000a');

insert into public.user_favorites (user_id, sale_id, bid_ceiling_eur, bid_ceiling_saved_at)
values
  ('c7820000-0000-4000-8000-000000000002', 'c7820000-1000-4000-8000-00000000000a', 120000, now()),
  ('c7820000-0000-4000-8000-000000000002', 'c7820000-1000-4000-8000-00000000000b', null, null);

insert into public.account_product_events (user_id, event_type, sale_id, occurred_at)
values
  ('c7820000-0000-4000-8000-000000000002', 'bid_ceiling_calculated',
   'c7820000-1000-4000-8000-00000000000a', now() - interval '2 days'),
  ('c7820000-0000-4000-8000-000000000002', 'bid_ceiling_calculated',
   'c7820000-1000-4000-8000-00000000000a', now() - interval '1 day'),
  ('c7820000-0000-4000-8000-000000000002', 'bid_ceiling_calculated',
   'c7820000-1000-4000-8000-00000000000b', now() - interval '1 day');

create temporary table pgtap_782_usage on commit drop as
select * from public.admin_signup_usage();
grant all on table pgtap_782_usage to public;

select is(
  (select array[unlocks, ceilings, favorites, sheets_served]::integer[]
     from pgtap_782_usage where user_id = 'c7820000-0000-4000-8000-000000000001'),
  array[0, 0, 0, 0],
  'an account that did nothing is returned with zeros'
);
select is(
  (select array[unlocks, ceilings, favorites, sheets_served]::integer[]
     from pgtap_782_usage where user_id = 'c7820000-0000-4000-8000-000000000002'),
  array[1, 1, 2, 2],
  'one unlock, one saved ceiling, two favourites, two distinct sales served'
);
select is(
  (select count(*) from pgtap_782_usage where user_id = 'c7820000-0000-4000-8000-000000000003'),
  0::bigint,
  'the administrator is not returned'
);
select is(
  (select count(*) from pgtap_782_usage where user_id in (
      'c7820000-0000-4000-8000-000000000001', 'c7820000-0000-4000-8000-000000000002')),
  2::bigint,
  'one row per account'
);
select is(
  (select trial_ends_at is not distinct from app_private.signup_trial_ends_at(user_id)
     from pgtap_782_usage where user_id = 'c7820000-0000-4000-8000-000000000001'),
  true,
  'the end of the trial is the one of the single rule'
);
select is(
  (select body from (select to_jsonb(u)::text as body from pgtap_782_usage u
                      where user_id = 'c7820000-0000-4000-8000-000000000002') x) ~ '(@example\.test|usage-active)',
  false,
  'no email address in the usage rows'
);

select * from finish();
rollback;
