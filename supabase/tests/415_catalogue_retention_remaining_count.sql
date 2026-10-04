begin;

select plan(6);

set local role service_role;

-- Both rows are past at p_now, but their historical retention deadlines are
-- still in the future (+24h).  The purge response must count the catalogue
-- deadline, not that legacy enrichment deadline.
insert into public.auction_sales (
  id,
  source_name,
  source_url,
  status,
  starting_price_eur,
  sale_date
)
values
  (
    '41500000-1000-4000-8000-000000000001',
    'retention-count-test',
    'https://example.test/415/remaining/1',
    'upcoming',
    10000,
    '2026-10-03 11:00:00Z'
  ),
  (
    '41500000-1000-4000-8000-000000000002',
    'retention-count-test',
    'https://example.test/415/remaining/2',
    'upcoming',
    11000,
    '2026-10-03 11:30:00Z'
  );

create temporary table first_retention_result on commit drop as
select public.purge_expired_auction_sales('2026-10-03 12:00:00Z'::timestamptz, 25) as result;

select is(
  (select (result->>'deleted')::integer from first_retention_result),
  1,
  'the first retention call deletes one row within its one-row transaction budget'
);
select is(
  (select (result->>'remaining')::integer from first_retention_result),
  1,
  'remaining counts the second catalogue-expired row despite its future legacy deadline'
);
select is(
  (select count(*)::integer from public.auction_sales where source_url like 'https://example.test/415/remaining/%'),
  1,
  'one expired fixture remains after the first call'
);

create temporary table second_retention_result on commit drop as
select public.purge_expired_auction_sales('2026-10-03 12:00:00Z'::timestamptz, 25) as result;

select is(
  (select (result->>'deleted')::integer from second_retention_result),
  1,
  'the next retention call deletes the remaining expired row'
);
select is(
  (select (result->>'remaining')::integer from second_retention_result),
  0,
  'remaining reaches zero after both catalogue-expired rows are removed'
);
select is(
  (select count(*)::integer from public.auction_sales where source_url like 'https://example.test/415/remaining/%'),
  0,
  'both retention fixtures are gone after two calls'
);

reset role;

select * from finish();
rollback;
