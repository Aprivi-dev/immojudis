begin;

select plan(3);

select ok(
  position(
    'lock table public.auction_sales in share row exclusive mode nowait' in
    lower(pg_catalog.pg_get_functiondef(
      'public.purge_expired_auction_sales(timestamptz,integer)'::regprocedure
    ))
  ) > 0,
  'retention never waits for a conflicting catalogue writer'
);

select ok(
  position(
    'when lock_not_available then' in
    lower(pg_catalog.pg_get_functiondef(
      'public.purge_expired_auction_sales(timestamptz,integer)'::regprocedure
    ))
  ) > 0,
  'lock contention returns a retryable busy result'
);

select ok(
  position(
    'limit least(p_limit,1)' in
    lower(pg_catalog.pg_get_functiondef(
      'public.purge_expired_auction_sales(timestamptz,integer)'::regprocedure
    ))
  ) > 0,
  'each RPC archives at most one sale inside the SQL statement budget'
);

select * from finish();

rollback;
