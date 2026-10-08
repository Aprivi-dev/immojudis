begin;

-- A replay can arrive as the same source URL with a newer date and later be
-- corrected back to the date that retention already retired.  The original
-- UPDATE trigger only ran when source_url changed, so that correction could
-- bypass the tombstone fence.  Keep the source identity guard and also run it
-- when the observed sale date changes.
drop trigger if exists aaaa_auction_sales_retention_tombstone_guard_update
  on public.auction_sales;
create trigger aaaa_auction_sales_retention_tombstone_guard_update
before update on public.auction_sales
for each row
when (
  old.source_url is distinct from new.source_url
  or old.sale_date is distinct from new.sale_date
)
execute function app_private.prevent_retention_tombstone_reimport();

commit;
