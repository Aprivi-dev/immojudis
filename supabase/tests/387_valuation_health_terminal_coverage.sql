begin;

select plan(8);

select has_function(
  'public',
  'evaluate_market_valuation_health',
  array['timestamp with time zone'],
  'valuation health remains a callable operational check'
);

select ok(
  has_function_privilege(
    'service_role',
    'public.evaluate_market_valuation_health(timestamptz)',
    'EXECUTE'
  ),
  'the operational worker retains valuation health access'
);

select ok(
  not has_function_privilege(
    'anon',
    'public.evaluate_market_valuation_health(timestamptz)',
    'EXECUTE'
  ),
  'anonymous clients cannot update operational alerts'
);

insert into public.auction_sales (source_name, source_url, status)
values (
  'valuation-health-test',
  'https://example.test/valuation-health-terminal-coverage',
  'upcoming'
);

select ok(
  exists (
    select 1
    from public.auction_sale_market_estimates queue
    join public.auction_sales sale on sale.id = queue.auction_sale_id
    where sale.source_url = 'https://example.test/valuation-health-terminal-coverage'
  ),
  'an active sale enters the valuation queue'
);

select lives_ok(
  $$select public.evaluate_market_valuation_health(statement_timestamp())$$,
  'valuation health can first observe pending work'
);

update public.auction_sale_market_estimates
set status = 'insufficient_data',
    estimate = null,
    next_refresh_at = statement_timestamp() + interval '1 day';

select is(
  (public.evaluate_market_valuation_health(statement_timestamp())->>'processed_pct')::numeric,
  100::numeric,
  'valid insufficient-data outcomes count as processed'
);

select is(
  (public.evaluate_market_valuation_health(statement_timestamp())->>'coverage_pct')::numeric,
  0::numeric,
  'estimate coverage remains separately visible as a data-quality diagnostic'
);

select is(
  (select status from public.operational_alerts
   where alert_key = 'valuation.queue.degraded'),
  'resolved',
  'an empty due queue with valid terminal outcomes resolves the stalled-queue alert'
);

select * from finish();

rollback;
