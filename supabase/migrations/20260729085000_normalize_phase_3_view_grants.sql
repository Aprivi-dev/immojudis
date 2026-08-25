begin;

-- Keep the trusted worker privileges already used in production and make the
-- map view consistently read-only for authenticated application users.
grant select, insert, update, delete on table
  public.auction_sales_investment_candidates
to service_role;

revoke all on table public.v_auction_map_pins from authenticated;
grant select on table public.v_auction_map_pins to authenticated;

commit;
