begin;

select plan(2);

insert into public.auction_sales (id, source_name, source_url) values (
  '60000000-0000-0000-0000-000000000001',
  'avoventes',
  'https://avoventes.fr/enchere/source-identity-test'
);

select lives_ok(
  $$update public.auction_sales
    set title = 'Titre actualisé', source_name = 'avoventes'
    where id = '60000000-0000-0000-0000-000000000001'$$,
  'the owning source may update its existing sale'
);

select throws_ok(
  $$update public.auction_sales
    set source_name = 'licitor'
    where id = '60000000-0000-0000-0000-000000000001'$$,
  '23514',
  'auction_sales.source_name is immutable for an existing source_url',
  'a different source cannot overwrite an existing sale identity'
);

select * from finish();

rollback;
