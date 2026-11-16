-- 20261202100000 : suivi des demandes de droits. Échéance de 14 jours pour une rétractation (déclencheur,
-- sans réécrire les lignes existantes), accusé de réception réel (acknowledged_at nul au dépôt), alertes
-- compliance.privacy_requests.* (échéance proche, dépassée, demande non prise en main), crédits non utilisés
-- lus par la garde avant effacement. Droits : service_role seul ; RLS de la table inchangée.
begin;

select plan(19);

-- Droits et RLS ------------------------------------------------------------------------------------------------
select ok(
  (select relrowsecurity from pg_class where oid = 'public.data_subject_requests'::regclass),
  'data_subject_requests keeps row level security'
);
select is(
  (select count(*)::integer from pg_policies
    where schemaname = 'public' and tablename = 'data_subject_requests'),
  0,
  'data_subject_requests has no policy: service_role only'
);
select ok(
  not has_table_privilege('anon', 'public.data_subject_requests', 'SELECT')
    and not has_table_privilege('authenticated', 'public.data_subject_requests', 'SELECT')
    and not has_table_privilege('authenticated', 'public.data_subject_requests', 'INSERT'),
  'browser roles still cannot read or write data_subject_requests'
);
select ok(
  (
    select procedure_row.prosecdef
      and procedure_row.proconfig @> array['search_path=""']::text[]
    from pg_proc procedure_row
    where procedure_row.oid = 'public.evaluate_privacy_request_health(timestamptz)'::regprocedure
  )
    and has_function_privilege('service_role', 'public.evaluate_privacy_request_health(timestamptz)', 'execute')
    and not has_function_privilege('anon', 'public.evaluate_privacy_request_health(timestamptz)', 'execute')
    and not has_function_privilege('authenticated', 'public.evaluate_privacy_request_health(timestamptz)', 'execute'),
  'evaluate_privacy_request_health is SECURITY DEFINER, empty search_path, service_role only'
);
select ok(
  (
    select procedure_row.prosecdef
      and procedure_row.proconfig @> array['search_path=""']::text[]
    from pg_proc procedure_row
    where procedure_row.oid = 'public.account_sale_unlock_credits(uuid)'::regprocedure
  )
    and has_function_privilege('service_role', 'public.account_sale_unlock_credits(uuid)', 'execute')
    and not has_function_privilege('anon', 'public.account_sale_unlock_credits(uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public.account_sale_unlock_credits(uuid)', 'execute'),
  'account_sale_unlock_credits is SECURITY DEFINER, empty search_path, service_role only'
);
select ok(
  not has_function_privilege('anon', 'app_private.set_data_subject_request_due_at()', 'execute')
    and not has_function_privilege('authenticated', 'app_private.set_data_subject_request_due_at()', 'execute'),
  'the due-date trigger function is not callable by browser roles'
);

-- Colonne acknowledged_at ------------------------------------------------------------------------------------
select is(
  (select is_nullable from information_schema.columns
    where table_schema = 'public' and table_name = 'data_subject_requests'
      and column_name = 'acknowledged_at'),
  'YES',
  'acknowledged_at may stay empty until the acknowledgement is sent'
);
select is(
  (select column_default from information_schema.columns
    where table_schema = 'public' and table_name = 'data_subject_requests'
      and column_name = 'acknowledged_at'),
  null,
  'acknowledged_at has no default: it reflects the real email'
);

set local role service_role;

-- Isolation : seules les demandes du test comptent pour les alertes.
delete from public.operational_alerts where alert_key like 'compliance.privacy_requests.%';
delete from public.data_subject_requests;

-- Échéance par type ----------------------------------------------------------------------------------------
insert into public.data_subject_requests (id, requester_email, request_type, submitted_at)
values
  ('90300000-0000-4000-8000-000000000001', 'a@example.test', 'contract_withdrawal',
   '2026-12-01T10:00:00Z');
insert into public.data_subject_requests (id, requester_email, request_type)
values ('90300000-0000-4000-8000-000000000002', 'b@example.test', 'erasure');

select is(
  (select due_at from public.data_subject_requests
    where id = '90300000-0000-4000-8000-000000000001'),
  '2026-12-15T10:00:00Z'::timestamptz,
  'a contract withdrawal is due 14 days after it was filed'
);
select ok(
  (select due_at = submitted_at + interval '1 month' from public.data_subject_requests
    where id = '90300000-0000-4000-8000-000000000002'),
  'other requests keep the one-month default'
);
select is(
  (select acknowledged_at from public.data_subject_requests
    where id = '90300000-0000-4000-8000-000000000002'),
  null,
  'a new request is not acknowledged before its email is sent'
);

update public.data_subject_requests
   set request_type = 'contract_withdrawal'
 where id = '90300000-0000-4000-8000-000000000002';
select ok(
  (select due_at = submitted_at + interval '1 month' from public.data_subject_requests
    where id = '90300000-0000-4000-8000-000000000002'),
  'existing rows are never rewritten by the trigger (insert only)'
);

-- Alertes --------------------------------------------------------------------------------------------------
delete from public.data_subject_requests;
insert into public.data_subject_requests (
  id, requester_email, request_type, status, submitted_at, due_at, completed_at, resolution_code
)
values
  -- Ouverte, échéance dans 5 jours, prise en main : « échéance proche ».
  ('90300000-0000-4000-8000-000000000011', 'c@example.test', 'erasure', 'in_review',
   '2026-11-15T09:00:00Z', '2026-12-15T09:00:00Z', null, null),
  -- Ouverte, échéance dépassée.
  ('90300000-0000-4000-8000-000000000012', 'd@example.test', 'access', 'identity_verification',
   '2026-10-01T09:00:00Z', '2026-11-01T09:00:00Z', null, null),
  -- Reçue il y a 4 jours, personne ne l'a prise en main.
  ('90300000-0000-4000-8000-000000000013', 'e@example.test', 'objection', 'received',
   '2026-12-06T09:00:00Z', '2027-01-06T09:00:00Z', null, null),
  -- Close : jamais comptée, même en retard.
  ('90300000-0000-4000-8000-000000000014', 'f@example.test', 'access', 'completed',
   '2026-09-01T09:00:00Z', '2026-10-01T09:00:00Z', '2026-09-20T09:00:00Z', 'done');

select is(
  public.evaluate_privacy_request_health('2026-12-10T09:00:00Z'),
  jsonb_build_object('due_soon', 1, 'overdue', 1, 'unacknowledged_operator', 1),
  'counts open requests due soon, overdue and left unacknowledged, never closed ones'
);
select results_eq(
  $$select alert_key, severity, status, category
      from public.operational_alerts
     where alert_key like 'compliance.privacy_requests.%'
     order by alert_key$$,
  $$values
      ('compliance.privacy_requests.due_soon'::text, 'warning'::text, 'open'::text, 'cron'::text),
      ('compliance.privacy_requests.overdue', 'critical', 'open', 'cron'),
      ('compliance.privacy_requests.unacknowledged_operator', 'warning', 'open', 'cron')$$,
  'opens the three compliance alerts with their severities'
);
select ok(
  (select details ? 'count' and not (details::text ilike '%@example.test%')
     from public.operational_alerts
    where alert_key = 'compliance.privacy_requests.overdue'),
  'alert details carry counts and dates, never a requester address'
);
select is(
  (select (details ->> 'warning_days')::integer from public.operational_alerts
    where alert_key = 'compliance.privacy_requests.due_soon'),
  7,
  'the due-soon alert states its seven-day threshold'
);

update public.data_subject_requests
   set status = 'completed', completed_at = '2026-12-10T10:00:00Z', resolution_code = 'done'
 where status <> 'completed';
select is(
  public.evaluate_privacy_request_health('2026-12-10T11:00:00Z'),
  jsonb_build_object('due_soon', 0, 'overdue', 0, 'unacknowledged_operator', 0),
  'nothing is counted once every request is closed'
);
-- Hystérésis commune (app_private.sync_operational_alert) : l'alerte se referme après deux heures au calme.
select public.evaluate_privacy_request_health('2026-12-10T13:30:00Z');
select is(
  (select count(*)::integer from public.operational_alerts
    where alert_key like 'compliance.privacy_requests.%' and status = 'resolved'),
  3,
  'the three alerts resolve after two quiet hours once every request is closed'
);

-- Crédits ---------------------------------------------------------------------------------------------------
select is(
  public.account_sale_unlock_credits('90300000-0000-4000-8000-0000000000ff'),
  0,
  'an account without purchase has no credit'
);

select * from finish();

rollback;
