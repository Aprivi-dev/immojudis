begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- Pilote automatique de l'agent d'information : marque « brouillon simulé » posée par la base (T8 de l'état des lieux
-- du 14/11/2026, lot B validé par le propriétaire le même jour).
--
-- Jusqu'ici, l'application lisait `metadata` du brouillon, y ajoutait `autopilot_simulated: true`, puis réécrivait
-- tout l'objet, sans lire les erreurs. Une lecture en échec donnait un objet vide : `metadata` était écrasé, le
-- brouillon perdait `trigger = autopilot` et passait pour celui d'un administrateur, ce qui écartait la vente du
-- pilote pour de bon.
--
-- public.mark_information_agent_autopilot_simulated(p_mission_id) fait la fusion en une seule instruction
-- (`metadata || '{"autopilot_simulated": true}'`) : aucune autre clé ne change, aucune lecture préalable. Refus
-- contrôlés :
--   * 22023 : identifiant absent ;
--   * P0002 : la mission n'est pas (ou plus) un brouillon du pilote (absente, envoyée, annulée, ou préparée par un
--     administrateur). Rien n'est écrit.
-- SECURITY INVOKER (relecture du lot B) : la fonction n'a besoin d'aucun droit que son seul appelant n'a pas déjà.
-- service_role, l'exécuteur du pilote, garde SELECT et UPDATE sur public.information_agent_missions
-- (20260824151027) et contourne la RLS. search_path vide ; exécutable par service_role seul.
--
-- Verrous : création d'une fonction (catalogue seulement) ; à l'appel, verrou de la seule ligne mise à jour.
-- Aucune donnée existante n'est modifiée par cette migration.
--
-- Retour arrière, par une nouvelle migration :
--   drop function if exists public.mark_information_agent_autopilot_simulated(uuid);
-- après avoir redéployé une application qui ne l'appelle plus.

create or replace function public.mark_information_agent_autopilot_simulated(p_mission_id uuid)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if p_mission_id is null then
    raise exception using errcode = '22023', message = 'Brouillon du pilote obligatoire.';
  end if;
  update public.information_agent_missions mission
  set metadata = mission.metadata || '{"autopilot_simulated": true}'::jsonb
  where mission.id = p_mission_id
    and mission.status = 'draft'
    and mission.metadata ->> 'trigger' = 'autopilot';
  if not found then
    raise exception using errcode = 'P0002',
      message = 'Brouillon du pilote introuvable : mission absente, qui n''est plus un brouillon, ou préparée par un administrateur.';
  end if;
end;
$$;

revoke all on function public.mark_information_agent_autopilot_simulated(uuid) from public, anon, authenticated;
grant execute on function public.mark_information_agent_autopilot_simulated(uuid) to service_role;

comment on function public.mark_information_agent_autopilot_simulated(uuid) is
  'Pilote automatique de l''agent d''information : ajoute autopilot_simulated = true au metadata d''un brouillon du pilote (fusion en une instruction, aucune autre clé modifiée). P0002 si la mission n''est pas un brouillon du pilote. Réservée à service_role.';

notify pgrst, 'reload schema';

commit;
