begin;

set local lock_timeout = '5s';

-- C1 (état des lieux du 08/11/2026) : à la fin de l'essai, une alerte quotidienne d'un compte
-- Découverte est réécrite en hebdomadaire (`persistAlertEvaluation`, src/lib/alert-matches.ts).
-- Rien ne la remettait en quotidien à la souscription de l'offre Analyse. Ce marqueur note la
-- réécriture automatique ; l'évaluation suivante d'un compte au droit Analyse durable remet
-- l'alerte en quotidien et efface le marqueur.
alter table public.user_alerts
  add column if not exists frequency_downgraded_at timestamptz;

comment on column public.user_alerts.frequency_downgraded_at is
  'Date à laquelle la fréquence a été repassée automatiquement de quotidienne à hebdomadaire (fin de l''essai Analyse). Effacée au retour en quotidien ou dès que la personne choisit elle-même une fréquence.';

-- Un choix de fréquence fait par la personne l'emporte : tout changement de fréquence qui ne
-- touche pas lui-même au marqueur l'efface, et l'alerte n'est plus remise en quotidien.
create or replace function app_private.clear_alert_frequency_downgrade_marker()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if new.alert_frequency is distinct from old.alert_frequency
    and new.frequency_downgraded_at is not distinct from old.frequency_downgraded_at
  then
    new.frequency_downgraded_at := null;
  end if;
  return new;
end;
$function$;

revoke all on function app_private.clear_alert_frequency_downgrade_marker()
  from public, anon, authenticated;

drop trigger if exists user_alerts_clear_frequency_downgrade_marker on public.user_alerts;
create trigger user_alerts_clear_frequency_downgrade_marker
  before update on public.user_alerts
  for each row
  execute function app_private.clear_alert_frequency_downgrade_marker();

-- Le marqueur n'est pas un critère : le poser ou l'effacer ne doit pas relancer une évaluation
-- complète de l'alerte (même liste que la migration 20261009183000, plus la nouvelle colonne).
create or replace function app_private.reset_alert_evaluation_on_change()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if (new.is_active and not old.is_active)
    or (to_jsonb(new) - array['updated_at', 'last_evaluated_at', 'last_match_count', 'name', 'alert_frequency', 'is_active', 'frequency_downgraded_at'])
      is distinct from
      (to_jsonb(old) - array['updated_at', 'last_evaluated_at', 'last_match_count', 'name', 'alert_frequency', 'is_active', 'frequency_downgraded_at'])
  then
    new.last_evaluated_at := null;
  end if;
  return new;
end;
$function$;

revoke all on function app_private.reset_alert_evaluation_on_change()
  from public, anon, authenticated;

notify pgrst, 'reload schema';

commit;
