-- Supervision de la progression de l'agent d'information (20261101150200) : fonction séparée
-- d'evaluate_operational_health, quatre alertes sur des nombres et des dates (aucune donnée personnelle).
begin;

select plan(13);

select has_function(
  'public',
  'evaluate_information_agent_health',
  array['timestamp with time zone'],
  'the information-agent health check is a callable operational check'
);
select ok(
  (
    select procedure_row.prosecdef
      and procedure_row.proconfig @> array['search_path=""']::text[]
      and has_function_privilege('service_role', procedure_row.oid, 'execute')
      and not has_function_privilege('anon', procedure_row.oid, 'execute')
      and not has_function_privilege('authenticated', procedure_row.oid, 'execute')
    from pg_proc procedure_row
    where procedure_row.oid = 'public.evaluate_information_agent_health(timestamptz)'::regprocedure
  ),
  'security definer with an empty search_path, closed to the browser roles, open to the server'
);
select ok(
  position('evaluate_operational_health' in pg_get_functiondef(
    'public.evaluate_information_agent_health(timestamptz)'::regprocedure
  )) = 0,
  'the check is separate from evaluate_operational_health'
);

delete from public.operational_alerts where alert_key like 'information_agent.%';
delete from public.operational_job_runs where job_name like 'information-agent-%';

-- Fixtures -----------------------------------------------------------------------------------------
insert into auth.users (id) values ('68700000-0000-4000-8000-000000000001');
insert into public.auction_sales (id, source_name, source_url, status)
values (
  '68700000-1000-4000-8000-000000000001',
  'information-agent-health-pgtap',
  'https://example.test/information-agent-health-pgtap',
  'upcoming'
);

insert into public.information_agent_missions (
  id, user_id, sale_id, status, recipient_email, subject, body_text, question_keys,
  missing_information, privacy_version, approved_at, updated_at, metadata
)
values
  -- en envoi depuis une heure, sans date d'envoi : bloquée
  ('68700000-2000-4000-8000-000000000001', '68700000-0000-4000-8000-000000000001',
   '68700000-1000-4000-8000-000000000001', 'sending', 'stuck-687@example.test',
   'Demande bloquée', 'Merci de transmettre les informations du dossier.',
   array['documents'], array['documents'], '687-pgtap',
   now() - interval '1 hour', now() - interval '1 hour', '{}'::jsonb),
  -- en envoi depuis cinq minutes : en cours normal
  ('68700000-2000-4000-8000-000000000002', '68700000-0000-4000-8000-000000000001',
   '68700000-1000-4000-8000-000000000001', 'sending', 'fresh-687@example.test',
   'Demande récente', 'Merci de transmettre les informations du dossier.',
   array['documents'], array['documents'], '687-pgtap',
   now() - interval '5 minutes', now() - interval '5 minutes', '{}'::jsonb),
  -- résultat d'envoi inconnu (délai Resend dépassé) : à vérifier
  ('68700000-2000-4000-8000-000000000003', '68700000-0000-4000-8000-000000000001',
   '68700000-1000-4000-8000-000000000001', 'failed', 'unverified-687@example.test',
   'Envoi à vérifier', 'Merci de transmettre les informations du dossier.',
   array['documents'], array['documents'], '687-pgtap',
   now() - interval '2 hours', now() - interval '2 hours',
   '{"send_outcome": "unverified"}'::jsonb);

insert into public.information_agent_cases (
  id, sale_id, created_by, status, recipient_email, normalized_recipient_email, subject, body_text,
  question_keys, missing_information
)
values (
  '68700000-3000-4000-8000-000000000001',
  '68700000-1000-4000-8000-000000000001',
  '68700000-0000-4000-8000-000000000001',
  'sent', 'job-687@example.test', 'job-687@example.test', 'Dossier de test',
  'Merci de transmettre les informations du dossier.',
  array['documents'], array['documents']
);
insert into public.information_agent_missions (
  id, user_id, sale_id, case_id, status, recipient_email, subject, body_text, question_keys,
  missing_information, privacy_version
)
values (
  '68700000-2000-4000-8000-000000000004', '68700000-0000-4000-8000-000000000001',
  '68700000-1000-4000-8000-000000000001', '68700000-3000-4000-8000-000000000001', 'draft',
  'job-687@example.test', 'Demande porteuse', 'Merci de transmettre les informations du dossier.',
  array['documents'], array['documents'], '687-pgtap'
);
insert into public.information_agent_messages (
  id, mission_id, case_id, user_id, direction, message_kind, delivery_status, subject, body_text
)
values
  ('68700000-4000-4000-8000-000000000001', '68700000-2000-4000-8000-000000000004',
   '68700000-3000-4000-8000-000000000001', '68700000-0000-4000-8000-000000000001',
   'inbound', 'reply', 'received', 'Réponse 1', 'Voici le document.'),
  ('68700000-4000-4000-8000-000000000002', '68700000-2000-4000-8000-000000000004',
   '68700000-3000-4000-8000-000000000001', '68700000-0000-4000-8000-000000000001',
   'inbound', 'reply', 'received', 'Réponse 2', 'Voici un autre document.');
insert into public.information_agent_inbound_jobs (
  id, message_id, case_id, provider_email_id, status, available_at, attachment_link_expires_at,
  created_at, updated_at
)
values
  -- en file depuis deux heures : ne progresse plus
  ('68700000-5000-4000-8000-000000000001', '68700000-4000-4000-8000-000000000001',
   '68700000-3000-4000-8000-000000000001', 'provider-687-a', 'queued',
   now() - interval '2 hours', now() + interval '1 day', now() - interval '2 hours',
   now() - interval '2 hours'),
  -- en file depuis une minute : normal
  ('68700000-5000-4000-8000-000000000002', '68700000-4000-4000-8000-000000000002',
   '68700000-3000-4000-8000-000000000001', 'provider-687-b', 'queued',
   now() - interval '1 minute', now() + interval '1 day', now() - interval '1 minute',
   now() - interval '1 minute');

insert into public.operational_job_runs (job_name, status, started_at)
values
  ('information-agent-inbound', 'running', now() - interval '1 hour'),
  ('information-agent-inbound', 'success', now() - interval '5 minutes');

-- Évaluation ----------------------------------------------------------------------------------------
select is(
  (public.evaluate_information_agent_health(now()) ->> 'stuck_missions')::integer,
  1,
  'a mission in sending for more than 30 minutes without a send date is stuck, a recent one is not'
);
select is(
  (public.evaluate_information_agent_health(now()) ->> 'stuck_inbound_jobs')::integer,
  1,
  'a queued reply that has not moved for more than 30 minutes is stuck, a recent one is not'
);
select is(
  (public.evaluate_information_agent_health(now()) ->> 'blocked_cron_runs')::integer,
  1,
  'an information-agent run left running for more than 30 minutes is blocked'
);
select is(
  (public.evaluate_information_agent_health(now()) ->> 'unverified_sends')::integer,
  1,
  'a send whose outcome is unknown is reported'
);
select is(
  (
    select array_agg(alert.alert_key order by alert.alert_key)
    from public.operational_alerts alert
    where alert.alert_key like 'information_agent.%' and alert.status = 'open'
  ),
  array[
    'information_agent.cron.blocked',
    'information_agent.inbound.stuck',
    'information_agent.mission.stuck',
    'information_agent.send.unverified'
  ],
  'the four alerts are open'
);
select is(
  (
    select alert.details ->> 'count'
    from public.operational_alerts alert
    where alert.alert_key = 'information_agent.mission.stuck'
  ),
  '1',
  'the alert carries counts, not addresses'
);
select ok(
  not exists (
    select 1
    from public.operational_alerts alert
    where alert.alert_key like 'information_agent.%'
      and alert.details::text ~* '687@example\.test'
  ),
  'no address in the alert details'
);

-- Rien ne bloque : aucune alerte ne s'ouvre pour une base saine.
delete from public.operational_alerts where alert_key like 'information_agent.%';
delete from public.information_agent_inbound_jobs;
delete from public.operational_job_runs where job_name like 'information-agent-%';
delete from public.information_agent_missions where recipient_email like '%-687@example.test';
select is(
  public.evaluate_information_agent_health(now()),
  jsonb_build_object(
    'stuck_missions', 0,
    'oldest_stuck_mission_at', null,
    'stuck_inbound_jobs', 0,
    'oldest_stuck_inbound_job_at', null,
    'blocked_cron_runs', 0,
    'oldest_blocked_cron_run_at', null,
    'unverified_sends', 0,
    'oldest_unverified_send_at', null,
    'maximum_age_minutes', 30
  ),
  'a healthy agent reports nothing'
);
select is(
  (select count(*) from public.operational_alerts
   where alert_key like 'information_agent.%' and status = 'open'),
  0::bigint,
  'and opens no alert'
);
set local role anon;
select throws_ok(
  $$select public.evaluate_information_agent_health(now())$$,
  '42501',
  null,
  'the check is closed to anonymous clients'
);
reset role;

select * from finish();
rollback;
