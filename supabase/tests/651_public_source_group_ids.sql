-- Chantier R1, point 1 (migration 20261031100100) : plus aucune clé dérivée d'une adresse source ne sort
-- de get_public_tribunal_sales (ouverte à anon) ni de get_public_upcoming_hearings. Un identifiant de
-- groupe (le plus petit id des lignes de la liste reliées, de proche en proche, par une adresse source
-- normalisée) le remplace.
--   * app_private.source_group_ids : composantes connexes, y compris le cas où deux lignes ne sont
--     reliées que par une troisième ; une ligne seule est son propre groupe ; entrée vide ou nulle sans
--     erreur ; fonction fermée aux rôles du navigateur ;
--   * get_public_tribunal_sales : la chaîne A-B (adresse 1), B-C (adresse 2) donne un seul groupe ; une
--     page d'accueil partagée (adresse réduite au domaine) ne fusionne rien ; aucune adresse ni
--     SHA-256 ne sort ; le visiteur sans compte lit toujours la liste ;
--   * get_public_upcoming_hearings : plus de clé source_keys.
begin;

select plan(11);

-- Fixtures -------------------------------------------------------------------------------------
insert into public.tribunals (code, canonical_name, department, city)
values ('c651-tj', 'TJ C651 Cobalt', '33', 'Cobalt');

-- 1, 2, 3 : chaîne (1 et 2 partagent l'adresse « commun/1 », 2 et 3 « chaine/2 ») ; 4 : isolée ;
-- 5 et 6 : seulement une page d'accueil en commun (aucune identité).
insert into public.auction_sales (
  id, source_name, source_url, source_urls, title, address, city, department, property_type,
  starting_price_eur, sale_date, app_surface_m2, app_surface_kind,
  rooms_count, bedrooms_count, bathrooms_count, status, latitude, longitude,
  sale_venue_type, sale_verification_status, raw_payload, tribunal_code
)
select
  ('c6510000-1000-4000-8000-' || lpad(f.n::text, 12, '0'))::uuid,
  'c651-test', f.url, f.urls::jsonb,
  'Source group title ' || f.n, 'Adresse privée ' || f.n, 'Cobaltville', '33', 'apartment',
  100000 + f.n, now() + (3 + f.n) * interval '1 day',
  50, 'habitable', 2, 1, 1, 'upcoming', 44.837812, -0.579234,
  'tribunal', 'pending', '{}'::jsonb, 'c651-tj'
from (
  values
    (3, 'https://c.example.test/c651/3', '["https://www.example.test/c651/chaine/2"]'),
    (2, 'https://b.example.test/c651/2', '["https://example.test/c651/commun/1", "http://example.test/c651/chaine/2/"]'),
    (1, 'https://a.example.test/c651/1', '["https://example.test/c651/commun/1"]'),
    (4, 'https://d.example.test/c651/4', '[]'),
    (5, 'https://accueil.example.test/', '[]'),
    (6, 'https://accueil.example.test', '[]')
) as f(n, url, urls);

-- La fonction de groupes -----------------------------------------------------------------------------
select ok(
  not has_function_privilege('anon', 'app_private.source_group_ids(jsonb)', 'execute')
  and not has_function_privilege('authenticated', 'app_private.source_group_ids(jsonb)', 'execute')
  and has_function_privilege('service_role', 'app_private.source_group_ids(jsonb)', 'execute'),
  'the group function is closed to the browser roles'
);
select is(
  (select count(*) from app_private.source_group_ids('[]'::jsonb))
    + (select count(*) from app_private.source_group_ids(null)),
  0::bigint,
  'an empty or null input gives no group and no error'
);
select is(
  (select array_agg(g.group_id order by g.id)
     from app_private.source_group_ids(
       '[{"id":"00000000-0000-4000-8000-000000000005","keys":["k1","k2"]},
         {"id":"00000000-0000-4000-8000-000000000007","keys":["k1","k3"]},
         {"id":"00000000-0000-4000-8000-000000000009","keys":["k2"]},
         {"id":"00000000-0000-4000-8000-000000000001","keys":["k3"]},
         {"id":"00000000-0000-4000-8000-000000000011","keys":[]},
         {"id":"00000000-0000-4000-8000-000000000012"}]'::jsonb
     ) g),
  array[
    '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001',
    '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001',
    '00000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-000000000012'
  ]::uuid[],
  'rows linked only through a third row share the smallest id of the chain; a row with no key is its own group'
);
select is(
  (select group_id from app_private.source_group_ids(
     '[{"id":"00000000-0000-4000-8000-000000000003","keys":["k1"]},
       {"id":"00000000-0000-4000-8000-000000000003","keys":["k1","k1"]}]'::jsonb
   ) limit 1),
  '00000000-0000-4000-8000-000000000003'::uuid,
  'a repeated row or key changes nothing'
);

-- Ventes d'un tribunal ---------------------------------------------------------------------------------
select is(
  (select array_agg(source_group order by id) from public.get_public_tribunal_sales('c651-tj')
    where right(id::text, 12)::integer <= 3),
  array[
    'c6510000-1000-4000-8000-000000000001',
    'c6510000-1000-4000-8000-000000000001',
    'c6510000-1000-4000-8000-000000000001'
  ]::uuid[],
  'the chain A-B, B-C gives the three sales one group: the smallest id'
);
select is(
  (select source_group from public.get_public_tribunal_sales('c651-tj')
    where id = 'c6510000-1000-4000-8000-000000000004'),
  'c6510000-1000-4000-8000-000000000004'::uuid,
  'an unrelated sale is its own group'
);
select is(
  (select count(distinct source_group) from public.get_public_tribunal_sales('c651-tj')
    where id in ('c6510000-1000-4000-8000-000000000005', 'c6510000-1000-4000-8000-000000000006')),
  2::bigint,
  'two sales whose only shared address is a home page are not merged'
);
select is(
  (select count(*) from public.get_public_tribunal_sales('c651-tj') r
    where r::text ~ 'example\.test|[0-9a-f]{64}'),
  0::bigint,
  'neither a source address nor a hash of one comes out'
);
select is(
  (select count(*)
     from pg_proc p, unnest(p.proargnames) as n(name)
    where p.oid = 'public.get_public_tribunal_sales(text, integer)'::regprocedure
      and n.name = 'source_keys'),
  0::bigint,
  'the source_keys column is gone from the public contract'
);

-- Audiences à venir ------------------------------------------------------------------------------------
select is(
  (select count(*) from jsonb_array_elements(public.get_public_upcoming_hearings(30) -> 'hearings') h
    where h ? 'source_keys'),
  0::bigint,
  'the hearings document carries no source_keys any more'
);

-- Un visiteur sans compte ----------------------------------------------------------------------------
set local role anon;
select is(
  (select count(*) from public.get_public_tribunal_sales('c651-tj')),
  6::bigint,
  'a signed-out visitor reads the sales of a court, with group ids only'
);
reset role;

select * from finish();
rollback;
