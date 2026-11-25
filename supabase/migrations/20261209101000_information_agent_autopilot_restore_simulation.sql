begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- Pilote automatique de l'agent d'information : correction du 25/11/2026, validée par le propriétaire le même jour.
--
-- Le 25/11/2026 à 10:01:36 UTC, l'arrêt d'urgence (public.stop_information_agent_autopilot) a été déclenché par
-- erreur. Il a mis le mode à « off » et effacé simulation_started_at, alors que la simulation tournait sans incident
-- depuis le 2026-11-14 10:47:15.380297+00 (évènement `mode_changed` du 14/11). La porte du mode réel exige 7 jours
-- de simulation depuis simulation_started_at (set_information_agent_autopilot_mode, 20261209100300 ;
-- autopilot-readiness.ts) : sans correction, l'horloge repartirait de zéro à la remise en route.
--
-- Réglage de la ligne unique, avec son journal, comme la levée du verrou `live_allowed` (20261209100900) : décision
-- du propriétaire de passer par une migration plutôt que par supabase/repairs/.
--
-- app_private.restore_information_agent_autopilot_simulation_20261125() :
--   * ne corrige QUE l'état décrit : mode « off », simulation_started_at nul, aucun arrêt automatique
--     (auto_stopped_at nul), dernier évènement du journal hors `run` = l'arrêt d'urgence du 25/11 à 10:01:36 UTC,
--     pris en simulation, et dernier `mode_changed` avant lui = la mise en simulation (depuis « off ») du 14/11 qui a
--     fixé la date rétablie. Sinon : exception 55000 explicite, rien n'est modifié (la transaction est annulée) ;
--   * remet mode = 'simulation' et simulation_started_at = 2026-11-14 10:47:15.380297+00 ; les autres colonnes ne
--     changent pas (updated_at mis à jour, comme 20261209100900) ;
--   * journalise un évènement `settings_changed`, acteur nul (le système), avant et après, motif de la décision,
--     sans adresse ;
--   * base où le pilote n'a jamais été mis en route (aucun `mode_changed` : rejeu des migrations en CI, base locale) :
--     rien à corriger, rien n'est écrit. Sans ce cas, le rejeu des migrations à partir de zéro échouerait.
-- La fonction reste en base pour le test pgTAP (920) ; réservée au propriétaire (aucun droit d'exécution accordé).
-- Une fois la correction faite, un second appel est refusé (le mode n'est plus « off »).
--
-- Contraintes et déclencheurs de public.information_agent_autopilot_settings : aucun déclencheur ; aucune contrainte
-- ne porte sur simulation_started_at. Les contraintes de l'article 14 (20261119100810, 20261209100200) restent
-- vérifiées : la ligne les respecte déjà et la borne de 30 jours ne vaut qu'en mode « live ».
--
-- Verrous : la ligne unique de public.information_agent_autopilot_settings (select … for update), le temps de la
-- transaction ; insertion d'une ligne dans le journal.
--
-- Retour arrière : public.stop_information_agent_autopilot (arrêt d'urgence) remet le mode à « off » et efface
-- simulation_started_at. La fonction peut être supprimée par une migration ultérieure, avec son test.

create or replace function app_private.restore_information_agent_autopilot_simulation_20261125()
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  c_simulation_started_at constant timestamptz := '2026-11-14 10:47:15.380297+00';
  v_settings public.information_agent_autopilot_settings%rowtype;
  v_stop public.information_agent_autopilot_events%rowtype;
  v_start public.information_agent_autopilot_events%rowtype;
begin
  select * into v_settings from public.information_agent_autopilot_settings where singleton for update;

  if not exists (select 1 from public.information_agent_autopilot_events e where e.kind = 'mode_changed') then
    return 'nothing_to_correct';
  end if;

  if v_settings.mode is distinct from 'off'
     or v_settings.simulation_started_at is not null
     or v_settings.auto_stopped_at is not null then
    raise exception using
      errcode = '55000',
      message = pg_catalog.format(
        'Pilote : état inattendu (mode %s, début de simulation %s, arrêt automatique %s) au lieu de « off », nul, nul : aucune modification faite.',
        coalesce(v_settings.mode, 'absent'), coalesce(v_settings.simulation_started_at::text, 'nul'),
        coalesce(v_settings.auto_stopped_at::text, 'nul')
      ),
      hint = 'Relire l''état du pilote (Admin › Agent IA › Pilote) et le journal avec le propriétaire avant toute autre correction.';
  end if;

  -- Dernier évènement hors passages : l'arrêt d'urgence du 25/11 à 10:01:36 UTC, pris en simulation.
  select * into v_stop
  from public.information_agent_autopilot_events e
  where e.kind <> 'run'
  order by e.at desc, e.id desc
  limit 1;
  if v_stop.kind is distinct from 'emergency_stop'
     or v_stop.at < '2026-11-25 10:01:36+00'::timestamptz
     or v_stop.at >= '2026-11-25 10:01:37+00'::timestamptz
     or v_stop.before_values ->> 'mode' is distinct from 'simulation' then
    raise exception using
      errcode = '55000',
      message = pg_catalog.format(
        'Pilote : le dernier évènement hors passages n''est pas l''arrêt d''urgence du 25/11/2026 à 10:01:36 UTC pris en simulation (trouvé : %s du %s, mode avant %s) : aucune modification faite.',
        coalesce(v_stop.kind, 'aucun'), coalesce(v_stop.at::text, 'nul'),
        coalesce(v_stop.before_values ->> 'mode', 'inconnu')
      ),
      hint = 'Relire le journal du pilote avec le propriétaire avant toute autre correction.';
  end if;

  -- La date rétablie est celle de la mise en simulation du 14/11 : dernier changement de mode avant l'arrêt, de
  -- « off » vers « simulation ». L'évènement est daté du début de sa transaction, simulation_started_at de son
  -- instruction (même appel de set_information_agent_autopilot_mode) : quelques millisecondes au plus avant.
  select * into v_start
  from public.information_agent_autopilot_events e
  where e.kind = 'mode_changed' and e.at < v_stop.at
  order by e.at desc, e.id desc
  limit 1;
  if v_start.after_values ->> 'mode' is distinct from 'simulation'
     or v_start.before_values ->> 'mode' is distinct from 'off'
     or v_start.at > c_simulation_started_at
     or v_start.at <= c_simulation_started_at - interval '1 minute' then
    raise exception using
      errcode = '55000',
      message = pg_catalog.format(
        'Pilote : le dernier changement de mode avant l''arrêt d''urgence n''est pas la mise en simulation du 14/11/2026 à 10:47:15 UTC (trouvé : %s vers %s, le %s) : aucune modification faite.',
        coalesce(v_start.before_values ->> 'mode', 'inconnu'), coalesce(v_start.after_values ->> 'mode', 'inconnu'),
        coalesce(v_start.at::text, 'nul')
      ),
      hint = 'Relire le journal du pilote avec le propriétaire avant toute autre correction.';
  end if;

  update public.information_agent_autopilot_settings
  set mode = 'simulation',
      simulation_started_at = c_simulation_started_at,
      updated_at = pg_catalog.statement_timestamp()
  where singleton;

  perform app_private.autopilot_log_event(
    'settings_changed', null, 'restore_simulation',
    pg_catalog.jsonb_build_object('mode', 'off', 'simulation_started_at', null),
    pg_catalog.jsonb_build_object('mode', 'simulation', 'simulation_started_at', c_simulation_started_at),
    'Correction 25/11 : arrêt d''urgence involontaire, simulation rétablie depuis le 14/11 (décision du propriétaire)',
    null,
    pg_catalog.jsonb_build_object('migration', '20261209101000', 'emergency_stop_event_id', v_stop.id)
  );
  return 'restored';
end;
$$;

revoke all on function app_private.restore_information_agent_autopilot_simulation_20261125()
  from public, anon, authenticated, service_role;

comment on function app_private.restore_information_agent_autopilot_simulation_20261125() is
  'Correction du 25/11/2026 (décision du propriétaire) : après l''arrêt d''urgence involontaire du 25/11 à 10:01:36 UTC, remet le pilote en simulation depuis le 2026-11-14 10:47:15.380297+00 et le journalise (settings_changed, acteur système). Refuse (55000) tout autre état ; rien à corriger sur une base où le pilote n''a jamais été mis en route. Appelée par la migration 20261209101000 ; aucun droit accordé.';

select app_private.restore_information_agent_autopilot_simulation_20261125();

commit;
