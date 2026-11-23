begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- Pilote automatique de l'agent d'information : l'aller-retour de réception est prouvé par l'attestation manuelle OU
-- par une réponse réelle (décision du 23/11/2026, transmise par le chef d'orchestre). Le propriétaire ne fait plus
-- d'envois manuels ni de test à la main ; une réponse réelle d'un professionnel prouve le chemin « Répondre à » depuis
-- un fournisseur extérieur, ce que le test interne prouvait.
--
-- 1. public.information_agent_roundtrip_proof(p_now) : preuve la plus récente, calculée À LA VOLÉE, sans rien écrire.
--    Deux sources :
--      * `attestation` : public.information_agent_operations.inbound_roundtrip_verified_at (bouton manuel, inchangé,
--        avec ses preuves : réponse de test reçue, domaine interne, 24 heures) ;
--      * `reply` : un message de public.information_agent_messages qui remplit TOUTES ces conditions :
--          - entrant (direction = 'inbound'), reçu par le vrai webhook : identifiant du fournisseur présent,
--            `metadata.imported_manually` explicitement faux (posé seulement par l'ingestion du webhook ; une réponse
--            consignée à la main porte vrai) et état de traitement de la file entrante présent ;
--          - expéditeur authentifié : `metadata.sender_authentication.status = 'pass'` (DMARC aligné et SPF ou DKIM,
--            normalizeInboundSenderAuthentication) ;
--          - expéditeur identique au destinataire du dossier : `metadata.sender_matches_recipient` vrai ;
--          - rattaché automatiquement (par le jeton de l'adresse de réponse) à un dossier ENVOYÉ (sent_at présent),
--            et reçu après cet envoi. Un message non routé reste dans information_agent_unrouted_messages : il ne compte
--            jamais.
--        Aucun domaine interne n'est exigé : l'expéditeur est un vrai tiers.
--    Rend au plus une ligne : date, nature (`attestation` ou `reply`) et dossier (pour `reply`). Jamais d'adresse.
--    Réservée à service_role (contrôle de préparation, écran, avertissement d'échéance).
-- 2. public.set_information_agent_autopilot_mode : reprise EN ENTIER de 20261119100500 (dernière définition), mêmes
--    droits et même search_path. Seuls changements : le garde du mode réel lit cette preuve au lieu de la seule
--    attestation (moins de 30 jours), et l'évènement `mode_changed` d'un passage en réel porte la preuve retenue
--    (`after_values.roundtrip_proof` : nature, date, dossier).
--
-- Rien n'est écrit, aucune attestation « système » n'est créée, aucune donnée existante n'est modifiée. Les réponses
-- déjà reçues comptent dès l'application, puisque la preuve est lue à la volée.
--
-- Verrous : aucun sur une table (CREATE OR REPLACE FUNCTION ne touche que le catalogue).
--
-- Retour arrière : rejouer la définition de public.set_information_agent_autopilot_mode de
-- 20261119100500_information_agent_autopilot_rearm.sql dans une nouvelle migration, puis
-- drop function public.information_agent_roundtrip_proof(timestamptz).

create or replace function public.information_agent_roundtrip_proof(p_now timestamptz default statement_timestamp())
returns table (proven_at timestamptz, source text, case_id uuid)
language sql
stable
security definer
set search_path = ''
as $$
  select proofs.proven_at, proofs.source, proofs.case_id
  from (
    select ops.inbound_roundtrip_verified_at as proven_at, 'attestation'::text as source, null::uuid as case_id
    from public.information_agent_operations ops
    where ops.singleton and ops.inbound_roundtrip_verified_at <= p_now
    union all
    (
      select coalesce(message.received_at, message.created_at), 'reply'::text, message.case_id
      from public.information_agent_messages message
      join public.information_agent_cases sent_case on sent_case.id = message.case_id
      where message.direction = 'inbound'
        and message.provider_message_id is not null
        and message.metadata ->> 'imported_manually' = 'false'
        and message.metadata ? 'inbound_processing'
        and message.metadata -> 'sender_authentication' ->> 'status' = 'pass'
        and message.metadata ->> 'sender_matches_recipient' = 'true'
        and sent_case.sent_at is not null
        and coalesce(message.received_at, message.created_at) >= sent_case.sent_at
        and coalesce(message.received_at, message.created_at) <= p_now
      order by coalesce(message.received_at, message.created_at) desc
      limit 1
    )
  ) proofs
  order by proofs.proven_at desc
  limit 1;
$$;

revoke all on function public.information_agent_roundtrip_proof(timestamptz) from public, anon, authenticated;
grant execute on function public.information_agent_roundtrip_proof(timestamptz) to service_role;

comment on function public.information_agent_roundtrip_proof(timestamptz) is
  'Preuve la plus récente de l''aller-retour de réception de l''agent, calculée à la volée : attestation manuelle (information_agent_operations) ou réponse réelle reçue par le webhook, expéditeur authentifié et identique au destinataire, rattachée automatiquement à un dossier envoyé. Rend la date, la nature (attestation, reply) et le dossier ; jamais d''adresse. Réservée à service_role.';

-- 2. Changement de mode : reprise EN ENTIER de 20261119100500, garde de l'aller-retour élargi ----------------------
create or replace function public.set_information_agent_autopilot_mode(p_mode text, p_reason text)
returns public.information_agent_autopilot_settings
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_before public.information_agent_autopilot_settings%rowtype;
  v_after public.information_agent_autopilot_settings%rowtype;
  v_actor uuid := (select auth.uid());
  -- Preuve d'aller-retour retenue (lue seulement pour le mode réel) ; nulles sinon.
  v_proof_at timestamptz;
  v_proof_source text;
  v_proof_case uuid;
begin
  if not public.is_admin() then
    raise exception using errcode = '42501', message = 'Admin access required.';
  end if;
  if p_mode is null or p_mode not in ('off', 'simulation', 'live') then
    raise exception using errcode = '22023', message = 'Mode inconnu.';
  end if;
  if p_reason is null or pg_catalog.char_length(pg_catalog.btrim(p_reason)) < 8 then
    raise exception using errcode = '22023', message = 'Motif obligatoire (8 caractères au moins).';
  end if;
  select * into v_before from public.information_agent_autopilot_settings where singleton for update;

  -- Reposer le mode en cours n'est pas un changement (ni journal, ni remise à zéro des marques) : 20261119100500.
  if v_before.mode = p_mode then
    raise exception using errcode = '22023', message = 'Le pilote est déjà dans ce mode.';
  end if;

  if p_mode = 'live' then
    if not v_before.live_allowed then
      raise exception using errcode = '55000', message = 'Mode réel non autorisé : les textes juridiques du lot 3 ne sont pas publiés.';
    end if;
    if v_before.aipd_attested_at is null then
      raise exception using errcode = '55000', message = 'Attestation d''AIPD manquante : le mode réel est refusé.';
    end if;
    -- Seul changement : l'aller-retour est prouvé par l'attestation manuelle OU par une réponse réelle authentifiée,
    -- rattachée automatiquement à son dossier (public.information_agent_roundtrip_proof), de moins de 30 jours.
    select proof.proven_at, proof.source, proof.case_id into v_proof_at, v_proof_source, v_proof_case
    from public.information_agent_roundtrip_proof(pg_catalog.statement_timestamp()) proof;
    if v_proof_at is null or v_proof_at <= pg_catalog.statement_timestamp() - interval '30 days' then
      raise exception using errcode = '55000', message = 'Aller-retour de réception non prouvé depuis 30 jours (ni attestation, ni réponse réelle authentifiée rattachée à son dossier) : le mode réel est refusé.';
    end if;
  end if;

  update public.information_agent_autopilot_settings s
  set mode = p_mode,
      acting_admin_id = coalesce(s.acting_admin_id, v_actor),
      simulation_started_at = case
        when p_mode = 'off' then null
        when p_mode = 'simulation' and s.mode = 'off' then pg_catalog.statement_timestamp()
        else s.simulation_started_at
      end,
      auto_stopped_at = null,
      auto_stop_reason = null,
      paused_until = null,
      updated_by = v_actor,
      updated_at = pg_catalog.statement_timestamp()
  where s.singleton
  returning * into v_after;

  perform app_private.autopilot_log_event(
    'mode_changed', v_actor, 'set_mode',
    pg_catalog.jsonb_build_object('mode', v_before.mode, 'auto_stopped', v_before.auto_stopped_at is not null),
    -- Passage en réel : la preuve d'aller-retour retenue est journalisée (date, nature, dossier ; jamais d'adresse).
    pg_catalog.jsonb_build_object('mode', v_after.mode)
      || case when p_mode = 'live' then pg_catalog.jsonb_build_object('roundtrip_proof', pg_catalog.jsonb_build_object(
        'source', v_proof_source, 'proven_at', v_proof_at, 'case_id', v_proof_case)) else '{}'::jsonb end,
    p_reason, null, '{}'::jsonb
  );
  -- Réactivation après un arrêt automatique : l'alerte critique est levée (manuellement, donc journalisée).
  if v_before.auto_stopped_at is not null then
    perform app_private.sync_operational_alert(
      'information_agent.autopilot.auto_stop', 'cron', 'critical', '{}'::jsonb, false, pg_catalog.statement_timestamp()
    );
  end if;
  return v_after;
end;
$$;

revoke all on function public.set_information_agent_autopilot_mode(text, text) from public, anon, authenticated;
grant execute on function public.set_information_agent_autopilot_mode(text, text) to authenticated, service_role;

notify pgrst, 'reload schema';

commit;
