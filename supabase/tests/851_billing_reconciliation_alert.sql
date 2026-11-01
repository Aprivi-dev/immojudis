-- Alerte opérationnelle du rapprochement Stripe (20261110140100) : un écart ouvre l'alerte, un rapprochement
-- calme la marque inactive (la résolution attend deux heures calmes), la fonction est réservée au serveur.
begin;

select plan(9);

select ok(
  not has_function_privilege('anon', 'public.sync_billing_reconciliation_alert(boolean, jsonb)', 'execute')
  and not has_function_privilege('authenticated', 'public.sync_billing_reconciliation_alert(boolean, jsonb)', 'execute'),
  'the browser roles cannot raise the reconciliation alert'
);
select ok(
  has_function_privilege('service_role', 'public.sync_billing_reconciliation_alert(boolean, jsonb)', 'execute'),
  'service_role raises the reconciliation alert'
);

select is(
  (select count(*) from public.operational_alerts where alert_key = 'billing.reconciliation.mismatch'),
  0::bigint,
  'no alert before the first mismatch'
);

select public.sync_billing_reconciliation_alert(
  true,
  '{"discrepancy_count": 2, "kinds": {"stripe_access_database_closed": 2}}'::jsonb
);
select is(
  (select status || '/' || severity || '/' || category from public.operational_alerts
   where alert_key = 'billing.reconciliation.mismatch'),
  'open/critical/webhook',
  'a mismatch opens a critical alert'
);
select is(
  (select notification_status from public.operational_alerts
   where alert_key = 'billing.reconciliation.mismatch'),
  'pending',
  'the opening is queued for the existing notification channel'
);
select is(
  (select details ->> 'discrepancy_count' from public.operational_alerts
   where alert_key = 'billing.reconciliation.mismatch'),
  '2',
  'the alert carries the mismatch count'
);

select public.sync_billing_reconciliation_alert(false, '{"discrepancy_count": 0}'::jsonb);
select is(
  (select status from public.operational_alerts where alert_key = 'billing.reconciliation.mismatch'),
  'open',
  'a first clean reconciliation does not resolve the alert at once (two clear hours needed)'
);
select isnt(
  (select inactive_since from public.operational_alerts
   where alert_key = 'billing.reconciliation.mismatch'),
  null::timestamptz,
  'a clean reconciliation marks the alert inactive'
);

select throws_ok(
  $$select public.sync_billing_reconciliation_alert(null, '{}'::jsonb)$$,
  '22023',
  null,
  'the alert state is required'
);

select * from finish();
rollback;
