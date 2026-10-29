begin;

set local lock_timeout = '5s';

-- Règle de pépite pepite-v1.2 (validée le 29/10/2026) : le marché local de la commune se lit dans
-- app_private.commune_market_trends (migration 20261109130100), recalculée depuis public.dvf_transactions
-- (6,26 millions de lignes). Cet index sert ce calcul et toute lecture par commune et type de logement :
-- (insee_code, property_type, sale_date).
--
-- Même convention que 20261008121940 : la table est déjà grosse, donc la migration ENREGISTRE seulement la
-- construction (table app_private.concurrent_index_operations) ; l'index est construit `concurrently`, hors
-- transaction, par scripts/apply-supabase-concurrent-index-operations.mjs (npm run db:indexes:concurrent), à la
-- suite de l'application des migrations. Aucun verrou d'écriture n'est pris sur dvf_transactions. La définition
-- ci-dessous est recopiée mot pour mot dans la liste blanche du script, qui refuse d'exécuter tout SQL venu de la
-- base qui ne lui correspond pas.
--
-- Attention : « Replace the DVF table atomically » (workflow DVF Import, replace_existing) remplace
-- dvf_transactions par une table neuve qui ne porte que les index de services/data-pipeline/src/dvf_import.py ;
-- cet index disparaît alors avec l'ancienne table. Le relancer (npm run db:indexes:concurrent) le recrée sans
-- rien casser (create index concurrently if not exists).
insert into app_private.concurrent_index_operations (
  operation_key, schema_name, table_name, index_name, create_sql
)
values (
  '20261109130000:dvf_transactions_insee_type_sale_date_idx',
  'public',
  'dvf_transactions',
  'dvf_transactions_insee_type_sale_date_idx',
  'create index concurrently if not exists "dvf_transactions_insee_type_sale_date_idx" on "public"."dvf_transactions" ("insee_code", "property_type", "sale_date")'
)
on conflict (operation_key) do nothing;

commit;
