-- Alerte opérationnelle du rapprochement Stripe quotidien (revue du 31/10/2026, n° 48).
--
-- La tâche /api/cron/billing-reconciliation compare chaque jour les abonnements Stripe et les droits en
-- base (src/lib/billing-reconciliation.ts). Un écart ouvre une alerte opérationnelle, livrée par le canal
-- existant (deliverOperationalAlertNotifications, passe operational-health) ; un rapprochement sans écart
-- la referme (app_private.sync_operational_alert ne résout qu'après deux heures calmes).
--
-- app_private.sync_operational_alert est fermée à tous les rôles (y compris service_role) : cette fonction
-- publique, réservée à service_role, fixe la clé, la catégorie et la gravité et ne laisse passer que l'état
-- (actif ou non) et le détail. Catégorie « webhook » (déjà permise par operational_alerts_category_check),
-- pour ne pas toucher la contrainte. Aucune donnée n'est écrite hors de public.operational_alerts.
--
-- DÉPLOIEMENT : appliquer la migration AVANT le code de la tâche (sans elle, la tâche échoue quand Stripe
-- est configuré, ce qui se voit dans operational_job_runs). RETOUR ARRIÈRE :
-- drop function public.sync_billing_reconciliation_alert(boolean, jsonb).
begin;

set local lock_timeout = '5s';

create or replace function public.sync_billing_reconciliation_alert(
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
    raise exception using errcode = '22023', message = 'The reconciliation alert state is required.';
  end if;
  -- operational_alerts.details est limité à 32 Ko : le détail est tronqué plutôt que de faire échouer
  -- l'alerte (le rapport complet reste dans le journal de la tâche).
  perform app_private.sync_operational_alert(
    'billing.reconciliation.mismatch',
    'webhook',
    'critical',
    case
      when pg_catalog.pg_column_size(coalesce(p_details, '{}'::jsonb)) <= 16384
        then coalesce(p_details, '{}'::jsonb)
      else pg_catalog.jsonb_build_object(
        'truncated_details', true,
        'discrepancy_count', p_details -> 'discrepancy_count'
      )
    end,
    p_active
  );
end;
$function$;

revoke all on function public.sync_billing_reconciliation_alert(boolean, jsonb)
  from public, anon, authenticated;
grant execute on function public.sync_billing_reconciliation_alert(boolean, jsonb)
  to service_role;

comment on function public.sync_billing_reconciliation_alert(boolean, jsonb) is
  'Ouvre ou referme l''alerte opérationnelle billing.reconciliation.mismatch (écart entre Stripe et les droits en base). Serveur seul (service_role).';

commit;
