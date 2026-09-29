begin;

select plan(5);

select ok(
  position(
    'precompute-valuations' in
      pg_get_functiondef('app_private.evaluate_operational_health(timestamptz)'::regprocedure)
  ) = 0,
  'manual valuation precompute is not classified as a stale periodic cron'
);

select ok(
  position(
    'cnb-lawyer-directory' in
      pg_get_functiondef('app_private.evaluate_operational_health(timestamptz)'::regprocedure)
  ) = 0,
  'manual CNB synchronization is not classified as a stale periodic cron'
);

select ok(
  position(
    'information-agent-inbound' in
      pg_get_functiondef('app_private.evaluate_operational_health(timestamptz)'::regprocedure)
  ) > 0,
  'the inbound worker remains covered by cron freshness monitoring'
);

select ok(
  position(
    'valuation.queue.degraded' in
      pg_get_functiondef('public.evaluate_market_valuation_health(timestamptz)'::regprocedure)
  ) > 0,
  'valuation queue degradation remains monitored independently'
);

select ok(
  position(
    'pipeline.enrichment.stalled' in
      pg_get_functiondef('public.observe_autonomous_pipeline(timestamptz)'::regprocedure)
  ) > 0,
  'enrichment queue stalling remains monitored independently'
);

select * from finish();

rollback;
