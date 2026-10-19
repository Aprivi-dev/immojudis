-- Copie des photos : la requête de sélection du pipeline (CANDIDATES_SQL, services/data-pipeline/src/photo_mirror.py)
-- s'exécute sur le schéma migré. Le texte ci-dessous est celui de CANDIDATES_SQL, ses « %s » remplacés par $1 à $6
-- (le test Python tests/test_photo_mirror_candidates_contract.py compare les deux et les paramètres).
begin;

select plan(8);

-- Fixtures -------------------------------------------------------------------------------------
-- 1 : à copier. 2 : déjà copiée. 3 : échec ancien (à retenter). 4 : échecs épuisés. 5 : échec récent.
-- 6 : en quarantaine. 7 : terminée. 8 : photo hébergée par Enchères Publiques. 9 : source Enchères Publiques.
-- 10 : sans photo. 11 : date dépassée.
insert into public.auction_sales (id, source_name, source_url, title, status, sale_date, raw_payload)
select
  ('c4780000-1000-4000-8000-' || lpad(i::text, 12, '0'))::uuid,
  case when i = 9 then 'Encheres Publiques' else 'photo-candidates-test' end,
  'https://example.test/photo-candidates/' || i,
  'Photo candidates ' || i,
  case when i = 7 then 'past' else 'upcoming' end,
  case when i = 11 then now() - interval '30 days' else '2099-01-01 12:00:00Z'::timestamptz end,
  case
    when i = 10 then '{}'::jsonb
    when i = 6 then jsonb_build_object('raw_image_url', 'https://photos.example.test/' || i || '.jpg',
                                       'publication_quarantine', 'test')
    when i = 8 then jsonb_build_object('raw_image_url', 'https://www.encheres-publiques.com/photos/8.jpg')
    else jsonb_build_object('raw_image_url', 'https://photos.example.test/' || i || '.jpg')
  end
from generate_series(1, 11) i;

insert into public.sale_photos (sale_id, source_url, source_host, status, attempts, last_attempt_at, sha256, path_640, path_1600)
values
  ('c4780000-1000-4000-8000-000000000002', 'https://photos.example.test/2.jpg', 'photos.example.test',
   'stored', 1, now(), 'abc', 'p/2-640.webp', 'p/2-1600.webp'),
  ('c4780000-1000-4000-8000-000000000003', 'https://photos.example.test/3.jpg', 'photos.example.test',
   'failed', 1, now() - interval '2 days', null, null, null),
  ('c4780000-1000-4000-8000-000000000004', 'https://photos.example.test/4.jpg', 'photos.example.test',
   'failed', 3, now() - interval '2 days', null, null, null),
  ('c4780000-1000-4000-8000-000000000005', 'https://photos.example.test/5.jpg', 'photos.example.test',
   'failed', 1, now(), null, null, null);

-- La requête, telle que le pipeline l'envoie -------------------------------------------------------------
select lives_ok(
  $q$prepare photo_mirror_candidates (integer, integer, boolean, text, boolean, integer) as
select s.id, s.source_name, s.observations, s.catalogue_thumbnail_url, coalesce(p.attempts, 0), s.source_url
  from public.auction_sales s
  left join public.sale_photos p
    on p.sale_id = s.id and p.source_url = s.catalogue_thumbnail_url
 where s.catalogue_thumbnail_url is not null
   and coalesce(s.status, 'unknown') in ('upcoming', 'unknown', 'postponed')
   and not s.catalogue_quarantined
   and app_private.sale_catalogue_projection_is_live(
         s.catalogue_expiry_materialized, s.catalogue_expiry_deadline, s.sale_date,
         s.catalogue_expiry_fallback, s.catalogue_state_observed_at, s.catalogue_state_end_estimate)
   and (
         p.id is null
         or (
              p.status = 'failed'
              and p.attempts < $1
              and (p.last_attempt_at is null or p.last_attempt_at < now() - make_interval(hours => $2::int))
            )
       )
   and ($3 or s.catalogue_thumbnail_url !~* $4)
   and (
         $5
         or replace(replace(lower(btrim(coalesce(s.source_name, ''))), '-', '_'), ' ', '_')
            <> 'encheres_publiques'
       )
 order by (s.sale_date is null), s.sale_date, s.id
 limit $6$q$,
  'CANDIDATES_SQL is valid on the migrated schema (columns, functions and types exist)'
);

-- Paramètres : MAX_ATTEMPTS = 3, RETRY_AFTER_HOURS = 12, motif ENCHERES_PUBLIQUES_URL_PATTERN.
create temporary table pgtap_478_closed on commit drop as
  execute photo_mirror_candidates(
    3, 12, false, '^https?://([^/?#]*\.)?encheres-publiques\.com([:/?#]|$)', false, 100
  );
create temporary table pgtap_478_open on commit drop as
  execute photo_mirror_candidates(
    3, 12, true, '^https?://([^/?#]*\.)?encheres-publiques\.com([:/?#]|$)', true, 100
  );
create temporary table pgtap_478_limited on commit drop as
  execute photo_mirror_candidates(
    3, 12, false, '^https?://([^/?#]*\.)?encheres-publiques\.com([:/?#]|$)', false, 1
  );

select is(
  (select count(*) from information_schema.columns
    where table_schema like 'pg_temp%' and table_name = 'pgtap_478_closed'),
  6::bigint,
  'six columns come back, in the order the pipeline reads them'
);
select is(
  (select array_agg(right(id::text, 2) order by id) from pgtap_478_closed),
  array['01', '03'],
  'selected: a sale with no copy yet and a failed attempt old enough to be retried'
);
select is(
  (select count(*) from pgtap_478_closed
    where right(id::text, 2) in ('02', '04', '05', '06', '07', '08', '09', '10', '11')),
  0::bigint,
  'not selected: already copied, attempts exhausted, retried too soon, quarantined, ended, closed source, no photo, past date'
);
select is(
  (select array_agg(right(id::text, 2) order by id) from pgtap_478_open),
  array['01', '03', '08', '09'],
  'with Encheres Publiques authorized, its photo host and its source come back'
);
select is(
  (select right(id::text, 2) from pgtap_478_limited),
  '01',
  'the limit applies, earliest sale first'
);
select is(
  (select bool_and(catalogue_thumbnail_url ~ '^https://photos\.example\.test/[0-9]+\.jpg$') from pgtap_478_closed),
  true,
  'the photo URL column is the materialized thumbnail'
);
select is(
  (select string_agg(right(id::text, 2) || ':' || "coalesce", ',' order by id) from pgtap_478_closed),
  '01:0,03:1',
  'the attempts column is 0 for a sale with no photo row yet, and the previous count for a retry'
);

select * from finish();
rollback;
