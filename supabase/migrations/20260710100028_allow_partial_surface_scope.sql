begin;

alter table public.auction_sales
  drop constraint if exists auction_sales_surface_scope_check;

alter table public.auction_sales
  add constraint auction_sales_surface_scope_check
  check (
    surface_scope is null
    or surface_scope in ('total', 'room', 'annex', 'room_or_annex', 'land', 'unknown', 'partial')
  ) not valid;

alter table public.auction_sales
  validate constraint auction_sales_surface_scope_check;

notify pgrst, 'reload schema';

commit;
