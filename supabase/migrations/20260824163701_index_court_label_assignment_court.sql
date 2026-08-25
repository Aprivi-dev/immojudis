begin;

create index auction_sale_court_label_assignments_court_idx
  on public.auction_sale_court_label_assignments(court_id, created_at desc);

commit;
