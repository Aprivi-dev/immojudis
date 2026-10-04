begin;

select plan(7);

set local role service_role;

select lives_ok(
  $$insert into public.auction_sale_retention_tombstones(source_url, sale_date)
    values ('https://example.test/419/retired', '2000-01-01 12:00Z')$$,
  'a retention worker can record the date fence for an expired source'
);

select lives_ok(
  $$insert into public.auction_sales(
      id, source_name, source_url, status, starting_price_eur, sale_date
    ) values (
      '41900000-1000-4000-8000-000000000001',
      'retention-test',
      'https://example.test/419/retired',
      'upcoming',
      10000,
      '2099-01-01 12:00Z'
    )$$,
  'a later hearing at the same source URL can be reimported'
);

select throws_ok(
  $$update public.auction_sales
      set sale_date = '2000-01-01 12:00Z'
    where id = '41900000-1000-4000-8000-000000000001'$$,
  '23505',
  'This auction sale date was retired by retention.',
  'an update back to the tombstoned date is rejected'
);

select is(
  (
    select sale_date
    from public.auction_sales
    where id = '41900000-1000-4000-8000-000000000001'
  ),
  '2099-01-01 12:00Z'::timestamptz,
  'the rejected date correction leaves the later hearing unchanged'
);

select lives_ok(
  $$insert into public.auction_sales(
      id, source_name, source_url, status, starting_price_eur, sale_date
    ) values (
      '41900000-1000-4000-8000-000000000002',
      'retention-test',
      'https://example.test/419/other',
      'upcoming',
      10000,
      '2000-01-01 12:00Z'
    )$$,
  'a different source URL can carry the retired date before correction'
);

select throws_ok(
  $$update public.auction_sales
      set source_url = 'https://example.test/419/retired'
    where id = '41900000-1000-4000-8000-000000000002'$$,
  '23505',
  'This auction sale date was retired by retention.',
  'the source URL guard remains active on updates'
);

select is(
  (
    select source_url
    from public.auction_sales
    where id = '41900000-1000-4000-8000-000000000002'
  ),
  'https://example.test/419/other',
  'the rejected source correction leaves the original URL unchanged'
);

reset role;

select * from finish();
rollback;
