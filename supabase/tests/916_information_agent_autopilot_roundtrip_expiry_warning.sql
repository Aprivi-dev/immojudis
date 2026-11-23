-- Échéance de l'aller-retour du pilote (application : autopilotRoundtripExpiry, runAutopilotPass) : l'avertissement
-- information_agent.autopilot.warning.roundtrip_expiry passe par public.sync_information_agent_autopilot_warning, donc
-- par app_private.sync_operational_alert. Ouvert, il est notifié une fois ; tant qu'il reste ouvert, il n'est
-- renotifié qu'une fois par 24 heures (au plus un e-mail par jour), avec le détail du dernier passage (état expiré).
begin;

select plan(5);

delete from public.operational_alerts where alert_key = 'information_agent.autopilot.warning.roundtrip_expiry';

select public.sync_information_agent_autopilot_warning(
  'roundtrip_expiry', true, '{"state": "expiring", "age_days": 26}'::jsonb
);
select is(
  (select status || '/' || severity || '/' || category || '/' || notification_status
   from public.operational_alerts where alert_key = 'information_agent.autopilot.warning.roundtrip_expiry'),
  'open/warning/cron/pending',
  'more than 25 days: the warning opens and is queued for the owner notification'
);

-- Notification remise il y a une heure : les passages suivants (toutes les 10 minutes) ne renotifient pas.
update public.operational_alerts
set notification_status = 'delivered', notified_at = now() - interval '1 hour'
where alert_key = 'information_agent.autopilot.warning.roundtrip_expiry';
select public.sync_information_agent_autopilot_warning(
  'roundtrip_expiry', true, '{"state": "expiring", "age_days": 26}'::jsonb
);
select is(
  (select notification_status from public.operational_alerts
   where alert_key = 'information_agent.autopilot.warning.roundtrip_expiry'),
  'delivered',
  'a warning still open is not notified again within 24 hours'
);

-- 24 heures plus tard, l'attestation a expiré : un rappel, qui porte l'état expiré.
update public.operational_alerts
set notified_at = now() - interval '25 hours'
where alert_key = 'information_agent.autopilot.warning.roundtrip_expiry';
select public.sync_information_agent_autopilot_warning(
  'roundtrip_expiry', true, '{"state": "expired", "age_days": 30}'::jsonb
);
select is(
  (select notification_status || '/' || notification_event from public.operational_alerts
   where alert_key = 'information_agent.autopilot.warning.roundtrip_expiry'),
  'pending/updated',
  'after 24 hours the open warning is notified again (daily reminder)'
);
select is(
  (select details ->> 'state' from public.operational_alerts
   where alert_key = 'information_agent.autopilot.warning.roundtrip_expiry'),
  'expired',
  'the reminder carries the expired state'
);

-- Nouvelle attestation : l'avertissement est marqué inactif (la résolution attend deux heures calmes).
select public.sync_information_agent_autopilot_warning('roundtrip_expiry', false, '{}'::jsonb);
select ok(
  (select inactive_since is not null from public.operational_alerts
   where alert_key = 'information_agent.autopilot.warning.roundtrip_expiry'),
  'a fresh attestation marks the warning inactive'
);

select * from finish();
rollback;
