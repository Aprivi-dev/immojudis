begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- Pilote automatique de l'agent d'information : la règle de l'article 14 ne se désactive plus, et son délai va de
-- 1 à 30 jours (J9 et P3 de l'état des lieux du 14/11/2026, lot B validé par le propriétaire le même jour).
-- L'article 14.3.a du RGPD fixe un délai « ne dépassant pas un mois » ; 20261110230000 admettait 1 à 365 jours et
-- une règle coupée par un simple réglage.
--
-- Sur public.information_agent_autopilot_settings (une seule ligne) :
--   1. art14_max_age_days : la contrainte de colonne de 20261110230000 (`between 1 and 365`, nom attribué d'office
--      information_agent_autopilot_settings_art14_max_age_days_check) est remplacée, sous le même nom, par
--      `between 1 and 30` ;
--   2. art14_rule_enabled : nouvelle contrainte information_agent_autopilot_settings_art14_rule_always_on, qui
--      refuse « faux ». La RPC update_information_agent_autopilot_settings n'est pas redéfinie : un réglage hors
--      bornes y échoue sur la contrainte (23514), après le refus de l'application (schéma de l'action).
--
-- Valeur par défaut : 30 jours et règle active (20261110230000), donc dans les nouvelles bornes. Une valeur posée
-- depuis par l'écran peut ne plus l'être (l'état des lieux du 14/11 note un réglage modifié ce jour-là, non
-- identifié). Aucune réparation ici (règle T17) : si la ligne est hors bornes, la migration s'arrête au premier
-- bloc avec un message qui dit quoi faire, avant toute modification, et la transaction est annulée.
--
-- Pourquoi pas NOT VALID puis VALIDATE : la table n'a qu'une ligne, la vérifier est immédiat et le verrou est le
-- même. Et une contrainte NOT VALID laissée sur une ligne hors bornes ferait échouer CHAQUE mise à jour de cette
-- ligne (une contrainte non validée s'applique quand même aux nouvelles versions des lignes), y compris l'arrêt
-- d'urgence et l'arrêt automatique. La contrainte est donc posée validée, après le contrôle explicite.
--
-- Verrous : ACCESS EXCLUSIVE bref sur public.information_agent_autopilot_settings (une ligne). Un passage du pilote
-- ou l'écran qui la lit attend au plus la durée de la migration ; lock_timeout de 5 s sinon. À appliquer de
-- préférence hors des plages de passage du pilote (9 h 30-11 h 30 et 14 h-16 h 30, heure de Paris).
--
-- Retour arrière, par une nouvelle migration (déconseillé : J9) :
--   alter table public.information_agent_autopilot_settings
--     drop constraint information_agent_autopilot_settings_art14_rule_always_on,
--     drop constraint information_agent_autopilot_settings_art14_max_age_days_check,
--     add constraint information_agent_autopilot_settings_art14_max_age_days_check
--       check (art14_max_age_days between 1 and 365);

do $$
declare
  v_enabled boolean;
  v_days integer;
begin
  select settings.art14_rule_enabled, settings.art14_max_age_days into v_enabled, v_days
  from public.information_agent_autopilot_settings settings
  where settings.singleton;
  if found and (v_enabled is distinct from true or v_days is null or v_days not between 1 and 30) then
    raise exception using
      errcode = '23514',
      message = 'Réglage du pilote hors des nouvelles bornes de l''article 14 (règle coupée ou délai hors de 1 à 30 jours) : aucune modification faite.',
      hint = 'Rétablir la règle et un délai de 30 jours au plus par Admin › Agent IA › Pilote (motif journalisé), puis appliquer de nouveau cette migration.';
  end if;
end;
$$;

alter table public.information_agent_autopilot_settings
  drop constraint if exists information_agent_autopilot_settings_art14_max_age_days_check;
alter table public.information_agent_autopilot_settings
  add constraint information_agent_autopilot_settings_art14_max_age_days_check
    check (art14_max_age_days between 1 and 30);
alter table public.information_agent_autopilot_settings
  drop constraint if exists information_agent_autopilot_settings_art14_rule_always_on;
alter table public.information_agent_autopilot_settings
  add constraint information_agent_autopilot_settings_art14_rule_always_on
    check (art14_rule_enabled);

comment on column public.information_agent_autopilot_settings.art14_rule_enabled is
  'Règle de l''article 14 du pilote : toujours vraie (contrainte information_agent_autopilot_settings_art14_rule_always_on, J9 du 14/11/2026).';
comment on column public.information_agent_autopilot_settings.art14_max_age_days is
  'Délai d''information de l''article 14, de 1 à 30 jours (art. 14.3.a RGPD ; J9 du 14/11/2026). Même borne côté application : AUTOPILOT_ART14_MAX_DAYS.';

commit;
