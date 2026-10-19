begin;

select plan(26);

-- 20261028100000 : boîte d'envoi de l'invalidation du cache. Une vente visible qui devient invisible
-- (statut, quarantaine, date), ou une ligne visible supprimée, laisse son identifiant dans
-- app_private.catalogue_invalidations, dans la même transaction. Les lignes insérées sont annulées en fin
-- de test.

-- Structure et droits -----------------------------------------------------------------------------------

select has_table('app_private', 'catalogue_invalidations', 'la boîte d''envoi existe');
select ok(
  (select relrowsecurity from pg_class where oid = 'app_private.catalogue_invalidations'::regclass),
  'RLS est activée sur la boîte d''envoi'
);
select ok(
  not has_table_privilege('anon', 'app_private.catalogue_invalidations', 'select')
  and not has_table_privilege('anon', 'app_private.catalogue_invalidations', 'insert')
  and not has_table_privilege('authenticated', 'app_private.catalogue_invalidations', 'select')
  and not has_table_privilege('authenticated', 'app_private.catalogue_invalidations', 'insert')
  and not has_table_privilege('authenticated', 'app_private.catalogue_invalidations', 'delete'),
  'les rôles du navigateur n''ont aucun droit sur la boîte d''envoi'
);
select ok(
  has_table_privilege('service_role', 'app_private.catalogue_invalidations', 'select')
  and has_table_privilege('service_role', 'app_private.catalogue_invalidations', 'delete')
  and not has_table_privilege('service_role', 'app_private.catalogue_invalidations', 'insert')
  and not has_table_privilege('service_role', 'app_private.catalogue_invalidations', 'update'),
  'le pipeline (service_role) lit et supprime, il n''écrit pas : seul le déclencheur insère'
);
select ok(
  (select count(*) = 2
   from pg_trigger trigger_row
   where trigger_row.tgrelid = 'public.auction_sales'::regclass
     and trigger_row.tgname in (
       'zzzzzz_auction_sales_catalogue_invalidation_update',
       'zzzzzz_auction_sales_catalogue_invalidation_delete'
     )
     and trigger_row.tgenabled = 'O'),
  'les deux déclencheurs (UPDATE et DELETE) sont actifs'
);
select ok(
  (select prosecdef and proconfig @> array['search_path=""']
   from pg_proc where oid = 'app_private.queue_catalogue_invalidation()'::regprocedure)
  and not has_function_privilege('anon', 'app_private.queue_catalogue_invalidation()', 'execute')
  and not has_function_privilege('authenticated', 'app_private.queue_catalogue_invalidation()', 'execute'),
  'la fonction du déclencheur est SECURITY DEFINER, à search_path vide, fermée au navigateur'
);
select ok(
  not has_function_privilege(
    'anon',
    'app_private.auction_sale_columns_are_catalogue_visible(text,boolean,boolean,timestamptz,timestamptz,timestamptz,timestamptz,date)',
    'execute')
  and not has_function_privilege(
    'authenticated',
    'app_private.auction_sale_columns_are_catalogue_visible(text,boolean,boolean,timestamptz,timestamptz,timestamptz,timestamptz,date)',
    'execute'),
  'le prédicat de visibilité par colonnes est fermé au navigateur'
);

-- Jeu d'essai ---------------------------------------------------------------------------------------------

insert into public.auction_sales (id, source_name, source_url, status, sale_date, raw_payload, sale_procedure)
values
  -- 01 à 09 : visibles (à venir, date future)
  ('c4710000-0000-4000-8000-000000000001', 'licitor', 'https://example.test/471/01', 'upcoming',
    current_timestamp + interval '3 days', '{}'::jsonb, '{}'::jsonb),
  ('c4710000-0000-4000-8000-000000000002', 'licitor', 'https://example.test/471/02', 'upcoming',
    current_timestamp + interval '3 days', '{}'::jsonb, '{}'::jsonb),
  ('c4710000-0000-4000-8000-000000000003', 'licitor', 'https://example.test/471/03', 'upcoming',
    current_timestamp + interval '3 days', '{}'::jsonb, '{}'::jsonb),
  ('c4710000-0000-4000-8000-000000000004', 'licitor', 'https://example.test/471/04', 'upcoming',
    current_timestamp + interval '3 days', '{}'::jsonb, '{}'::jsonb),
  ('c4710000-0000-4000-8000-000000000005', 'licitor', 'https://example.test/471/05', 'upcoming',
    current_timestamp + interval '3 days', '{}'::jsonb, '{}'::jsonb),
  ('c4710000-0000-4000-8000-000000000006', 'licitor', 'https://example.test/471/06', 'upcoming',
    current_timestamp + interval '3 days', '{}'::jsonb, '{}'::jsonb),
  ('c4710000-0000-4000-8000-000000000007', 'licitor', 'https://example.test/471/07', 'upcoming',
    current_timestamp + interval '3 days', '{}'::jsonb, '{}'::jsonb),
  ('c4710000-0000-4000-8000-000000000008', 'licitor', 'https://example.test/471/08', 'upcoming',
    current_timestamp + interval '3 days', '{}'::jsonb, '{}'::jsonb),
  ('c4710000-0000-4000-8000-000000000009', 'licitor', 'https://example.test/471/09', 'upcoming',
    current_timestamp + interval '3 days', '{}'::jsonb, '{}'::jsonb),
  -- 10 : déjà invisible (statut passé) ; 11 : déjà invisible (quarantaine)
  ('c4710000-0000-4000-8000-000000000010', 'licitor', 'https://example.test/471/10', 'past',
    current_timestamp + interval '3 days', '{}'::jsonb, '{}'::jsonb),
  ('c4710000-0000-4000-8000-000000000011', 'licitor', 'https://example.test/471/11', 'upcoming',
    current_timestamp + interval '3 days', '{"publication_quarantine": "operator_hold"}'::jsonb, '{}'::jsonb);

-- La base exige le rattachement de chaque fiche au graphe des issues avant sa suppression (comme les
-- tests 320 et 475) : les suppressions plus bas ne le seraient pas sans lui.
select count(*) from public.bridge_auction_sales_to_outcome_graph();

select is(
  (select count(*) from app_private.catalogue_invalidations),
  0::bigint,
  'insérer des ventes, visibles ou non, n''écrit rien dans la boîte d''envoi'
);

-- Bascules qui comptent -----------------------------------------------------------------------------------

update public.auction_sales set status = 'cancelled'
  where id = 'c4710000-0000-4000-8000-000000000001';
select is(
  (select array_agg(sale_id::text) from app_private.catalogue_invalidations),
  array['c4710000-0000-4000-8000-000000000001'],
  'une vente annulée est notée'
);

update public.auction_sales
  set raw_payload = '{"publication_quarantine": "operator_hold"}'::jsonb
  where id = 'c4710000-0000-4000-8000-000000000002';
select is(
  (select count(*) from app_private.catalogue_invalidations
    where sale_id = 'c4710000-0000-4000-8000-000000000002'),
  1::bigint,
  'une vente mise en quarantaine par raw_payload est notée (le déclencheur BEFORE recalcule la colonne)'
);

update public.auction_sales set catalogue_quarantined = true
  where id = 'c4710000-0000-4000-8000-000000000003';
select is(
  (select count(*) from app_private.catalogue_invalidations
    where sale_id = 'c4710000-0000-4000-8000-000000000003'),
  0::bigint,
  'l''écriture directe de la colonne est corrigée par le déclencheur BEFORE, la vente reste visible : rien'
);

update public.auction_sales set sale_date = current_timestamp - interval '2 days'
  where id = 'c4710000-0000-4000-8000-000000000004';
select is(
  (select count(*) from app_private.catalogue_invalidations
    where sale_id = 'c4710000-0000-4000-8000-000000000004'),
  1::bigint,
  'une vente dont la date passe devient invisible : notée'
);

delete from public.auction_sales where id = 'c4710000-0000-4000-8000-000000000005';
select is(
  (select count(*) from app_private.catalogue_invalidations
    where sale_id = 'c4710000-0000-4000-8000-000000000005'),
  1::bigint,
  'une ligne visible supprimée (fusion, purge) est notée'
);

update public.auction_sales set status = 'quarantined'
  where id = 'c4710000-0000-4000-8000-000000000006';
select is(
  (select count(*) from app_private.catalogue_invalidations
    where sale_id = 'c4710000-0000-4000-8000-000000000006'),
  1::bigint,
  'un statut hors de la liste visible est noté'
);

-- Écritures sans effet sur la visibilité ------------------------------------------------------------------

update public.auction_sales set status = 'postponed'
  where id = 'c4710000-0000-4000-8000-000000000007';
update public.auction_sales set status = 'unknown'
  where id = 'c4710000-0000-4000-8000-000000000007';
select is(
  (select count(*) from app_private.catalogue_invalidations
    where sale_id = 'c4710000-0000-4000-8000-000000000007'),
  0::bigint,
  'à venir, reporté et inconnu restent visibles : rien'
);

update public.auction_sales
  set starting_price_eur = 123000, city = 'Quelquepart'
  where id = 'c4710000-0000-4000-8000-000000000008';
update public.auction_sales set sale_date = current_timestamp + interval '9 days'
  where id = 'c4710000-0000-4000-8000-000000000009';
select is(
  (select count(*) from app_private.catalogue_invalidations
    where sale_id in ('c4710000-0000-4000-8000-000000000008', 'c4710000-0000-4000-8000-000000000009')),
  0::bigint,
  'un changement de prix, de ville ou une date qui reste future ne note rien'
);

update public.auction_sales set status = 'cancelled'
  where id = 'c4710000-0000-4000-8000-000000000010';
update public.auction_sales set status = 'adjudicated'
  where id = 'c4710000-0000-4000-8000-000000000010';
delete from public.auction_sales where id = 'c4710000-0000-4000-8000-000000000010';
delete from public.auction_sales where id = 'c4710000-0000-4000-8000-000000000011';
select is(
  (select count(*) from app_private.catalogue_invalidations
    where sale_id in ('c4710000-0000-4000-8000-000000000010', 'c4710000-0000-4000-8000-000000000011')),
  0::bigint,
  'une vente déjà invisible (statut, quarantaine), modifiée puis supprimée, ne note rien'
);

-- Retour à la visibilité, puis nouvelle sortie ------------------------------------------------------------

update public.auction_sales set status = 'upcoming'
  where id = 'c4710000-0000-4000-8000-000000000001';
select is(
  (select count(*) from app_private.catalogue_invalidations
    where sale_id = 'c4710000-0000-4000-8000-000000000001'),
  1::bigint,
  'une vente qui redevient visible ne note rien de plus'
);

update public.auction_sales set status = 'cancelled'
  where id = 'c4710000-0000-4000-8000-000000000001';
select is(
  (select count(*) from app_private.catalogue_invalidations
    where sale_id = 'c4710000-0000-4000-8000-000000000001'),
  2::bigint,
  'une seconde sortie est notée à nouveau (une ligne par bascule, le pipeline dédoublonne)'
);

select is(
  (select array_agg(distinct sale_id::text order by sale_id::text) from app_private.catalogue_invalidations),
  array[
    'c4710000-0000-4000-8000-000000000001', 'c4710000-0000-4000-8000-000000000002',
    'c4710000-0000-4000-8000-000000000004', 'c4710000-0000-4000-8000-000000000005',
    'c4710000-0000-4000-8000-000000000006'
  ],
  'au total : annulée, quarantaine, date passée, supprimée, statut hors liste'
);

select ok(
  (select bool_and(at is not null and at <= now()) from app_private.catalogue_invalidations),
  'chaque ligne porte l''instant de la bascule'
);

-- Fiche de l'État sans date : sortie par la fenêtre de 14 jours ---------------------------------------------

insert into public.auction_sales (id, source_name, source_url, status, sale_date, raw_payload, sale_procedure)
values (
  'c4710000-0000-4000-8000-000000000012', 'cessions_etat', 'https://example.test/471/12', 'upcoming', null,
  jsonb_build_object('source_name', 'cessions_etat', 'state_listing', jsonb_build_object(
    'active', true,
    'observed_at', to_char((current_timestamp - interval '1 day') at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS"+00:00"'))),
  '{}'::jsonb
);
update public.auction_sales
  set raw_payload = jsonb_build_object('source_name', 'cessions_etat', 'state_listing', jsonb_build_object(
    'active', false))
  where id = 'c4710000-0000-4000-8000-000000000012';
select is(
  (select count(*) from app_private.catalogue_invalidations
    where sale_id = 'c4710000-0000-4000-8000-000000000012'),
  1::bigint,
  'une fiche de l''État qui n''est plus active quitte le catalogue : notée'
);

-- Le service_role lit et supprime ------------------------------------------------------------------------

set local role service_role;
select is(
  (select count(*) from app_private.catalogue_invalidations
    where sale_id = 'c4710000-0000-4000-8000-000000000012'),
  1::bigint,
  'le service_role lit la boîte d''envoi'
);
-- Un DELETE ne peut pas vivre dans une sous-requête : lives_ok, puis le décompte plus bas.
select lives_ok(
  $$ delete from app_private.catalogue_invalidations
     where sale_id = 'c4710000-0000-4000-8000-000000000012' $$,
  'le service_role supprime les lignes transmises'
);
select throws_ok(
  $$ insert into app_private.catalogue_invalidations (sale_id)
     values ('c4710000-0000-4000-8000-0000000000ff') $$,
  '42501',
  null,
  'le service_role n''insère pas lui-même dans la boîte d''envoi'
);
reset role;

select is(
  (select count(*) from app_private.catalogue_invalidations
    where sale_id = 'c4710000-0000-4000-8000-000000000012'),
  0::bigint,
  'la ligne supprimée a bien disparu'
);

select * from finish();
rollback;
