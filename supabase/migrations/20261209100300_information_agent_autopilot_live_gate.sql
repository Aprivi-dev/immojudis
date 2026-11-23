begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- DÉPLOIEMENT : appliquer les migrations AVANT le code (le code lit public.information_agent_roundtrip_proof et
-- appelle public.record_information_agent_roundtrip_reply_proof ; sans elles, le pilote et l'écran échouent).
--
-- Pilote automatique de l'agent d'information : porte SQL du mode réel et preuve de l'aller-retour (lot du 23/11/2026,
-- relectures sécurité et Postgres de la PR #553).
--
-- 1. Preuve de l'aller-retour de réception, sans clic : l'attestation manuelle OU une réponse réelle.
--    a. public.information_agent_roundtrip_reply_proofs(p_now) : les réponses qui prouvent l'aller-retour, SEULE
--       définition des conditions :
--         - message entrant reçu par le vrai webhook : identifiant du fournisseur présent, `metadata.imported_manually`
--           explicitement faux (posé seulement par l'ingestion du webhook ; une réponse consignée à la main porte vrai)
--           et état de la file entrante présent ;
--         - pas une réponse automatique (absence, accusé : `inbound_processing.reason = 'auto_reply'`) ;
--         - expéditeur authentifié : `metadata.sender_authentication.status = 'pass'` (DMARC aligné et SPF ou DKIM,
--           normalizeInboundSenderAuthentication) et identique au destinataire du dossier
--           (`metadata.sender_matches_recipient`) ;
--         - rattaché automatiquement (jeton de l'adresse de réponse) à un dossier ENVOYÉ, reçu après cet envoi et pas
--           dans le futur. Un message non routé reste dans information_agent_unrouted_messages : il ne compte jamais.
--       Aucun domaine interne n'est exigé : l'expéditeur est un vrai tiers.
--    b. Trace durable : public.information_agent_operations.inbound_roundtrip_proved_at et
--       inbound_roundtrip_proved_case_id (aucune adresse). La preuve calculée disparaît avec la vente purgée (cascade
--       des dossiers et messages), parfois avant 30 jours ; l'ingestion appelle donc
--       public.record_information_agent_roundtrip_reply_proof(message) quand elle rattache une réponse, et la
--       fonction n'écrit la trace que si ce message remplit les conditions ci-dessus (jamais une date plus ancienne).
--    c. public.information_agent_roundtrip_proof(p_now) : la preuve la plus récente parmi l'attestation manuelle, la
--       trace et le calcul à la volée. Rend la date, la nature (`attestation` ou `reply`) et le dossier ; jamais
--       d'adresse. SECURITY INVOKER : service_role lit déjà ces tables ; la RPC du changement de mode (SECURITY
--       DEFINER) l'appelle avec les droits de son propriétaire.
-- 2. Les envois manuels réels lus par la porte (3) sont ceux de public.information_agent_autopilot_stats, définie par
--    20261209100100 (destinataires distincts, hors adresses de test, domaines internes et comptes administrateurs).
-- 3. public.set_information_agent_autopilot_mode : reprise EN ENTIER de 20261119100500 (dernière définition), mêmes
--    droits et même search_path. Le passage en « live » exige, en plus du verrou `live_allowed` :
--      - une session en double authentification (`aal2`), quel que soit l'interrupteur admin_mfa_required ;
--      - une AIPD attestée le 23/11/2026 ou après (heure de Paris) : la version qui couvre l'envoi automatique ;
--      - une preuve d'aller-retour de moins de 30 jours (1.c) ;
--      - défense en profondeur, conditions jusqu'ici seulement vérifiées par l'application (autopilot-readiness.ts) :
--        au moins 15 envois manuels réels (destinataires distincts), aucune plainte, moins de 3 % de rebonds
--        définitifs (public.information_agent_autopilot_stats), et au moins 7 jours de simulation.
--    L'évènement `mode_changed` d'un passage en réel porte la preuve retenue (`after_values.roundtrip_proof` : nature,
--    date, dossier). Le délai de l'article 14 (30 jours au plus en réel) reste tenu par la contrainte de
--    20261209100200.
--
-- RÈGLES LIÉES (autopilot-readiness.ts) : AUTOPILOT_MIN_MANUAL_SENDS (15), taux de 3 %, AUTOPILOT_MIN_SIMULATION_DAYS
-- (7), AUTOPILOT_MIN_AIPD_ATTESTED_AT (23/11/2026), AUTOPILOT_ROUNDTRIP_MAX_AGE_DAYS (30). Les deux changent ensemble.
--
-- Verrous : ACCESS EXCLUSIVE bref sur public.information_agent_operations (ajout de deux colonnes nullables, sans
-- réécriture ; une ligne). Le reste ne touche que le catalogue.
--
-- Retour arrière : rejouer la définition de public.set_information_agent_autopilot_mode de
-- 20261119100500_information_agent_autopilot_rearm.sql dans une nouvelle migration, puis supprimer les fonctions
-- public.information_agent_roundtrip_proof(timestamptz), public.record_information_agent_roundtrip_reply_proof(uuid)
-- et public.information_agent_roundtrip_reply_proofs(timestamptz). Les deux colonnes peuvent rester.

-- 1.b Trace durable ------------------------------------------------------------------------------------------------
alter table public.information_agent_operations
  add column if not exists inbound_roundtrip_proved_at timestamptz,
  add column if not exists inbound_roundtrip_proved_case_id uuid;

comment on column public.information_agent_operations.inbound_roundtrip_proved_at is
  'Date de la dernière réponse réelle qui a prouvé l''aller-retour (public.information_agent_roundtrip_reply_proofs), écrite à l''ingestion. Survit à la purge de la vente. Aucune adresse.';
comment on column public.information_agent_operations.inbound_roundtrip_proved_case_id is
  'Dossier de cette réponse (sans clé étrangère : la trace survit à la purge du dossier).';

-- 1.a Réponses qui prouvent l'aller-retour ---------------------------------------------------------------------------
create or replace function public.information_agent_roundtrip_reply_proofs(p_now timestamptz default statement_timestamp())
returns table (proven_at timestamptz, case_id uuid, message_id uuid)
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce(message.received_at, message.created_at), message.case_id, message.id
  from public.information_agent_messages message
  join public.information_agent_cases sent_case on sent_case.id = message.case_id
  where message.direction = 'inbound'
    and message.provider_message_id is not null
    and message.metadata ->> 'imported_manually' = 'false'
    and message.metadata ? 'inbound_processing'
    and coalesce(message.metadata -> 'inbound_processing' ->> 'reason', '') <> 'auto_reply'
    and message.metadata -> 'sender_authentication' ->> 'status' = 'pass'
    and message.metadata ->> 'sender_matches_recipient' = 'true'
    and sent_case.sent_at is not null
    and coalesce(message.received_at, message.created_at) >= sent_case.sent_at
    and coalesce(message.received_at, message.created_at) <= p_now;
$$;

revoke all on function public.information_agent_roundtrip_reply_proofs(timestamptz) from public, anon, authenticated;
grant execute on function public.information_agent_roundtrip_reply_proofs(timestamptz) to service_role;

comment on function public.information_agent_roundtrip_reply_proofs(timestamptz) is
  'Réponses réelles qui prouvent l''aller-retour de réception de l''agent : reçues par le webhook, pas une réponse automatique, expéditeur authentifié et identique au destinataire, rattachées automatiquement à un dossier envoyé, reçues après l''envoi et pas dans le futur. Seule définition de ces conditions. Réservée à service_role.';

-- 1.b Écriture de la trace par l'ingestion --------------------------------------------------------------------------
create or replace function public.record_information_agent_roundtrip_reply_proof(p_message_id uuid)
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_at timestamptz;
  v_case uuid;
begin
  select proof.proven_at, proof.case_id into v_at, v_case
  from public.information_agent_roundtrip_reply_proofs(pg_catalog.statement_timestamp()) proof
  where proof.message_id = p_message_id;
  if v_at is null then
    return null;
  end if;
  update public.information_agent_operations ops
  set inbound_roundtrip_proved_at = v_at,
      inbound_roundtrip_proved_case_id = v_case,
      updated_at = pg_catalog.statement_timestamp()
  where ops.singleton
    and (ops.inbound_roundtrip_proved_at is null or ops.inbound_roundtrip_proved_at < v_at);
  return v_at;
end;
$$;

revoke all on function public.record_information_agent_roundtrip_reply_proof(uuid) from public, anon, authenticated;
grant execute on function public.record_information_agent_roundtrip_reply_proof(uuid) to service_role;

comment on function public.record_information_agent_roundtrip_reply_proof(uuid) is
  'Écrit la trace durable de l''aller-retour (information_agent_operations.inbound_roundtrip_proved_at et _case_id) si ce message remplit les conditions de public.information_agent_roundtrip_reply_proofs ; jamais une date plus ancienne. Rend la date retenue, ou null. Réservée à service_role (ingestion des réponses).';

-- 1.c Preuve la plus récente ------------------------------------------------------------------------------------------
create or replace function public.information_agent_roundtrip_proof(p_now timestamptz default statement_timestamp())
returns table (proven_at timestamptz, source text, case_id uuid)
language sql
stable
security invoker
set search_path = ''
as $$
  select proofs.proven_at, proofs.source, proofs.case_id
  from (
    select ops.inbound_roundtrip_verified_at as proven_at, 'attestation'::text as source, null::uuid as case_id
    from public.information_agent_operations ops
    where ops.singleton and ops.inbound_roundtrip_verified_at <= p_now
    union all
    select ops.inbound_roundtrip_proved_at, 'reply'::text, ops.inbound_roundtrip_proved_case_id
    from public.information_agent_operations ops
    where ops.singleton and ops.inbound_roundtrip_proved_at <= p_now
    union all
    (
      select reply.proven_at, 'reply'::text, reply.case_id
      from public.information_agent_roundtrip_reply_proofs(p_now) reply
      order by reply.proven_at desc
      limit 1
    )
  ) proofs
  order by proofs.proven_at desc
  limit 1;
$$;

revoke all on function public.information_agent_roundtrip_proof(timestamptz) from public, anon, authenticated;
grant execute on function public.information_agent_roundtrip_proof(timestamptz) to service_role;

comment on function public.information_agent_roundtrip_proof(timestamptz) is
  'Preuve la plus récente de l''aller-retour de réception de l''agent : attestation manuelle, trace durable d''une réponse réelle (information_agent_operations) ou réponse réelle calculée à la volée (information_agent_roundtrip_reply_proofs). Rend la date, la nature (attestation, reply) et le dossier ; jamais d''adresse. Réservée à service_role.';

-- 3. Changement de mode : reprise EN ENTIER de 20261119100500, porte du mode réel élargie ----------------------------
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
  v_stats jsonb;
  v_manual integer;
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
    -- Double authentification exigée pour le mode réel, quel que soit l'interrupteur admin_mfa_required.
    if coalesce((select auth.jwt() ->> 'aal'), 'aal1') <> 'aal2' then
      raise exception using errcode = '55000', message = 'Double authentification requise pour passer en mode réel : reconnectez-vous avec votre second facteur, puis recommencez.';
    end if;
    if v_before.aipd_attested_at is null then
      raise exception using errcode = '55000', message = 'Attestation d''AIPD manquante : le mode réel est refusé.';
    end if;
    -- RÈGLE LIÉE : AUTOPILOT_MIN_AIPD_ATTESTED_AT (autopilot-readiness.ts).
    if v_before.aipd_attested_at < '2026-11-23 00:00:00 Europe/Paris'::timestamptz then
      raise exception using errcode = '55000', message = 'Attestation d''AIPD antérieure au 23/11/2026 : attestez la version qui couvre l''envoi automatique, puis recommencez.';
    end if;
    select proof.proven_at, proof.source, proof.case_id into v_proof_at, v_proof_source, v_proof_case
    from public.information_agent_roundtrip_proof(pg_catalog.statement_timestamp()) proof;
    if v_proof_at is null or v_proof_at <= pg_catalog.statement_timestamp() - interval '30 days' then
      raise exception using errcode = '55000', message = 'Aller-retour de réception non prouvé depuis 30 jours (ni attestation, ni réponse réelle authentifiée rattachée à son dossier) : le mode réel est refusé.';
    end if;
    -- Défense en profondeur. RÈGLES LIÉES : AUTOPILOT_MIN_MANUAL_SENDS (15), taux de 3 % et
    -- AUTOPILOT_MIN_SIMULATION_DAYS (7) de autopilot-readiness.ts.
    v_stats := public.information_agent_autopilot_stats(pg_catalog.statement_timestamp());
    v_manual := coalesce((v_stats ->> 'manual_real_sends')::integer, 0);
    if v_manual < 15
       or coalesce((v_stats ->> 'manual_complaints')::integer, 0) > 0
       or coalesce((v_stats ->> 'manual_permanent_bounces')::integer, 0)::numeric >= 0.03 * v_manual then
      raise exception using errcode = '55000', message = 'Envois manuels réels insuffisants ou taux non propres (15 au moins, aucune plainte, moins de 3 % de rebonds définitifs) : le mode réel est refusé.';
    end if;
    if v_before.simulation_started_at is null
       or v_before.simulation_started_at > pg_catalog.statement_timestamp() - interval '7 days' then
      raise exception using errcode = '55000', message = 'Moins de 7 jours de simulation : le mode réel est refusé.';
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
