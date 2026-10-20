-- Accueil, « Données vérifiées le … » (migration 20261029160000) : la date est le MIN de
-- last_publication_complete_at sur les sources actives (enabled) qui ont au moins une vente visible à
-- venir, et non plus le MAX de toutes les sources.
--   * une source figée qui alimente des ventes affichées vieillit la date de l'accueil ;
--   * ne comptent pas : une source désactivée, une source sans vente visible à venir (vente passée,
--     retirée, en quarantaine de publication) ;
--   * une source du périmètre qui n'a jamais de collecte complète (NULL) rend la date inconnue : NULL
--     (migration 20261031100200, voir aussi le test 652) ;
--   * aucune date exploitable : NULL ; une date dans le futur est ramenée à l'heure courante ;
--   * mêmes droits que 20261028100400 : lisible par anon, seule la date sort.
-- Les écritures sont annulées en fin de test.
begin;

select plan(17);

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
  'les visiteurs anonymes et connectés peuvent lire la date'
);
select is(
  pg_get_function_result('public.get_public_catalogue_verified_at()'::regprocedure),
  'timestamp with time zone',
  'elle ne rend qu''une date'
);

-- Fixtures ---------------------------------------------------------------------------------------------------
-- Toutes les sources partent désactivées et sans collecte ; chaque cas en réactive quelques-unes.
update public.auction_source_state
  set enabled = false, catalogue_withdrawn = false, last_publication_complete_at = null;

-- Une vente par source : n = 1 licitor (à venir), 2 vench (à venir), 3 notaires (passée), 4 agrasc (retirée),
-- 5 avoventes (à venir, source désactivée), 6 info_encheres (à venir mais en quarantaine de publication),
-- 7 encheres_publiques (à venir, source sans collecte complète).
insert into public.auction_sales (id, source_name, source_url, title, status, sale_date, raw_payload)
select
  ('c5900000-1000-4000-8000-' || lpad(f.n::text, 12, '0'))::uuid,
  f.source, 'https://example.test/c590/' || f.n, 'Vente c590 ' || f.n, f.status,
  f.sale_date, f.payload
from (
  values
    (1, 'licitor', 'upcoming', now() + interval '30 days', '{}'::jsonb),
    (2, 'vench', 'upcoming', now() + interval '30 days', '{}'::jsonb),
    (3, 'notaires', 'upcoming', now() - interval '400 days', '{}'::jsonb),
    (4, 'agrasc', 'withdrawn', now() + interval '30 days', '{}'::jsonb),
    (5, 'avoventes', 'upcoming', now() + interval '30 days', '{}'::jsonb),
    (6, 'info_encheres', 'upcoming', now() + interval '30 days',
      '{"publication_quarantine": "source_withdrawn"}'::jsonb),
    (7, 'encheres_publiques', 'upcoming', now() + interval '30 days', '{}'::jsonb)
) as f(n, source, status, sale_date, payload);

-- Valeurs ----------------------------------------------------------------------------------------------------

update public.auction_source_state set enabled = true, last_publication_complete_at = '2026-10-17 05:00:00+00'
  where source_name = 'licitor';
update public.auction_source_state set enabled = true, last_publication_complete_at = '2026-10-18 06:30:00+00'
  where source_name = 'vench';
select is(
  public.get_public_catalogue_verified_at(),
  '2026-10-17 05:00:00+00'::timestamptz,
  'la source active la moins récente, pas la plus récente'
);

update public.auction_source_state set enabled = true, last_publication_complete_at = '2026-10-01 04:00:00+00'
  where source_name = 'notaires';
select is(
  public.get_public_catalogue_verified_at(),
  '2026-10-17 05:00:00+00'::timestamptz,
  'une source active sans vente à venir visible (vente passée) ne compte pas'
);

update public.auction_source_state set enabled = true, last_publication_complete_at = '2026-09-20 04:00:00+00'
  where source_name = 'agrasc';
select is(
  public.get_public_catalogue_verified_at(),
  '2026-10-17 05:00:00+00'::timestamptz,
  'une source active dont la seule vente est retirée ne compte pas'
);

update public.auction_source_state set enabled = false, last_publication_complete_at = '2026-09-01 04:00:00+00'
  where source_name = 'avoventes';
select is(
  public.get_public_catalogue_verified_at(),
  '2026-10-17 05:00:00+00'::timestamptz,
  'une source désactivée ne compte pas, même avec une vente à venir'
);

update public.auction_source_state set enabled = true, last_publication_complete_at = '2026-09-10 04:00:00+00'
  where source_name = 'info_encheres';
select is(
  public.get_public_catalogue_verified_at(),
  '2026-10-17 05:00:00+00'::timestamptz,
  'une source dont la seule vente est en quarantaine de publication ne compte pas'
);

update public.auction_source_state set last_publication_complete_at = '2026-10-05 06:30:00+00'
  where source_name = 'vench';
select is(
  public.get_public_catalogue_verified_at(),
  '2026-10-05 06:30:00+00'::timestamptz,
  'une source figée qui alimente des ventes affichées vieillit la date de l''accueil'
);

update public.auction_source_state set enabled = true, last_publication_complete_at = null
  where source_name = 'encheres_publiques';
select is(
  public.get_public_catalogue_verified_at(),
  null::timestamptz,
  'une source du périmètre qui n''a jamais de collecte complète (NULL) rend la date inconnue'
);

update public.auction_source_state set enabled = false
  where source_name = 'encheres_publiques';
select is(
  public.get_public_catalogue_verified_at(),
  '2026-10-05 06:30:00+00'::timestamptz,
  'désactivée, cette source ne compte plus'
);

update public.auction_source_state set last_publication_complete_at = null
  where source_name in ('licitor', 'vench');
select is(
  public.get_public_catalogue_verified_at(),
  null::timestamptz,
  'aucune source qui compte n''a de date : pas de date'
);

update public.auction_source_state set last_publication_complete_at = '2026-10-06 06:30:00+00'
  where source_name = 'vench';
update public.auction_source_state set last_publication_complete_at = now() + interval '3 days'
  where source_name = 'licitor';
select is(
  public.get_public_catalogue_verified_at() <= now(),
  true,
  'une date dans le futur est ramenée à l''heure courante'
);

-- Un visiteur anonyme la lit ---------------------------------------------------------------------------------

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
