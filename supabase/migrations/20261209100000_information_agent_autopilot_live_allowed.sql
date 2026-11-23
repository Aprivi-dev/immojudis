begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- Pilote automatique de l'agent d'information : levée du verrou `live_allowed` (décision du propriétaire du
-- 23/11/2026, envoi automatique aux avocats seulement).
--
-- `public.information_agent_autopilot_settings.live_allowed` (20261110230000) ne se lève que par migration : tant
-- qu'il vaut faux, public.set_information_agent_autopilot_mode refuse le mode réel, même appelée directement. Cette
-- migration le passe à vrai, et rien d'autre :
--   * le MODE NE CHANGE PAS : il reste celui en cours (« simulation » en production). Le passage en « Réel » reste un
--     geste du propriétaire, par le bouton, avec motif ; set_information_agent_autopilot_mode (définition de
--     20261119100500) garde toutes ses autres conditions : AIPD attestée, aller-retour vérifié depuis moins de
--     30 jours. Le contrôle de préparation de l'application (autopilot-readiness.ts) s'applique toujours, à
--     l'activation et à chaque passage ;
--   * la publication automatique sur les fiches n'est PAS concernée : ses verrous (`auto_locked`) ne sont pas
--     touchés ;
--   * comme tout changement de réglage, la levée est journalisée dans public.information_agent_autopilot_events
--     (`settings_changed`, acteur nul : le système), avec l'état avant et après.
--
-- Rejouable : la ligne n'est modifiée, et le journal écrit, que si le verrou était encore en place.
--
-- Verrous : une ligne de public.information_agent_autopilot_settings (ligne unique), le temps de l'instruction.
--
-- Retour arrière : une nouvelle migration repasse `live_allowed` à faux (même forme, journalisée). Le mode réel
-- déjà actif n'est pas coupé par elle : l'arrêt d'urgence (public.stop_information_agent_autopilot) le fait.

do $$
declare
  v_before public.information_agent_autopilot_settings%rowtype;
begin
  select * into v_before from public.information_agent_autopilot_settings where singleton for update;
  if not found or v_before.live_allowed then
    return;
  end if;

  update public.information_agent_autopilot_settings
  set live_allowed = true, updated_at = pg_catalog.statement_timestamp()
  where singleton;

  perform app_private.autopilot_log_event(
    'settings_changed', null, 'live_allowed',
    pg_catalog.jsonb_build_object('live_allowed', false, 'mode', v_before.mode),
    pg_catalog.jsonb_build_object('live_allowed', true, 'mode', v_before.mode),
    'Migration 20261209100000 : verrou du mode réel levé (décision du propriétaire du 23/11/2026). Mode inchangé.',
    null, '{}'::jsonb
  );
end;
$$;

commit;
