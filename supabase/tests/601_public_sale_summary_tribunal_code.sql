-- 20261029180100 : la fiche publique (get_public_sale_summary) rend tribunal_code, pour que le nom du
-- tribunal soit un lien vers sa page /tribunaux/[slug]. Les lignes insérées sont annulées en fin de test.
--   * le contrat ajoute tribunal_code après tribunal_city, et garde content_changed_at en dernière
--     colonne (473) ; la fonction privée et l'enveloppe publique ont les mêmes colonnes ;
--   * le code n'est rendu que pour une vente au tribunal dont le tribunal est connu du référentiel ;
--   * la visibilité et les droits d'avant sont conservés, aucune adresse ni donnée privée ne sort.
begin;

select plan(11);

-- Contrat des fonctions -------------------------------------------------------------------------------------

select is(
  pg_get_function_result('public.get_public_sale_summary(uuid)'::regprocedure),
  'TABLE(id uuid, starting_price_eur numeric, sale_venue_type text, sale_verification_status text, city text, department text, property_type text, sale_date timestamp with time zone, app_surface_m2 numeric, app_surface_kind text, rooms_count integer, bedrooms_count integer, bathrooms_count integer, tribunal_name text, tribunal_city text, tribunal_code text, thumbnail_url text, content_changed_at timestamp with time zone)',
  'la fiche publique rend tribunal_code après tribunal_city'
);
select is(
  pg_get_function_result('app_private.get_public_sale_summary(uuid)'::regprocedure)
    = pg_get_function_result('public.get_public_sale_summary(uuid)'::regprocedure),
  true,
  'la fonction privée et l''enveloppe publique ont les mêmes colonnes'
);
select is(
  pg_get_function_result('public.get_public_sale_summary(uuid)'::regprocedure) ~ 'content_changed_at timestamp with time zone\)$'
  and pg_get_function_result('public.get_public_sale_summary(uuid)'::regprocedure) !~ 'updated_at',
  true,
  'content_changed_at reste la dernière colonne et updated_at ne sort toujours pas'
);
select ok(
  (select prosecdef and proconfig @> array['search_path=""']
     from pg_proc where oid = 'app_private.get_public_sale_summary(uuid)'::regprocedure)
  and not (select prosecdef from pg_proc where oid = 'public.get_public_sale_summary(uuid)'::regprocedure),
  'la fonction privée reste SECURITY DEFINER à search_path vide, l''enveloppe publique SECURITY INVOKER'
);
select ok(
  has_function_privilege('anon', 'public.get_public_sale_summary(uuid)', 'execute')
  and has_function_privilege('authenticated', 'public.get_public_sale_summary(uuid)', 'execute')
  and has_function_privilege('service_role', 'public.get_public_sale_summary(uuid)', 'execute'),
  'les visiteurs anonymes et connectés appellent toujours la fonction'
);
select is(
  (select pg_get_functiondef('app_private.get_public_sale_summary(uuid)'::regprocedure)
          ~ 's\.(address|latitude|longitude|lawyer_contact|documents|visit_dates|description|raw_text)\b'),
  false,
  'ni adresse, ni coordonnées, ni contacts, ni documents ne sortent'
);

-- Jeu d'essai -----------------------------------------------------------------------------------------------

insert into public.tribunals (code, canonical_name, department, city)
values ('c597-tj-a', 'TJ C597 Alpha', '33', 'Alpha');

insert into public.auction_sales (
  id, source_name, source_url, status, sale_date, city, property_type, starting_price_eur,
  raw_payload, sale_procedure, sale_venue_type, tribunal_code
)
values
  -- 01 vente au tribunal, tribunal connu ; 02 vente au tribunal sans code ; 03 vente chez un notaire
  -- qui porte un code de tribunal (jamais rendu : le lien n'a de sens que pour une audience).
  ('c5970000-0000-4000-8000-000000000001', 'licitor', 'https://example.test/597/01', 'upcoming',
    current_timestamp + interval '20 days', 'Alphaville', 'apartment', 90000, '{}'::jsonb, '{}'::jsonb,
    'tribunal', 'c597-tj-a'),
  ('c5970000-0000-4000-8000-000000000002', 'licitor', 'https://example.test/597/02', 'upcoming',
    current_timestamp + interval '21 days', 'Betaville', 'house', 120000, '{}'::jsonb, '{}'::jsonb,
    'tribunal', null),
  ('c5970000-0000-4000-8000-000000000003', 'licitor', 'https://example.test/597/03', 'upcoming',
    current_timestamp + interval '22 days', 'Gammaville', 'apartment', 80000, '{}'::jsonb, '{}'::jsonb,
    'notary', 'c597-tj-a'),
  -- 04 en quarantaine : toujours invisible
  ('c5970000-0000-4000-8000-000000000004', 'licitor', 'https://example.test/597/04', 'upcoming',
    current_timestamp + interval '23 days', 'Deltaville', 'apartment', 70000,
    '{"publication_quarantine": "operator_hold"}'::jsonb, '{}'::jsonb, 'tribunal', 'c597-tj-a');

-- La fiche publique -------------------------------------------------------------------------------------------

select is(
  (select tribunal_code from public.get_public_sale_summary('c5970000-0000-4000-8000-000000000001')),
  'c597-tj-a',
  'une vente au tribunal rend le code de son tribunal'
);
select is(
  (select tribunal_code from public.get_public_sale_summary('c5970000-0000-4000-8000-000000000002')),
  null::text,
  'une vente au tribunal sans tribunal connu n''a pas de code'
);
select is(
  (select tribunal_code from public.get_public_sale_summary('c5970000-0000-4000-8000-000000000003')),
  null::text,
  'une vente d''un autre type ne rend jamais de code de tribunal'
);
select is(
  (select count(*) from public.get_public_sale_summary('c5970000-0000-4000-8000-000000000004')),
  0::bigint,
  'une fiche en quarantaine reste invisible'
);

-- Un visiteur anonyme ------------------------------------------------------------------------------------------

set local role anon;
select is(
  (select tribunal_code from public.get_public_sale_summary('c5970000-0000-4000-8000-000000000001')),
  'c597-tj-a',
  'le rôle anonyme lit le code du tribunal'
);
reset role;

select * from finish();
rollback;
