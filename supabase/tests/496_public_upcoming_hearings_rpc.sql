-- Page /audiences-a-venir (migrations 20261028150100, 20261028160100, réécrite par 20261029100100) :
-- les audiences des prochains jours.
--   * la fonction n'est plus ouverte à anon ni à authenticated : la page la lit côté serveur
--     (service_role) ; la fonction privée est SECURITY DEFINER à search_path fixé, l'enveloppe publique
--     est SECURITY INVOKER ;
--   * elle rend un document { total_count, hearings } (pas de limite de lignes de PostgREST) ;
--   * la règle de « date sourcée » est celle de l'export agenda (get_public_sale_calendar_event) :
--     recalculée en SQL ensembliste, comparée à la fonction d'origine par le test 531 ;
--   * aucun champ privé (adresse, coordonnées, contacts, documents) ni adresse source ne sort, ni clé
--     dérivée d'une adresse : un identifiant de groupe (source_group, migration 20261031100100) permet
--     à la page de ne fusionner que sur une identité certaine ;
--   * seules les audiences exportables de la fenêtre sont rendues : ni vente reportée, ni date
--     rejetée ou en conflit, ni vente chez un notaire, ni date hors fenêtre ;
--   * la fenêtre est bornée à 1..60 jours.
begin;

select plan(23);

-- Fixtures -------------------------------------------------------------------------------------
insert into public.tribunals (code, canonical_name, department, city)
values
  ('c496-tj-x', 'TJ C496 Xenon', '33', 'Xenon'),
  ('c496-tj-y', 'TJ C496 Yttrium', '33', 'Yttrium');

-- n : numéro de la vente ; day : jours à partir d'aujourd'hui (heure de Paris) ; hour : heure de
-- l'audience, null pour minuit (heure inconnue : événement sur la journée).
--   1, 2 : mêmes tribunal, jour et mise à prix, deux fiches (deux sources) : toutes deux rendues (sources distinctes),
--          l'appelant ne les fusionne que s'ils partagent une source ;
--   3    : tribunal Y, dans 20 jours ; 5 : minuit, dans 5 jours (heure inconnue) ;
--   4    : reportée ; 6 : chez un notaire ; 7 : date rejetée ; 8 : dans 90 jours ;
--   9    : en conflit entre sources.
insert into public.auction_sales (
  id, source_name, source_url, title, address, city, department, property_type,
  starting_price_eur, sale_date, app_surface_m2, app_surface_kind,
  rooms_count, bedrooms_count, bathrooms_count, status, latitude, longitude,
  sale_venue_type, sale_verification_status, raw_payload, tribunal_code
)
select
  ('c4960000-1000-4000-8000-' || lpad(f.n::text, 12, '0'))::uuid,
  'public-upcoming-hearings-test', 'https://example.test/c496/' || f.n,
  'Hearing title ' || f.n, 'Adresse privée ' || f.n, f.city, '33', 'house',
  f.price,
  (
    date_trunc('day', now() at time zone 'Europe/Paris')
    + f.day * interval '1 day' + coalesce(f.hour, 0) * interval '1 hour'
  ) at time zone 'Europe/Paris',
  80, 'habitable', 3, 2, 1, f.status, 44.837812, -0.579234,
  f.venue, f.verification, f.payload, f.court
from (
  values
    (1, 'Xenonville', 'c496-tj-x', 'upcoming', 'tribunal', 3, 10, 100000, 'pending', '{}'::jsonb),
    (2, 'Xenonville', 'c496-tj-x', 'upcoming', 'tribunal', 3, 10, 100000, 'pending', '{}'::jsonb),
    (3, 'Yttriumville', 'c496-tj-y', 'upcoming', 'tribunal', 20, 14, 60000, 'pending', '{}'::jsonb),
    (4, 'Xenonreport', 'c496-tj-x', 'postponed', 'tribunal', 4, 10, 70000, 'pending', '{}'::jsonb),
    (5, 'Xenonjour', 'c496-tj-x', 'upcoming', 'tribunal', 5, null, 80000, 'pending', '{}'::jsonb),
    (6, 'Xenonnotaire', 'c496-tj-x', 'upcoming', 'notary', 6, 10, 90000, 'pending', '{}'::jsonb),
    (7, 'Xenonrejet', 'c496-tj-x', 'upcoming', 'tribunal', 7, 10, 91000, 'pending', '{"sale_date_unverified": true}'::jsonb),
    (8, 'Xenonlointain', 'c496-tj-x', 'upcoming', 'tribunal', 90, 10, 92000, 'pending', '{}'::jsonb),
    (9, 'Xenonconflit', 'c496-tj-x', 'upcoming', 'tribunal', 8, 10, 93000, 'conflict', '{}'::jsonb)
) as f(n, city, court, status, venue, day, hour, price, verification, payload);

-- Les fonctions -------------------------------------------------------------------------------
-- Lecture du document comme un tableau de lignes, pour les assertions.
create function pg_temp.hearings(p_days integer)
returns table (
  id uuid,
  sale_date timestamptz,
  date_only boolean,
  property_type text,
  city text,
  department text,
  tribunal_code text,
  tribunal_name text,
  tribunal_city text,
  starting_price_eur numeric,
  source_group uuid
)
language sql
stable
as $$
  select h.*
  from jsonb_to_recordset(public.get_public_upcoming_hearings(p_days) -> 'hearings') as h(
    id uuid,
    sale_date timestamptz,
    date_only boolean,
    property_type text,
    city text,
    department text,
    tribunal_code text,
    tribunal_name text,
    tribunal_city text,
    starting_price_eur numeric,
    source_group uuid
  );
$$;

select has_function(
  'public', 'get_public_upcoming_hearings', array['integer'],
  'the upcoming hearings RPC exists'
);
select ok(
  not has_function_privilege('anon', 'public.get_public_upcoming_hearings(integer)', 'execute')
  and not has_function_privilege('authenticated', 'public.get_public_upcoming_hearings(integer)', 'execute')
  and has_function_privilege('service_role', 'public.get_public_upcoming_hearings(integer)', 'execute'),
  'only the server (service role) reads the upcoming hearings: no execute for anon or authenticated'
);
select ok(
  not has_function_privilege('anon', 'app_private.get_public_upcoming_hearings(integer)', 'execute')
  and not has_function_privilege('authenticated', 'app_private.get_public_upcoming_hearings(integer)', 'execute')
  and has_function_privilege('service_role', 'app_private.get_public_upcoming_hearings(integer)', 'execute'),
  'the private function is closed to the browser roles too'
);
select ok(
  (select prosecdef from pg_proc where oid = 'app_private.get_public_upcoming_hearings(integer)'::regprocedure)
  and (select coalesce(proconfig::text, '') like '%search_path=%'
         from pg_proc where oid = 'app_private.get_public_upcoming_hearings(integer)'::regprocedure),
  'the read is a security definer function with a fixed search_path'
);
select ok(
  not (select prosecdef from pg_proc where oid = 'public.get_public_upcoming_hearings(integer)'::regprocedure),
  'the public wrapper is security invoker'
);
select is(
  pg_get_function_result('public.get_public_upcoming_hearings(integer)'::regprocedure),
  'jsonb',
  'the contract is one document, so no row limit applies'
);

-- Le contrat -----------------------------------------------------------------------------------
select is(
  (select array_agg(k.name order by k.name)
     from jsonb_object_keys(public.get_public_upcoming_hearings(30) -> 'hearings' -> 0) as k(name)),
  array[
    'city', 'date_only', 'department', 'id', 'property_type', 'sale_date', 'source_group',
    'starting_price_eur', 'tribunal_city', 'tribunal_code', 'tribunal_name'
  ]::text[],
  'a hearing carries the public card of a sale and a source group id: no address, no source link, no key'
);
select is(
  (select pg_get_functiondef('app_private.get_public_upcoming_hearings(integer)'::regprocedure)
          ~ '\.(address|latitude|longitude|lawyer_contact|documents|visit_dates|description|raw_text)\b'),
  false,
  'address, coordinates, contacts, documents, visit text and the announcement text stay out'
);
select is(
  (select position('source_url' in public.get_public_upcoming_hearings(60)::text)),
  0,
  'neither source_url nor source_urls comes out'
);
select is(
  (select position('example.test' in public.get_public_upcoming_hearings(60)::text)),
  0,
  'and no source address comes out'
);

-- Le comportement ------------------------------------------------------------------------------
select is(
  (select array_agg(id order by sale_date, id) from pg_temp.hearings(30)),
  array[
    'c4960000-1000-4000-8000-000000000001',
    'c4960000-1000-4000-8000-000000000002',
    'c4960000-1000-4000-8000-000000000005',
    'c4960000-1000-4000-8000-000000000003'
  ]::uuid[],
  'the exportable tribunal hearings of the next 30 days come out, the nearest first'
);
select is(
  (select array_agg(id order by sale_date, id) from pg_temp.hearings(7)),
  array[
    'c4960000-1000-4000-8000-000000000001',
    'c4960000-1000-4000-8000-000000000002',
    'c4960000-1000-4000-8000-000000000005'
  ]::uuid[],
  'the 7-day window leaves the hearing of day 20 out'
);
select is(
  (select count(*) from pg_temp.hearings(null)),
  4::bigint,
  'a null window falls back to 30 days'
);
select is(
  (select count(*) from pg_temp.hearings(0)),
  0::bigint,
  'a window below 1 day is raised to 1 day (nothing falls in today or tomorrow)'
);
select is(
  (select count(*) from pg_temp.hearings(1000)),
  4::bigint,
  'a window above 60 days is cut to 60 days (the hearing of day 90 stays out)'
);
select is(
  (select array_agg(date_only order by id)
     from pg_temp.hearings(30)
    where id in ('c4960000-1000-4000-8000-000000000001', 'c4960000-1000-4000-8000-000000000005')),
  array[false, true],
  'a timed hearing is not day-only; a midnight date (hour unknown) is day-only'
);
select is(
  (select row(starting_price_eur, tribunal_code, city)::text
     from pg_temp.hearings(30)
    where id = 'c4960000-1000-4000-8000-000000000001'),
  '(100000,c496-tj-x,Xenonville)',
  'the price, the court code and the commune come out'
);
select is(
  (select array_agg(source_group order by id) from pg_temp.hearings(30)
    where id in ('c4960000-1000-4000-8000-000000000001', 'c4960000-1000-4000-8000-000000000002')),
  array['c4960000-1000-4000-8000-000000000001', 'c4960000-1000-4000-8000-000000000002']::uuid[],
  'two sales without a source address in common are each their own group'
);
select is(
  (select count(*) from pg_temp.hearings(60)
    where id in (
      'c4960000-1000-4000-8000-000000000004',
      'c4960000-1000-4000-8000-000000000006',
      'c4960000-1000-4000-8000-000000000007',
      'c4960000-1000-4000-8000-000000000008',
      'c4960000-1000-4000-8000-000000000009'
    )),
  0::bigint,
  'a postponed, notary, rejected-date, out-of-window or conflicting sale is never listed'
);
select is(
  (public.get_public_upcoming_hearings(30) ->> 'total_count')::bigint,
  4::bigint,
  'total_count is the number of hearings of the window'
);

-- Un visiteur sans compte, un compte connecté : plus d'accès --------------------------------------------
set local role anon;
select throws_ok(
  $$select public.get_public_upcoming_hearings(30)$$,
  '42501', null, 'a signed-out visitor can no longer call the function (the page reads it server-side)'
);
reset role;
set local role authenticated;
select throws_ok(
  $$select public.get_public_upcoming_hearings(30)$$,
  '42501', null, 'a signed-in account cannot call it either'
);
reset role;
set local role service_role;
select is(
  jsonb_array_length(public.get_public_upcoming_hearings(30) -> 'hearings'),
  4,
  'the server (service role) reads the upcoming hearings'
);
reset role;

select * from finish();
rollback;
