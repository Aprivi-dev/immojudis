begin;

set local lock_timeout = '5s';

-- Journal durable des consultations de l'historique des emails par les administrateurs (lot 4).
--
-- Consulter le journal des envois, ou le contenu d'un message encore conservé chez Resend, est un traitement de
-- données personnelles : ces consultations sont tracées 6 mois, SANS le contenu et SANS l'adresse. Cette migration
-- ajoute :
--   1. public.admin_email_access_log : administrateur (identifiant, sans clé étrangère : la trace ne doit pas
--      dépendre du compte), instant, portée (admin.email.list : une liste ; admin.email.view : un message),
--      identifiant technique du message (jamais l'adresse) ou nombre de lignes d'une liste. RLS activée, AUCUN droit
--      pour anon, authenticated ni public : seul service_role y accède (routes d'administration, purge).
--   2. app_private.admin_email_access_log_retention() : 6 mois, dans UNE fonction. À confirmer par juridique-rgpd.
--   3. app_private.purge_admin_email_access_log, ajoutée à public.run_data_retention comme dix-huitième purge
--      isolée. run_data_retention est reprise à l'identique de sa dernière définition (20261110210100, dix-sept
--      parties) avec UN bloc en plus.
--
-- Aucune ligne existante n'est modifiée.

create table if not exists public.admin_email_access_log (
  id uuid primary key default gen_random_uuid(),
  admin_user_id uuid not null,
  occurred_at timestamptz not null default now(),
  scope text not null,
  -- Identifiant technique de la ligne du journal des envois ou du message consulté ; jamais une adresse.
  target_id text,
  -- Nombre de lignes renvoyées par une liste.
  row_count integer,
  constraint admin_email_access_log_scope_check check (scope in ('admin.email.view', 'admin.email.list')),
  constraint admin_email_access_log_size_check check (
    (target_id is null or char_length(target_id) <= 80) and (row_count is null or row_count between 0 and 1000)
  )
);

comment on table public.admin_email_access_log is
  'Consultations de l''historique des emails par les administrateurs : qui, quand, quelle portée, quel identifiant technique ; ni contenu ni adresse. Conservation : 6 mois, voir app_private.admin_email_access_log_retention.';

create index if not exists admin_email_access_log_occurred_idx
  on public.admin_email_access_log (occurred_at);

alter table public.admin_email_access_log enable row level security;

revoke all on table public.admin_email_access_log from public, anon, authenticated;
grant select, insert, delete on table public.admin_email_access_log to service_role;
-- Aucune politique : RLS sans politique refuse tout rôle soumis aux politiques ; service_role les contourne.

create or replace function app_private.admin_email_access_log_retention()
returns interval
language sql
immutable
parallel safe
security invoker
set search_path = ''
as $$
  select interval '6 months';
$$;

revoke all on function app_private.admin_email_access_log_retention() from public, anon, authenticated;
grant execute on function app_private.admin_email_access_log_retention() to service_role;

comment on function app_private.admin_email_access_log_retention() is
  'Durée de conservation d''une consultation de l''historique des emails, comptée depuis occurred_at : 6 mois (à confirmer par juridique-rgpd).';

create or replace function app_private.purge_admin_email_access_log(
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
  delete from public.admin_email_access_log entry
  where entry.occurred_at < p_now - app_private.admin_email_access_log_retention();
  get diagnostics v_deleted = row_count;
  return pg_catalog.jsonb_build_object('admin_email_access_log', v_deleted);
end;
$$;

revoke all on function app_private.purge_admin_email_access_log(timestamptz)
  from public, anon, authenticated;
grant execute on function app_private.purge_admin_email_access_log(timestamptz) to service_role;

-- run_data_retention : dernière définition (20261110210100) + la dix-huitième partie -------------------------
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

  -- Journal des emails envoyés (20261110210000) : 90 jours (app_private.email_send_log_retention).
  begin
    v_result := v_result || coalesce(app_private.purge_email_send_log(p_now), '{}'::jsonb);
  exception when others then
    v_errors := v_errors || pg_catalog.jsonb_build_object('purge_email_send_log', sqlstate);
    raise warning 'run_data_retention: purge_email_send_log failed (SQLSTATE %): %',
      sqlstate, sqlerrm;
  end;

  -- Consultations de l'historique des emails par les administrateurs (20261110210200) : 6 mois.
  begin
    v_result := v_result || coalesce(app_private.purge_admin_email_access_log(p_now), '{}'::jsonb);
  exception when others then
    v_errors := v_errors || pg_catalog.jsonb_build_object('purge_admin_email_access_log', sqlstate);
    raise warning 'run_data_retention: purge_admin_email_access_log failed (SQLSTATE %): %',
      sqlstate, sqlerrm;
  end;

  if v_errors <> '{}'::jsonb then
    v_result := v_result || pg_catalog.jsonb_build_object('purge_errors', v_errors);
  end if;
  return v_result;
end;
$$;

comment on function public.run_data_retention(timestamptz) is
  'Runs the eighteen retention purges, each isolated: a failing purge is logged and reported under purge_errors while the others still run and commit.';

revoke all on function public.run_data_retention(timestamptz)
  from public, anon, authenticated;
grant execute on function public.run_data_retention(timestamptz) to service_role;

notify pgrst, 'reload schema';

commit;
