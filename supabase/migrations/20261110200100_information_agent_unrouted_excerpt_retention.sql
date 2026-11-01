begin;

set local lock_timeout = '5s';

-- Minimisation des messages reçus sans dossier ouvert (relecture juridique du 01/11/2026) : l'extrait de texte
-- d'un message marqué « traité » est effacé (mis à NULL) 90 jours après son traitement. L'expéditeur, l'objet, la
-- date et le motif restent jusqu'à la fin de la durée du message (12 mois si l'expéditeur nous était connu, 21 jours
-- sinon, voir 20261110200000), qui supprime la ligne entière.
--
--   * Repère : handled_at, la date posée par « Marquer comme traité ». Un message encore « à traiter » garde son
--     extrait jusqu'à la fin de sa durée : l'extrait sert à le lire.
--   * La durée est une constante dans sa propre fonction (comme les autres) : la changer demande une migration
--     d'une fonction. Proposition du 01/11/2026, à confirmer par juridique-rgpd.
--   * Migration distincte de 20261110200000 pour ne pas réécrire une migration déjà poussée : la fonction de purge
--     est redéfinie à l'identique (suppression des lignes échues, même clé de rapport) avec l'étape de l'extrait
--     en plus. run_data_retention n'est pas modifiée : elle appelle déjà cette fonction.

create or replace function app_private.information_agent_unrouted_excerpt_retention()
returns interval
language sql
immutable
parallel safe
security invoker
set search_path = ''
as $$
  select interval '90 days';
$$;

revoke all on function app_private.information_agent_unrouted_excerpt_retention()
  from public, anon, authenticated;
grant execute on function app_private.information_agent_unrouted_excerpt_retention() to service_role;

comment on function app_private.information_agent_unrouted_excerpt_retention() is
  'Durée après laquelle l''extrait de texte d''un message sans dossier ouvert marqué « traité » est effacé, comptée depuis handled_at : 90 jours (à confirmer par juridique-rgpd). Les autres champs suivent la durée du message.';

create or replace function app_private.purge_information_agent_unrouted_messages(
  p_now timestamptz default statement_timestamp()
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted integer := 0;
  v_cleared integer := 0;
begin
  delete from public.information_agent_unrouted_messages message
  where message.created_at < p_now - case
    when message.sender_known then app_private.information_agent_unrouted_known_retention()
    else app_private.information_agent_unrouted_unknown_retention()
  end;
  get diagnostics v_deleted = row_count;

  -- L'extrait d'un message traité depuis plus de 90 jours est effacé ; le reste de la ligne demeure.
  update public.information_agent_unrouted_messages message
  set excerpt = null
  where message.status = 'handled'
    and message.excerpt is not null
    and message.handled_at < p_now - app_private.information_agent_unrouted_excerpt_retention();
  get diagnostics v_cleared = row_count;

  return pg_catalog.jsonb_build_object(
    'information_agent_unrouted_messages', v_deleted,
    'information_agent_unrouted_excerpts', v_cleared
  );
end;
$$;

revoke all on function app_private.purge_information_agent_unrouted_messages(timestamptz)
  from public, anon, authenticated;
grant execute on function app_private.purge_information_agent_unrouted_messages(timestamptz)
  to service_role;

comment on table public.information_agent_unrouted_messages is
  'Messages reçus à l''adresse de réponse de l''agent d''information sans dossier ouvert. Contenu non fiable, jamais analysé ni suivi d''une réponse ; lu seulement par l''écran d''administration et le résumé quotidien. Conservation : 12 mois (expéditeur connu) ou 21 jours (inconnu) ; l''extrait d''un message traité est effacé 90 jours après le traitement. Voir app_private.purge_information_agent_unrouted_messages.';

notify pgrst, 'reload schema';

commit;
