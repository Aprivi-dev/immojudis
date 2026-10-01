begin;

set local lock_timeout = '5s';

-- Keep the existing anonymous preview allow-list and coordinate requirement
-- intact.  The missing publication marker guard is the concrete leak fix.
alter policy auction_sales_public_preview_read
on public.auction_sales
to anon
using (
  coalesce(status, 'unknown') in ('upcoming', 'unknown')
  and latitude is not null
  and longitude is not null
  and coalesce(raw_payload->>'publication_quarantine', '') = ''
);

commit;
