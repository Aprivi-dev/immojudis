begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- DÉPLOIEMENT : appliquer les migrations AVANT le code.
-- Pilote automatique de l'agent d'information : en mode RÉEL, le délai de l'article 14 est de 30 jours au plus
-- (relecture juridique du 23/11/2026, « Avis courts », point 4 : l'article 14.3.a du RGPD fixe l'information au plus
-- tard un mois après l'obtention des données ; 30 jours est un plafond, pas un réglage à allonger).
--
-- La règle est déjà toujours active, dans tous les modes (contrainte
-- information_agent_autopilot_settings_art14_rule_always_on, 20261119100810). Le délai reste réglable de 1 à 90 jours
-- (décision du propriétaire du 14/11/2026) EN SIMULATION ; une nouvelle contrainte de ligne,
-- information_agent_autopilot_settings_art14_live_max_days, refuse toute ligne en mode « live » dont le délai dépasse
-- 30 jours. Elle s'applique à toutes les écritures de la ligne, donc :
--   * public.set_information_agent_autopilot_mode refuse de passer en « live » avec un délai de plus de 30 jours ;
--   * public.update_information_agent_autopilot_settings refuse d'allonger le délai au-delà de 30 jours en « live ».
-- Les deux RPC ne sont pas redéfinies : leur écriture échoue sur la contrainte (23514), comme pour les bornes de
-- 20261119100810. L'application refuse avant elles avec un message lisible (contrôle de préparation `art14_live`,
-- AUTOPILOT_ART14_LIVE_MAX_DAYS, autopilot-readiness.ts). L'arrêt d'urgence et l'arrêt automatique passent toujours
-- (mode « off »), comme la pause (la ligne, déjà conforme, ne change pas de délai).
--
-- Aucune réparation ici (règle T17) : si la ligne est en « live » avec plus de 30 jours, la migration s'arrête avant
-- toute modification, avec un message qui dit quoi faire.
--
-- Verrous : ACCESS EXCLUSIVE bref sur public.information_agent_autopilot_settings (une ligne), comme 20261119100810.
--
-- Retour arrière, par une nouvelle migration :
--   alter table public.information_agent_autopilot_settings
--     drop constraint information_agent_autopilot_settings_art14_live_max_days;

do $$
begin
  if exists (
    select 1 from public.information_agent_autopilot_settings settings
    where settings.singleton and settings.mode = 'live' and settings.art14_max_age_days > 30
  ) then
    raise exception using
      errcode = '23514',
      message = 'Pilote en mode réel avec un délai de l''article 14 de plus de 30 jours : aucune modification faite.',
      hint = 'Ramener le délai à 30 jours au plus (ou repasser en simulation) par Admin › Agent IA › Pilote, puis appliquer de nouveau cette migration.';
  end if;
end;
$$;

alter table public.information_agent_autopilot_settings
  drop constraint if exists information_agent_autopilot_settings_art14_live_max_days;
alter table public.information_agent_autopilot_settings
  add constraint information_agent_autopilot_settings_art14_live_max_days
    check (mode <> 'live' or art14_max_age_days <= 30);

comment on constraint information_agent_autopilot_settings_art14_live_max_days
  on public.information_agent_autopilot_settings is
  'Mode réel : délai de l''article 14 de 30 jours au plus (art. 14.3.a RGPD, relecture juridique du 23/11/2026). Même borne côté application : AUTOPILOT_ART14_LIVE_MAX_DAYS.';

commit;
