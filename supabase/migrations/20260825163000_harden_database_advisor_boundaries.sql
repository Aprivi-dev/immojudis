begin;

-- This function is only an AFTER UPDATE trigger. Browser and service roles do
-- not need to invoke it directly, and every relation used by its body is
-- schema-qualified. Pinning an empty search path removes ambient name lookup
-- from the audit path without changing trigger execution.
alter function public.log_auction_sale_change()
  set search_path = '';

revoke all on function public.log_auction_sale_change()
from public, anon, authenticated, service_role;

comment on function public.log_auction_sale_change() is
  'Writes material auction-sale updates to the immutable history table. Trigger-only; direct execution is revoked and name lookup is pinned.';

commit;
