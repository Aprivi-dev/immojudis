begin;

select plan(1);

select ok(
  exists (
    select 1
    from pg_catalog.pg_indexes
    where schemaname = 'public'
      and tablename = 'auction_runs'
      and indexname = 'auction_runs_created_at_desc_idx'
      and indexdef like '%(created_at DESC NULLS LAST)%'
  ),
  'auction_runs is indexed by created_at DESC for the admin dashboard and quality report'
);

select * from finish();

rollback;
