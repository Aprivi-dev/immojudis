begin;

set local lock_timeout = '5s';

-- Supervision de la progression de l'agent d'information (audit du 23/10/2026, n° 48).
--
-- evaluate_operational_health vérifie que la tâche `information-agent-inbound` a réussi dans les dix
-- dernières minutes ; elle ne voit pas une mission ou une réponse qui n'avance plus alors que la
-- tâche réussit (une réponse qui échoue à chaque passage, un envoi interrompu, une exécution restée
-- « running »). Cette fonction, SÉPARÉE d'evaluate_operational_health (redéfinie par ailleurs), ouvre
-- trois alertes, avec la même mécanique que les autres évaluations (app_private.sync_operational_alert,
-- hystérésis comprise) :
--   information_agent.mission.stuck    mission en `sending` depuis plus de 30 minutes, sans date d'envoi
--   information_agent.inbound.stuck    réponse en file (queued, processing ou failed) qui n'avance plus
--                                      depuis plus de 30 minutes
--   information_agent.cron.blocked     exécution `information-agent-*` restée `running` plus de 30 minutes
--   information_agent.send.unverified  envoi dont le résultat est inconnu (délai Resend dépassé), à
--                                      vérifier dans Resend avant tout renvoi
-- Elle est appelée par evaluateOperationalHealth (src/lib/cron-jobs.ts), à côté des évaluations de
-- valorisation et du pipeline. Aucune donnée personnelle dans les détails : des nombres et des dates.
create or replace function public.evaluate_information_agent_health(
  p_now timestamptz default statement_timestamp()
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  stuck_mission_count integer;
  oldest_stuck_mission timestamptz;
  stuck_job_count integer;
  oldest_stuck_job timestamptz;
  blocked_run_count integer;
  oldest_blocked_run timestamptz;
  unverified_send_count integer;
  oldest_unverified_send timestamptz;
  details jsonb;
begin
  select count(*)::integer, min(coalesce(mission.approved_at, mission.updated_at))
  into stuck_mission_count, oldest_stuck_mission
  from public.information_agent_missions mission
  where mission.status = 'sending'
    and mission.sent_at is null
    and coalesce(mission.approved_at, mission.updated_at) < p_now - interval '30 minutes';

  select count(*)::integer, min(job.updated_at)
  into stuck_job_count, oldest_stuck_job
  from public.information_agent_inbound_jobs job
  where job.status in ('queued', 'processing', 'failed')
    and job.updated_at < p_now - interval '30 minutes'
    and greatest(job.available_at, coalesce(job.locked_at, job.available_at))
      < p_now - interval '30 minutes';

  select count(*)::integer, min(run.started_at)
  into blocked_run_count, oldest_blocked_run
  from public.operational_job_runs run
  where run.job_name like 'information-agent-%'
    and run.status = 'running'
    and run.started_at < p_now - interval '30 minutes';

  select count(*)::integer, min(mission.updated_at)
  into unverified_send_count, oldest_unverified_send
  from public.information_agent_missions mission
  where mission.status in ('sending', 'failed')
    and mission.metadata ->> 'send_outcome' = 'unverified';

  details := jsonb_build_object(
    'stuck_missions', stuck_mission_count,
    'oldest_stuck_mission_at', oldest_stuck_mission,
    'stuck_inbound_jobs', stuck_job_count,
    'oldest_stuck_inbound_job_at', oldest_stuck_job,
    'blocked_cron_runs', blocked_run_count,
    'oldest_blocked_cron_run_at', oldest_blocked_run,
    'unverified_sends', unverified_send_count,
    'oldest_unverified_send_at', oldest_unverified_send,
    'maximum_age_minutes', 30
  );

  perform app_private.sync_operational_alert(
    'information_agent.mission.stuck',
    'cron',
    'warning',
    jsonb_build_object(
      'count', stuck_mission_count,
      'oldest_at', oldest_stuck_mission,
      'maximum_age_minutes', 30
    ),
    stuck_mission_count > 0,
    p_now
  );

  perform app_private.sync_operational_alert(
    'information_agent.inbound.stuck',
    'cron',
    case when stuck_job_count >= 5 then 'critical' else 'warning' end,
    jsonb_build_object(
      'count', stuck_job_count,
      'oldest_at', oldest_stuck_job,
      'maximum_age_minutes', 30
    ),
    stuck_job_count > 0,
    p_now
  );

  perform app_private.sync_operational_alert(
    'information_agent.cron.blocked',
    'cron',
    'warning',
    jsonb_build_object(
      'count', blocked_run_count,
      'oldest_started_at', oldest_blocked_run,
      'maximum_age_minutes', 30
    ),
    blocked_run_count > 0,
    p_now
  );

  perform app_private.sync_operational_alert(
    'information_agent.send.unverified',
    'cron',
    'warning',
    jsonb_build_object(
      'count', unverified_send_count,
      'oldest_at', oldest_unverified_send
    ),
    unverified_send_count > 0,
    p_now
  );

  return details;
end;
$$;

revoke all on function public.evaluate_information_agent_health(timestamptz)
from public, anon, authenticated;
grant execute on function public.evaluate_information_agent_health(timestamptz)
to service_role;

comment on function public.evaluate_information_agent_health(timestamptz) is
  'Alertes de progression de l''agent d''information (mission en envoi, réponse en file, exécution bloquée, envoi à vérifier). Séparée d''evaluate_operational_health.';

notify pgrst, 'reload schema';

commit;
