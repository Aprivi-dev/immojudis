-- Photos des pièces jointes (20261111030013_sale_document_photos.sql, 20261111030117_sale_document_photos_gallery.sql) :
-- tables fermées aux rôles du navigateur, fichiers mis en file de purge à la suppression, galerie, et requête de
-- sélection du pipeline (CANDIDATES_SQL de services/data-pipeline/src/pdf_photos.py, ses « %s » remplacés par
-- $1 à $9 ; tests/test_pdf_photos.py compare le texte et les paramètres).
begin;

select plan(29);

-- RLS et droits ----------------------------------------------------------------------------------
select ok(
  (select relrowsecurity from pg_class where oid = 'public.sale_document_photos'::regclass)
  and (select relrowsecurity from pg_class where oid = 'public.sale_document_photo_scans'::regclass),
  'RLS is enabled on both tables'
);
select ok(
  not has_table_privilege('anon', 'public.sale_document_photos', 'select')
  and not has_table_privilege('anon', 'public.sale_document_photos', 'insert')
  and not has_table_privilege('anon', 'public.sale_document_photos', 'update')
  and not has_table_privilege('anon', 'public.sale_document_photos', 'delete')
  and not has_table_privilege('anon', 'public.sale_document_photo_scans', 'select'),
  'anon has no right on the document photos'
);
select ok(
  not has_table_privilege('authenticated', 'public.sale_document_photos', 'select')
  and not has_table_privilege('authenticated', 'public.sale_document_photos', 'insert')
  and not has_table_privilege('authenticated', 'public.sale_document_photos', 'update')
  and not has_table_privilege('authenticated', 'public.sale_document_photos', 'delete')
  and not has_table_privilege('authenticated', 'public.sale_document_photo_scans', 'select'),
  'authenticated has no right on the document photos'
);
select ok(
  has_table_privilege('service_role', 'public.sale_document_photos', 'insert')
  and has_table_privilege('service_role', 'public.sale_document_photos', 'delete')
  and has_table_privilege('service_role', 'public.sale_document_photo_scans', 'insert')
  and has_table_privilege('service_role', 'public.sale_document_photo_scans', 'update'),
  'the pipeline (service_role) writes both tables'
);
select is(
  (select count(*) from pg_policies
    where schemaname = 'public' and tablename in ('sale_document_photos', 'sale_document_photo_scans')),
  0::bigint,
  'no policy opens the tables to a browser role'
);
select ok(
  not has_function_privilege('anon', 'app_private.enqueue_sale_document_photo_files_for_deletion()', 'execute')
  and not has_function_privilege('authenticated', 'app_private.enqueue_sale_document_photo_files_for_deletion()', 'execute'),
  'the purge trigger function is not callable by the browser roles'
);
select ok(
  (select prosecdef and proconfig @> array['search_path=""'] from pg_proc
    where oid = 'app_private.sale_document_photo_media(jsonb,uuid)'::regprocedure)
  and not has_function_privilege('anon', 'app_private.sale_document_photo_media(jsonb,uuid)', 'execute')
  and has_function_privilege('authenticated', 'app_private.sale_document_photo_media(jsonb,uuid)', 'execute')
  and has_function_privilege('service_role', 'app_private.sale_document_photo_media(jsonb,uuid)', 'execute'),
  'the gallery reader is SECURITY DEFINER with an empty search_path, granted to authenticated and service_role only'
);
select ok(
  pg_get_viewdef('public.v_auction_sales_app'::regclass, true) ~ 'app_private\.sale_document_photo_media\(COALESCE\(m\.media'
  and pg_get_viewdef('public.v_auction_sales_discovery'::regclass, true) ~ 'app_private\.sale_document_photo_media\(COALESCE\(m\.media'
  and pg_get_viewdef('public.v_auction_sales_unlocked'::regclass, true) ~ 'app_private\.sale_document_photo_media\(COALESCE\(m\.media',
  'the three sale views append the document photos to their media'
);
select ok(
  (select reloptions @> array['security_barrier=true'] from pg_class where oid = 'public.v_auction_sales_discovery'::regclass)
  and (select reloptions @> array['security_barrier=true'] from pg_class where oid = 'public.v_auction_sales_unlocked'::regclass),
  'the rewritten views keep their options'
);

-- Données ----------------------------------------------------------------------------------------
-- Ventes 1 à 12 pour la sélection (voir plus bas) ; la vente 1 sert aussi à la galerie et à la purge.
insert into public.auction_sales (id, source_name, source_url, title, status, sale_date, raw_payload)
select
  ('c8690000-1000-4000-8000-' || lpad(i::text, 12, '0'))::uuid,
  case when i = 8 then 'Encheres Publiques' else 'pdf-photos-test' end,
  'https://example.test/pdf-photos/' || i,
  'PDF photos ' || i,
  case when i = 7 then 'past' else 'upcoming' end,
  case when i = 12 then now() + interval '2 days' else '2099-01-01 12:00:00Z'::timestamptz + make_interval(days => i) end,
  case
    when i = 6 then '{"publication_quarantine": "test"}'::jsonb
    when i = 1 then '{"raw_image_url": "https://photos.example.test/1.jpg"}'::jsonb
    else '{}'::jsonb
  end
from generate_series(1, 12) i;

insert into public.auction_documents (source_url, document_url, label, document_type)
values
  ('https://example.test/pdf-photos/1', 'https://example.test/pdf-photos/1/cahier.pdf', 'Cahier des charges', 'cahier_conditions_vente'),
  ('https://example.test/pdf-photos/1', 'https://example.test/pdf-photos/1/pv.pdf', 'PV descriptif', 'pv_huissier'),
  ('https://example.test/pdf-photos/2', 'https://example.test/pdf-photos/2/cahier.pdf', 'Cahier des charges', 'cahier_conditions_vente'),
  ('https://example.test/pdf-photos/3', 'https://example.test/pdf-photos/3/pv.pdf', 'PV descriptif', 'pv_huissier'),
  ('https://example.test/pdf-photos/4', 'https://example.test/pdf-photos/4/pv.pdf', 'PV descriptif', 'pv_huissier'),
  ('https://example.test/pdf-photos/5', 'https://example.test/pdf-photos/5/dpe.pdf', 'Diagnostics', 'diagnostics_techniques'),
  ('https://example.test/pdf-photos/6', 'https://example.test/pdf-photos/6/pv.pdf', 'PV descriptif', 'pv_huissier'),
  ('https://example.test/pdf-photos/7', 'https://example.test/pdf-photos/7/pv.pdf', 'PV descriptif', 'pv_huissier'),
  ('https://example.test/pdf-photos/8', 'https://example.test/pdf-photos/8/pv.pdf', 'PV descriptif', 'pv_huissier'),
  ('https://example.test/pdf-photos/9', 'https://www.encheres-publiques.com/documents/9/pv.pdf', 'PV descriptif', 'pv_huissier'),
  ('https://example.test/pdf-photos/10', 'https://example.test/pdf-photos/10/pv.pdf', 'PV descriptif', 'pv_huissier'),
  ('https://example.test/pdf-photos/12', 'https://example.test/pdf-photos/12/cahier.pdf', 'Cahier des charges', 'cahier_conditions_vente');

-- 2 : déjà lu. 3 : échec ancien (à retenter). 4 : échecs épuisés.
insert into public.sale_document_photo_scans (sale_id, document_url, status, attempts, last_attempt_at)
values
  ('c8690000-1000-4000-8000-000000000002', 'https://example.test/pdf-photos/2/cahier.pdf', 'done', 1, now()),
  ('c8690000-1000-4000-8000-000000000003', 'https://example.test/pdf-photos/3/pv.pdf', 'failed', 1, now() - interval '2 days'),
  ('c8690000-1000-4000-8000-000000000004', 'https://example.test/pdf-photos/4/pv.pdf', 'failed', 3, now() - interval '2 days');

-- 10 : déjà 12 photos de documents (le plafond).
insert into public.sale_document_photos
  (sale_id, document_url, image_sha256, page_number, position, width, height, path_640, path_1600, public_url)
select
  'c8690000-1000-4000-8000-000000000010',
  'https://example.test/pdf-photos/10/old.pdf',
  repeat(to_hex(i), 64),
  1, i, 1000, 700,
  'documents/c8690000-1000-4000-8000-000000000010/' || repeat(to_hex(i), 16) || '-640.webp',
  'documents/c8690000-1000-4000-8000-000000000010/' || repeat(to_hex(i), 16) || '-1600.webp',
  'https://project.supabase.co/storage/v1/object/public/sale-photos/documents/c8690000-1000-4000-8000-000000000010/'
    || repeat(to_hex(i), 16) || '-1600.webp'
from generate_series(1, 12) i;

-- 1 : deux photos d'un document, une d'un autre, une retirée à la main.
insert into public.sale_document_photos
  (sale_id, document_url, image_sha256, page_number, position, width, height, path_640, path_1600, public_url, status)
values
  ('c8690000-1000-4000-8000-000000000001', 'https://example.test/pdf-photos/1/pv.pdf', repeat('b', 64), 3, 5, 1000, 700,
   'documents/c8690000-1000-4000-8000-000000000001/bbbbbbbbbbbbbbbb-640.webp',
   'documents/c8690000-1000-4000-8000-000000000001/bbbbbbbbbbbbbbbb-1600.webp',
   'https://project.supabase.co/storage/v1/object/public/sale-photos/documents/c8690000-1000-4000-8000-000000000001/bbbbbbbbbbbbbbbb-1600.webp',
   'stored'),
  ('c8690000-1000-4000-8000-000000000001', 'https://example.test/pdf-photos/1/cahier.pdf', repeat('a', 64), 2, 3, 600, 450,
   'documents/c8690000-1000-4000-8000-000000000001/aaaaaaaaaaaaaaaa-640.webp',
   'documents/c8690000-1000-4000-8000-000000000001/aaaaaaaaaaaaaaaa-640.webp',
   'https://project.supabase.co/storage/v1/object/public/sale-photos/documents/c8690000-1000-4000-8000-000000000001/aaaaaaaaaaaaaaaa-640.webp',
   'stored'),
  ('c8690000-1000-4000-8000-000000000001', 'https://example.test/pdf-photos/1/cahier.pdf', repeat('c', 64), 1, 1, 1000, 700,
   'documents/c8690000-1000-4000-8000-000000000001/cccccccccccccccc-640.webp',
   'documents/c8690000-1000-4000-8000-000000000001/cccccccccccccccc-1600.webp',
   'https://project.supabase.co/storage/v1/object/public/sale-photos/documents/c8690000-1000-4000-8000-000000000001/cccccccccccccccc-1600.webp',
   'stored'),
  ('c8690000-1000-4000-8000-000000000001', 'https://example.test/pdf-photos/1/cahier.pdf', repeat('d', 64), 1, 2, 1000, 700,
   'documents/c8690000-1000-4000-8000-000000000001/dddddddddddddddd-640.webp',
   'documents/c8690000-1000-4000-8000-000000000001/dddddddddddddddd-1600.webp',
   'https://project.supabase.co/storage/v1/object/public/sale-photos/documents/c8690000-1000-4000-8000-000000000001/dddddddddddddddd-1600.webp',
   'withdrawn');

select throws_ok(
  $$insert into public.sale_document_photos
      (sale_id, document_url, image_sha256, page_number, position, width, height, path_640, path_1600, public_url)
    values ('c8690000-1000-4000-8000-000000000001', 'https://example.test/pdf-photos/1/pv.pdf', repeat('e', 64), 1, 9,
      1000, 700, 'documents/c8690000-1000-4000-8000-000000000001/eeeeeeeeeeeeeeee-640.webp',
      'documents/c8690000-1000-4000-8000-000000000001/eeeeeeeeeeeeeeee-1600.webp', 'https://elsewhere.example.test/x.webp')$$,
  '23514',
  null,
  'the public URL must be the one of path_1600 in the sale-photos bucket'
);
select throws_ok(
  $$insert into public.sale_document_photos
      (sale_id, document_url, image_sha256, page_number, position, width, height, path_640, path_1600, public_url)
    values ('c8690000-1000-4000-8000-000000000001', 'https://example.test/pdf-photos/1/pv.pdf', repeat('e', 64), 1, 9,
      1000, 700, 'documents/c8690000-1000-4000-8000-000000000002/eeeeeeeeeeeeeeee-640.webp',
      'documents/c8690000-1000-4000-8000-000000000002/eeeeeeeeeeeeeeee-640.webp',
      'https://project.supabase.co/storage/v1/object/public/sale-photos/documents/c8690000-1000-4000-8000-000000000002/eeeeeeeeeeeeeeee-640.webp')$$,
  '23514',
  null,
  'the files of a photo live under the folder of its own sale'
);
select throws_ok(
  $$insert into public.sale_document_photos
      (sale_id, document_url, image_sha256, page_number, position, width, height, path_640, path_1600, public_url)
    values ('c8690000-1000-4000-8000-000000000001', 'https://example.test/pdf-photos/1/other.pdf', repeat('b', 64), 1, 1,
      1000, 700, 'documents/c8690000-1000-4000-8000-000000000001/bbbbbbbbbbbbbbbb-640.webp',
      'documents/c8690000-1000-4000-8000-000000000001/bbbbbbbbbbbbbbbb-1600.webp',
      'https://project.supabase.co/storage/v1/object/public/sale-photos/documents/c8690000-1000-4000-8000-000000000001/bbbbbbbbbbbbbbbb-1600.webp')$$,
  '23505',
  null,
  'one image is kept once per sale, whatever the document'
);

-- Les rôles du navigateur ne lisent pas la table ----------------------------------------------------
set local role anon;
select throws_ok(
  $$select count(*) from public.sale_document_photos$$,
  '42501',
  null,
  'anon cannot select the document photos'
);
reset role;
set local role authenticated;
select throws_ok(
  $$select count(*) from public.sale_document_photo_scans$$,
  '42501',
  null,
  'authenticated cannot select the scans'
);
reset role;

-- Galerie ----------------------------------------------------------------------------------------
select is(
  (select array_agg(item ->> 'url' order by ordinality)
     from jsonb_array_elements(
       app_private.sale_document_photo_media(
         '[{"type": "image", "url": "https://photos.example.test/1.jpg"}]'::jsonb,
         'c8690000-1000-4000-8000-000000000001'
       )
     ) with ordinality as entry(item, ordinality)),
  array[
    'https://photos.example.test/1.jpg',
    'https://project.supabase.co/storage/v1/object/public/sale-photos/documents/c8690000-1000-4000-8000-000000000001/cccccccccccccccc-1600.webp',
    'https://project.supabase.co/storage/v1/object/public/sale-photos/documents/c8690000-1000-4000-8000-000000000001/aaaaaaaaaaaaaaaa-640.webp',
    'https://project.supabase.co/storage/v1/object/public/sale-photos/documents/c8690000-1000-4000-8000-000000000001/bbbbbbbbbbbbbbbb-1600.webp'
  ],
  'document photos come after the source photos, by document then position; a withdrawn one is left out'
);
select is(
  app_private.sale_document_photo_media(
    '[{"type": "image", "url": "https://photos.example.test/1.jpg"}]'::jsonb,
    'c8690000-1000-4000-8000-000000000001'
  ) -> 1,
  jsonb_build_object(
    'type', 'image',
    'url', 'https://project.supabase.co/storage/v1/object/public/sale-photos/documents/c8690000-1000-4000-8000-000000000001/cccccccccccccccc-1600.webp',
    'source', 'Pièce jointe de la vente',
    'mirror', jsonb_build_object(
      'path640', 'documents/c8690000-1000-4000-8000-000000000001/cccccccccccccccc-640.webp',
      'path1600', 'documents/c8690000-1000-4000-8000-000000000001/cccccccccccccccc-1600.webp',
      'width', 1000,
      'height', 700
    )
  ),
  'a document photo carries its public URL and its two hosted sizes'
);
select is(
  jsonb_array_length(app_private.sale_document_photo_media(
    jsonb_build_array(jsonb_build_object('type', 'image', 'url',
      'https://project.supabase.co/storage/v1/object/public/sale-photos/documents/c8690000-1000-4000-8000-000000000001/bbbbbbbbbbbbbbbb-1600.webp')),
    'c8690000-1000-4000-8000-000000000001'
  )),
  3,
  'a URL already in the gallery is not repeated'
);
select is(
  jsonb_array_length(app_private.sale_document_photo_media(null, 'c8690000-1000-4000-8000-000000000010')),
  12,
  'at most 12 document photos are added'
);
select is(
  (select photo_count from app_private.get_public_sale_details('c8690000-1000-4000-8000-000000000001')),
  4,
  'the public page counts the source photo and the three stored document photos'
);

-- Sélection du pipeline ----------------------------------------------------------------------------
select lives_ok(
  $q$prepare pdf_photos_candidates (text[], integer, integer, integer, boolean, text, boolean, integer, text[]) as
with pending as (
  select s.id as sale_id, s.source_name, s.observations, s.source_url as sale_source_url,
         coalesce(s.sale_date, now() + interval '7 days') as due_at,
         d.document_url, d.label, d.document_type, coalesce(scan.attempts, 0) as attempts
    from public.auction_sales s
    join public.auction_documents d on d.source_url = s.source_url
    left join public.sale_document_photo_scans scan
      on scan.sale_id = s.id and scan.document_url = d.document_url
   where coalesce(s.status, 'unknown') in ('upcoming', 'unknown', 'postponed')
     and not s.catalogue_quarantined
     and app_private.sale_catalogue_projection_is_live(
           s.catalogue_expiry_materialized, s.catalogue_expiry_deadline, s.sale_date,
           s.catalogue_expiry_fallback, s.catalogue_state_observed_at, s.catalogue_state_end_estimate)
     and d.document_url ~* '^https?://'
     and d.document_type = any ($1::text[])
     and (
           scan.id is null
           or (
                scan.status = 'failed'
                and scan.attempts < $2
                and (scan.last_attempt_at is null or scan.last_attempt_at < now() - make_interval(hours => $3::int))
              )
         )
     and (
           select count(*) from public.sale_document_photos photo
            where photo.sale_id = s.id and photo.status = 'stored'
         ) < $4
     and ($5 or d.document_url !~* $6)
     and (
           $7
           or replace(replace(lower(btrim(coalesce(s.source_name, ''))), '-', '_'), ' ', '_')
              <> 'encheres_publiques'
         )
),
chosen as (
  select pending.sale_id, min(pending.due_at) as due_at
    from pending
   group by pending.sale_id
   order by min(pending.due_at), pending.sale_id
   limit $8
)
select p.sale_id, p.source_name, p.observations, p.sale_source_url, p.document_url, p.label,
       p.document_type, p.attempts
  from pending p
  join chosen c on c.sale_id = p.sale_id
 order by c.due_at, p.sale_id, array_position($9::text[], p.document_type), p.document_url$q$,
  'CANDIDATES_SQL is valid on the migrated schema (columns, functions and types exist)'
);

-- Paramètres : PHOTO_DOCUMENT_TYPES, MAX_ATTEMPTS = 3, RETRY_AFTER_HOURS = 12, MAX_PHOTOS_PER_SALE = 12,
-- motif ENCHERES_PUBLIQUES_URL_PATTERN. Une table temporaire neuve se relit dans l'ordre d'insertion (ctid) :
-- c'est l'ordre dans lequel le pipeline traite les documents.
create temporary table pgtap_869_closed on commit drop as
  execute pdf_photos_candidates(
    array['pv_huissier', 'cahier_conditions_vente', 'proces_verbal', 'conditions_vente'], 3, 12, 12, false, '^https?://([^/?#]*\.)?encheres-publiques\.com([:/?#]|$)', false, 10, array['pv_huissier', 'cahier_conditions_vente', 'proces_verbal', 'conditions_vente']
  );
create temporary table pgtap_869_open on commit drop as
  execute pdf_photos_candidates(
    array['pv_huissier', 'cahier_conditions_vente', 'proces_verbal', 'conditions_vente'], 3, 12, 12, true, '^https?://([^/?#]*\.)?encheres-publiques\.com([:/?#]|$)', true, 10, array['pv_huissier', 'cahier_conditions_vente', 'proces_verbal', 'conditions_vente']
  );
create temporary table pgtap_869_limited on commit drop as
  execute pdf_photos_candidates(
    array['pv_huissier', 'cahier_conditions_vente', 'proces_verbal', 'conditions_vente'], 3, 12, 12, false, '^https?://([^/?#]*\.)?encheres-publiques\.com([:/?#]|$)', false, 2, array['pv_huissier', 'cahier_conditions_vente', 'proces_verbal', 'conditions_vente']
  );

select is(
  (select count(*) from information_schema.columns
    where table_schema like 'pg_temp%' and table_name = 'pgtap_869_closed'),
  8::bigint,
  'eight columns come back, in the order the pipeline reads them'
);
select is(
  (select array_agg(right(sale_id::text, 2) || ':' || document_type order by ctid) from pgtap_869_closed),
  array['12:cahier_conditions_vente', '01:pv_huissier', '01:cahier_conditions_vente', '03:pv_huissier'],
  'nearest sale first, the PV descriptif before the cahier; not selected: already read, attempts exhausted, a diagnostic, quarantined, ended, closed source or host, 12 photos already, no document'
);
select is(
  (select array_agg(right(sale_id::text, 2) || ':' || document_type order by ctid) from pgtap_869_open),
  array['12:cahier_conditions_vente', '01:pv_huissier', '01:cahier_conditions_vente', '03:pv_huissier',
        '08:pv_huissier', '09:pv_huissier'],
  'with Encheres Publiques authorized, its source and its document host come back'
);
select is(
  (select array_agg(right(sale_id::text, 2) || ':' || document_type order by ctid) from pgtap_869_limited),
  array['12:cahier_conditions_vente', '01:pv_huissier', '01:cahier_conditions_vente'],
  'the limit counts sales, not documents: every pending document of the chosen sales comes back'
);
select is(
  (select string_agg(right(sale_id::text, 2) || ':' || attempts, ',' order by ctid) from pgtap_869_closed),
  '12:0,01:0,01:0,03:1',
  'the attempts column is 0 for a document never read, and the previous count for a retry'
);

-- Purge des fichiers -------------------------------------------------------------------------------
select is(
  (select count(*) from public.sale_retention_storage_queue
    where object_path like 'documents/c8690000-1000-4000-8000-0000000000%'),
  0::bigint,
  'the queue holds no document photo before any deletion'
);
delete from public.sale_document_photos where image_sha256 = repeat('a', 64);
select is(
  (select array_agg(object_path order by object_path) from public.sale_retention_storage_queue
    where bucket = 'sale-photos' and object_path like 'documents/c8690000-1000-4000-8000-000000000001/%'),
  array['documents/c8690000-1000-4000-8000-000000000001/aaaaaaaaaaaaaaaa-640.webp'],
  'deleting a photo queues its file once (path_640 = path_1600 for a narrow image)'
);
-- Deux images qui partagent les mêmes fichiers (mêmes 16 premiers caractères d'empreinte).
insert into public.sale_document_photos
  (sale_id, document_url, image_sha256, page_number, position, width, height, path_640, path_1600, public_url)
select 'c8690000-1000-4000-8000-000000000003', 'https://example.test/pdf-photos/3/pv.pdf', sha, 1, position, 1000, 700,
       'documents/c8690000-1000-4000-8000-000000000003/eeeeeeeeeeeeeeee-640.webp',
       'documents/c8690000-1000-4000-8000-000000000003/eeeeeeeeeeeeeeee-1600.webp',
       'https://project.supabase.co/storage/v1/object/public/sale-photos/documents/c8690000-1000-4000-8000-000000000003/eeeeeeeeeeeeeeee-1600.webp'
  from (values (repeat('e', 64), 1), (repeat('e', 16) || repeat('f', 48), 2)) shared(sha, position);
delete from public.sale_document_photos where image_sha256 = repeat('e', 64);
select is(
  (select count(*) from public.sale_retention_storage_queue
    where object_path like 'documents/c8690000-1000-4000-8000-000000000003/%'),
  0::bigint,
  'a file another stored photo of the sale still uses is not queued'
);
delete from public.sale_document_photos where sale_id in (
  'c8690000-1000-4000-8000-000000000001', 'c8690000-1000-4000-8000-000000000003'
);
select is(
  (select array_agg(object_path order by object_path) from public.sale_retention_storage_queue
    where bucket = 'sale-photos'
      and object_path ~ '^documents/c8690000-1000-4000-8000-00000000000[13]/'),
  array[
    'documents/c8690000-1000-4000-8000-000000000001/aaaaaaaaaaaaaaaa-640.webp',
    'documents/c8690000-1000-4000-8000-000000000001/bbbbbbbbbbbbbbbb-1600.webp',
    'documents/c8690000-1000-4000-8000-000000000001/bbbbbbbbbbbbbbbb-640.webp',
    'documents/c8690000-1000-4000-8000-000000000001/cccccccccccccccc-1600.webp',
    'documents/c8690000-1000-4000-8000-000000000001/cccccccccccccccc-640.webp',
    'documents/c8690000-1000-4000-8000-000000000001/dddddddddddddddd-1600.webp',
    'documents/c8690000-1000-4000-8000-000000000001/dddddddddddddddd-640.webp',
    'documents/c8690000-1000-4000-8000-000000000003/eeeeeeeeeeeeeeee-1600.webp',
    'documents/c8690000-1000-4000-8000-000000000003/eeeeeeeeeeeeeeee-640.webp'
  ],
  'deleting the remaining photos (a withdrawn one included) queues every file, the shared ones once'
);

select * from finish();
rollback;
