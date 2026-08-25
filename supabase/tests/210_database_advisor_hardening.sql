begin;

select plan(6);

select ok(
  (
    select function_row.proconfig @> array['search_path=""']::text[]
    from pg_proc function_row
    where function_row.oid = 'public.log_auction_sale_change()'::regprocedure
  ),
  'the auction-sale history trigger has an empty search path'
);

select ok(
  not has_function_privilege(
    'anon',
    'public.log_auction_sale_change()',
    'EXECUTE'
  ),
  'anonymous callers cannot execute the history trigger directly'
);

select ok(
  not has_function_privilege(
    'authenticated',
    'public.log_auction_sale_change()',
    'EXECUTE'
  ),
  'authenticated callers cannot execute the history trigger directly'
);

select ok(
  not has_function_privilege(
    'service_role',
    'public.log_auction_sale_change()',
    'EXECUTE'
  ),
  'the service role cannot bypass the table update path by invoking the trigger directly'
);

select ok(
  exists (
    select 1
    from pg_trigger trigger_row
    where trigger_row.tgrelid = 'public.auction_sales'::regclass
      and trigger_row.tgname = 'trg_log_auction_sale_change'
      and trigger_row.tgfoid = 'public.log_auction_sale_change()'::regprocedure
      and trigger_row.tgenabled = 'O'
      and not trigger_row.tgisinternal
  ),
  'the enabled auction-sale history trigger remains attached'
);

insert into public.auction_sales (
  id,
  source_name,
  source_url,
  title
) values (
  'c2100000-0000-4000-8000-000000000001',
  'advisor-hardening-test',
  'https://example.test/advisor-hardening/sale',
  'Before hardening test update'
);

set local role service_role;

update public.auction_sales
set title = 'After hardening test update'
where id = 'c2100000-0000-4000-8000-000000000001';

reset role;

select is(
  (
    select count(*)::integer
    from public.auction_sale_history
    where source_url = 'https://example.test/advisor-hardening/sale'
      and old_row->>'title' = 'Before hardening test update'
      and new_row->>'title' = 'After hardening test update'
  ),
  1,
  'trusted table updates still append exactly one history row'
);

select * from finish();

rollback;
