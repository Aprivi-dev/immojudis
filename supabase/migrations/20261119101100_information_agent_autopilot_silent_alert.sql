-- Pilote de l'agent d'information muet (T5, état des lieux du 14/11/2026) : alerte opérationnelle
-- information_agent.autopilot.silent.
--
-- Le pilote n'est pas dans cron.stale, qui ne lui convient pas : sa liste attendue
-- (app_private.evaluate_operational_health) ne connaît que des délais fixes, sans plage horaire, et lit
-- operational_job_runs, où un passage arrêté par sa garde (hors plage, en pause, hors production faute de
-- VERCEL_ENV) compte comme un succès. Une panne de pg_cron, de Vault ou de VERCEL_ENV ne sonnait donc nulle part.
-- Ici, un passage ne compte que s'il a travaillé : son évènement « run » dans le journal du pilote.
--
-- La règle est évaluée par l'application, dans la santé opérationnelle (/api/cron/operational-health,
-- evaluateOperationalHealth), là où vivent déjà la plage d'envoi à l'heure de Paris (jours fériés et changements
-- d'heure compris, src/lib/information-agent/paris-time.ts) et la marque des passages lancés à la main
-- (AUTOPILOT_MANUAL_RUN_MARK, lue par loadLastAutopilotRunAt) : aucune des deux n'est recopiée ici. Règle :
-- autopilotSilence (src/lib/information-agent/autopilot-rules.ts), 40 minutes de plage ouverte cumulées depuis le
-- dernier passage planifié. Plage fermée, l'application n'appelle pas cette fonction : l'alerte garde son état et ne
-- se referme qu'après un passage planifié, pilote éteint, arrêté automatiquement ou en pause.
--
-- Comme public.sync_billing_reconciliation_alert (20261110140100) : app_private.sync_operational_alert est fermée
-- à tous les rôles, y compris service_role. Cette fonction publique, réservée à service_role, fixe la clé, la
-- catégorie (« cron », comme les autres alertes de l'agent) et la gravité (avertissement : un pilote muet n'envoie
-- rien, il retarde la simulation), et ne laisse passer que l'état (actif ou non) et le détail. Fermeture : deux
-- heures après que la condition a cessé (app_private.sync_operational_alert, 20261009184000). Aucune donnée n'est
-- écrite hors de public.operational_alerts ; aucune ligne existante n'est modifiée.
--
-- DÉPLOIEMENT : appliquer avant le code ou aussitôt après. Tant que la fonction manque, chaque passage
-- d'operational-health se termine en échec (« Could not find the function », visible dans operational_job_runs) ;
-- les autres évaluations et la remise des alertes ont lieu quand même.
--
-- Verrous : création d'une fonction. Possible pendant un import.
--
-- RETOUR ARRIÈRE : retirer l'appel d'evaluateOperationalHealth (code), puis
-- drop function public.sync_information_agent_autopilot_silent_alert(boolean, jsonb);
-- Une alerte information_agent.autopilot.silent déjà ouverte reste dans operational_alerts : ne pas la supprimer.
begin;

set local lock_timeout = '5s';

create or replace function public.sync_information_agent_autopilot_silent_alert(
  p_active boolean,
  p_details jsonb default '{}'::jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if p_active is null then
    raise exception using errcode = '22023', message = 'The autopilot silence alert state is required.';
  end if;
  perform app_private.sync_operational_alert(
    'information_agent.autopilot.silent',
    'cron',
    'warning',
    coalesce(p_details, '{}'::jsonb),
    p_active
  );
end;
$function$;

revoke all on function public.sync_information_agent_autopilot_silent_alert(boolean, jsonb)
  from public, anon, authenticated;
grant execute on function public.sync_information_agent_autopilot_silent_alert(boolean, jsonb)
  to service_role;

comment on function public.sync_information_agent_autopilot_silent_alert(boolean, jsonb) is
  'Ouvre ou referme l''alerte opérationnelle information_agent.autopilot.silent (pilote de l''agent sans passage planifié depuis 40 minutes de plage ouverte ; règle évaluée par l''application). Serveur seul (service_role).';

notify pgrst, 'reload schema';

commit;
