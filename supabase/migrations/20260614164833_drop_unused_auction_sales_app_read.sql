begin;

-- Drop the superseded investor read-model table. Move the lightweight map view
-- to the canonical source first: older environments still have the view
-- created by 20260604120840 and PostgreSQL correctly prevents dropping its
-- backing table while that dependency exists.
drop view if exists public.v_auction_map_pins;

drop table if exists public.auction_sales_app_read;

create view public.v_auction_map_pins
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
from public.auction_sales
where latitude is not null
  and longitude is not null
  and coalesce(status, 'unknown') in ('upcoming', 'unknown');

grant select on table public.v_auction_map_pins to authenticated;

notify pgrst, 'reload schema';

commit;
