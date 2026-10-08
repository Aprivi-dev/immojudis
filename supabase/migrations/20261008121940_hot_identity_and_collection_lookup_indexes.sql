begin;

set local lock_timeout = '5s';

-- These four indexes target tables that are already large in production.
-- Register them atomically, but execute their physical builds in the separate
-- autocommit operation runner. CREATE INDEX CONCURRENTLY cannot share the
-- migration runner's transaction and a normal CREATE INDEX would block writes.
create table if not exists app_private.concurrent_index_operations (
  operation_key text primary key,
  schema_name text not null,
  table_name text not null,
  index_name text not null unique,
  create_sql text not null,
  status text not null default 'pending'
    check (status in ('pending', 'running', 'applied', 'failed')),
  applied_at timestamptz,
  last_error text,
  created_at timestamptz not null default pg_catalog.statement_timestamp(),
  updated_at timestamptz not null default pg_catalog.statement_timestamp()
);

comment on table app_private.concurrent_index_operations is
  'Allowlisted large-index builds executed outside the atomic migration transaction; failed builds are resumable.';

alter table app_private.concurrent_index_operations enable row level security;
revoke all on table app_private.concurrent_index_operations
  from public, anon, authenticated, service_role;
grant select, update on table app_private.concurrent_index_operations to service_role;
drop policy if exists concurrent_index_operations_service_role
  on app_private.concurrent_index_operations;
create policy concurrent_index_operations_service_role
  on app_private.concurrent_index_operations
  for all to service_role
  using (true)
  with check (true);

insert into app_private.concurrent_index_operations (
  operation_key, schema_name, table_name, index_name, create_sql
)
values
  (
    '20261008102334:auction_sales_source_urls_gin_idx',
    'public',
    'auction_sales',
    'auction_sales_source_urls_gin_idx',
    'create index concurrently if not exists "auction_sales_source_urls_gin_idx" on "public"."auction_sales" using gin ("source_urls")'
  ),
  (
    '20261008102334:auction_sales_postal_code_idx',
    'public',
    'auction_sales',
    'auction_sales_postal_code_idx',
    'create index concurrently if not exists "auction_sales_postal_code_idx" on "public"."auction_sales" ("postal_code")'
  ),
  (
    '20261008102334:auction_collection_items_run_source_url_idx',
    'public',
    'auction_collection_items',
    'auction_collection_items_run_source_url_idx',
    'create index concurrently if not exists "auction_collection_items_run_source_url_idx" on "public"."auction_collection_items" ("run_id", "source_url")'
  ),
  (
    '20261008102334:auction_collection_items_run_canonical_source_url_idx',
    'public',
    'auction_collection_items',
    'auction_collection_items_run_canonical_source_url_idx',
    'create index concurrently if not exists "auction_collection_items_run_canonical_source_url_idx" on "public"."auction_collection_items" ("run_id", "canonical_source_url")'
  )
on conflict (operation_key) do nothing;

commit;
