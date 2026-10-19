begin;
-- L'offre de lancement (active par défaut, 20261028120000) donne l'accès Analyse à tout compte
-- connecté : ce test vérifie les règles d'un compte gratuit, il la coupe (annulé par le rollback).
update app_private.launch_offer set active = false where singleton;
select plan(4);
insert into public.auction_sales(id,source_name,source_url,city,status,sale_date,raw_payload)
values ('c3300000-0000-4000-8000-000000000001','catalogue-reserve','https://example.test/reserve/1','CatalogueReserveC330','postponed',now() + interval '30 days','{}'),
('c3300000-0000-4000-8000-000000000002','catalogue-reserve','https://example.test/reserve/2','CatalogueReserveC330','upcoming',now() + interval '30 days','{"publication_quarantine":"identity"}');
select is((select count(*) from public.v_auction_sales_app where city='CatalogueReserveC330'),1::bigint,'detail admits missing GPS and excludes critical quarantine');
set local role authenticated;
select is((select count(*) from public.v_auction_sales_discovery where city='CatalogueReserveC330'),1::bigint,'discovery admits missing GPS with unchanged premium redactions');
reset role;
set local role anon;
select is((select count(*) from public.search_auction_sales_preview_v4(p_city=>'CatalogueReserveC330')),1::bigint,'anonymous preview includes postponed and excludes quarantine');
select throws_ok($$select * from public.search_auction_sales_preview_v4(p_north=>50)$$,'42501','Protected filters are not available in the public preview.','map access boundary is preserved');
reset role;
select * from finish();
rollback;
