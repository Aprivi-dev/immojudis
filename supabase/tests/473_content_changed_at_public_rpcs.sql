begin;

select plan(17);

-- 20261028100300 : le sitemap des fiches et la fiche publique rendent content_changed_at (date du dernier
-- changement visible) à la place de updated_at (date technique de la ligne). Les lignes insérées sont
-- annulées en fin de test.

-- Contrat des fonctions -------------------------------------------------------------------------------------

select is(
  pg_get_function_result('public.list_public_sale_sitemap_entries(integer,integer)'::regprocedure),
  'TABLE(id uuid, content_changed_at timestamp with time zone, total_count bigint)',
  'le sitemap rend content_changed_at, plus updated_at'
);
select is(
  pg_get_function_result('public.get_public_sale_summary(uuid)'::regprocedure) ~ 'content_changed_at timestamp with time zone\)$',
  true,
  'la fiche publique rend content_changed_at en dernière colonne'
);
select is(
  pg_get_function_result('public.get_public_sale_summary(uuid)'::regprocedure) ~ 'updated_at',
  false,
  'la fiche publique ne rend plus updated_at'
);
select is(
  pg_get_function_result('app_private.get_public_sale_summary(uuid)'::regprocedure)
    = pg_get_function_result('public.get_public_sale_summary(uuid)'::regprocedure)
  and pg_get_function_result('app_private.list_public_sale_sitemap_entries(integer,integer)'::regprocedure)
    = pg_get_function_result('public.list_public_sale_sitemap_entries(integer,integer)'::regprocedure),
  true,
  'les fonctions publiques et leurs fonctions privées ont les mêmes colonnes'
);

select ok(
  (select prosecdef and proconfig @> array['search_path=""']
   from pg_proc where oid = 'app_private.list_public_sale_sitemap_entries(integer,integer)'::regprocedure)
  and (select prosecdef and proconfig @> array['search_path=""']
   from pg_proc where oid = 'app_private.get_public_sale_summary(uuid)'::regprocedure),
  'les fonctions privées restent SECURITY DEFINER à search_path vide'
);
select ok(
  not (select prosecdef from pg_proc where oid = 'public.list_public_sale_sitemap_entries(integer,integer)'::regprocedure)
  and not (select prosecdef from pg_proc where oid = 'public.get_public_sale_summary(uuid)'::regprocedure),
  'les enveloppes publiques ne sont pas SECURITY DEFINER'
);
select ok(
  has_function_privilege('anon', 'public.list_public_sale_sitemap_entries(integer,integer)', 'execute')
  and has_function_privilege('anon', 'public.get_public_sale_summary(uuid)', 'execute')
  and has_function_privilege('authenticated', 'public.get_public_sale_summary(uuid)', 'execute')
  and has_function_privilege('service_role', 'public.list_public_sale_sitemap_entries(integer,integer)', 'execute'),
  'les visiteurs anonymes et connectés appellent toujours les deux fonctions'
);
-- Jeu d'essai -----------------------------------------------------------------------------------------------

insert into public.auction_sales (
  id, source_name, source_url, status, sale_date, city, property_type, starting_price_eur,
  raw_payload, sale_procedure, content_changed_at
)
values
  -- 01 visible, indexable, date de changement connue ; 02 visible, indexable, jamais modifiée
  ('c4730000-0000-4000-8000-000000000001', 'licitor', 'https://example.test/473/01', 'upcoming',
    current_timestamp + interval '20 days', 'Bordeaux', 'apartment', 90000, '{}'::jsonb, '{}'::jsonb,
    '2026-10-20 09:30:00+00'),
  ('c4730000-0000-4000-8000-000000000002', 'licitor', 'https://example.test/473/02', 'upcoming',
    current_timestamp + interval '21 days', 'Pau', 'house', 120000, '{}'::jsonb, '{}'::jsonb, null),
  -- 03 en quarantaine, 04 date passée, 05 statut passé : jamais listées
  ('c4730000-0000-4000-8000-000000000003', 'licitor', 'https://example.test/473/03', 'upcoming',
    current_timestamp + interval '22 days', 'Lyon', 'apartment', 80000,
    '{"publication_quarantine": "operator_hold"}'::jsonb, '{}'::jsonb, '2026-10-21 09:30:00+00'),
  ('c4730000-0000-4000-8000-000000000004', 'licitor', 'https://example.test/473/04', 'upcoming',
    current_timestamp - interval '5 days', 'Nantes', 'apartment', 70000, '{}'::jsonb, '{}'::jsonb,
    '2026-10-22 09:30:00+00'),
  ('c4730000-0000-4000-8000-000000000005', 'licitor', 'https://example.test/473/05', 'past',
    current_timestamp + interval '23 days', 'Lille', 'apartment', 60000, '{}'::jsonb, '{}'::jsonb,
    '2026-10-23 09:30:00+00'),
  -- 06 visible mais non indexable (ni surface ni mise à prix) : dans la fiche publique, pas dans le sitemap
  ('c4730000-0000-4000-8000-000000000006', 'licitor', 'https://example.test/473/06', 'upcoming',
    current_timestamp + interval '24 days', 'Metz', 'apartment', null, '{}'::jsonb, '{}'::jsonb,
    '2026-10-24 09:30:00+00');

-- Le sitemap -------------------------------------------------------------------------------------------------

create temp table sitemap on commit drop as
  select * from public.list_public_sale_sitemap_entries(5000, 0)
  where id::text like 'c4730000-%';

select is(
  (select array_agg(id::text order by id) from sitemap),
  array['c4730000-0000-4000-8000-000000000001', 'c4730000-0000-4000-8000-000000000002'],
  'le sitemap liste les fiches visibles et indexables, pas la quarantaine, la date passée, le statut passé ni la fiche mince'
);
select is(
  (select content_changed_at from sitemap where id = 'c4730000-0000-4000-8000-000000000001'),
  '2026-10-20 09:30:00+00'::timestamptz,
  'la date d''un changement connu est rendue'
);
select is(
  (select content_changed_at from sitemap where id = 'c4730000-0000-4000-8000-000000000002'),
  null::timestamptz,
  'une fiche jamais modifiée est rendue sans date (jamais une date inventée)'
);
select cmp_ok(
  (select min(total_count) from public.list_public_sale_sitemap_entries(5000, 0)),
  '>=',
  2::bigint,
  'le total compte les fiches listées'
);
select throws_ok(
  $$ select * from public.list_public_sale_sitemap_entries(0, 0) $$,
  '22023',
  'Invalid sitemap pagination.',
  'la pagination invalide est toujours refusée'
);

-- La fiche publique -------------------------------------------------------------------------------------------

select is(
  (select content_changed_at from public.get_public_sale_summary('c4730000-0000-4000-8000-000000000001')),
  '2026-10-20 09:30:00+00'::timestamptz,
  'la fiche rend la date du dernier changement visible'
);
select is(
  (select content_changed_at from public.get_public_sale_summary('c4730000-0000-4000-8000-000000000002')),
  null::timestamptz,
  'une fiche jamais modifiée n''a pas de date'
);
select is(
  (select count(*) from public.get_public_sale_summary('c4730000-0000-4000-8000-000000000003')),
  0::bigint,
  'une fiche en quarantaine reste invisible'
);
select is(
  (select count(*) from public.get_public_sale_summary('c4730000-0000-4000-8000-000000000006')),
  1::bigint,
  'une fiche visible mais non indexable reste servie'
);

-- Un visiteur anonyme appelle les deux fonctions ---------------------------------------------------------------------

set local role anon;
select is(
  (select count(*) from public.list_public_sale_sitemap_entries(5000, 0)
    where id = 'c4730000-0000-4000-8000-000000000001')
  + (select count(*) from public.get_public_sale_summary('c4730000-0000-4000-8000-000000000001')),
  2::bigint,
  'le rôle anonyme lit le sitemap et la fiche'
);
reset role;

select * from finish();
rollback;
