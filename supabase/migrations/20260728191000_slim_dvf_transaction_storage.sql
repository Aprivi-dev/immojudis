begin;

-- Provenance belongs to dvf_import_batches and the application links to the
-- stable data.gouv dataset page. The JSON payload is only used transiently by
-- the importer while canonicalizing mutations. Per-row timestamps duplicate
-- immutable batch metadata. Removing these fields avoids repeating the same
-- values millions of times without changing any product query or model input.
drop trigger if exists immojudis_dvf_transactions_updated_at
on public.dvf_transactions;

alter table public.dvf_transactions
  drop column if exists source_url,
  drop column if exists raw_payload,
  drop column if exists source_last_seen_at,
  drop column if exists created_at,
  drop column if exists updated_at;

comment on table public.dvf_transactions is
  'Canonical DVF mutations used by plan-gated comparable, backtest, and valuation services. Import provenance is stored once in dvf_import_batches.';

commit;
