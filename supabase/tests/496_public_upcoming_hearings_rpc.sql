-- Page /audiences-a-venir (migration 20261028150100) : les audiences des prochains jours.
--   * la fonction publique est accessible sans compte, la fonction privée est SECURITY DEFINER à
--     search_path fixé, l'enveloppe publique est SECURITY INVOKER ;
--   * la règle de « date sourcée » est celle de l'export agenda (get_public_sale_calendar_event),
--     appelée par la fonction et non recopiée ;
--   * aucun champ privé (adresse, coordonnées, contacts, documents) ne sort ;
--   * seules les audiences exportables de la fenêtre sont rendues : ni vente reportée, ni date
--     rejetée ou en conflit, ni vente chez un notaire, ni date hors fenêtre ;
--   * la fenêtre est bornée à 1..60 jours ; l'identifiant, source_url et source_urls (publics) sortent
--     pour que la page ne fusionne que sur une identité certaine (20261028160100) : le prix et le
--     tribunal ne suffisent plus.
begin;

select plan(18);

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
select has_function(
  'public', 'get_public_upcoming_hearings', array['integer'],
  'the public upcoming hearings RPC exists'
);
select ok(
  has_function_privilege('anon', 'public.get_public_upcoming_hearings(integer)', 'execute')
  and has_function_privilege('authenticated', 'public.get_public_upcoming_hearings(integer)', 'execute'),
  'signed-out visitors and accounts may read the upcoming hearings'
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
  'TABLE(id uuid, sale_date timestamp with time zone, date_only boolean, property_type text, city text, department text, tribunal_code text, tribunal_name text, tribunal_city text, starting_price_eur numeric, source_url text, source_urls jsonb, total_count bigint)',
  'the contract is the public card of a sale: commune, type, court, date, price, source links'
);

-- Le contrat -----------------------------------------------------------------------------------
select is(
  (select pg_get_functiondef('app_private.get_public_upcoming_hearings(integer)'::regprocedure)
          ~ 's\.(address|latitude|longitude|lawyer_contact|documents|visit_dates|raw_payload|description|raw_text)\b'),
  false,
  'address, coordinates, contacts, documents, visit text and the raw announcement stay out'
);
select is(
  (select pg_get_functiondef('app_private.get_public_upcoming_hearings(integer)'::regprocedure)
          ~ 'get_public_sale_calendar_event\(s\.id\)'
      and pg_get_functiondef('app_private.get_public_upcoming_hearings(integer)'::regprocedure)
          ~ 'e\.exportable'),
  true,
  'a hearing is listed only when the calendar export rule declares it exportable'
);

-- Le comportement ------------------------------------------------------------------------------
select is(
  (select array_agg(id order by sale_date, id) from public.get_public_upcoming_hearings(30)),
  array[
    'c4960000-1000-4000-8000-000000000001',
    'c4960000-1000-4000-8000-000000000002',
    'c4960000-1000-4000-8000-000000000005',
    'c4960000-1000-4000-8000-000000000003'
  ]::uuid[],
  'the exportable tribunal hearings of the next 30 days come out, the nearest first'
);
select is(
  (select array_agg(id order by sale_date, id) from public.get_public_upcoming_hearings(7)),
  array[
    'c4960000-1000-4000-8000-000000000001',
    'c4960000-1000-4000-8000-000000000002',
    'c4960000-1000-4000-8000-000000000005'
  ]::uuid[],
  'the 7-day window leaves the hearing of day 20 out'
);
select is(
  (select count(*) from public.get_public_upcoming_hearings(null)),
  4::bigint,
  'a null window falls back to 30 days'
);
select is(
  (select count(*) from public.get_public_upcoming_hearings(0)),
  0::bigint,
  'a window below 1 day is raised to 1 day (nothing falls in today or tomorrow)'
);
select is(
  (select count(*) from public.get_public_upcoming_hearings(1000)),
  4::bigint,
  'a window above 60 days is cut to 60 days (the hearing of day 90 stays out)'
);
select is(
  (select array_agg(date_only order by id)
     from public.get_public_upcoming_hearings(30)
    where id in ('c4960000-1000-4000-8000-000000000001', 'c4960000-1000-4000-8000-000000000005')),
  array[false, true],
  'a timed hearing is not day-only; a midnight date (hour unknown) is day-only'
);
select is(
  (select row(starting_price_eur, tribunal_code, city)::text
     from public.get_public_upcoming_hearings(30)
    where id = 'c4960000-1000-4000-8000-000000000001'),
  '(100000,c496-tj-x,Xenonville)',
  'the price, the court code and the commune come out'
);
select is(
  (select source_url from public.get_public_upcoming_hearings(30)
    where id = 'c4960000-1000-4000-8000-000000000001'),
  'https://example.test/c496/1',
  'the source link comes out, so the page merges two lines only on a shared source'
);
select is(
  (select count(*) from public.get_public_upcoming_hearings(60)
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
  (select min(total_count) || '/' || max(total_count) from public.get_public_upcoming_hearings(30)),
  '4/4',
  'total_count is the number of hearings of the window'
);

-- Un visiteur sans compte ----------------------------------------------------------------------
set local role anon;
select is(
  (select count(*) from public.get_public_upcoming_hearings(30)),
  4::bigint,
  'a signed-out visitor reads the upcoming hearings'
);
reset role;

select * from finish();
rollback;
