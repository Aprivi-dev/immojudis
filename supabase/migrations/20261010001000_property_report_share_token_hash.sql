-- P4-08: store only a SHA-256 digest of property-report share tokens (like
-- user_sale_analysis_sets.share_token_hash). The raw token is shown once when the
-- link is created and never persisted again.
begin;
set local lock_timeout = '5s';

alter table public.saved_property_reports
  add column if not exists share_token_hash text
    check (share_token_hash is null or share_token_hash ~ '^[0-9a-f]{64}$');

-- Existing links keep working: hash the stored token, then erase the plaintext.
update public.saved_property_reports
   set share_token_hash = pg_catalog.encode(
         pg_catalog.sha256(pg_catalog.convert_to(share_token, 'UTF8')),
         'hex'
       )
 where share_token is not null
   and share_token_hash is null;

update public.saved_property_reports
   set share_token = null
 where share_token is not null;

create unique index if not exists saved_property_reports_share_token_hash_key
  on public.saved_property_reports (share_token_hash)
  where share_token_hash is not null;

comment on column public.saved_property_reports.share_token_hash is
  'SHA-256 (hex) of the opaque public share token. The token itself is never stored.';
comment on column public.saved_property_reports.share_token is
  'Deprecated: always null. Lookups use share_token_hash.';

commit;
