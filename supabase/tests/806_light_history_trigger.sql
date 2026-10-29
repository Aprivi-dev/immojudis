-- 20261109140000 : le journal des ventes vide les colonnes non comparées avant de convertir la ligne en jsonb ;
-- il enregistre toujours les mêmes changements.
begin;

select plan(4);

insert into public.auction_sales (id, source_name, source_url, title, status, sale_date, city, starting_price_eur, raw_payload)
values (
  'c8010000-1000-4000-8000-000000000001', 'history-801', 'https://www.vench.fr/vente-801', 'Journal léger',
  'upcoming', '2099-01-01 12:00:00Z', 'Paris', 100000, '{"source_blocks": {"description": "avant"}}'
);

update public.auction_sales
set raw_payload = '{"source_blocks": {"description": "après"}}', raw_text = 'texte', observations = '[{"x": 1}]'
where id = 'c8010000-1000-4000-8000-000000000001';

select is(
  (select count(*) from public.auction_sale_history where source_url = 'https://www.vench.fr/vente-801'),
  0::bigint,
  'a change of the raw payload, observations or page text alone is not logged'
);

update public.auction_sales
set starting_price_eur = 90000, raw_payload = '{"source_blocks": {"description": "encore"}}'
where id = 'c8010000-1000-4000-8000-000000000001';

select is(
  (select changed_fields->'starting_price_eur'
   from public.auction_sale_history where source_url = 'https://www.vench.fr/vente-801'),
  '90000'::jsonb,
  'a business change is logged with its new value'
);

select ok(
  not (select changed_fields ? 'raw_payload'
       from public.auction_sale_history where source_url = 'https://www.vench.fr/vente-801'),
  'the raw payload never enters the log'
);

select is(
  (select raw_payload->'source_blocks'->>'description'
   from public.auction_sales where id = 'c8010000-1000-4000-8000-000000000001'),
  'encore',
  'the trigger leaves the stored row untouched'
);

select * from finish();

rollback;
