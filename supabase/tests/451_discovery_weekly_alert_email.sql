begin;
select plan(2);

select ok(
  pg_get_functiondef('app_private.enforce_geographic_alert_quota'::regproc) ~ $$new\.alert_frequency <> 'weekly'$$,
  'free alerts must use the weekly digest'
);
select ok(
  pg_get_functiondef('app_private.enforce_geographic_alert_quota'::regproc) !~ $$new\.alert_frequency <> 'daily'$$,
  'the daily-only rule for free alerts is gone'
);

select * from finish();
rollback;
