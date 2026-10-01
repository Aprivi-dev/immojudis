begin;

-- The CNB directory and market valuation precompute are operator-triggered in
-- production. They remain callable routes, and valuation freshness is still
-- monitored by valuation.queue.degraded, but neither route is an expected
-- periodic worker for cron.stale while its scheduler is disabled.
do $$
declare
  definition text;
  updated_definition text;
begin
  definition := pg_get_functiondef(
    'app_private.evaluate_operational_health(timestamptz)'::regprocedure
  );

  -- Refuse to patch a function whose expected-job list changed shape. This
  -- keeps a later migration from silently dropping a newly added job.
  if position('(''precompute-valuations'', interval ''30 hours'')' in definition) = 0
    or position('(''cnb-lawyer-directory'', interval ''8 days'')' in definition) = 0
    or position('(''information-agent-inbound'', interval ''10 minutes'')' in definition) = 0 then
    raise exception
      'Operational health expected-jobs list changed; review manual job monitoring';
  end if;

  updated_definition := replace(
    definition,
    '(''precompute-valuations'', interval ''30 hours''),',
    ''
  );
  updated_definition := replace(
    updated_definition,
    E',\n      (''cnb-lawyer-directory'', interval ''8 days'')',
    ''
  );

  if updated_definition = definition then
    raise exception 'Manual operational jobs were not removed from cron.stale';
  end if;

  if updated_definition ~ E'\\(''information-agent-inbound'', interval ''10 minutes''\\),[[:space:]]*\\)' then
    raise exception 'Inbound freshness entry would leave a trailing comma';
  end if;

  execute updated_definition;
end;
$$;

notify pgrst, 'reload schema';

commit;
