begin;

-- Drop the superseded investor read-model table. The app reads auction_sales
-- directly via v_auction_sales_app; nothing reads this table and the pipeline
-- no longer writes to it (read-model code removed in df98d11). Its 6 indexes
-- drop with it. No dependent views (verified via pg_depend).
drop table if exists public.auction_sales_app_read;

notify pgrst, 'reload schema';

commit;
