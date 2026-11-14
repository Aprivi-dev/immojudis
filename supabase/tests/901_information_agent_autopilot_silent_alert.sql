-- Pilote de l'agent muet (20261119101100) : l'application évalue la règle (40 minutes de plage ouverte sans passage
-- planifié, isAutopilotSilent) ; la base n'écrit que l'alerte information_agent.autopilot.silent. Un pilote muet
-- ouvre un avertissement, un passage planifié ou la fermeture de la plage le marque inactif (la résolution attend
-- deux heures calmes), la fonction est réservée au serveur.
begin;

select plan(9);

select ok(
  not has_function_privilege(
    'anon', 'public.sync_information_agent_autopilot_silent_alert(boolean, jsonb)', 'execute'
  )
  and not has_function_privilege(
    'authenticated', 'public.sync_information_agent_autopilot_silent_alert(boolean, jsonb)', 'execute'
  ),
  'the browser roles cannot raise the autopilot silence alert'
);
select ok(
  has_function_privilege(
    'service_role', 'public.sync_information_agent_autopilot_silent_alert(boolean, jsonb)', 'execute'
  ),
  'service_role raises the autopilot silence alert'
);

delete from public.operational_alerts where alert_key = 'information_agent.autopilot.silent';

select public.sync_information_agent_autopilot_silent_alert(false, '{}'::jsonb);
select is(
  (select count(*) from public.operational_alerts where alert_key = 'information_agent.autopilot.silent'),
  0::bigint,
  'a pilot that is not silent writes no alert'
);

select public.sync_information_agent_autopilot_silent_alert(
  true,
  '{"mode": "simulation", "last_scheduled_run_at": null, "silent_after_minutes": 40}'::jsonb
);
select is(
  (select status || '/' || severity || '/' || category from public.operational_alerts
   where alert_key = 'information_agent.autopilot.silent'),
  'open/warning/cron',
  'a silent pilot opens a warning, in the category of the other agent alerts'
);
select is(
  (select notification_status from public.operational_alerts
   where alert_key = 'information_agent.autopilot.silent'),
  'pending',
  'the opening is queued for the existing notification channel'
);
select is(
  (select details ->> 'silent_after_minutes' from public.operational_alerts
   where alert_key = 'information_agent.autopilot.silent'),
  '40',
  'the alert carries the details given by the application'
);

select public.sync_information_agent_autopilot_silent_alert(false, '{}'::jsonb);
select is(
  (select status from public.operational_alerts where alert_key = 'information_agent.autopilot.silent'),
  'open',
  'a scheduled run does not resolve the alert at once (two clear hours needed)'
);
select isnt(
  (select inactive_since from public.operational_alerts
   where alert_key = 'information_agent.autopilot.silent'),
  null::timestamptz,
  'a scheduled run, or the window closing, marks the alert inactive'
);

select throws_ok(
  $$select public.sync_information_agent_autopilot_silent_alert(null, '{}'::jsonb)$$,
  '22023',
  null,
  'the alert state is required'
);

select * from finish();
rollback;
