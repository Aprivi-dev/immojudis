begin;

set local lock_timeout = '5s';

-- Messages reçus à l'adresse de réponse de l'agent d'information SANS dossier ouvert (jeton absent ou inconnu,
-- dossier supprimé avec sa vente, dossier clos, jetons multiples). Jusqu'ici le webhook se contentait d'un
-- console.warn : un avocat qui répondait après la clôture du dossier n'était lu par personne.
--
-- Cette migration ajoute :
--   1. public.information_agent_unrouted_messages : expéditeur, objet, date, extrait texte borné (1 000
--      caractères), motif du non-rattachement, nombre de pièces jointes (leurs fichiers ne sont PAS conservés :
--      le circuit des pièces est rattaché à un dossier), état « à traiter » ou « traité ». AUCUNE extraction de
--      faits, AUCUNE réponse : la table n'est lue que par l'écran d'administration et le résumé quotidien.
--      RLS activée, AUCUN droit pour anon, authenticated ni public (règle des tables récentes, vérifiée par
--      scripts/check-security-invariants.mjs) : seul service_role y accède (webhook, purge, et routes
--      /api/admin/information-agent/unrouted, qui vérifient le rôle administrateur avant toute lecture ou
--      écriture). Un administrateur n'a donc pas d'accès direct par l'API de la base : il passe par ces routes.
--   2. Durées de conservation, alignées sur la matrice docs/data-retention-matrix.md :
--        - expéditeur connu (destinataire d'un dossier ou fiche du registre) : 12 mois, comme une demande envoyée
--          sans réponse rattachée ;
--        - expéditeur inconnu (jamais sollicité, le plus souvent du spam) : 21 jours, comme une adresse du registre
--          jamais utilisée pour un envoi (suppression au plus tard 28 jours après, la purge étant hebdomadaire).
--      Repère de date : created_at (l'instant où NOUS avons enregistré le message), non la date annoncée par le
--      fournisseur. LES DURÉES SONT DES PROPOSITIONS À FAIRE CONFIRMER PAR juridique-rgpd ; chacune tient dans sa
--      propre fonction app_private.*_retention().
--   3. app_private.purge_information_agent_unrouted_messages, ajoutée à public.run_data_retention comme seizième
--      purge isolée. run_data_retention est reprise à l'identique de sa dernière définition (20261110120300,
--      quinze parties) avec ce bloc en plus : une migration plus récente qui la redéfinit doit reprendre SA
--      définition et y garder ce bloc.
--
-- Aucune ligne existante n'est modifiée.

-- 1. Table ---------------------------------------------------------------------------------------------------
create table if not exists public.information_agent_unrouted_messages (
  id uuid primary key default gen_random_uuid(),
  -- Identifiant du message chez Resend : une livraison rejouée par le fournisseur n'écrit qu'une ligne.
  provider_email_id text not null,
  -- En-tête « From » tel que reçu, borné ; adresse normalisée à part (comparaison, effacement par adresse).
  sender text not null default '',
  sender_email text,
  subject text not null default '',
  received_at timestamptz not null,
  -- Extrait texte brut (1 000 caractères au plus). Nul quand le message n'a pas été lu chez Resend : un expéditeur
  -- inconnu ne coûte pas d'appel d'API (plafond de lectures du webhook).
  excerpt text,
  reason text not null,
  -- L'expéditeur figurait dans nos données (destinataire d'un dossier ou fiche du registre) : fixe la durée.
  sender_known boolean not null default false,
  -- Résultat SPF/DKIM/DMARC normalisé (pass, fail, unverified) ; nul quand le message n'a pas été lu.
  sender_authentication text,
  attachment_count integer not null default 0,
  -- Une demande d'arrêt d'un expéditeur authentifié a été inscrite à la liste d'opposition à la réception.
  opposition_recorded boolean not null default false,
  status text not null default 'pending',
  handled_at timestamptz,
  -- Identifiant de l'administrateur, sans clé étrangère : la ligne ne doit pas dépendre d'un compte.
  handled_by uuid,
  created_at timestamptz not null default now(),
  constraint information_agent_unrouted_messages_reason_check check (
    reason in ('no_token', 'unknown_case', 'case_not_open', 'token_mismatch')
  ),
  constraint information_agent_unrouted_messages_status_check check (
    (status = 'pending' and handled_at is null)
    or (status = 'handled' and handled_at is not null)
  ),
  constraint information_agent_unrouted_messages_size_check check (
    char_length(provider_email_id) between 1 and 200
    and char_length(sender) <= 320
    and char_length(subject) <= 500
    and (excerpt is null or char_length(excerpt) <= 1000)
    and attachment_count between 0 and 1000
  )
);

comment on table public.information_agent_unrouted_messages is
  'Messages reçus à l''adresse de réponse de l''agent d''information sans dossier ouvert. Contenu non fiable, jamais analysé ni suivi d''une réponse ; lu seulement par l''écran d''administration et le résumé quotidien. Conservation : 12 mois (expéditeur connu) ou 21 jours (inconnu), voir app_private.purge_information_agent_unrouted_messages.';

create unique index if not exists information_agent_unrouted_messages_provider_email_idx
  on public.information_agent_unrouted_messages (provider_email_id);
create index if not exists information_agent_unrouted_messages_pending_idx
  on public.information_agent_unrouted_messages (received_at desc)
  where status = 'pending';
create index if not exists information_agent_unrouted_messages_sender_email_idx
  on public.information_agent_unrouted_messages (sender_email)
  where sender_email is not null;
create index if not exists information_agent_unrouted_messages_created_idx
  on public.information_agent_unrouted_messages (created_at);

alter table public.information_agent_unrouted_messages enable row level security;

revoke all on table public.information_agent_unrouted_messages from public, anon, authenticated;
grant select, insert, update, delete on table public.information_agent_unrouted_messages to service_role;
-- Aucune politique : RLS sans politique refuse tout rôle soumis aux politiques ; service_role les contourne.

-- 2. Durées --------------------------------------------------------------------------------------------------
create or replace function app_private.information_agent_unrouted_known_retention()
returns interval
language sql
immutable
parallel safe
security invoker
set search_path = ''
as $$
  select interval '12 months';
$$;

create or replace function app_private.information_agent_unrouted_unknown_retention()
returns interval
language sql
immutable
parallel safe
security invoker
set search_path = ''
as $$
  select interval '21 days';
$$;

revoke all on function app_private.information_agent_unrouted_known_retention()
  from public, anon, authenticated;
revoke all on function app_private.information_agent_unrouted_unknown_retention()
  from public, anon, authenticated;
grant execute on function app_private.information_agent_unrouted_known_retention() to service_role;
grant execute on function app_private.information_agent_unrouted_unknown_retention() to service_role;

comment on function app_private.information_agent_unrouted_known_retention() is
  'Durée de conservation d''un message sans dossier ouvert dont l''expéditeur figurait dans nos données, comptée depuis created_at : 12 mois (à confirmer par juridique-rgpd).';
comment on function app_private.information_agent_unrouted_unknown_retention() is
  'Durée de conservation d''un message sans dossier ouvert dont l''expéditeur était inconnu, comptée depuis created_at : 21 jours (à confirmer par juridique-rgpd).';

-- 3. Purge ---------------------------------------------------------------------------------------------------
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
begin
  delete from public.information_agent_unrouted_messages message
  where message.created_at < p_now - case
    when message.sender_known then app_private.information_agent_unrouted_known_retention()
    else app_private.information_agent_unrouted_unknown_retention()
  end;
  get diagnostics v_deleted = row_count;
  return pg_catalog.jsonb_build_object('information_agent_unrouted_messages', v_deleted);
end;
$$;

revoke all on function app_private.purge_information_agent_unrouted_messages(timestamptz)
  from public, anon, authenticated;
grant execute on function app_private.purge_information_agent_unrouted_messages(timestamptz)
  to service_role;

-- 4. run_data_retention : dernière définition (20261110120300) + la seizième partie --------------------------
create or replace function public.run_data_retention(
  p_now timestamptz default statement_timestamp()
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_result jsonb := '{}'::jsonb;
  v_errors jsonb := '{}'::jsonb;
begin
  begin
    v_result := v_result || coalesce(app_private.purge_expired_operational_data(p_now), '{}'::jsonb);
  exception when others then
    v_errors := v_errors || pg_catalog.jsonb_build_object('purge_expired_operational_data', sqlstate);
    raise warning 'run_data_retention: purge_expired_operational_data failed (SQLSTATE %): %',
      sqlstate, sqlerrm;
  end;

  begin
    v_result := v_result || coalesce(app_private.purge_information_agent_data(p_now), '{}'::jsonb);
  exception when others then
    v_errors := v_errors || pg_catalog.jsonb_build_object('purge_information_agent_data', sqlstate);
    raise warning 'run_data_retention: purge_information_agent_data failed (SQLSTATE %): %',
      sqlstate, sqlerrm;
  end;

  begin
    v_result := v_result || coalesce(app_private.purge_offer_opening_notifications(p_now), '{}'::jsonb);
  exception when others then
    v_errors := v_errors
      || pg_catalog.jsonb_build_object('purge_offer_opening_notifications', sqlstate);
    raise warning 'run_data_retention: purge_offer_opening_notifications failed (SQLSTATE %): %',
      sqlstate, sqlerrm;
  end;

  begin
    v_result := v_result || coalesce(app_private.purge_sale_unlocks(p_now), '{}'::jsonb);
  exception when others then
    v_errors := v_errors || pg_catalog.jsonb_build_object('purge_sale_unlocks', sqlstate);
    raise warning 'run_data_retention: purge_sale_unlocks failed (SQLSTATE %): %',
      sqlstate, sqlerrm;
  end;

  begin
    v_result := v_result || coalesce(app_private.purge_account_product_events(p_now), '{}'::jsonb);
  exception when others then
    v_errors := v_errors || pg_catalog.jsonb_build_object('purge_account_product_events', sqlstate);
    raise warning 'run_data_retention: purge_account_product_events failed (SQLSTATE %): %',
      sqlstate, sqlerrm;
  end;

  begin
    v_result := v_result || coalesce(app_private.purge_followed_sale_snapshots(p_now), '{}'::jsonb);
  exception when others then
    v_errors := v_errors
      || pg_catalog.jsonb_build_object('purge_followed_sale_snapshots', sqlstate);
    raise warning 'run_data_retention: purge_followed_sale_snapshots failed (SQLSTATE %): %',
      sqlstate, sqlerrm;
  end;

  -- Journal des rappels d'audience (20261028130100) : 180 jours. Jusqu'ici appelée seulement par le cron
  -- des rappels, donc jamais quand les rappels sont en mode « off ».
  begin
    v_result := v_result || pg_catalog.jsonb_build_object(
      'sale_reminder_dispatches', public.purge_sale_reminder_dispatches()
    );
  exception when others then
    v_errors := v_errors
      || pg_catalog.jsonb_build_object('purge_sale_reminder_dispatches', sqlstate);
    raise warning 'run_data_retention: purge_sale_reminder_dispatches failed (SQLSTATE %): %',
      sqlstate, sqlerrm;
  end;

  -- Retours sur les signaux d'une vente (20261030110100) : 90 jours.
  begin
    v_result := v_result || coalesce(app_private.purge_sale_signal_feedback(p_now), '{}'::jsonb);
  exception when others then
    v_errors := v_errors || pg_catalog.jsonb_build_object('purge_sale_signal_feedback', sqlstate);
    raise warning 'run_data_retention: purge_sale_signal_feedback failed (SQLSTATE %): %',
      sqlstate, sqlerrm;
  end;

  -- Journal du récapitulatif hebdomadaire « Ma semaine » (20261030120100) : 180 jours. Purgé même quand
  -- l'envoi est fermé (WEEKLY_DIGEST_MODE=off).
  begin
    v_result := v_result || pg_catalog.jsonb_build_object(
      'weekly_digest_dispatches', public.purge_weekly_digest_dispatches()
    );
  exception when others then
    v_errors := v_errors
      || pg_catalog.jsonb_build_object('purge_weekly_digest_dispatches', sqlstate);
    raise warning 'run_data_retention: purge_weekly_digest_dispatches failed (SQLSTATE %): %',
      sqlstate, sqlerrm;
  end;

  -- Journal des alertes de résultat ou de remise en vente (20261030120200) : 180 jours. Purgé même quand
  -- l'envoi est fermé (SALE_RESULTS_MODE=off).
  begin
    v_result := v_result || pg_catalog.jsonb_build_object(
      'sale_result_dispatches', public.purge_sale_result_dispatches()
    );
  exception when others then
    v_errors := v_errors
      || pg_catalog.jsonb_build_object('purge_sale_result_dispatches', sqlstate);
    raise warning 'run_data_retention: purge_sale_result_dispatches failed (SQLSTATE %): %',
      sqlstate, sqlerrm;
  end;

  -- Instantanés d'estimation de marché avant l'audience (20261102110100) : 36 mois après l'audience.
  begin
    v_result := v_result || coalesce(app_private.purge_market_estimate_snapshots(p_now), '{}'::jsonb);
  exception when others then
    v_errors := v_errors
      || pg_catalog.jsonb_build_object('purge_market_estimate_snapshots', sqlstate);
    raise warning 'run_data_retention: purge_market_estimate_snapshots failed (SQLSTATE %): %',
      sqlstate, sqlerrm;
  end;

  -- Captures HTML du collecteur d'historique Licitor (20261110120300) : 90 jours après la dernière observation.
  begin
    v_result := v_result || coalesce(app_private.purge_licitor_captures(p_now), '{}'::jsonb);
  exception when others then
    v_errors := v_errors || pg_catalog.jsonb_build_object('purge_licitor_captures', sqlstate);
    raise warning 'run_data_retention: purge_licitor_captures failed (SQLSTATE %): %',
      sqlstate, sqlerrm;
  end;

  -- Motif libre d'une prolongation d'essai (20261110120300) : 24 mois après la fin de la prolongation.
  begin
    v_result := v_result || coalesce(app_private.purge_trial_extension_notes(p_now), '{}'::jsonb);
  exception when others then
    v_errors := v_errors || pg_catalog.jsonb_build_object('purge_trial_extension_notes', sqlstate);
    raise warning 'run_data_retention: purge_trial_extension_notes failed (SQLSTATE %): %',
      sqlstate, sqlerrm;
  end;

  -- Motif libre d'une attribution manuelle d'accès (20261110120300) : 24 mois après la fin de l'accès.
  begin
    v_result := v_result || coalesce(app_private.purge_manual_grant_notes(p_now), '{}'::jsonb);
  exception when others then
    v_errors := v_errors || pg_catalog.jsonb_build_object('purge_manual_grant_notes', sqlstate);
    raise warning 'run_data_retention: purge_manual_grant_notes failed (SQLSTATE %): %',
      sqlstate, sqlerrm;
  end;

  -- Cache des analyses LLM (20261110120300) : 180 jours.
  begin
    v_result := v_result || coalesce(app_private.purge_llm_analysis_cache(p_now), '{}'::jsonb);
  exception when others then
    v_errors := v_errors || pg_catalog.jsonb_build_object('purge_llm_analysis_cache', sqlstate);
    raise warning 'run_data_retention: purge_llm_analysis_cache failed (SQLSTATE %): %',
      sqlstate, sqlerrm;
  end;

  -- Messages reçus sans dossier ouvert (20261110200000) : 12 mois si l'expéditeur nous était connu, 21 jours sinon.
  begin
    v_result := v_result
      || coalesce(app_private.purge_information_agent_unrouted_messages(p_now), '{}'::jsonb);
  exception when others then
    v_errors := v_errors
      || pg_catalog.jsonb_build_object('purge_information_agent_unrouted_messages', sqlstate);
    raise warning 'run_data_retention: purge_information_agent_unrouted_messages failed (SQLSTATE %): %',
      sqlstate, sqlerrm;
  end;

  if v_errors <> '{}'::jsonb then
    v_result := v_result || pg_catalog.jsonb_build_object('purge_errors', v_errors);
  end if;
  return v_result;
end;
$$;

comment on function public.run_data_retention(timestamptz) is
  'Runs the sixteen retention purges, each isolated: a failing purge is logged and reported under purge_errors while the others still run and commit.';

revoke all on function public.run_data_retention(timestamptz)
  from public, anon, authenticated;
grant execute on function public.run_data_retention(timestamptz) to service_role;

notify pgrst, 'reload schema';

commit;
