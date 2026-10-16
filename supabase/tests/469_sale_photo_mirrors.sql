begin;

select plan(28);

-- Bucket -----------------------------------------------------------------------------------------
select is(
  (select public from storage.buckets where id = 'sale-photos'),
  true,
  'the sale-photos bucket is public (copies are served from their public URL)'
);
select is(
  (select file_size_limit from storage.buckets where id = 'sale-photos'),
  2097152::bigint,
  'the bucket refuses files above 2 MB'
);
select is(
  (select allowed_mime_types from storage.buckets where id = 'sale-photos'),
  array['image/webp']::text[],
  'the bucket only accepts WebP'
);
select is(
  (select count(*) from pg_policies where schemaname = 'storage' and tablename = 'objects'
     and (coalesce(qual, '') || coalesce(with_check, '')) like '%sale-photos%'),
  0::bigint,
  'no browser-facing Storage policy exists for sale-photos'
);

-- RLS and grants ---------------------------------------------------------------------------------
select ok(
  (select relrowsecurity from pg_class where oid = 'public.sale_photos'::regclass),
  'RLS is enabled on sale_photos'
);
select ok(
  not has_table_privilege('anon', 'public.sale_photos', 'select')
  and not has_table_privilege('anon', 'public.sale_photos', 'insert')
  and not has_table_privilege('anon', 'public.sale_photos', 'update')
  and not has_table_privilege('anon', 'public.sale_photos', 'delete'),
  'anon has no right on sale_photos'
);
select ok(
  not has_table_privilege('authenticated', 'public.sale_photos', 'select')
  and not has_table_privilege('authenticated', 'public.sale_photos', 'insert')
  and not has_table_privilege('authenticated', 'public.sale_photos', 'update')
  and not has_table_privilege('authenticated', 'public.sale_photos', 'delete'),
  'authenticated has no right on sale_photos'
);
select ok(
  has_table_privilege('service_role', 'public.sale_photos', 'insert')
  and has_table_privilege('service_role', 'public.sale_photos', 'delete'),
  'the pipeline (service_role) writes sale_photos'
);
select is(
  (select count(*) from pg_policies where schemaname = 'public' and tablename = 'sale_photos'),
  0::bigint,
  'sale_photos has no policy for a browser role'
);

-- Functions --------------------------------------------------------------------------------------
select ok(
  has_function_privilege('anon', 'public.sale_photo_mirrors(text[])', 'execute')
  and has_function_privilege('authenticated', 'public.sale_photo_mirrors(text[])', 'execute'),
  'visitors may read the stored copies'
);
select ok(
  (select prosecdef and proconfig @> array['search_path=""'] from pg_proc
    where oid = 'app_private.sale_photo_mirrors(text[])'::regprocedure),
  'the reader is SECURITY DEFINER with an empty search_path'
);
select ok(
  not has_function_privilege('anon', 'app_private.enqueue_sale_photo_files_for_deletion()', 'execute')
  and not has_function_privilege('authenticated', 'app_private.enqueue_sale_photo_files_for_deletion()', 'execute'),
  'the purge trigger function is not callable by the browser roles'
);

-- Data -------------------------------------------------------------------------------------------
insert into public.auction_sales(id, source_name, source_url, status, starting_price_eur, sale_date)
values
  ('ffffffff-ffff-ffff-ffff-fffffffff691', 'photo-test', 'https://example.test/photo/1', 'upcoming', 10000, '1999-01-02 12:00Z'),
  ('ffffffff-ffff-ffff-ffff-fffffffff692', 'photo-test', 'https://example.test/photo/2', 'upcoming', 10000, '2099-01-02 12:00Z'),
  ('ffffffff-ffff-ffff-ffff-fffffffff695', 'photo-test', 'https://example.test/photo/5', 'upcoming', 10000, '2099-01-02 12:00Z'),
  ('ffffffff-ffff-ffff-ffff-fffffffff696', 'photo-test', 'https://example.test/photo/6', 'upcoming', 10000, '1999-01-03 12:00Z');
-- Ventes sorties du catalogue public : mise en quarantaine (déclencheur de projection) et vente terminée.
insert into public.auction_sales(id, source_name, source_url, status, starting_price_eur, sale_date, raw_payload)
values
  ('ffffffff-ffff-ffff-ffff-fffffffff693', 'photo-test', 'https://example.test/photo/3', 'upcoming', 10000, '2099-01-02 12:00Z',
   '{"publication_quarantine": "test"}'::jsonb),
  ('ffffffff-ffff-ffff-ffff-fffffffff694', 'photo-test', 'https://example.test/photo/4', 'adjudicated', 10000, '2099-01-02 12:00Z',
   '{}'::jsonb);

insert into public.sale_photos(
  sale_id, source_url, source_host, sha256, path_640, path_1600, width, height, bytes_640, bytes_1600, status, attempts, stored_at
) values
  -- Vente 1 (sera purgée) : deux tailles distinctes.
  ('ffffffff-ffff-ffff-ffff-fffffffff691', 'https://img.example.test/a.jpg', 'img.example.test',
   repeat('a', 64), 'ffffffff-ffff-ffff-ffff-fffffffff691/aaaaaaaaaaaaaaaa-640.webp',
   'ffffffff-ffff-ffff-ffff-fffffffff691/aaaaaaaaaaaaaaaa-1600.webp', 2000, 1500, 30000, 90000, 'stored', 1, now()),
  -- Vente 2 : une copie lisible, une ligne en échec, une bloquée, une retirée.
  ('ffffffff-ffff-ffff-ffff-fffffffff692', 'https://img.example.test/b.jpg', 'img.example.test',
   repeat('b', 64), 'ffffffff-ffff-ffff-ffff-fffffffff692/bbbbbbbbbbbbbbbb-640.webp',
   'ffffffff-ffff-ffff-ffff-fffffffff692/bbbbbbbbbbbbbbbb-640.webp', 600, 450, 20000, 20000, 'stored', 1, now()),
  ('ffffffff-ffff-ffff-ffff-fffffffff692', 'https://img.example.test/c.jpg', 'img.example.test',
   null, null, null, null, null, null, null, 'failed', 1, null),
  ('ffffffff-ffff-ffff-ffff-fffffffff692', 'https://img.example.test/d.jpg', 'img.example.test',
   null, null, null, null, null, null, null, 'blocked', 1, null),
  ('ffffffff-ffff-ffff-ffff-fffffffff692', 'https://img.example.test/e.jpg', 'img.example.test',
   repeat('e', 64), null, null, 1000, 800, null, null, 'withdrawn', 1, now()),
  -- Ventes 693 (en quarantaine) et 694 (terminée) : copies `stored` qui ne doivent plus être servies.
  ('ffffffff-ffff-ffff-ffff-fffffffff693', 'https://img.example.test/q.jpg', 'img.example.test',
   repeat('1', 64), 'ffffffff-ffff-ffff-ffff-fffffffff693/1111111111111111-640.webp',
   'ffffffff-ffff-ffff-ffff-fffffffff693/1111111111111111-640.webp', 600, 450, 20000, 20000, 'stored', 1, now()),
  ('ffffffff-ffff-ffff-ffff-fffffffff694', 'https://img.example.test/s.jpg', 'img.example.test',
   repeat('2', 64), 'ffffffff-ffff-ffff-ffff-fffffffff694/2222222222222222-640.webp',
   'ffffffff-ffff-ffff-ffff-fffffffff694/2222222222222222-640.webp', 600, 450, 20000, 20000, 'stored', 1, now()),
  -- Vente 695 : la même photo sous deux URL (même vente, même empreinte, donc même fichier).
  ('ffffffff-ffff-ffff-ffff-fffffffff695', 'https://img.example.test/x1.jpg', 'img.example.test',
   repeat('c', 64), 'ffffffff-ffff-ffff-ffff-fffffffff695/cccccccccccccccc-640.webp',
   'ffffffff-ffff-ffff-ffff-fffffffff695/cccccccccccccccc-640.webp', 600, 450, 20000, 20000, 'stored', 1, now()),
  ('ffffffff-ffff-ffff-ffff-fffffffff695', 'https://img.example.test/x2.jpg', 'img.example.test',
   repeat('c', 64), 'ffffffff-ffff-ffff-ffff-fffffffff695/cccccccccccccccc-640.webp',
   'ffffffff-ffff-ffff-ffff-fffffffff695/cccccccccccccccc-640.webp', 600, 450, 20000, 20000, 'stored', 1, now()),
  -- Vente 696 (sera purgée) : le même fichier partagé par deux copies.
  ('ffffffff-ffff-ffff-ffff-fffffffff696', 'https://img.example.test/y1.jpg', 'img.example.test',
   repeat('d', 64), 'ffffffff-ffff-ffff-ffff-fffffffff696/dddddddddddddddd-640.webp',
   'ffffffff-ffff-ffff-ffff-fffffffff696/dddddddddddddddd-640.webp', 600, 450, 20000, 20000, 'stored', 1, now()),
  ('ffffffff-ffff-ffff-ffff-fffffffff696', 'https://img.example.test/y2.jpg', 'img.example.test',
   repeat('d', 64), 'ffffffff-ffff-ffff-ffff-fffffffff696/dddddddddddddddd-640.webp',
   'ffffffff-ffff-ffff-ffff-fffffffff696/dddddddddddddddd-640.webp', 600, 450, 20000, 20000, 'stored', 1, now());

select throws_ok(
  $$insert into public.sale_photos(sale_id, source_url, source_host, status)
    values ('ffffffff-ffff-ffff-ffff-fffffffff692', 'https://img.example.test/f.jpg', 'img.example.test', 'stored')$$,
  '23514',
  null,
  'a stored copy must carry its files and its fingerprint'
);
select throws_ok(
  $$insert into public.sale_photos(sale_id, source_url, source_host, status)
    values ('ffffffff-ffff-ffff-ffff-fffffffff692', 'https://img.example.test/f.jpg', 'img.example.test', 'unknown')$$,
  '23514',
  null,
  'an unknown status is refused'
);

-- Lecture : seules les lignes `stored` d'une vente du catalogue public sortent ----------------------
set local role anon;
select is(
  (select count(*) from public.sale_photo_mirrors(array[
    'https://img.example.test/b.jpg',
    'https://img.example.test/c.jpg', 'https://img.example.test/d.jpg',
    'https://img.example.test/e.jpg', 'https://img.example.test/inconnue.jpg'
  ])),
  1::bigint,
  'only stored copies are returned (failed, blocked, withdrawn and unknown URLs are not)'
);
select is(
  (select path_640 from public.sale_photo_mirrors(array['https://img.example.test/b.jpg'])),
  'ffffffff-ffff-ffff-ffff-fffffffff692/bbbbbbbbbbbbbbbb-640.webp',
  'the row of a stored URL carries its 640 px path'
);
select is(
  (select count(*) from public.sale_photo_mirrors(array[
    'https://img.example.test/a.jpg', 'https://img.example.test/q.jpg', 'https://img.example.test/s.jpg'
  ])),
  0::bigint,
  'a stored copy is not served when its sale is over, quarantined or no longer live'
);
select is(
  (select count(*) from public.sale_photo_mirrors(null)),
  0::bigint,
  'a null list returns nothing'
);
select throws_ok(
  $$select * from public.sale_photos$$,
  '42501',
  null,
  'anon cannot read the table directly'
);
reset role;

-- La copie d'une vente revenue dans le catalogue public est de nouveau servie.
update public.auction_sales set raw_payload = '{}'::jsonb where id = 'ffffffff-ffff-ffff-ffff-fffffffff693';
set local role anon;
select is(
  (select count(*) from public.sale_photo_mirrors(array['https://img.example.test/q.jpg'])),
  1::bigint,
  'the copy is served again once the sale leaves quarantine'
);
reset role;
update public.auction_sales set raw_payload = '{"publication_quarantine": "again"}'::jsonb
 where id = 'ffffffff-ffff-ffff-ffff-fffffffff693';
set local role anon;
select is(
  (select count(*) from public.sale_photo_mirrors(array['https://img.example.test/q.jpg'])),
  0::bigint,
  'the copy stops being served as soon as the sale is quarantined'
);
reset role;

-- Purge : la suppression d'une vente met ses fichiers dans la file --------------------------------
select is((select count(*) from public.sale_retention_storage_queue where bucket = 'sale-photos'), 0::bigint, 'the queue starts empty');

set local role service_role;
-- La purge supprime une vente par appel (`limit least(p_limit, 1)`) : deux appels pour les deux ventes.
select is(
  (public.purge_expired_auction_sales('2000-01-02 12:00Z', 25)->>'deleted')::integer
    + (public.purge_expired_auction_sales('2000-01-02 12:00Z', 25)->>'deleted')::integer,
  2,
  'the expired sales are purged'
);
reset role;

select is(
  (select array_agg(object_path order by object_path) from public.sale_retention_storage_queue where bucket = 'sale-photos'),
  array[
    'ffffffff-ffff-ffff-ffff-fffffffff691/aaaaaaaaaaaaaaaa-1600.webp',
    'ffffffff-ffff-ffff-ffff-fffffffff691/aaaaaaaaaaaaaaaa-640.webp',
    'ffffffff-ffff-ffff-ffff-fffffffff696/dddddddddddddddd-640.webp'
  ]::text[],
  'the purged sales put their files in the retention queue (a file shared by two copies once)'
);

-- Original étroit : un seul fichier, aucun doublon ni erreur ---------------------------------------
delete from public.sale_photos where source_url = 'https://img.example.test/b.jpg';
select is(
  (select count(*) from public.sale_retention_storage_queue
    where bucket = 'sale-photos' and object_path = 'ffffffff-ffff-ffff-ffff-fffffffff692/bbbbbbbbbbbbbbbb-640.webp'),
  1::bigint,
  'path_640 = path_1600 queues a single file without error'
);
delete from public.sale_photos where sale_id = 'ffffffff-ffff-ffff-ffff-fffffffff692';
select is(
  (select count(*) from public.sale_retention_storage_queue where bucket = 'sale-photos'),
  4::bigint,
  'rows without files (failed, blocked, withdrawn) queue nothing'
);

-- Un fichier que la même vente utilise encore sous une autre URL n'est pas mis en file ---------------
delete from public.sale_photos where source_url = 'https://img.example.test/x1.jpg';
select is(
  (select count(*) from public.sale_retention_storage_queue
    where bucket = 'sale-photos' and object_path = 'ffffffff-ffff-ffff-ffff-fffffffff695/cccccccccccccccc-640.webp'),
  0::bigint,
  'deleting one of two copies that share a file keeps the file'
);
delete from public.sale_photos where source_url = 'https://img.example.test/x2.jpg';
select is(
  (select count(*) from public.sale_retention_storage_queue
    where bucket = 'sale-photos' and object_path = 'ffffffff-ffff-ffff-ffff-fffffffff695/cccccccccccccccc-640.webp'),
  1::bigint,
  'deleting the last copy that uses a file queues it'
);

select * from finish();
rollback;
