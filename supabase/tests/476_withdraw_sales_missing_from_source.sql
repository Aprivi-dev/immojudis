-- Ventes disparues de leur source (20261028110100) : retrait après deux inventaires complets sans les revoir,
-- jamais sans inventaire complet récent, et rien si plus de 15 % des ventes visibles seraient retirées.
begin;

select plan(28);

-- Fixtures -------------------------------------------------------------------------------------
-- Source « pgtap-476-main » : 27 ventes (ids 1 à 27), dont 26 visibles.
--   1, 2 (g1, g2) : absentes de deux inventaires complets, aucune autre source : disparues.
--   3 (o1)        : absente d'un seul inventaire complet : conservée.
--   4 (m1)        : absente deux fois, mais revue par une autre source : conservée.
--   5 (m2)        : absente deux fois de deux sources : disparue.
--   6 (h1)        : déjà passée, donc hors catalogue visible : ni dans la population ni parmi les candidates.
--   7 (n1)        : absente deux fois, mais une autre source ne l'a jamais inventoriée : conservée.
--   8 à 27        : présentes (20).
-- Source « pgtap-476-mass » : 10 ventes (ids 29 à 38), dont 3 disparues (30 %, au-dessus de la limite de 15 %).
-- Source « pgtap-476-stale » : 1 vente (id 28) dont l'inventaire complet date de 3 h.
insert into public.auction_source_state (source_name, enabled, last_inventory_complete_at)
values
  ('pgtap-476-main', true, now()),
  ('pgtap-476-other', true, now()),
  ('pgtap-476-stale', true, now() - interval '3 hours'),
  ('pgtap-476-mass', true, now());

insert into public.auction_sales (id, source_name, source_url, title, status, sale_date)
select
  ('c4760000-1000-4000-8000-' || lpad(i::text, 12, '0'))::uuid,
  case when i <= 27 then 'pgtap-476-main' when i = 28 then 'pgtap-476-stale' else 'pgtap-476-mass' end,
  'https://example.test/pgtap-476/' || i,
  'Source absence ' || i,
  case when i = 6 then 'past' else 'upcoming' end,
  case when i = 6 then now() - interval '30 days' else '2099-01-01 12:00:00Z'::timestamptz end
from generate_series(1, 38) i;

insert into app_private.auction_sale_source_presence
  (sale_id, source_name, availability, state, checked_at, absent_inventories)
select
  ('c4760000-1000-4000-8000-' || lpad(i::text, 12, '0'))::uuid,
  'pgtap-476-main',
  'available',
  case when i <= 7 then 'absent' else 'present' end,
  now(),
  case when i in (1, 2, 4, 5, 6, 7) then 2 when i = 3 then 1 else 0 end
from generate_series(1, 27) i;

-- Les autres sources de m1 (revue), m2 (perdue deux fois) et n1 (jamais inventoriée complètement : état nul).
insert into app_private.auction_sale_source_presence
  (sale_id, source_name, availability, state, checked_at, absent_inventories)
values
  ('c4760000-1000-4000-8000-000000000004', 'pgtap-476-other', 'available', 'present', now(), 0),
  ('c4760000-1000-4000-8000-000000000005', 'pgtap-476-other', 'available', 'absent', now(), 2),
  ('c4760000-1000-4000-8000-000000000007', 'pgtap-476-other', 'unchecked', null, null, 0);

insert into app_private.auction_sale_source_presence
  (sale_id, source_name, availability, state, checked_at, absent_inventories)
select
  ('c4760000-1000-4000-8000-' || lpad(i::text, 12, '0'))::uuid,
  'pgtap-476-mass',
  'available',
  case when i <= 31 then 'absent' else 'present' end,
  now(),
  case when i <= 31 then 2 else 0 end
from generate_series(29, 38) i;

insert into app_private.auction_sale_source_presence
  (sale_id, source_name, availability, state, checked_at, absent_inventories)
values ('c4760000-1000-4000-8000-000000000028', 'pgtap-476-stale', 'available', 'absent', now(), 2);

-- Structure et droits ---------------------------------------------------------------------------
select has_column('app_private', 'auction_sale_source_presence', 'absent_inventories',
  'the presence table counts the consecutive complete inventories without the sale');
select col_default_is('app_private', 'auction_sale_source_presence', 'absent_inventories', '0',
  'the counter starts at 0');
select ok(
  not has_function_privilege('anon', 'app_private.withdraw_missing_source_sales(text,boolean,timestamptz)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'app_private.withdraw_missing_source_sales(text,boolean,timestamptz)', 'EXECUTE')
  and not has_function_privilege('service_role', 'app_private.withdraw_missing_source_sales(text,boolean,timestamptz)', 'EXECUTE'),
  'the withdrawal is not callable through the Data API'
);
select ok(
  (select prosecdef and proconfig @> array['search_path=""']
     from pg_proc where oid = 'app_private.withdraw_missing_source_sales(text,boolean,timestamptz)'::regprocedure),
  'the withdrawal is SECURITY DEFINER with an empty search_path'
);

-- Calcul à blanc ----------------------------------------------------------------------------------
create temporary table pgtap_476_dry on commit drop as
  select app_private.withdraw_missing_source_sales('pgtap-476-main', false) as result;

select is((select result ->> 'action' from pgtap_476_dry), 'would_withdraw', 'a dry run reports without writing');
select is((select (result ->> 'population')::int from pgtap_476_dry), 26,
  'the population is the visible sales of the source (the past one is out)');
select is((select (result ->> 'candidates')::int from pgtap_476_dry), 3,
  'candidates: absent twice from every source that lists them (g1, g2, m2)');
select is(
  (select count(*) from public.auction_sales where source_name = 'pgtap-476-main' and status = 'withdrawn'),
  0::bigint,
  'and nothing was written'
);

-- Retrait -----------------------------------------------------------------------------------------
create temporary table pgtap_476_run on commit drop as
  select app_private.withdraw_missing_source_sales('pgtap-476-main') as result;

select is((select result ->> 'action' from pgtap_476_run), 'withdrawn', 'the sales are withdrawn');
select is((select (result ->> 'withdrawn')::int from pgtap_476_run), 3, 'three sales are withdrawn');
select is(
  (select array_agg(right(id::text, 2) order by id) from public.auction_sales
    where source_name = 'pgtap-476-main' and status = 'withdrawn'),
  array['01', '02', '05'],
  'g1, g2 and m2 (absent twice from all their sources) are withdrawn'
);
select is(
  (select status from public.auction_sales where id = 'c4760000-1000-4000-8000-000000000003'),
  'upcoming',
  'absent from only one complete inventory: kept'
);
select is(
  (select status from public.auction_sales where id = 'c4760000-1000-4000-8000-000000000004'),
  'upcoming',
  'still listed by another source: kept'
);
select is(
  (select status from public.auction_sales where id = 'c4760000-1000-4000-8000-000000000007'),
  'upcoming',
  'another source never completed an inventory: kept (unknown is not absent)'
);
select is(
  (select status from public.auction_sales where id = 'c4760000-1000-4000-8000-000000000006'),
  'past',
  'a sale that is no longer visible is left as it is'
);
select is(
  (select count(*) from public.auction_sales where source_name = 'pgtap-476-main' and status = 'upcoming'),
  23::bigint,
  'the 20 present sales and the 3 kept ones are untouched'
);
select is(
  (select raw_payload -> 'source_absence' ->> 'status_before' from public.auction_sales
    where id = 'c4760000-1000-4000-8000-000000000001'),
  'upcoming',
  'the former status is kept in the sale for a possible reversal'
);
select is(
  (select count(*) from public.auction_sales
    where id in ('c4760000-1000-4000-8000-000000000001', 'c4760000-1000-4000-8000-000000000002',
                 'c4760000-1000-4000-8000-000000000005')
      and app_private.auction_sale_is_publicly_visible(id)),
  0::bigint,
  'a withdrawn sale leaves the public catalogue'
);

create temporary table pgtap_476_again on commit drop as
  select app_private.withdraw_missing_source_sales('pgtap-476-main') as result;
select is((select result ->> 'action' from pgtap_476_again), 'none', 'a second pass finds nothing left to withdraw');

-- Jamais sans inventaire complet récent ------------------------------------------------------------
select is(
  (app_private.withdraw_missing_source_sales('pgtap-476-stale') ->> 'reason'),
  'no_recent_complete_inventory',
  'an old complete inventory does not allow a withdrawal'
);
select is(
  (select status from public.auction_sales where id = 'c4760000-1000-4000-8000-000000000028'),
  'upcoming',
  'and the sale stays online'
);
select is(
  (app_private.withdraw_missing_source_sales('pgtap-476-unknown') ->> 'reason'),
  'no_recent_complete_inventory',
  'a source that never completed an inventory neither'
);
select throws_ok(
  $$select app_private.withdraw_missing_source_sales('')$$,
  '22023',
  'A source name is required.',
  'an empty source name is refused'
);

-- Garde-fou des 15 % --------------------------------------------------------------------------------
create temporary table pgtap_476_mass on commit drop as
  select app_private.withdraw_missing_source_sales('pgtap-476-mass') as result;

select is((select result ->> 'action' from pgtap_476_mass), 'blocked',
  'more than 15 percent of the visible sales would go: nothing is done');
select is(
  (select count(*) from public.auction_sales where source_name = 'pgtap-476-mass' and status = 'withdrawn'),
  0::bigint,
  'no sale is withdrawn'
);
select is(
  (select status || ':' || (details ->> 'candidates') from public.operational_alerts
    where alert_key = 'catalogue.source_absence.pgtap-476-mass'),
  'open:3',
  'an operational alert is raised with the figures'
);

-- Le problème se résorbe (deux ventes reviennent) : 1 sur 10, le retrait se fait et l'alerte se ferme.
update app_private.auction_sale_source_presence
   set state = 'present', absent_inventories = 0
 where source_name = 'pgtap-476-mass'
   and sale_id in ('c4760000-1000-4000-8000-000000000030', 'c4760000-1000-4000-8000-000000000031');

select is(
  (app_private.withdraw_missing_source_sales('pgtap-476-mass') ->> 'withdrawn')::int,
  1,
  'once under the limit (1 of 10) the remaining sale is withdrawn'
);
select is(
  (select status from public.operational_alerts where alert_key = 'catalogue.source_absence.pgtap-476-mass'),
  'resolved',
  'and the alert closes'
);

select * from finish();
rollback;
