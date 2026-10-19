begin;

select plan(11);

-- 20261028100400 : la date de la dernière collecte réussie, lue par l'accueil. Les écritures sont annulées
-- en fin de test.

select has_function('public', 'get_public_catalogue_verified_at', array[]::text[], 'la fonction publique existe');
select has_function('app_private', 'get_public_catalogue_verified_at', array[]::text[], 'la fonction privée existe');

select ok(
  (select prosecdef and proconfig @> array['search_path=""']
   from pg_proc where oid = 'app_private.get_public_catalogue_verified_at()'::regprocedure)
  and not (select prosecdef from pg_proc where oid = 'public.get_public_catalogue_verified_at()'::regprocedure),
  'la fonction privée est SECURITY DEFINER à search_path vide, l''enveloppe publique ne l''est pas'
);
select ok(
  has_function_privilege('anon', 'public.get_public_catalogue_verified_at()', 'execute')
  and has_function_privilege('authenticated', 'public.get_public_catalogue_verified_at()', 'execute')
  and has_function_privilege('service_role', 'public.get_public_catalogue_verified_at()', 'execute'),
  'les visiteurs anonymes et connectés peuvent la lire'
);
select is(
  pg_get_function_result('public.get_public_catalogue_verified_at()'::regprocedure),
  'timestamp with time zone',
  'elle ne rend qu''une date'
);

-- Valeurs ----------------------------------------------------------------------------------------------------

update public.auction_source_state set last_publication_complete_at = null;
select is(
  public.get_public_catalogue_verified_at(),
  null::timestamptz,
  'aucune collecte réussie : pas de date'
);

update public.auction_source_state
  set last_publication_complete_at = '2026-10-17 05:00:00+00'
  where source_name = 'licitor';
update public.auction_source_state
  set last_publication_complete_at = '2026-10-18 06:30:00+00'
  where source_name = 'vench';
update public.auction_source_state
  set last_publication_complete_at = '2026-10-16 04:00:00+00'
  where source_name = 'notaires';
select is(
  public.get_public_catalogue_verified_at(),
  '2026-10-18 06:30:00+00'::timestamptz,
  'la plus récente des sources'
);

update public.auction_source_state
  set last_inventory_complete_at = '2026-10-19 06:30:00+00'
  where source_name = 'avoventes';
select is(
  public.get_public_catalogue_verified_at(),
  '2026-10-18 06:30:00+00'::timestamptz,
  'un inventaire complet sans publication complète ne compte pas'
);

update public.auction_source_state
  set last_publication_complete_at = now() + interval '3 days'
  where source_name = 'agrasc';
select is(
  public.get_public_catalogue_verified_at() <= now(),
  true,
  'une date dans le futur est ramenée à l''heure courante'
);

-- Un visiteur anonyme la lit -------------------------------------------------------------------------------------

set local role anon;
select is(
  public.get_public_catalogue_verified_at() is not null,
  true,
  'le rôle anonyme lit la date'
);
select throws_ok(
  $$ select * from public.auction_source_state $$,
  '42501',
  null,
  'mais pas la table des sources'
);
reset role;

select * from finish();
rollback;
