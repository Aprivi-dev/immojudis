-- Migration 20261204100000 : copie commune des politiques robots.txt (table privée, rôle de service seulement) et
-- avertissement d'une source suspendue parce que son site ne répond plus.
begin;

select plan(12);

select ok(
  (select relrowsecurity from pg_class where oid = 'app_private.robots_policies'::regclass),
  'the shared robots.txt copy has row level security'
);

select ok(
  not has_table_privilege('anon', 'app_private.robots_policies', 'select')
  and not has_table_privilege('authenticated', 'app_private.robots_policies', 'select')
  and not has_table_privilege('anon', 'app_private.robots_policies', 'insert')
  and not has_table_privilege('authenticated', 'app_private.robots_policies', 'update'),
  'no client role reads or writes the shared robots.txt copy'
);

select ok(
  has_table_privilege('service_role', 'app_private.robots_policies', 'select')
  and has_table_privilege('service_role', 'app_private.robots_policies', 'insert')
  and has_table_privilege('service_role', 'app_private.robots_policies', 'update'),
  'the service role keeps the shared copy'
);

select throws_ok(
  $$insert into app_private.robots_policies (origin, rules, verified_at) values
    ('https://example.test:443', '[]'::jsonb, now())$$,
  '23514',
  null,
  'a copy without the user agent digest is refused'
);

select throws_ok(
  $$insert into app_private.robots_policies (origin, last_failure_class, last_failure_at) values
    ('https://example.test:443', 'allowed', now())$$,
  '23514',
  null,
  'an unknown failure class is refused (a refusal is never stored as a policy)'
);

select lives_ok(
  $$insert into app_private.robots_policies (origin, last_failure_class, last_failure_at) values
    ('https://example.test:443', 'no_tcp_response', now())$$,
  'a failure alone is recorded'
);

select ok(
  not has_function_privilege('service_role', 'app_private.sync_source_suspension_alerts(timestamptz)', 'execute')
  and not has_function_privilege('anon', 'app_private.sync_source_suspension_alerts(timestamptz)', 'execute'),
  'the alert sync is only run by the pipeline owner role'
);

-- Rollback-only fixture.
delete from public.operational_alerts where alert_key like 'pipeline.source.pgtap-908-%';
insert into public.auction_source_state (source_name, enabled, next_inventory_at, suspended_until, suspension_reason,
                                         coverage)
values
  ('pgtap-908-down', true, statement_timestamp() + interval '7 days', statement_timestamp() + interval '7 days',
   'source_unreachable: no answer since 2026-11-15T00:00:00+00:00 (no_tcp_response)',
   '{"failure_class": "no_tcp_response", "unreachable_since": "2026-11-15T00:00:00+00:00"}'::jsonb),
  ('pgtap-908-refused', true, statement_timestamp() + interval '1 day', statement_timestamp() + interval '1 day',
   'Persistent source-detail access refusal', '{}'::jsonb);

select is(
  app_private.sync_source_suspension_alerts(statement_timestamp()),
  1,
  'one source is suspended because its site does not answer'
);

select is(
  (
    select severity || ' ' || category || ' ' || status || ' ' || (details->>'failure_class')
      from public.operational_alerts
     where alert_key = 'pipeline.source.pgtap-908-down.suspended_unreachable'
  ),
  'warning import open no_tcp_response',
  'the warning opens with the class of the failure'
);

select ok(
  (
    select (details->>'resume_probe_at')::timestamptz > statement_timestamp() + interval '6 days'
      from public.operational_alerts
     where alert_key = 'pipeline.source.pgtap-908-down.suspended_unreachable'
  ),
  'the warning says when the probe decides the resumption'
);

select ok(
  not exists (
    select 1 from public.operational_alerts where alert_key = 'pipeline.source.pgtap-908-refused.suspended_unreachable'
  ),
  'a suspension for another reason opens no unreachable warning'
);

-- The probe answered: the source is no longer suspended. The warning closes after the usual two clear hours.
update public.auction_source_state
   set suspended_until = null, suspension_reason = null
 where source_name = 'pgtap-908-down';
select app_private.sync_source_suspension_alerts(statement_timestamp());
select app_private.sync_source_suspension_alerts(statement_timestamp() + interval '2 hours 1 minute');

select is(
  (
    select status
      from public.operational_alerts
     where alert_key = 'pipeline.source.pgtap-908-down.suspended_unreachable'
  ),
  'resolved',
  'the warning closes once the source answers again'
);

select * from finish();
rollback;
