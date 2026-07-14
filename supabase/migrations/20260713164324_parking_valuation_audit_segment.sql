begin;

alter table public.valuation_estimates
  drop constraint if exists valuation_estimates_segment_check;

alter table public.valuation_estimates
  add constraint valuation_estimates_segment_check check (
    segment in ('apartment', 'house', 'building', 'commercial', 'land', 'parking')
  );

alter table public.auction_sale_market_estimates
  drop constraint if exists auction_sale_market_estimates_segment_check;

alter table public.auction_sale_market_estimates
  add constraint auction_sale_market_estimates_segment_check check (
    segment is null or segment in (
      'apartment', 'house', 'building', 'commercial', 'land', 'parking'
    )
  );

commit;
