-- v_auction_sales_app is defined with security_invoker = true, so the querying
-- role needs table-level SELECT on every table the view reads. The SELECT grants
-- had been dropped on auction_sales and its related read-model tables (tribunals
-- still had them), which made the view raise "permission denied for table
-- auction_sales" for the app roles → no listings.
--
-- Product decision: only authenticated (logged-in) users may read the sales data.
-- We grant SELECT to authenticated on the view's source tables; anon keeps no
-- table access (the public homepage stats, which run as anon, will not read the
-- view — accepted trade-off). RLS (auction_sales_public_read) still applies.

grant select on
  public.auction_sales,
  public.auction_risks,
  public.auction_risk_occurrences,
  public.auction_score_factors,
  public.auction_documents
to authenticated;
