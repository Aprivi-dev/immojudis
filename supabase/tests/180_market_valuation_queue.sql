begin;

select plan(17);

select has_table(
  'public',
  'valuation_estimate_attempts',
  'every valuation attempt has an immutable operational audit table'
);
select has_function(
  'public',
  'claim_auction_sale_market_estimates',
  array['integer', 'timestamp with time zone', 'integer'],
  'valuation work can be claimed atomically'
);
select has_function(
  'public',
  'enqueue_auction_sale_market_estimate',
  array['uuid', 'integer', 'text', 'timestamp with time zone'],
  'a trusted server can prioritize a user-requested valuation'
);
select ok(
  has_function_privilege(
    'service_role',
    'public.claim_auction_sale_market_estimates(integer,timestamptz,integer)',
    'EXECUTE'
  ),
  'the trusted worker can claim valuation jobs'
);
select ok(
  not has_function_privilege(
    'authenticated',
    'public.claim_auction_sale_market_estimates(integer,timestamptz,integer)',
    'EXECUTE'
  ),
  'subscribers cannot claim internal valuation work'
);

select lives_ok(
  $$select public.evaluate_market_valuation_health(statement_timestamp())$$,
  'valuation health can synchronize its dedicated operational alert category'
);

set local role service_role;

select lives_ok(
  $$insert into public.auction_sales (
      source_name,
      source_url,
      status,
      address,
      city,
      postal_code,
      property_type,
      app_surface_m2,
      rooms_count
    ) values (
      'valuation-queue-test',
      'https://example.test/valuation-queue',
      'upcoming',
      '1 rue du Test',
      'Bordeaux',
      '33000',
      'apartment',
      50,
      2
    )$$,
  'inserting an active sale queues a valuation'
);

select is(
  (
    select priority
    from public.auction_sale_market_estimates queue
    join public.auction_sales sale on sale.id = queue.auction_sale_id
    where sale.source_url = 'https://example.test/valuation-queue'
  ),
  80,
  'new sales receive backlog priority'
);

update public.auction_sale_market_estimates queue
set
  status = 'ready',
  input_fingerprint = 'stable-input',
  estimate = '{"estimatedValueEur": 150000}'::jsonb,
  priority = 0,
  next_refresh_at = statement_timestamp() + interval '7 days'
from public.auction_sales sale
where sale.id = queue.auction_sale_id
  and sale.source_url = 'https://example.test/valuation-queue';

select lives_ok(
  $$update public.auction_sales
    set address = address
    where source_url = 'https://example.test/valuation-queue'$$,
  'an ingestion upsert may mention an unchanged valuation column'
);

select is(
  (
    select queue.status
    from public.auction_sale_market_estimates queue
    join public.auction_sales sale on sale.id = queue.auction_sale_id
    where sale.source_url = 'https://example.test/valuation-queue'
  ),
  'ready',
  'an unchanged ingestion update does not requeue the estimate'
);

select is(
  (
    select queue.input_fingerprint
    from public.auction_sale_market_estimates queue
    join public.auction_sales sale on sale.id = queue.auction_sale_id
    where sale.source_url = 'https://example.test/valuation-queue'
  ),
  'stable-input',
  'an unchanged ingestion update preserves the stable input fingerprint'
);

select lives_ok(
  $$update public.auction_sales
    set app_surface_m2 = 65
    where source_url = 'https://example.test/valuation-queue'$$,
  'a real valuation-input change is accepted'
);

select is(
  (
    select queue.status
    from public.auction_sale_market_estimates queue
    join public.auction_sales sale on sale.id = queue.auction_sale_id
    where sale.source_url = 'https://example.test/valuation-queue'
  ),
  'pending',
  'a real surface change requeues the estimate'
);

select is(
  (
    select count(*)::integer
    from public.claim_auction_sale_market_estimates(1, statement_timestamp(), 300)
  ),
  1,
  'the atomic claim returns one due valuation'
);

select is(
  (
    select queue.attempt_count
    from public.auction_sale_market_estimates queue
    join public.auction_sales sale on sale.id = queue.auction_sale_id
    where sale.source_url = 'https://example.test/valuation-queue'
  ),
  1,
  'claiming increments the attempt counter exactly once'
);

select lives_ok(
  $$select public.enqueue_auction_sale_market_estimate(
      sale.id,
      100,
      'user_requested',
      statement_timestamp()
    )
    from public.auction_sales sale
    where sale.source_url = 'https://example.test/valuation-queue'$$,
  'an authenticated server request can reprioritize in-flight work safely'
);

select is(
  (
    select queue.priority
    from public.auction_sale_market_estimates queue
    join public.auction_sales sale on sale.id = queue.auction_sale_id
    where sale.source_url = 'https://example.test/valuation-queue'
  ),
  100,
  'a user-requested valuation receives the highest priority'
);

select * from finish();

rollback;
