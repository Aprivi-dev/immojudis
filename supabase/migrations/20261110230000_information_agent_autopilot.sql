begin;

set local lock_timeout = '5s';

-- Agent d'information, lot 2 (refonte validée le 02/11/2026) : pilote automatique.
--
-- DÉSACTIVÉ PAR DÉFAUT. Trois modes : « off », « simulation » (brouillons et aperçus, AUCUN envoi) et « live »
-- (envoi réel, bloqué tant que le contrôle de préparation n'est pas satisfait, voir
-- src/lib/information-agent/autopilot-readiness.ts). Cette migration ajoute :
--   1. public.information_agent_autopilot_settings : ligne unique de réglages (mode, administrateur d'exécution,
--      plafond réglé, accord de Licitor, règle de l'article 14, attestation d'AIPD, arrêt automatique).
--   2. public.information_agent_autopilot_events : journal en AJOUT SEUL (acteur, action, valeurs avant/après, motif
--      obligatoire pour toute modification humaine, jamais d'adresse : une contrainte refuse tout « @ »). Conservation
--      5 ans, purge dédiée public.purge_information_agent_autopilot (appelée depuis runDataRetention : run_data_retention
--      n'est PAS redéfinie).
--   3. public.information_agent_autopilot_exclusions : identités à ne plus jamais traiter en automatique (mauvais
--      destinataire). Elles repassent en validation manuelle. Conservation 24 mois.
--   4. RPC d'administration (is_admin) : set_information_agent_autopilot_mode, update_information_agent_autopilot_settings,
--      stop_information_agent_autopilot (arrêt d'urgence, toujours permis), attest_information_agent_aipd.
--      RPC de service : record_information_agent_autopilot_event, record_information_agent_autopilot_auto_stop,
--      record_information_agent_autopilot_exclusions, sync_information_agent_autopilot_warning, information_agent_autopilot_stats.
--   5. app_private.guard_information_agent_mission_contact : reprise EN ENTIER de la dernière définition
--      (20261108203000), plus le filet : une mission marquée trigger = 'autopilot' ne passe pas en « sending » si le
--      pilote n'est pas en mode « live ».
--   6. email_send_log : le mode d'envoi « autopilot » s'ajoute aux modes permis (traçabilité de chaque envoi).
--   7. Attestation de l'aller-retour : public.attest_information_agent_roundtrip (lot 1) est redéfinie. Ce n'est plus
--      un simple clic : une réponse de test réellement reçue ET routée vers un dossier doit exister dans les 24 dernières
--      heures (dossier d'essai de l'administrateur vers une adresse de son propre domaine). Chaque attestation est
--      inscrite dans public.information_agent_roundtrip_attestations (qui, quand ; ajout seul ; 5 ans).
--   8. Planification : pg_cron toutes les 10 minutes, l'appel HTTP n'a lieu que si le mode n'est pas « off ». Bail
--      « information-agent-autopilot » (public.cron_lease).
--
-- Aucune ligne existante n'est modifiée, aucune migration existante non plus.

-- 1. Réglages ------------------------------------------------------------------------------------------------
create table if not exists public.information_agent_autopilot_settings (
  singleton boolean primary key default true check (singleton),
  mode text not null default 'off' check (mode in ('off', 'simulation', 'live')),
  -- Administrateur sous l'identité duquel les brouillons sont créés (sans clé étrangère : la ligne ne dépend pas d'un compte).
  acting_admin_id uuid,
  -- Plafond journalier réglé à la main (le minimum avec la phase et l'environnement s'applique) ; 60 = plafond dur.
  cap_total_override integer check (cap_total_override is null or cap_total_override between 1 and 60),
  -- Adresses Licitor décodées : exclues du pilote tant que l'accord écrit de Licitor n'est pas versé.
  allow_licitor_decoded boolean not null default false,
  -- Article 14 RGPD : première adresse relevée il y a moins de N jours, ou personne déjà informée.
  art14_rule_enabled boolean not null default true,
  art14_max_age_days integer not null default 30 check (art14_max_age_days between 1 and 365),
  -- Verrou du lot 3 : seule une migration du lot 3 (textes juridiques publiés) le passe à vrai. Tant qu'il vaut faux,
  -- aucun appel de RPC ne peut mettre le pilote en mode réel.
  live_allowed boolean not null default false,
  aipd_attested_at timestamptz,
  aipd_version text check (aipd_version is null or char_length(aipd_version) between 1 and 40),
  simulation_started_at timestamptz,
  paused_until timestamptz,
  auto_stopped_at timestamptz,
  auto_stop_reason text check (auto_stop_reason is null or char_length(auto_stop_reason) <= 80),
  updated_by uuid,
  updated_at timestamptz not null default now()
);

comment on table public.information_agent_autopilot_settings is
  'Réglages du pilote automatique de l''agent d''information (ligne unique, désactivé par défaut). Modifiés seulement par les RPC set_/update_/stop_/attest_ (is_admin) et record_..._auto_stop (service) ; chaque changement est journalisé dans information_agent_autopilot_events.';

insert into public.information_agent_autopilot_settings (singleton) values (true) on conflict (singleton) do nothing;

alter table public.information_agent_autopilot_settings enable row level security;
revoke all on table public.information_agent_autopilot_settings from public, anon, authenticated;
-- Lecture seule : les RPC (security definer) sont les seules à écrire les réglages.
grant select on table public.information_agent_autopilot_settings to service_role;
-- Aucune politique : RLS sans politique refuse tout rôle soumis aux politiques ; service_role les contourne.

-- 2. Journal en ajout seul -------------------------------------------------------------------------------------
create table if not exists public.information_agent_autopilot_events (
  id uuid primary key default gen_random_uuid(),
  at timestamptz not null default now(),
  kind text not null check (
    kind in (
      'mode_changed', 'settings_changed', 'emergency_stop', 'auto_stop', 'aipd_attested', 'run', 'skip',
      'would_send', 'sent', 'send_error', 'wrong_recipient'
    )
  ),
  -- Administrateur auteur du changement ; nul pour le système.
  actor uuid,
  action text,
  before_values jsonb,
  after_values jsonb,
  reason text,
  run_id uuid,
  details jsonb not null default '{}'::jsonb,
  constraint information_agent_autopilot_events_reason_check check (
    kind not in ('mode_changed', 'settings_changed', 'aipd_attested')
    or (reason is not null and char_length(btrim(reason)) >= 8)
  ),
  constraint information_agent_autopilot_events_size_check check (
    char_length(coalesce(reason, '')) <= 500
    and pg_column_size(details) <= 4096
    and pg_column_size(coalesce(before_values, '{}'::jsonb)) <= 4096
    and pg_column_size(coalesce(after_values, '{}'::jsonb)) <= 4096
  ),
  -- Jamais d'adresse dans le journal : identifiants de vente et codes de motifs seulement.
  constraint information_agent_autopilot_events_no_address_check check (
    position('@' in coalesce(reason, '') || coalesce(action, '') || details::text
      || coalesce(before_values::text, '') || coalesce(after_values::text, '')) = 0
  )
);

comment on table public.information_agent_autopilot_events is
  'Journal du pilote automatique de l''agent d''information, en ajout seul : changements de mode et de réglages (acteur, avant/après, motif), arrêts, passages, envois simulés ou réels. AUCUNE adresse. Conservation : 5 ans (public.purge_information_agent_autopilot).';

create index if not exists information_agent_autopilot_events_at_idx
  on public.information_agent_autopilot_events (at desc);
create index if not exists information_agent_autopilot_events_kind_idx
  on public.information_agent_autopilot_events (kind, at desc);

alter table public.information_agent_autopilot_events enable row level security;
revoke all on table public.information_agent_autopilot_events from public, anon, authenticated;
-- Pas de delete : seule la purge de conservation (security definer, bornée) supprime.
grant select, insert on table public.information_agent_autopilot_events to service_role;

-- Ajout seul : ni modification ni suppression, sauf la purge de conservation (drapeau local à la transaction).
create or replace function app_private.information_agent_autopilot_events_append_only()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' and pg_catalog.current_setting('app.autopilot_purge', true) = 'on' then
    return old;
  end if;
  raise exception using errcode = '55000', message = 'Le journal du pilote automatique est en ajout seul.';
end;
$$;

revoke all on function app_private.information_agent_autopilot_events_append_only() from public, anon, authenticated;

drop trigger if exists information_agent_autopilot_events_append_only on public.information_agent_autopilot_events;
create trigger information_agent_autopilot_events_append_only
  before update or delete on public.information_agent_autopilot_events
  for each row execute function app_private.information_agent_autopilot_events_append_only();

drop trigger if exists information_agent_autopilot_events_no_truncate on public.information_agent_autopilot_events;
create trigger information_agent_autopilot_events_no_truncate
  before truncate on public.information_agent_autopilot_events
  for each statement execute function app_private.information_agent_autopilot_events_append_only();

-- 3. Identités exclues du pilote -----------------------------------------------------------------------------------
create table if not exists public.information_agent_autopilot_exclusions (
  identity_key text primary key check (char_length(identity_key) between 3 and 400),
  reason text not null check (reason in ('wrong_recipient')),
  created_at timestamptz not null default now()
);

comment on table public.information_agent_autopilot_exclusions is
  'Identités professionnelles (clés d''identité de l''agent) à ne plus traiter en automatique : elles repassent en validation manuelle (mauvais destinataire). Conservation : 24 mois.';

alter table public.information_agent_autopilot_exclusions enable row level security;
revoke all on table public.information_agent_autopilot_exclusions from public, anon, authenticated;
grant select, insert, delete on table public.information_agent_autopilot_exclusions to service_role;

-- 4. Écriture du journal (interne) ---------------------------------------------------------------------------------
create or replace function app_private.autopilot_log_event(
  p_kind text,
  p_actor uuid,
  p_action text,
  p_before jsonb,
  p_after jsonb,
  p_reason text,
  p_run_id uuid,
  p_details jsonb
)
returns void
language sql
security definer
set search_path = ''
as $$
  -- Le journal ne reçoit jamais d'adresse : tout « @ » est neutralisé ici, pour qu'un motif saisi à la main ne fasse
  -- jamais échouer (ni l'arrêt d'urgence, ni un autre changement) sur la contrainte du journal.
  insert into public.information_agent_autopilot_events (kind, actor, action, before_values, after_values, reason, run_id, details)
  values (
    p_kind, p_actor, pg_catalog.replace(p_action, '@', '(at)'), p_before, p_after,
    nullif(pg_catalog.left(pg_catalog.replace(pg_catalog.btrim(p_reason), '@', '(at)'), 500), ''),
    p_run_id,
    pg_catalog.replace(coalesce(p_details, '{}'::jsonb)::text, '@', '(at)')::jsonb
  );
$$;

revoke all on function app_private.autopilot_log_event(text, uuid, text, jsonb, jsonb, text, uuid, jsonb)
  from public, anon, authenticated;

-- 5. RPC d'administration ---------------------------------------------------------------------------------------
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

  if p_mode = 'live' then
    if not v_before.live_allowed then
      raise exception using errcode = '55000', message = 'Mode réel non autorisé : les textes juridiques du lot 3 ne sont pas publiés.';
    end if;
    if v_before.aipd_attested_at is null then
      raise exception using errcode = '55000', message = 'Attestation d''AIPD manquante : le mode réel est refusé.';
    end if;
    if not exists (
      select 1 from public.information_agent_operations ops
      where ops.inbound_roundtrip_verified_at > pg_catalog.statement_timestamp() - interval '30 days'
    ) then
      raise exception using errcode = '55000', message = 'Aller-retour de réception non vérifié depuis 30 jours : le mode réel est refusé.';
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
    pg_catalog.jsonb_build_object('mode', v_after.mode),
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

create or replace function public.update_information_agent_autopilot_settings(p_changes jsonb, p_reason text)
returns public.information_agent_autopilot_settings
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_before public.information_agent_autopilot_settings%rowtype;
  v_after public.information_agent_autopilot_settings%rowtype;
  v_actor uuid := (select auth.uid());
  v_key text;
  v_allowed text[] := array['cap_total_override', 'allow_licitor_decoded', 'art14_rule_enabled', 'art14_max_age_days', 'acting_admin_id'];
begin
  if not public.is_admin() then
    raise exception using errcode = '42501', message = 'Admin access required.';
  end if;
  if p_reason is null or pg_catalog.char_length(pg_catalog.btrim(p_reason)) < 8 then
    raise exception using errcode = '22023', message = 'Motif obligatoire (8 caractères au moins).';
  end if;
  if p_changes is null or pg_catalog.jsonb_typeof(p_changes) <> 'object' or p_changes = '{}'::jsonb then
    raise exception using errcode = '22023', message = 'Aucun réglage à modifier.';
  end if;
  for v_key in select pg_catalog.jsonb_object_keys(p_changes) loop
    if not (v_key = any (v_allowed)) then
      raise exception using errcode = '22023', message = 'Réglage inconnu : ' || v_key;
    end if;
  end loop;
  if p_changes ? 'acting_admin_id'
     and not exists (
       select 1 from public.user_profiles profile
       where profile.user_id = nullif(p_changes ->> 'acting_admin_id', '')::uuid and profile.user_role = 'admin'
     ) then
    raise exception using errcode = '22023', message = 'L''administrateur d''exécution doit être un administrateur.';
  end if;

  select * into v_before from public.information_agent_autopilot_settings where singleton for update;

  update public.information_agent_autopilot_settings s
  set cap_total_override = case when p_changes ? 'cap_total_override'
        then nullif(p_changes ->> 'cap_total_override', '')::integer else s.cap_total_override end,
      allow_licitor_decoded = case when p_changes ? 'allow_licitor_decoded'
        then (p_changes ->> 'allow_licitor_decoded')::boolean else s.allow_licitor_decoded end,
      art14_rule_enabled = case when p_changes ? 'art14_rule_enabled'
        then (p_changes ->> 'art14_rule_enabled')::boolean else s.art14_rule_enabled end,
      art14_max_age_days = case when p_changes ? 'art14_max_age_days'
        then (p_changes ->> 'art14_max_age_days')::integer else s.art14_max_age_days end,
      acting_admin_id = case when p_changes ? 'acting_admin_id'
        then nullif(p_changes ->> 'acting_admin_id', '')::uuid else s.acting_admin_id end,
      updated_by = v_actor,
      updated_at = pg_catalog.statement_timestamp()
  where s.singleton
  returning * into v_after;

  perform app_private.autopilot_log_event(
    'settings_changed', v_actor, 'update_settings',
    pg_catalog.to_jsonb(v_before) - 'singleton' - 'updated_by' - 'updated_at' - 'aipd_attested_at' - 'aipd_version'
      - 'simulation_started_at' - 'paused_until' - 'auto_stopped_at' - 'auto_stop_reason' - 'mode',
    pg_catalog.to_jsonb(v_after) - 'singleton' - 'updated_by' - 'updated_at' - 'aipd_attested_at' - 'aipd_version'
      - 'simulation_started_at' - 'paused_until' - 'auto_stopped_at' - 'auto_stop_reason' - 'mode',
    p_reason, null, '{}'::jsonb
  );
  return v_after;
end;
$$;

revoke all on function public.update_information_agent_autopilot_settings(jsonb, text) from public, anon, authenticated;
grant execute on function public.update_information_agent_autopilot_settings(jsonb, text) to authenticated, service_role;

-- Arrêt d'urgence : toujours permis à un administrateur, sans condition ni motif exigé.
create or replace function public.stop_information_agent_autopilot(p_reason text default null)
returns public.information_agent_autopilot_settings
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_before text;
  v_after public.information_agent_autopilot_settings%rowtype;
  v_actor uuid := (select auth.uid());
begin
  if not public.is_admin() then
    raise exception using errcode = '42501', message = 'Admin access required.';
  end if;
  select mode into v_before from public.information_agent_autopilot_settings where singleton for update;
  update public.information_agent_autopilot_settings s
  set mode = 'off', simulation_started_at = null, updated_by = v_actor, updated_at = pg_catalog.statement_timestamp()
  where s.singleton
  returning * into v_after;
  perform app_private.autopilot_log_event(
    'emergency_stop', v_actor, 'stop',
    pg_catalog.jsonb_build_object('mode', v_before), pg_catalog.jsonb_build_object('mode', 'off'),
    coalesce(nullif(pg_catalog.btrim(p_reason), ''), 'Arrêt d''urgence'), null, '{}'::jsonb
  );
  return v_after;
end;
$$;

revoke all on function public.stop_information_agent_autopilot(text) from public, anon, authenticated;
grant execute on function public.stop_information_agent_autopilot(text) to authenticated, service_role;

create or replace function public.attest_information_agent_aipd(p_version text, p_reason text)
returns public.information_agent_autopilot_settings
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_after public.information_agent_autopilot_settings%rowtype;
  v_actor uuid := (select auth.uid());
begin
  if not public.is_admin() then
    raise exception using errcode = '42501', message = 'Admin access required.';
  end if;
  if p_version is null or pg_catalog.char_length(pg_catalog.btrim(p_version)) not between 1 and 40 then
    raise exception using errcode = '22023', message = 'Version de l''AIPD obligatoire.';
  end if;
  if p_reason is null or pg_catalog.char_length(pg_catalog.btrim(p_reason)) < 8 then
    raise exception using errcode = '22023', message = 'Motif obligatoire (8 caractères au moins).';
  end if;
  update public.information_agent_autopilot_settings s
  set aipd_attested_at = pg_catalog.statement_timestamp(), aipd_version = pg_catalog.btrim(p_version),
      updated_by = v_actor, updated_at = pg_catalog.statement_timestamp()
  where s.singleton
  returning * into v_after;
  perform app_private.autopilot_log_event(
    'aipd_attested', v_actor, 'attest_aipd', null,
    pg_catalog.jsonb_build_object('aipd_version', v_after.aipd_version), p_reason, null, '{}'::jsonb
  );
  return v_after;
end;
$$;

revoke all on function public.attest_information_agent_aipd(text, text) from public, anon, authenticated;
grant execute on function public.attest_information_agent_aipd(text, text) to authenticated, service_role;

-- 6. RPC de service (exécuteur, webhook) -------------------------------------------------------------------------
create or replace function public.record_information_agent_autopilot_event(
  p_kind text,
  p_run_id uuid default null,
  p_details jsonb default '{}'::jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_kind not in ('run', 'skip', 'would_send', 'sent', 'send_error', 'wrong_recipient') then
    raise exception using errcode = '22023', message = 'Type d''évènement inconnu.';
  end if;
  perform app_private.autopilot_log_event(p_kind, null, p_kind, null, null, null, p_run_id, p_details);
end;
$$;

revoke all on function public.record_information_agent_autopilot_event(text, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.record_information_agent_autopilot_event(text, uuid, jsonb) to service_role;

-- Arrêt automatique : écrit en base (mode « off »), évènement, alerte critique. La réactivation est manuelle.
create or replace function public.record_information_agent_autopilot_auto_stop(
  p_reason text,
  p_details jsonb default '{}'::jsonb,
  p_pause_hours integer default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_before text;
  v_now timestamptz := pg_catalog.statement_timestamp();
begin
  if p_reason is null or p_reason !~ '^[a-z0-9_]{1,80}$' then
    raise exception using errcode = '22023', message = 'Code de motif invalide.';
  end if;
  select mode into v_before from public.information_agent_autopilot_settings where singleton for update;
  if p_pause_hours is not null then
    -- Pause (retards de livraison) : le mode ne change pas, le pilote attend.
    update public.information_agent_autopilot_settings
    set paused_until = v_now + pg_catalog.make_interval(hours => least(greatest(p_pause_hours, 1), 168)), updated_at = v_now
    where singleton;
  else
    update public.information_agent_autopilot_settings
    set mode = 'off', auto_stopped_at = v_now, auto_stop_reason = p_reason, simulation_started_at = null, updated_at = v_now
    where singleton;
    perform app_private.sync_operational_alert(
      'information_agent.autopilot.auto_stop', 'cron', 'critical',
      pg_catalog.jsonb_build_object('reason', p_reason, 'mode_before', v_before), true, v_now
    );
  end if;
  perform app_private.autopilot_log_event(
    'auto_stop', null, case when p_pause_hours is null then 'stop' else 'pause' end,
    pg_catalog.jsonb_build_object('mode', v_before),
    pg_catalog.jsonb_build_object('mode', case when p_pause_hours is null then 'off' else v_before end),
    p_reason, null, coalesce(p_details, '{}'::jsonb)
  );
end;
$$;

revoke all on function public.record_information_agent_autopilot_auto_stop(text, jsonb, integer) from public, anon, authenticated;
grant execute on function public.record_information_agent_autopilot_auto_stop(text, jsonb, integer) to service_role;

create or replace function public.record_information_agent_autopilot_exclusions(p_identity_keys text[], p_reason text default 'wrong_recipient')
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  insert into public.information_agent_autopilot_exclusions (identity_key, reason)
  select distinct pg_catalog.lower(pg_catalog.btrim(key)), p_reason
  from pg_catalog.unnest(coalesce(p_identity_keys, array[]::text[])) as key
  where pg_catalog.char_length(pg_catalog.btrim(key)) between 3 and 400
  on conflict (identity_key) do nothing;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.record_information_agent_autopilot_exclusions(text[], text) from public, anon, authenticated;
grant execute on function public.record_information_agent_autopilot_exclusions(text[], text) to service_role;

-- Alerte d'avertissement (seuil à la moitié de l'arrêt automatique) : ouverte ou refermée à chaque passage.
create or replace function public.sync_information_agent_autopilot_warning(
  p_code text,
  p_active boolean,
  p_details jsonb default '{}'::jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_code is null or p_code !~ '^[a-z0-9_]{1,60}$' then
    raise exception using errcode = '22023', message = 'Code d''avertissement invalide.';
  end if;
  perform app_private.sync_operational_alert(
    'information_agent.autopilot.warning.' || p_code, 'cron', 'warning',
    coalesce(p_details, '{}'::jsonb), coalesce(p_active, false), pg_catalog.statement_timestamp()
  );
end;
$$;

revoke all on function public.sync_information_agent_autopilot_warning(text, boolean, jsonb) from public, anon, authenticated;
grant execute on function public.sync_information_agent_autopilot_warning(text, boolean, jsonb) to service_role;

-- 7. Compteurs --------------------------------------------------------------------------------------------------
create or replace function public.information_agent_autopilot_stats(p_now timestamptz default statement_timestamp())
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_day_start timestamptz := ((p_now at time zone 'Europe/Paris')::date)::timestamp at time zone 'Europe/Paris';
  v_first timestamptz;
  v_result jsonb;
begin
  select min(entry.created_at) into v_first
  from public.email_send_log entry where entry.mode = 'autopilot' and entry.category = 'agent';

  with sent as (
    select m.id, m.sale_id, m.approved_at, pg_catalog.lower(pg_catalog.split_part(m.recipient_email, '@', 2)) as domain
    from public.information_agent_missions m
    where m.approved_at is not null
      and m.approved_at >= p_now - interval '8 days'
      and (m.status in ('sending', 'sent', 'replied', 'review', 'completed')
           or (m.status = 'failed' and m.metadata ->> 'send_outcome' = 'unverified'))
  ),
  ap as (
    select entry.status, entry.bounce_type, entry.created_at, entry.to_address
    from public.email_send_log entry where entry.mode = 'autopilot' and entry.category = 'agent'
  ),
  ap_first100 as (select * from ap order by created_at asc limit 100),
  ap_first30 as (select * from ap order by created_at asc limit 30),
  ap_mature as (
    select * from (select * from ap where created_at <= p_now - interval '48 hours' order by created_at desc limit 100) latest
  ),
  manual as (
    select entry.status, entry.bounce_type
    from public.email_send_log entry
    where entry.mode = 'manual' and entry.category = 'agent' and entry.to_address <> 'delivered@resend.dev'
  )
  select pg_catalog.jsonb_build_object(
    'sent_today_total', (select pg_catalog.count(*) from sent where approved_at >= v_day_start),
    'sent_last_hour_total', (select pg_catalog.count(*) from sent where approved_at >= p_now - interval '1 hour'),
    'last_send_at', (select pg_catalog.max(approved_at) from sent),
    'today_by_domain', (select coalesce(pg_catalog.jsonb_object_agg(domain, n), '{}'::jsonb)
      from (select domain, pg_catalog.count(*) as n from sent where approved_at >= v_day_start group by domain) d),
    'week_by_domain', (select coalesce(pg_catalog.jsonb_object_agg(domain, n), '{}'::jsonb)
      from (select domain, pg_catalog.count(*) as n from sent where approved_at >= p_now - interval '7 days' group by domain) d),
    'today_by_court', (select coalesce(pg_catalog.jsonb_object_agg(court, n), '{}'::jsonb)
      from (select s.tribunal_code as court, pg_catalog.count(*) as n
            from sent join public.auction_sales s on s.id = sent.sale_id
            where sent.approved_at >= v_day_start and s.tribunal_code is not null group by s.tribunal_code) c),
    'recent_domains', (select coalesce(pg_catalog.jsonb_agg(distinct domain), '[]'::jsonb)
      from sent where approved_at >= p_now - interval '15 minutes'),
    'first_autopilot_send_at', v_first,
    'autopilot_total', (select pg_catalog.count(*) from ap),
    'first100_complaints', (select pg_catalog.count(*) from ap_first100 where status = 'complained'),
    'first30_permanent_bounces', (select pg_catalog.count(*) from ap_first30 where status = 'bounced' and coalesce(bounce_type, '') = 'permanent'),
    'mature_total', (select pg_catalog.count(*) from ap_mature),
    'mature_permanent_bounces', (select pg_catalog.count(*) from ap_mature where status = 'bounced' and coalesce(bounce_type, '') = 'permanent'),
    'last24h_sent', (select pg_catalog.count(*) from ap where created_at >= p_now - interval '24 hours' and created_at <= p_now - interval '1 hour'),
    'last24h_delayed', (select pg_catalog.count(*) from ap where created_at >= p_now - interval '24 hours' and created_at <= p_now - interval '1 hour' and status = 'delayed'),
    'last24h_delivered', (select pg_catalog.count(*) from ap where created_at >= p_now - interval '24 hours' and created_at <= p_now - interval '1 hour' and status = 'delivered'),
    'last24h_failed', (select pg_catalog.count(*) from ap where created_at >= p_now - interval '24 hours' and created_at <= p_now - interval '1 hour' and status = 'failed'),
    'complaints_14d', (select pg_catalog.count(*) from ap where created_at >= p_now - interval '14 days' and status = 'complained'),
    'sent_14d', (select pg_catalog.count(*) from ap where created_at >= p_now - interval '14 days'),
    'oppositions_14d', (select pg_catalog.count(distinct contact.normalized_email)
      from public.information_agent_contacts contact
      where contact.scope_sale_id is null and contact.opposition_status = 'opposed'
        and contact.opposed_at >= p_now - interval '14 days'
        and contact.normalized_email in (select to_address from ap)),
    'weeks', (select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('week', w.week, 'sent', w.sent,
        'complaints', w.complaints, 'permanent_bounces', w.permanent_bounces) order by w.week), '[]'::jsonb)
      from (select pg_catalog.floor(extract(epoch from (created_at - v_first)) / 604800)::integer as week,
                   pg_catalog.count(*)::integer as sent,
                   (pg_catalog.count(*) filter (where status = 'complained'))::integer as complaints,
                   (pg_catalog.count(*) filter (where status = 'bounced' and coalesce(bounce_type, '') = 'permanent'))::integer as permanent_bounces
            from ap where v_first is not null group by 1) w),
    'consecutive_api_errors', (select pg_catalog.count(*) from public.information_agent_autopilot_events e
      where e.kind = 'send_error' and e.details ->> 'status' is distinct from '429'
        and e.at > coalesce((select pg_catalog.max(at) from public.information_agent_autopilot_events where kind = 'sent'), '-infinity'::timestamptz)),
    'rejected_7d', (select pg_catalog.count(*) from public.information_agent_autopilot_events e
      where e.kind = 'skip' and e.at >= p_now - interval '7 days' and e.details ->> 'code' in ('policy_rejected', 'content_rejected')),
    'unverified_open', (select pg_catalog.count(*) from public.information_agent_missions m
      where m.metadata ->> 'send_outcome' = 'unverified' and m.status in ('sending', 'failed')),
    'stuck_sending', (select pg_catalog.count(*) from public.information_agent_missions m
      where m.status = 'sending' and m.sent_at is null and coalesce(m.approved_at, m.updated_at) < p_now - interval '30 minutes'),
    'manual_real_sends', (select pg_catalog.count(*) from manual),
    'manual_complaints', (select pg_catalog.count(*) from manual where status = 'complained'),
    'manual_permanent_bounces', (select pg_catalog.count(*) from manual where status = 'bounced' and coalesce(bounce_type, '') = 'permanent'),
    'would_send_days', (select pg_catalog.count(distinct (e.at at time zone 'Europe/Paris')::date)
      from public.information_agent_autopilot_events e
      where e.kind = 'would_send'
        and e.at >= coalesce((select simulation_started_at from public.information_agent_autopilot_settings where singleton), p_now)),
    'anomalies_since_simulation', (select pg_catalog.count(*) from public.information_agent_autopilot_events e
      where e.kind in ('auto_stop', 'send_error')
        and e.at >= coalesce((select simulation_started_at from public.information_agent_autopilot_settings where singleton), p_now))
  ) into v_result;
  return v_result;
end;
$$;

revoke all on function public.information_agent_autopilot_stats(timestamptz) from public, anon, authenticated;
grant execute on function public.information_agent_autopilot_stats(timestamptz) to service_role;

-- 8. Purge de conservation ------------------------------------------------------------------------------------
create or replace function public.purge_information_agent_autopilot(p_now timestamptz default statement_timestamp())
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_events integer;
  v_exclusions integer;
begin
  -- La date de référence ne peut pas être dans le futur : un appel ne peut pas purger tout le journal d'un coup.
  p_now := least(coalesce(p_now, pg_catalog.statement_timestamp()), pg_catalog.statement_timestamp());
  perform pg_catalog.set_config('app.autopilot_purge', 'on', true);
  delete from public.information_agent_autopilot_events where at < p_now - interval '5 years';
  get diagnostics v_events = row_count;
  delete from public.information_agent_roundtrip_attestations where at < p_now - interval '5 years';
  perform pg_catalog.set_config('app.autopilot_purge', 'off', true);
  delete from public.information_agent_autopilot_exclusions where created_at < p_now - interval '24 months';
  get diagnostics v_exclusions = row_count;
  return pg_catalog.jsonb_build_object('information_agent_autopilot_events', v_events, 'information_agent_autopilot_exclusions', v_exclusions);
end;
$$;

revoke all on function public.purge_information_agent_autopilot(timestamptz) from public, anon, authenticated;
grant execute on function public.purge_information_agent_autopilot(timestamptz) to service_role;


-- 8bis. Attestation de l'aller-retour avec preuve -------------------------------------------------------------------
create table if not exists public.information_agent_roundtrip_attestations (
  id uuid primary key default gen_random_uuid(),
  at timestamptz not null default now(),
  -- Sans clé étrangère : la ligne ne dépend pas d'un compte. Aucune adresse.
  admin_id uuid not null,
  message_id uuid,
  case_id uuid
);

comment on table public.information_agent_roundtrip_attestations is
  'Historique, en ajout seul, des attestations de l''aller-retour de réception : administrateur, date, message de test et dossier. Conservation : 5 ans (public.purge_information_agent_autopilot).';

alter table public.information_agent_roundtrip_attestations enable row level security;
revoke all on table public.information_agent_roundtrip_attestations from public, anon, authenticated;
grant select, insert on table public.information_agent_roundtrip_attestations to service_role;

create or replace function app_private.information_agent_roundtrip_attestations_append_only()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' and pg_catalog.current_setting('app.autopilot_purge', true) = 'on' then
    return old;
  end if;
  raise exception using errcode = '55000', message = 'L''historique des attestations est en ajout seul.';
end;
$$;

revoke all on function app_private.information_agent_roundtrip_attestations_append_only() from public, anon, authenticated;

drop trigger if exists information_agent_roundtrip_attestations_append_only on public.information_agent_roundtrip_attestations;
create trigger information_agent_roundtrip_attestations_append_only
  before update or delete on public.information_agent_roundtrip_attestations
  for each row execute function app_private.information_agent_roundtrip_attestations_append_only();

drop trigger if exists information_agent_roundtrip_attestations_no_truncate on public.information_agent_roundtrip_attestations;
create trigger information_agent_roundtrip_attestations_no_truncate
  before truncate on public.information_agent_roundtrip_attestations
  for each statement execute function app_private.information_agent_roundtrip_attestations_append_only();

-- Domaines internes (liste blanche) : seule une adresse de l'un de ces domaines peut servir de dossier d'essai pour
-- l'aller-retour. Alimentée par une RPC administrateur journalisée ; immojudis.com par défaut.
create table if not exists public.information_agent_internal_domains (
  domain text primary key check (domain ~ '^[a-z0-9.-]{3,100}$' and domain !~ '@'),
  added_at timestamptz not null default now()
);

comment on table public.information_agent_internal_domains is
  'Domaines internes admis pour le dossier d''essai de l''aller-retour de réception (liste blanche, modifiée par set_information_agent_internal_domain).';

alter table public.information_agent_internal_domains enable row level security;
revoke all on table public.information_agent_internal_domains from public, anon, authenticated;
grant select on table public.information_agent_internal_domains to service_role;

insert into public.information_agent_internal_domains (domain) values ('immojudis.com') on conflict (domain) do nothing;

create or replace function public.set_information_agent_internal_domain(p_domain text, p_enabled boolean, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_domain text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_domain, '')));
begin
  if not public.is_admin() then
    raise exception using errcode = '42501', message = 'Admin access required.';
  end if;
  if v_domain !~ '^[a-z0-9.-]{3,100}$' or v_domain in ('gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'yahoo.com', 'icloud.com', 'orange.fr', 'free.fr', 'wanadoo.fr', 'sfr.fr', 'laposte.net') then
    raise exception using errcode = '22023', message = 'Domaine interne invalide.';
  end if;
  if p_reason is null or pg_catalog.char_length(pg_catalog.btrim(p_reason)) < 8 then
    raise exception using errcode = '22023', message = 'Motif obligatoire (8 caractères au moins).';
  end if;
  if coalesce(p_enabled, true) then
    insert into public.information_agent_internal_domains (domain) values (v_domain) on conflict (domain) do nothing;
  else
    delete from public.information_agent_internal_domains where domain = v_domain;
  end if;
  perform app_private.autopilot_log_event(
    'settings_changed', (select auth.uid()), 'internal_domain',
    null, pg_catalog.jsonb_build_object('domain', v_domain, 'enabled', coalesce(p_enabled, true)), p_reason, null, '{}'::jsonb
  );
end;
$$;

revoke all on function public.set_information_agent_internal_domain(text, boolean, text) from public, anon, authenticated;
grant execute on function public.set_information_agent_internal_domain(text, boolean, text) to authenticated, service_role;

create or replace function public.attest_information_agent_roundtrip(p_admin_id uuid)
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_at timestamptz := pg_catalog.statement_timestamp();
  v_message uuid;
  v_case uuid;
  v_email text;
begin
  select profile.email into v_email
  from public.user_profiles profile
  where profile.user_id = p_admin_id and profile.user_role = 'admin';
  if p_admin_id is null or not found then
    raise exception using errcode = '42501', message = 'Admin access required.';
  end if;

  -- Preuve : une réponse REÇUE par le circuit réel (jamais importée à la main), d'un expéditeur authentifié et qui
  -- correspond au destinataire, routée vers un dossier ENVOYÉ de cet administrateur dont le destinataire est une
  -- adresse d'un domaine interne (liste blanche), dans les 24 dernières heures.
  select message.id, message.case_id into v_message, v_case
  from public.information_agent_messages message
  join public.information_agent_cases test_case on test_case.id = message.case_id
  where message.direction = 'inbound'
    and coalesce(message.received_at, message.created_at) >= v_at - interval '24 hours'
    and coalesce((message.metadata ->> 'imported_manually')::boolean, false) is not true
    and message.metadata -> 'sender_authentication' ->> 'status' = 'pass'
    and (message.metadata ->> 'sender_matches_recipient')::boolean is true
    and message.provider_message_id is not null
    and test_case.created_by = p_admin_id
    and test_case.sent_at is not null
    and pg_catalog.split_part(test_case.normalized_recipient_email, '@', 2) in (
      select internal.domain from public.information_agent_internal_domains internal
    )
  order by coalesce(message.received_at, message.created_at) desc
  limit 1;
  if v_message is null then
    raise exception using errcode = '55000',
      message = 'Aucune réponse de test reçue et routée dans les 24 dernières heures : envoyez un message de test à une adresse interne, répondez-y, puis attendez qu''il arrive en revue.';
  end if;

  insert into public.information_agent_roundtrip_attestations (at, admin_id, message_id, case_id)
  values (v_at, p_admin_id, v_message, v_case);
  insert into public.information_agent_operations as ops (singleton, inbound_roundtrip_verified_at, inbound_roundtrip_verified_by, updated_at)
  values (true, v_at, p_admin_id, v_at)
  on conflict (singleton) do update set
    inbound_roundtrip_verified_at = excluded.inbound_roundtrip_verified_at,
    inbound_roundtrip_verified_by = excluded.inbound_roundtrip_verified_by,
    updated_at = excluded.updated_at;
  return v_at;
end;
$$;

revoke all on function public.attest_information_agent_roundtrip(uuid) from public, anon, authenticated;
grant execute on function public.attest_information_agent_roundtrip(uuid) to service_role;

comment on function public.attest_information_agent_roundtrip(uuid) is
  'Enregistre qu''un administrateur a vérifié l''aller-retour réel d''une réponse. Exige une réponse de test reçue par le circuit réel (expéditeur authentifié, jamais importée à la main), routée vers un dossier envoyé d''un domaine interne (liste blanche), dans les 24 dernières heures ; inscrit l''attestation dans l''historique en ajout seul. Réservée à service_role.';

-- 9. Filet SQL : reprise EN ENTIER de app_private.guard_information_agent_mission_contact (20261108203000) ----------
-- Seul ajout : une mission marquée trigger = 'autopilot' ne passe pas en « sending » si le pilote n'est pas en
-- mode « live ». Ferme la fenêtre entre la relecture du réglage par l'exécuteur et l'approbation, et bloque tout
-- envoi automatique quand le pilote est coupé ou en simulation.
create or replace function app_private.guard_information_agent_mission_contact()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  should_check boolean;
begin
  if (tg_op = 'INSERT' or new.recipient_email is distinct from old.recipient_email)
     and not app_private.information_agent_email_is_valid(new.recipient_email) then
    raise exception using
      errcode = '23514',
      message = 'Aucune adresse email de contact : l''agent ne peut pas écrire.';
  end if;

  if tg_op = 'INSERT' then
    should_check := true;
  else
    should_check := old.status not in ('sending', 'sent')
      or new.recipient_email is distinct from old.recipient_email
      or new.recipient_identity_keys is distinct from old.recipient_identity_keys
      or new.sale_id is distinct from old.sale_id;
  end if;

  if new.status in ('sending', 'sent')
     and should_check
     and (
       app_private.information_agent_contact_is_blocked(new.sale_id, new.recipient_email)
       or app_private.information_agent_identity_is_blocked(new.recipient_identity_keys)
     ) then
    raise exception using
      errcode = '23514',
      message = 'Information-agent contact is opposed or permanently bounced.';
  end if;

  if new.status = 'sending'
     and (tg_op = 'INSERT' or old.status is distinct from 'sending')
     and new.metadata ->> 'trigger' = 'autopilot'
     and coalesce(
       (select settings.mode from public.information_agent_autopilot_settings settings where settings.singleton),
       'off'
     ) <> 'live' then
    raise exception using
      errcode = '23514',
      message = 'Autopilot send refused: the autopilot is not in live mode.';
  end if;
  return new;
end;
$$;

revoke all on function app_private.guard_information_agent_mission_contact()
from public, anon, authenticated;

-- 10. Mode d'envoi « autopilot » dans le journal des envois ----------------------------------------------------
alter table public.email_send_log drop constraint if exists email_send_log_mode_check;
alter table public.email_send_log
  add constraint email_send_log_mode_check check (mode in ('on', 'internal', 'test', 'manual', 'autopilot'));

-- 11. Planification -------------------------------------------------------------------------------------------
insert into public.cron_lease (name) values ('information-agent-autopilot') on conflict (name) do nothing;

create or replace function app_private.invoke_information_agent_autopilot_endpoint()
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  endpoint_url text;
  cron_secret text;
  request_id bigint;
begin
  -- Aucun appel (donc aucun coût côté application) tant que le pilote est coupé.
  if not exists (
    select 1 from public.information_agent_autopilot_settings settings where settings.singleton and settings.mode <> 'off'
  ) then
    return null;
  end if;

  select decrypted_secret into endpoint_url
  from vault.decrypted_secrets
  where name = 'immojudis_operational_health_url'
  order by updated_at desc
  limit 1;

  select decrypted_secret into cron_secret
  from vault.decrypted_secrets
  where name = 'immojudis_operational_health_secret'
  order by updated_at desc
  limit 1;

  if nullif(pg_catalog.btrim(endpoint_url), '') is null
    or nullif(pg_catalog.btrim(cron_secret), '') is null then
    raise warning 'ImmoJudis scheduler Vault secrets are not configured.';
    return null;
  end if;

  select net.http_get(
    url => pg_catalog.rtrim(endpoint_url, '/') || '/api/cron/information-agent-autopilot',
    headers => jsonb_build_object(
      'Authorization', 'Bearer ' || cron_secret,
      'Accept', 'application/json',
      'User-Agent', 'immojudis-supabase-cron/1.0'
    ),
    timeout_milliseconds => 280000
  ) into request_id;

  return request_id;
end;
$$;

revoke all on function app_private.invoke_information_agent_autopilot_endpoint()
from public, anon, authenticated, service_role;

select cron.unschedule(jobid)
from cron.job
where jobname = 'immojudis-information-agent-autopilot';

select cron.schedule(
  'immojudis-information-agent-autopilot',
  '*/10 * * * *',
  'select app_private.invoke_information_agent_autopilot_endpoint();'
);

notify pgrst, 'reload schema';

commit;
