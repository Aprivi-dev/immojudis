-- Pages /tribunaux/[slug] (migration 20261028150000) : les prochaines ventes d'UN tribunal.
--   * la fonction publique est accessible sans compte, la fonction privée est SECURITY DEFINER à
--     search_path fixé, l'enveloppe publique est SECURITY INVOKER ;
--   * aucun champ privé (adresse, coordonnées, contacts, documents) ne sort ;
--   * un tribunal est désigné par son code (égalité), pas par un libellé ;
--   * seules les ventes au tribunal visibles du catalogue public sont rendues, les ventes reportées
--     avec leur statut, les ventes proches d'abord ;
--   * p_limit est borné.
-- Contrat de sortie : depuis 20261031100100 (point 1 de la relecture du 20/10/2026), la carte rend un
-- identifiant de groupe (source_group) à la place des adresses sources et des clés ; voir aussi 651.
begin;

select plan(18);

-- Fixtures -------------------------------------------------------------------------------------
insert into public.tribunals (code, canonical_name, department, city)
values
  ('c495-tj-a', 'TJ C495 Alpha', '33', 'Alpha'),
  ('c495-tj-b', 'TJ C495 Beta', '33', 'Beta');

-- Tribunal A : deux ventes visibles (a2 est reportée), une retirée, une vente chez un notaire.
-- Tribunal B : une vente visible, qui ne doit jamais sortir pour le code du tribunal A.
insert into public.auction_sales (
  id, source_name, source_url, title, address, city, department, property_type,
  starting_price_eur, sale_date, app_surface_m2, app_surface_kind,
  rooms_count, bedrooms_count, bathrooms_count, status, latitude, longitude,
  sale_venue_type, sale_verification_status, raw_payload, tribunal_code
)
select
  ('c4950000-1000-4000-8000-' || lpad(f.n::text, 12, '0'))::uuid,
  'public-tribunal-sales-test', 'https://example.test/c495/' || f.n,
  'Tribunal sales title ' || f.n, 'Adresse privée ' || f.n, f.city, '33', 'apartment',
  100000 + f.n * 1000,
  now() + f.in_days * interval '1 day',
  50, 'habitable', 2, 1, 1, f.status, 44.837812, -0.579234,
  f.venue, 'pending', '{}'::jsonb, f.court
from (
  values
    (1, 'Alphaville', 'c495-tj-a', 'upcoming', 'tribunal', 30),
    (2, 'Alphabourg', 'c495-tj-a', 'postponed', 'tribunal', 10),
    (3, 'Alpharetraite', 'c495-tj-a', 'withdrawn', 'tribunal', 12),
    (4, 'Alphanotaire', 'c495-tj-a', 'upcoming', 'notary', 14),
    (5, 'Betaville', 'c495-tj-b', 'upcoming', 'tribunal', 20)
) as f(n, city, court, status, venue, in_days);

-- Les fonctions -------------------------------------------------------------------------------
select has_function(
  'public', 'get_public_tribunal_sales', array['text', 'integer'],
  'the public tribunal sales RPC exists'
);
select ok(
  has_function_privilege('anon', 'public.get_public_tribunal_sales(text, integer)', 'execute')
  and has_function_privilege('authenticated', 'public.get_public_tribunal_sales(text, integer)', 'execute'),
  'signed-out visitors and accounts may read the sales of a court'
);
select ok(
  (select prosecdef from pg_proc where oid = 'app_private.get_public_tribunal_sales(text, integer)'::regprocedure)
  and (select coalesce(proconfig::text, '') like '%search_path=%'
         from pg_proc where oid = 'app_private.get_public_tribunal_sales(text, integer)'::regprocedure),
  'the read is a security definer function with a fixed search_path'
);
select ok(
  not (select prosecdef from pg_proc where oid = 'public.get_public_tribunal_sales(text, integer)'::regprocedure),
  'the public wrapper is security invoker'
);
select is(
  pg_get_function_result('public.get_public_tribunal_sales(text, integer)'::regprocedure),
  'TABLE(id uuid, city text, department text, property_type text, sale_date timestamp with time zone, starting_price_eur numeric, surface_m2 numeric, status text, source_group uuid)',
  'the contract is the public card of a sale: commune, type, date, price, surface, status, and a source group id (no source address, no key)'
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
          ~ 'auction_sale_is_publicly_visible\('),
  true,
  'the public catalogue visibility rule decides which sales are listed'
);
select is(
  (select pg_get_functiondef('app_private.get_public_tribunal_sales(text, integer)'::regprocedure)
          ~ 's\.tribunal_code = p_tribunal_code'),
  true,
  'a court is designated by its code (equality), not by a label pattern'
);
-- Le comportement ------------------------------------------------------------------------------
select is(
  (select array_agg(id order by sale_date) from public.get_public_tribunal_sales('c495-tj-a')),
  array[
    'c4950000-1000-4000-8000-000000000002',
    'c4950000-1000-4000-8000-000000000001'
  ]::uuid[],
  'the visible tribunal sales of the court come out, the nearest first'
);
select is(
  (select status from public.get_public_tribunal_sales('c495-tj-a')
    where id = 'c4950000-1000-4000-8000-000000000002'),
  'postponed',
  'a postponed sale keeps its status, so the page does not announce its date'
);
select is(
  (select count(*) from public.get_public_tribunal_sales('c495-tj-a')
    where id in (
      'c4950000-1000-4000-8000-000000000003',
      'c4950000-1000-4000-8000-000000000004',
      'c4950000-1000-4000-8000-000000000005'
    )),
  0::bigint,
  'a withdrawn sale, a notary sale and the sale of another court are not listed'
);
select is(
  (select array_agg(id) from public.get_public_tribunal_sales('c495-tj-b')),
  array['c4950000-1000-4000-8000-000000000005']::uuid[],
  'the other court lists its own sale'
);
select is(
  (select count(*) from public.get_public_tribunal_sales('c495-tj')),
  0::bigint,
  'a code prefix designates nothing'
);
select is(
  (select count(*) from public.get_public_tribunal_sales('inconnu')),
  0::bigint,
  'an unknown court has no sale'
);
select is(
  (select count(*) from public.get_public_tribunal_sales('c495-tj-a', 1)),
  1::bigint,
  'p_limit caps the number of sales'
);
select is(
  (select count(*) from public.get_public_tribunal_sales('c495-tj-a', null)),
  2::bigint,
  'a null limit falls back to the default'
);
select is(
  (select count(*) from public.get_public_tribunal_sales('c495-tj-a', -5)),
  1::bigint,
  'a limit below 1 is raised to 1'
);

-- Un visiteur sans compte ----------------------------------------------------------------------
set local role anon;
select is(
  (select count(*) from public.get_public_tribunal_sales('c495-tj-a')),
  2::bigint,
  'a signed-out visitor reads the sales of a court'
);
reset role;

select * from finish();
rollback;
