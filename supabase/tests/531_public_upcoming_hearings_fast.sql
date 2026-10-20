-- Non-régression de la page /audiences-a-venir (20261029100100) :
--   * la réécriture en SQL ensembliste rend exactement ce que get_public_sale_calendar_event, la règle
--     d'origine, déclare exportable (même ensemble d'audiences, même date, même « heure inconnue »),
--     sur des ventes qui exercent chacune de ses règles (statut brut, précision de date, date sans heure,
--     conflit de sources sur la date, calendrier source, drapeau de qualité, fenêtre de vente en ligne,
--     quarantaine, conflit de vérification, audience déjà passée aujourd'hui) ;
--   * aucune adresse source ne sort, ni clé dérivée d'une adresse : seulement un identifiant de groupe
--     (source_group, migration 20261031100100) ;
--   * normalize_source_url suit les règles de l'ancien normalizeSourceUrl ;
--   * plus de troncature à 1 000 audiences : un document de plus de 1 000 lignes sort entier.
begin;

select plan(13);

-- Fixtures -------------------------------------------------------------------------------------
insert into public.tribunals (code, canonical_name, department, city)
values ('c531-tj', 'TJ C531 Argon', '33', 'Argon');

-- n : numéro ; day : jours à partir d'aujourd'hui (Paris) ; hour : heure, null pour minuit (heure
-- inconnue) ; raw : raw_payload ; flags : quality_flags ; proc : sale_procedure ; verif : statut de
-- vérification ; urls : source_urls.
--   1  : audience ordinaire (exportable, heure connue)
--   2  : statut brut « reportée » dans raw_payload (écartée)
--   3  : précision de date « day » (exportable, heure inconnue)
--   4  : date brute sans heure (exportable, heure inconnue)
--   5  : date brute avec heure (exportable, heure connue)
--   6  : conflit de sources sur la date (écartée)
--   7  : conflit de sources sur un autre champ (exportable)
--   8  : calendrier source (écartée)
--   9  : drapeau de qualité date_conflict (écartée)
--   10 : fenêtre de vente en ligne (écartée)
--   11 : mise en quarantaine de publication (écartée)
--   13 : minuit à Paris aujourd'hui, précision « day » (exportable, jour entier). Sans précision dans
--        raw_payload, une date à minuit est un instant passé : l'échéance du catalogue (matérialisée par
--        sale_catalogue_expiry, 20261003130000) la fait sortir dès minuit, pour la règle d'origine comme
--        pour la réécriture. Seule une date de jour (précision, ou date brute sans heure) reste visible
--        toute la journée.
--   14 : audience d'il y a trois heures (écartée : passée)
--   15 : conflit de vérification (écartée)
--   17 : plusieurs adresses sources (clés)
insert into public.auction_sales (
  id, source_name, source_url, source_urls, title, address, city, department, property_type,
  starting_price_eur, sale_date, app_surface_m2, app_surface_kind,
  rooms_count, bedrooms_count, bathrooms_count, status, latitude, longitude,
  sale_venue_type, sale_verification_status, raw_payload, quality_flags, sale_procedure,
  tribunal_code
)
select
  ('c5310000-1000-4000-8000-' || lpad(f.n::text, 12, '0'))::uuid,
  'c531-test', coalesce(f.url, 'https://example.test/c531/' || f.n), f.urls,
  'Hearing title ' || f.n, 'Adresse privée ' || f.n, 'Argonville', '33', 'house',
  100000 + f.n,
  case
    when f.n = 14 then now() - interval '3 hours'
    else (
      date_trunc('day', now() at time zone 'Europe/Paris')
      + f.day * interval '1 day' + coalesce(f.hour, 0) * interval '1 hour'
    ) at time zone 'Europe/Paris'
  end,
  80, 'habitable', 3, 2, 1, 'upcoming', 44.837812, -0.579234,
  'tribunal', f.verif, f.raw, f.flags, f.proc, 'c531-tj'
from (
  values
    (1, 3, 10, '{}'::jsonb, '[]'::jsonb, '{}'::jsonb, 'pending', null::text, null::jsonb),
    (2, 3, 10, '{"status": "Reportée"}'::jsonb, '[]'::jsonb, '{}'::jsonb, 'pending', null, null),
    (3, 4, 10, '{"date_precision": "day"}'::jsonb, '[]'::jsonb, '{}'::jsonb, 'pending', null, null),
    (4, 5, 10, '{"sale_date": "2026-11-01"}'::jsonb, '[]'::jsonb, '{}'::jsonb, 'pending', null, null),
    (5, 6, 14, '{"sale_date": "1 novembre 2026 à 14h30"}'::jsonb, '[]'::jsonb, '{}'::jsonb, 'pending', null, null),
    (6, 7, 10, '{"source_conflicts": [{"field": "sale_date"}]}'::jsonb, '[]'::jsonb, '{}'::jsonb, 'pending', null, null),
    (7, 8, 10, '{"source_conflicts": [{"field": "starting_price_eur"}]}'::jsonb, '[]'::jsonb, '{}'::jsonb, 'pending', null, null),
    (8, 9, 10, '{"source_sale_schedule": {"opens_at": "2099-01-01T09:00:00Z", "closes_at": "2099-01-02T09:00:00Z"}}'::jsonb, '[]'::jsonb, '{}'::jsonb, 'pending', null, null),
    (9, 10, 10, '{}'::jsonb, '["date_conflict"]'::jsonb, '{}'::jsonb, 'pending', null, null),
    (10, 11, 10, '{}'::jsonb, '[]'::jsonb, '{"sale_window": {"opens_at": "2099-01-01T09:00:00Z", "closes_at": "2099-01-02T09:00:00Z"}}'::jsonb, 'pending', null, null),
    (11, 12, 10, '{"publication_quarantine": "c531"}'::jsonb, '[]'::jsonb, '{}'::jsonb, 'pending', null, null),
    (13, 0, null, '{"date_precision": "day"}'::jsonb, '[]'::jsonb, '{}'::jsonb, 'pending', null, null),
    (14, 0, 0, '{}'::jsonb, '[]'::jsonb, '{}'::jsonb, 'pending', null, null),
    (15, 13, 10, '{}'::jsonb, '[]'::jsonb, '{}'::jsonb, 'conflict', null, null),
    (
      17, 14, 9, '{}'::jsonb, '[]'::jsonb, '{}'::jsonb, 'pending',
      'https://www.licitor.com/annonce/9/vente.html',
      '["https://www.licitor.com/annonce/9/vente.html", "http://licitor.com/annonce/10/", 5, null, {"u": 1}, "pas une adresse"]'::jsonb
    )
) as f(n, day, hour, raw, flags, proc, verif, url, urls);

-- Lecture du document comme un tableau de lignes.
create function pg_temp.hearings(p_days integer)
returns table (
  id uuid,
  sale_date timestamptz,
  date_only boolean,
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
    source_group uuid
  )
  where h.id::text like 'c5310000-%';
$$;

-- La règle d'origine : get_public_sale_calendar_event, dans la même fenêtre (aujourd'hui + 30 jours).
create temporary table oracle_531 on commit drop as
select s.id, e.sale_date, e.date_only
from public.auction_sales s
cross join lateral app_private.get_public_sale_calendar_event(s.id) e
where s.source_name = 'c531-test'
  and e.exportable
  and (e.sale_date at time zone 'Europe/Paris')::date
        between (now() at time zone 'Europe/Paris')::date
            and (now() at time zone 'Europe/Paris')::date + 30;

-- Équivalence avec la règle d'origine ----------------------------------------------------------------
select is(
  (select array_agg(id order by id) from pg_temp.hearings(30)),
  (select array_agg(id order by id) from oracle_531),
  'the set-based read lists exactly the hearings the calendar export rule declares exportable'
);
select is(
  (select count(*)
     from pg_temp.hearings(30) h
     join oracle_531 o using (id)
    where h.sale_date is distinct from o.sale_date or h.date_only is distinct from o.date_only),
  0::bigint,
  'and gives them the same date and the same day-only flag'
);
select is(
  (select array_agg(n order by n)
     from pg_temp.hearings(30) h
     cross join lateral (select right(h.id::text, 12)::integer as n) x),
  array[1, 3, 4, 5, 7, 13, 17],
  'the expected hearings are the ordinary one, the day-only ones, the timed raw date, the unrelated conflict, today at midnight and the multi-source one'
);
select is(
  (select array_agg(date_only order by id) from pg_temp.hearings(30)),
  array[false, true, true, false, false, true, false],
  'the hour is unknown only for the day precision, the raw date without hour and the midnight date'
);

-- Identifiant de groupe --------------------------------------------------------------------------------
select is(
  (select source_group from pg_temp.hearings(30) where id = 'c5310000-1000-4000-8000-000000000001'),
  'c5310000-1000-4000-8000-000000000001'::uuid,
  'a sale that shares no source address is its own group'
);
select is(
  (select source_group from pg_temp.hearings(30) where id = 'c5310000-1000-4000-8000-000000000017'),
  'c5310000-1000-4000-8000-000000000017'::uuid,
  'a sale with several source addresses, none shared, is its own group'
);

-- normalize_source_url -----------------------------------------------------------------------------------
select is(
  (select array_agg(distinct app_private.normalize_source_url(u))
     from unnest(array[
       'https://www.licitor.com/annonce/1/2/vente.html',
       'http://licitor.com/annonce/1/2/vente.html/',
       'LICITOR.com/annonce/1/2/vente.html?x=1#y'
     ]) as u),
  array['licitor.com/annonce/1/2/vente.html'],
  'the spellings of one announcement share one key'
);
select isnt(
  app_private.normalize_source_url('https://licitor.com/annonce/1'),
  app_private.normalize_source_url('https://licitor.com/annonce/2'),
  'two announcements keep two keys'
);
select ok(
  app_private.normalize_source_url(null) is null
  and app_private.normalize_source_url('   ') is null
  and app_private.normalize_source_url('pas une adresse') is null,
  'a null, blank or non-address value has no key'
);
select is(
  app_private.normalize_source_url('https://user:pw@www.Example.com:8080/a/b/?q=1#h'),
  'example.com/a/b',
  'the credentials, the port, www., the query, the anchor and the final slash are dropped'
);
select ok(
  not has_function_privilege('anon', 'app_private.normalize_source_url(text)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'app_private.normalize_source_url(text)', 'EXECUTE')
  and has_function_privilege('service_role', 'app_private.normalize_source_url(text)', 'EXECUTE'),
  'the key function is closed to the browser roles'
);

-- Plus de troncature à 1 000 audiences ----------------------------------------------------------------------
insert into public.auction_sales (
  id, source_name, source_url, title, address, city, department, property_type,
  starting_price_eur, sale_date, app_surface_m2, app_surface_kind,
  rooms_count, bedrooms_count, bathrooms_count, status, latitude, longitude,
  sale_venue_type, sale_verification_status, raw_payload, tribunal_code
)
select
  ('c5310000-2000-4000-8000-' || lpad(g::text, 12, '0'))::uuid,
  'c531-bulk', 'https://example.test/c531/bulk/' || g,
  'Bulk hearing ' || g, 'Adresse privée bulk ' || g, 'Argonville', '33', 'house',
  50000 + g,
  (
    date_trunc('day', now() at time zone 'Europe/Paris') + interval '5 days' + interval '11 hours'
  ) at time zone 'Europe/Paris',
  80, 'habitable', 3, 2, 1, 'upcoming', 44.837812, -0.579234,
  'tribunal', 'pending', '{}'::jsonb, 'c531-tj'
from generate_series(1, 1001) as g;

select cmp_ok(
  jsonb_array_length(public.get_public_upcoming_hearings(30) -> 'hearings'),
  '>',
  1000,
  'a window of more than 1 000 hearings is not cut at 1 000'
);
select is(
  jsonb_array_length(public.get_public_upcoming_hearings(30) -> 'hearings')::bigint,
  (public.get_public_upcoming_hearings(30) ->> 'total_count')::bigint,
  'every hearing of the window is in the document: nothing is truncated'
);

select * from finish();
rollback;
