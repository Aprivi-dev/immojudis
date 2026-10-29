-- Règle de pépite pepite-v1.2 (migration 20261109130000) : l'index de dvf_transactions (insee_code, property_type,
-- sale_date) est enregistré comme construction différée, comme les index de 20261008121940 : la migration ne prend
-- aucun verrou sur la table de 6,26 millions de lignes ; le script d'index concurrents le construit hors transaction.
begin;
select plan(5);

select is(
  (
    select count(*)::integer
      from app_private.concurrent_index_operations
     where operation_key = '20261109130000:dvf_transactions_insee_type_sale_date_idx'
  ),
  1,
  'the commune market index has one deferred operation'
);

select is(
  (
    select create_sql
      from app_private.concurrent_index_operations
     where operation_key = '20261109130000:dvf_transactions_insee_type_sale_date_idx'
  ),
  'create index concurrently if not exists "dvf_transactions_insee_type_sale_date_idx" on "public"."dvf_transactions" ("insee_code", "property_type", "sale_date")',
  'the operation is the reviewed concurrent build on (insee_code, property_type, sale_date)'
);

select ok(
  (
    select schema_name = 'public'
       and table_name = 'dvf_transactions'
       and index_name = 'dvf_transactions_insee_type_sale_date_idx'
       and status in ('pending', 'applied')
      from app_private.concurrent_index_operations
     where operation_key = '20261109130000:dvf_transactions_insee_type_sale_date_idx'
  ),
  'the operation targets the reviewed table and index, and is never silently left failed'
);

select ok(
  not exists (
    select 1
      from app_private.concurrent_index_operations operation_row
     where operation_key = '20261109130000:dvf_transactions_insee_type_sale_date_idx'
       and status = 'applied'
       and not exists (
         select 1
           from pg_catalog.pg_class relation_row
           join pg_catalog.pg_namespace namespace_row
             on namespace_row.oid = relation_row.relnamespace
           join pg_catalog.pg_index index_row
             on index_row.indexrelid = relation_row.oid
          where namespace_row.nspname = operation_row.schema_name
            and relation_row.relname = operation_row.index_name
            and index_row.indisvalid
       )
  ),
  'an operation marked applied has a valid physical index'
);

select ok(
  has_table_privilege('service_role', 'app_private.concurrent_index_operations', 'SELECT')
  and not has_table_privilege('authenticated', 'app_private.concurrent_index_operations', 'SELECT')
  and not has_table_privilege('anon', 'app_private.concurrent_index_operations', 'SELECT'),
  'the operation table stays closed to the browser roles'
);

select * from finish();
rollback;
