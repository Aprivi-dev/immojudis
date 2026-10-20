-- Pages /tribunaux/[slug] (migration 20261029180000) : la liste d'un tribunal rend l'adresse source
-- de chaque vente (source_url, source_urls), de quoi ne dédoublonner que sur une identité certaine.
--   * le contrat ajoute exactement ces deux colonnes, la fonction privée et l'enveloppe publique
--     ont les mêmes colonnes ;
--   * les deux colonnes sont rendues telles qu'elles sont enregistrées ;
--   * aucun champ privé ne sort, la règle de visibilité et le critère « code du tribunal » sont ceux
--     de 20261028150000 ;
--   * les droits d'avant sont conservés (visiteur sans compte compris).
begin;

select plan(9);

-- Fixtures -------------------------------------------------------------------------------------
insert into public.tribunals (code, canonical_name, department, city)
values ('c596-tj-a', 'TJ C596 Alpha', '33', 'Alpha');

-- 1 et 2 : une même vente publiée par deux sources, avec une adresse source en commun dans
-- source_urls ; 3 : une vente sans adresse source supplémentaire.
insert into public.auction_sales (
  id, source_name, source_url, source_urls, title, address, city, department, property_type,
  starting_price_eur, sale_date, app_surface_m2, app_surface_kind,
  rooms_count, bedrooms_count, bathrooms_count, status, latitude, longitude,
  sale_venue_type, sale_verification_status, raw_payload, tribunal_code
)
select
  ('c5960000-1000-4000-8000-' || lpad(f.n::text, 12, '0'))::uuid,
  'public-tribunal-sales-source-test', f.url,
  f.urls::jsonb,
  'Tribunal sales source title ' || f.n, 'Adresse privée ' || f.n, 'Alphaville', '33', 'apartment',
  100000, now() + (10 + f.n) * interval '1 day',
  50, 'habitable', 2, 1, 1, 'upcoming', 44.837812, -0.579234,
  'tribunal', 'pending', '{}'::jsonb, 'c596-tj-a'
from (
  values
    (1, 'https://example.test/c596/a/1', '["https://example.test/c596/commun"]'),
    (2, 'https://example.test/c596/b/2', '["https://example.test/c596/commun"]'),
    (3, 'https://example.test/c596/a/3', '[]')
) as f(n, url, urls);

-- Les fonctions -------------------------------------------------------------------------------
select is(
  pg_get_function_result('public.get_public_tribunal_sales(text, integer)'::regprocedure),
  'TABLE(id uuid, city text, department text, property_type text, sale_date timestamp with time zone, starting_price_eur numeric, surface_m2 numeric, status text, source_url text, source_urls jsonb)',
  'the contract adds the source links to the public card of a sale'
);
select is(
  pg_get_function_result('app_private.get_public_tribunal_sales(text, integer)'::regprocedure)
    = pg_get_function_result('public.get_public_tribunal_sales(text, integer)'::regprocedure),
  true,
  'the private function and the public wrapper have the same columns'
);
select ok(
  (select prosecdef and proconfig @> array['search_path=""']
     from pg_proc where oid = 'app_private.get_public_tribunal_sales(text, integer)'::regprocedure)
  and not (select prosecdef from pg_proc where oid = 'public.get_public_tribunal_sales(text, integer)'::regprocedure),
  'the private read stays security definer with an empty search_path, the wrapper security invoker'
);
select ok(
  has_function_privilege('anon', 'public.get_public_tribunal_sales(text, integer)', 'execute')
  and has_function_privilege('authenticated', 'public.get_public_tribunal_sales(text, integer)', 'execute'),
  'signed-out visitors and accounts may still read the sales of a court'
);

-- Le contrat -----------------------------------------------------------------------------------
select is(
  (select pg_get_functiondef('app_private.get_public_tribunal_sales(text, integer)'::regprocedure)
          ~ 's\.(address|latitude|longitude|lawyer_contact|documents|visit_dates|raw_payload|description|raw_text)\b'),
  false,
  'address, coordinates, contacts, documents, visit text and the raw announcement stay out'
);
select is(
  (select pg_get_functiondef('app_private.get_public_tribunal_sales(text, integer)'::regprocedure)
          ~ 'auction_sale_is_publicly_visible\('
      and pg_get_functiondef('app_private.get_public_tribunal_sales(text, integer)'::regprocedure)
          ~ 's\.tribunal_code = p_tribunal_code'),
  true,
  'the court code and the public catalogue visibility rule still decide which sales are listed'
);

-- Le comportement ------------------------------------------------------------------------------
select is(
  (select source_url from public.get_public_tribunal_sales('c596-tj-a')
    where id = 'c5960000-1000-4000-8000-000000000001'),
  'https://example.test/c596/a/1',
  'the source url of the sale comes out as recorded'
);
select is(
  (select source_urls from public.get_public_tribunal_sales('c596-tj-a')
    where id = 'c5960000-1000-4000-8000-000000000002'),
  '["https://example.test/c596/commun"]'::jsonb,
  'the merged source urls come out as recorded, so the page can see a shared source'
);

-- Un visiteur sans compte ----------------------------------------------------------------------
set local role anon;
select is(
  (select count(*) from public.get_public_tribunal_sales('c596-tj-a')),
  3::bigint,
  'a signed-out visitor reads the sales of a court, source links included'
);
reset role;

select * from finish();
rollback;
