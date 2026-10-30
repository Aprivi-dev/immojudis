-- 20261110093117 : Petites Affiches est retirée ; une vente qu'elle partage avec une autre source reste visible.
begin;

select plan(3);

select ok(
  (select catalogue_withdrawn and not enabled from public.auction_source_state where source_name = 'petites_affiches'),
  'Petites Affiches is withdrawn and no longer collected'
);

insert into public.auction_sales (id, source_name, source_url, title, status, sale_date, observations, raw_payload)
values
  ('c8080000-1000-4000-8000-000000000001', 'petites_affiches',
   'https://www.petitesaffiches.fr/encheres-immobilieres/vente/immobiliere/j/une-maison-a-test-808001.html',
   'Petites Affiches et Vench', 'upcoming', now() + interval '30 days',
   '[{"source_name":"petites_affiches"},{"source_name":"vench"}]', '{}'::jsonb),
  ('c8080000-1000-4000-8000-000000000002', 'licitor', 'https://www.licitor.com/annonce/808-2.html',
   'Licitor et Petites Affiches', 'upcoming', now() + interval '30 days',
   '[{"source_name":"licitor"},{"source_name":"petites_affiches"}]', '{}'::jsonb);

select is(
  (select raw_payload->>'publication_quarantine' from public.auction_sales
   where id = 'c8080000-1000-4000-8000-000000000001'),
  'source_withdrawn',
  'a sale known only through Petites Affiches and Vench leaves the catalogue'
);

select is(
  (select raw_payload->>'publication_quarantine' from public.auction_sales
   where id = 'c8080000-1000-4000-8000-000000000002'),
  null,
  'a sale that Licitor also publishes stays in the catalogue'
);

select * from finish();

rollback;
