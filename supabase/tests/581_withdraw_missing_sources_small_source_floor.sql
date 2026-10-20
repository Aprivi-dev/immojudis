-- Ventes disparues de leur source (20261029150100) : au moins un retrait autorisé pour une petite source,
-- et un écart minimal de 12 h entre le premier inventaire d'absence et le retrait (pour la source et pour
-- les autres sources de la vente).
begin;

select plan(13);

-- Fixtures -------------------------------------------------------------------------------------
-- Source « pgtap-581-small » : 5 ventes visibles (ids 1 à 5), dont une (1) absente de deux inventaires complets
--   depuis 13 h : 1 sur 5 = 20 % (> 15 %), le plancher d'un retrait l'autorise.
-- Source « pgtap-581-block » : 5 ventes visibles (ids 11 à 15), dont deux (11, 12) absentes deux fois depuis 13 h :
--   deux retraits dépassent le plancher et 15 % : bloqué.
-- Source « pgtap-581-spacing » : 20 ventes visibles (ids 21 à 40), dont quatre avec un compteur de deux :
--   21 depuis 13 h (retirée), 22 depuis 1 h (écartée : trop rapprochée), 23 sans absent_since (retirée : lignes
--   antérieures à la colonne), 24 depuis 13 h mais aussi absente d'une autre source depuis 1 h (conservée).
insert into public.auction_source_state (source_name, enabled, last_inventory_complete_at)
values
  ('pgtap-581-small', true, now()),
  ('pgtap-581-block', true, now()),
  ('pgtap-581-spacing', true, now()),
  ('pgtap-581-other', true, now());

insert into public.auction_sales (id, source_name, source_url, title, status, sale_date)
select
  ('c5810000-1000-4000-8000-' || lpad(i::text, 12, '0'))::uuid,
  case when i <= 5 then 'pgtap-581-small' when i <= 15 then 'pgtap-581-block' else 'pgtap-581-spacing' end,
  'https://example.test/pgtap-581/' || i,
  'Source absence floor ' || i,
  'upcoming',
  '2099-01-01 12:00:00Z'::timestamptz
from generate_series(1, 40) i
where i <= 5 or i between 11 and 15 or i >= 21;

insert into app_private.auction_sale_source_presence
  (sale_id, source_name, availability, state, checked_at, absent_inventories, absent_since)
select
  ('c5810000-1000-4000-8000-' || lpad(i::text, 12, '0'))::uuid,
  'pgtap-581-small',
  'available',
  case when i = 1 then 'absent' else 'present' end,
  now(),
  case when i = 1 then 2 else 0 end,
  case when i = 1 then now() - interval '13 hours' else null end
from generate_series(1, 5) i
union all
select
  ('c5810000-1000-4000-8000-' || lpad(i::text, 12, '0'))::uuid,
  'pgtap-581-block',
  'available',
  case when i in (11, 12) then 'absent' else 'present' end,
  now(),
  case when i in (11, 12) then 2 else 0 end,
  case when i in (11, 12) then now() - interval '13 hours' else null end
from generate_series(11, 15) i
union all
select
  ('c5810000-1000-4000-8000-' || lpad(i::text, 12, '0'))::uuid,
  'pgtap-581-spacing',
  'available',
  case when i <= 24 then 'absent' else 'present' end,
  now(),
  case when i <= 24 then 2 else 0 end,
  case when i in (21, 24) then now() - interval '13 hours' when i = 22 then now() - interval '1 hour' else null end
from generate_series(21, 40) i;

-- La vente 24 est aussi listée par une autre source, qui ne l'a pas vue depuis une heure seulement.
insert into app_private.auction_sale_source_presence
  (sale_id, source_name, availability, state, checked_at, absent_inventories, absent_since)
values
  ('c5810000-1000-4000-8000-000000000024', 'pgtap-581-other', 'available', 'absent', now(), 2,
   now() - interval '1 hour');

-- Structure et droits ---------------------------------------------------------------------------
select ok(
  not has_function_privilege('anon', 'app_private.withdraw_missing_source_sales(text,boolean,timestamptz)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'app_private.withdraw_missing_source_sales(text,boolean,timestamptz)', 'EXECUTE')
  and not has_function_privilege('service_role', 'app_private.withdraw_missing_source_sales(text,boolean,timestamptz)', 'EXECUTE'),
  'the withdrawal is still not callable through the Data API'
);
select ok(
  (select prosecdef and proconfig @> array['search_path=""']
     from pg_proc where oid = 'app_private.withdraw_missing_source_sales(text,boolean,timestamptz)'::regprocedure),
  'the withdrawal is still SECURITY DEFINER with an empty search_path'
);
-- Les constantes sont comparées, côté Python, à ce texte (tests/test_source_absence.py).
select ok(
  (select strpos(prosrc, 'c_max_share constant numeric := 0.15;') > 0
      and strpos(prosrc, 'c_min_inventories constant integer := 2;') > 0
      and strpos(prosrc, 'c_min_withdrawals constant integer := 1;') > 0
      and strpos(prosrc, 'c_min_spacing constant interval := interval ''12 hours'';') > 0
     from pg_proc where oid = 'app_private.withdraw_missing_source_sales(text,boolean,timestamptz)'::regprocedure),
  'the thresholds are 15 %, two inventories, at least one withdrawal and 12 hours'
);

-- Petite source : un retrait autorisé malgré 20 % ----------------------------------------------------------
create temporary table pgtap_581_small on commit drop as
  select app_private.withdraw_missing_source_sales('pgtap-581-small') as result;

select is((select result ->> 'action' from pgtap_581_small), 'withdrawn',
  'a small source may lose one sale even above 15 %');
select is(
  (select (result ->> 'withdrawn') || ' ' || (select status from public.auction_sales
     where id = 'c5810000-1000-4000-8000-000000000001') from pgtap_581_small),
  '1 withdrawn',
  'exactly the one absent sale is withdrawn'
);

-- Deux retraits sur cinq : au-dessus du plancher et de 15 % -----------------------------------------------
create temporary table pgtap_581_block on commit drop as
  select app_private.withdraw_missing_source_sales('pgtap-581-block') as result;

select is((select result ->> 'action' from pgtap_581_block), 'blocked',
  'two of five visible sales exceed the floor and 15 %: blocked');
select is(
  (select (result ->> 'candidates') || ' ' || (result ->> 'max_withdrawals') from pgtap_581_block),
  '2 1',
  'the report gives the candidates and the number of withdrawals allowed'
);
select is(
  (select count(*) from public.auction_sales where source_name = 'pgtap-581-block' and status = 'withdrawn'),
  0::bigint,
  'and nothing is withdrawn'
);

-- Écart minimal de 12 h ----------------------------------------------------------------------------------
create temporary table pgtap_581_dry on commit drop as
  select app_private.withdraw_missing_source_sales('pgtap-581-spacing', false) as result;
select is((select (result ->> 'candidates')::int from pgtap_581_dry), 2,
  'candidates: absent since 13 h and without absent_since; the one counted 1 h ago and the one still recent on another source are out');

create temporary table pgtap_581_spacing on commit drop as
  select app_private.withdraw_missing_source_sales('pgtap-581-spacing') as result;
select is((select (result ->> 'withdrawn')::int from pgtap_581_spacing), 2, 'two sales are withdrawn');
select is(
  (select array_agg(right(id::text, 2) order by id) from public.auction_sales
    where source_name = 'pgtap-581-spacing' and status = 'withdrawn'),
  array['21', '23'],
  'the sales absent for at least 12 h (and the one from before the column) are withdrawn'
);
select is(
  (select status from public.auction_sales where id = 'c5810000-1000-4000-8000-000000000022'),
  'upcoming',
  'a sale whose second inventory came less than 12 h after the first is kept'
);
select is(
  (select status from public.auction_sales where id = 'c5810000-1000-4000-8000-000000000024'),
  'upcoming',
  'a sale still recent on another source is kept'
);

select * from finish();
rollback;
