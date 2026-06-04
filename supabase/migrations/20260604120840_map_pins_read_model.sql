begin;

-- Lightweight public read model for /map.
-- Keep this view intentionally small: the map only needs pins and short popup
-- metadata, not documents, risks, score factors or full investor payloads.
create or replace view public.v_auction_map_pins
with (security_invoker = true)
as
select
  id,
  title,
  city,
  department,
  property_type,
  starting_price_eur,
  sale_date,
  latitude,
  longitude,
  occupancy_status,
  app_surface_m2,
  investment_score,
  score_confidence,
  status,
  created_at
from public.auction_sales_app_read
where id is not null
  and latitude is not null
  and longitude is not null
  and coalesce(status, 'unknown') in ('upcoming', 'unknown');

grant select on public.v_auction_map_pins to anon, authenticated;

notify pgrst, 'reload schema';

commit;
