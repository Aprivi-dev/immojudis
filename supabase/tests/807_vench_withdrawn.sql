-- 20261109153217 : Vench est retirée du catalogue ; sa collecte est arrêtée et ses ventes seules sont masquées.
begin;

select plan(4);

select ok(
  (select catalogue_withdrawn and not enabled from public.auction_source_state where source_name = 'vench'),
  'Vench is withdrawn and no longer collected'
);

select ok(
  'vench' = any (public.get_withdrawn_catalogue_sources()),
  'the site reads Vench as a withdrawn source'
);

insert into public.auction_sales (id, source_name, source_url, title, status, sale_date, raw_payload)
values
  ('c8070000-1000-4000-8000-000000000001', 'vench', 'https://www.vench.fr/vente-807-1', 'Vench seule',
   'upcoming', now() + interval '30 days', '{}'::jsonb),
  ('c8070000-1000-4000-8000-000000000002', 'licitor', 'https://www.licitor.com/annonce/807-2.html', 'Licitor',
   'upcoming', now() + interval '30 days', '{}'::jsonb);

select is(
  (select raw_payload->>'publication_quarantine' from public.auction_sales
   where id = 'c8070000-1000-4000-8000-000000000001'),
  'source_withdrawn',
  'a sale whose only source is Vench leaves the catalogue'
);

select is(
  (select raw_payload->>'publication_quarantine' from public.auction_sales
   where id = 'c8070000-1000-4000-8000-000000000002'),
  null,
  'a sale from another source stays in the catalogue'
);

select * from finish();

rollback;
