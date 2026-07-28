begin;

-- The official DVF resource repeats a mutation on local and parcel rows. The
-- importer now writes one canonical transaction per mutation so the database
-- does not store or statistically weight those repetitions.
drop index if exists public.dvf_transactions_source_mutation_parcel_uidx;

create unique index if not exists dvf_transactions_source_mutation_uidx
  on public.dvf_transactions (source, source_mutation_id);

comment on index public.dvf_transactions_source_mutation_uidx is
  'One canonical DVF transaction per source mutation; local and parcel source rows are aggregated by the importer.';

-- Current application queries use latitude/longitude bounding boxes and never
-- read the generated geography column. Removing it and its GiST index avoids
-- storing the same coordinates twice for millions of canonical mutations.
alter table public.dvf_transactions
  drop column if exists location;

-- These indexes are not used by any production query. The batch identifier is
-- retained for traceability, and price_per_m2 remains a stored generated value.
drop index if exists public.dvf_transactions_import_batch_idx;
drop index if exists public.dvf_transactions_price_per_m2_idx;

-- Match the actual comparable query: department equality plus a date window.
drop index if exists public.dvf_transactions_department_city_type_idx;
create index if not exists dvf_transactions_department_sale_date_idx
  on public.dvf_transactions (department, sale_date desc);

commit;
