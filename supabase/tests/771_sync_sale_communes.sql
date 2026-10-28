-- Recopie du code commune du pipeline en une instruction (migration 20261108110100) :
--   * fonction réservée au rôle de service ;
--   * mêmes règles que `pipelineCommuneOf` (src/lib/sale-communes-sync.server.ts) : code à 5 caractères, source connue,
--     arrondissement valable pour SA commune sinon commune seule, ventes à venir seulement ;
--   * seules les lignes nouvelles ou changées sont écrites ; un second passage n'écrit rien ;
--   * un code commune modifié par le pipeline est repris, la date de pose avance.
-- Le saut sans attente d'une vente verrouillée par une autre transaction se vérifie à deux sessions (pgTAP n'en a qu'une).
begin;

select plan(14);

insert into public.auction_sales (
  id, source_name, source_url, title, status, sale_date, starting_price_eur, sale_venue_type, raw_payload
) values
  ('c7710000-1000-4000-8000-000000000001', 'sync-test', 'https://example.test/sync/1', 'Sync 1', 'upcoming',
   '2099-01-01 12:00:00Z', 100000, 'tribunal', '{"commune": {"insee": "33063", "source": "geocode"}}'),
  ('c7710000-1000-4000-8000-000000000002', 'sync-test', 'https://example.test/sync/2', 'Sync 2', 'upcoming',
   '2099-01-02 12:00:00Z', 100000, 'tribunal',
   '{"commune": {"insee": " 75056 ", "arrondissement_insee": "75108", "source": "reference_communes"}}'),
  ('c7710000-1000-4000-8000-000000000003', 'sync-test', 'https://example.test/sync/3', 'Sync 3', 'upcoming',
   '2099-01-03 12:00:00Z', 100000, 'tribunal',
   '{"commune": {"insee": "13055", "arrondissement_insee": "75108", "source": "geocode"}}'),
  ('c7710000-1000-4000-8000-000000000004', 'sync-test', 'https://example.test/sync/4', 'Sync 4', 'upcoming',
   '2099-01-04 12:00:00Z', 100000, 'tribunal', '{"commune": {"insee": "2a004", "source": "geocode"}}'),
  ('c7710000-1000-4000-8000-000000000005', 'sync-test', 'https://example.test/sync/5', 'Sync 5', 'upcoming',
   '2099-01-05 12:00:00Z', 100000, 'tribunal', '{"commune": {"insee": "33063", "source": "somewhere"}}'),
  ('c7710000-1000-4000-8000-000000000006', 'sync-test', 'https://example.test/sync/6', 'Sync 6', 'past',
   '2099-01-06 12:00:00Z', 100000, 'tribunal', '{"commune": {"insee": "33063", "source": "geocode"}}'),
  ('c7710000-1000-4000-8000-000000000007', 'sync-test', 'https://example.test/sync/7', 'Sync 7', 'upcoming',
   '2099-01-07 12:00:00Z', 100000, 'tribunal', '{"commune": "33063"}'),
  ('c7710000-1000-4000-8000-000000000008', 'sync-test', 'https://example.test/sync/8', 'Sync 8', 'upcoming',
   '2099-01-08 12:00:00Z', 100000, 'tribunal', '{"commune": {"insee": "abc", "source": "geocode"}}');

-- Droits ---------------------------------------------------------------------------------------------
select ok(
  not has_function_privilege('anon', 'public.sync_sale_communes()', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.sync_sale_communes()', 'EXECUTE')
  and has_function_privilege('service_role', 'public.sync_sale_communes()', 'EXECUTE'),
  'only service_role runs the commune sync'
);
select ok(
  not (select prosecdef from pg_proc where oid = 'public.sync_sale_communes()'::regprocedure)
  and (select proconfig @> array['search_path=""']::text[]
         from pg_proc where oid = 'public.sync_sale_communes()'::regprocedure),
  'the sync is a security invoker function with an empty search_path'
);
select ok(
  has_table_privilege('service_role', 'public.auction_sales', 'UPDATE'),
  'service_role can lock sale rows (for key share needs the update right)'
);

-- Premier passage ----------------------------------------------------------------------------------------
set local role service_role;
create temporary table pgtap_771_runs (label text primary key, with_code integer, changed integer, written integer)
  on commit drop;
grant all on pgtap_771_runs to public;
insert into pgtap_771_runs select 'first', n_with_code, n_changed, n_written from public.sync_sale_communes();
reset role;

select ok(
  (select with_code >= 4 and changed >= 4 and written = changed from pgtap_771_runs where label = 'first'),
  'the first pass reads the valid codes of upcoming sales and writes every new line'
);
select is(
  (select array_agg(sale_id::text || ':' || commune_insee || ':' || coalesce(arrondissement_insee, '-') || ':' || source
                    order by sale_id)
     from public.auction_sale_communes
    where sale_id::text like 'c7710000-1000-4000-8000-0000000000%'),
  array[
    'c7710000-1000-4000-8000-000000000001:33063:-:geocode',
    'c7710000-1000-4000-8000-000000000002:75056:75108:reference_communes',
    'c7710000-1000-4000-8000-000000000003:13055:-:geocode',
    'c7710000-1000-4000-8000-000000000004:2A004:-:geocode'
  ]::text[],
  'codes are trimmed and upper-cased, an arrondissement under the wrong city is dropped, and an unknown source, a past sale, a malformed or non-object commune is ignored'
);

-- Second passage : rien à écrire --------------------------------------------------------------------------
set local role service_role;
insert into pgtap_771_runs select 'second', n_with_code, n_changed, n_written from public.sync_sale_communes();
reset role;
select is(
  (select changed || '/' || written from pgtap_771_runs where label = 'second'),
  '0/0',
  'a second pass writes nothing: unchanged lines are not rewritten'
);
select is(
  (select with_code from pgtap_771_runs where label = 'second'),
  (select with_code from pgtap_771_runs where label = 'first'),
  'the count of sales with a code does not depend on what is already stored'
);

-- Le pipeline change le code d'une vente --------------------------------------------------------------------
update public.auction_sale_communes set resolved_at = '2020-01-01 00:00:00Z'
 where sale_id = 'c7710000-1000-4000-8000-000000000001';
update public.auction_sales
   set raw_payload = '{"commune": {"insee": "33064", "source": "geocode"}}'
 where id = 'c7710000-1000-4000-8000-000000000001';
set local role service_role;
insert into pgtap_771_runs select 'third', n_with_code, n_changed, n_written from public.sync_sale_communes();
reset role;
select is(
  (select changed || '/' || written from pgtap_771_runs where label = 'third'),
  '1/1',
  'a changed code is the only line written'
);
select is(
  (select commune_insee from public.auction_sale_communes where sale_id = 'c7710000-1000-4000-8000-000000000001'),
  '33064',
  'the new code replaces the old one'
);
select ok(
  (select resolved_at > '2020-01-01 00:00:00Z' from public.auction_sale_communes
    where sale_id = 'c7710000-1000-4000-8000-000000000001'),
  'the date of the line moves with the change'
);

-- Un arrondissement valable apparaît plus tard -----------------------------------------------------------------
update public.auction_sales
   set raw_payload = '{"commune": {"insee": "13055", "arrondissement_insee": "13208", "source": "geocode"}}'
 where id = 'c7710000-1000-4000-8000-000000000003';
set local role service_role;
insert into pgtap_771_runs select 'fourth', n_with_code, n_changed, n_written from public.sync_sale_communes();
reset role;
select is(
  (select arrondissement_insee from public.auction_sale_communes where sale_id = 'c7710000-1000-4000-8000-000000000003'),
  '13208',
  'a Marseille arrondissement is stored once the pipeline gives a valid one'
);

-- Une vente qui n'est plus à venir n'est pas reprise ----------------------------------------------------------------
update public.auction_sales
   set status = 'past', raw_payload = '{"commune": {"insee": "99999", "source": "geocode"}}'
 where id = 'c7710000-1000-4000-8000-000000000004';
set local role service_role;
insert into pgtap_771_runs select 'fifth', n_with_code, n_changed, n_written from public.sync_sale_communes();
reset role;
select is(
  (select commune_insee from public.auction_sale_communes where sale_id = 'c7710000-1000-4000-8000-000000000004'),
  '2A004',
  'a sale that is no longer upcoming keeps its stored code'
);
select is(
  (select changed || '/' || written from pgtap_771_runs where label = 'fifth'),
  '0/0',
  'and nothing is written for it'
);
select is(
  (select count(*) from public.auction_sale_communes where sale_id = 'c7710000-1000-4000-8000-000000000005'),
  0::bigint,
  'a commune with an unknown source never reaches the table'
);

select * from finish();

rollback;
