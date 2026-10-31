begin;

set local lock_timeout = '5s';

-- Compte-rendu du 31/10/2026, n° 3 et partie « purge » du n° 2 (protection-donnees-code n° 2, 3 et 4) : quatre purges
-- ajoutées à public.run_data_retention, chacune isolée (une purge en échec est journalisée sous purge_errors et ne
-- bloque pas les autres), jamais exécutées jusqu'ici faute de code :
--
--   partie               table                                  durée      repère de date
--   licitor_captures     licitor_ingestion.captures             90 jours   last_seen_at (dernière observation)
--   trial_extension_notes app_private.trial_extension_notes     24 mois    fin de la prolongation (ends_at)
--   manual_grant_notes   app_private.manual_grant_notes         24 mois    fin de l'accès (current_period_end),
--                                                                           à défaut date de la décision
--   llm_analysis_cache   public.llm_analysis_cache              180 jours  created_at
--
-- LES DURÉES SONT DES PROPOSITIONS TECHNIQUES À FAIRE CONFIRMER PAR juridique-rgpd (matrice docs/data-retention-matrix.md
-- et registre docs/rgpd-processing-register.md mis à jour dans le même changement). Chacune tient dans une fonction
-- app_private.*_retention() : pour la changer, une migration qui redéfinit cette seule fonction suffit.
--
-- Choix de repère de date (à confirmer) :
--   * captures : last_seen_at, pas first_seen_at. Une capture est relue par la campagne en cours (cache de pages) et sa
--     date d'observation est mise à jour à chaque relecture ; une capture que la campagne vient de reprendre ne doit pas
--     disparaître sous elle. Une page plus observée depuis 90 jours n'est plus utile (la collecte relit les annonces
--     des 90 derniers jours) et contient des adresses masquées sous forme réversible (data-cfemail). Effet d'une
--     suppression : la page est simplement retéléchargée et re-analysée à la prochaine campagne qui la concerne
--     (announcements.current_capture_hash n'est qu'une empreinte, sans clé étrangère). Le collecteur existe depuis le
--     28/08/2026 : aucune capture n'atteint 90 jours avant fin novembre, la première purge ne supprime donc presque rien ;
--   * notes : la ligne entière est supprimée (la note est libre et le reste de la ligne ne sert qu'à la rattacher). Un
--     accès sans date de fin (current_period_end nul) garde sa note 24 mois après la décision, pas indéfiniment ;
--   * cache LLM : le résultat validé d'une extraction (sans le prompt) est recalculable ; 180 jours bornent sa durée
--     sans changer les coûts de façon sensible.
--
-- Ce que cette migration ne fait pas : filtrer les noms avant l'envoi à Replicate et avant l'écriture dans
-- llm_analysis_cache (code du pipeline, autre lot).
--
-- run_data_retention est reprise de sa dernière définition (20261102110100, onze parties) avec les quatre blocs en plus.
-- Une migration plus récente qui la redéfinit doit reprendre SA définition et y garder ces blocs.

-- 1. Durées -------------------------------------------------------------------------------------------------
create or replace function app_private.licitor_capture_retention()
returns interval
language sql
immutable
parallel safe
security invoker
set search_path = ''
as $$
  select interval '90 days';
$$;

create or replace function app_private.admin_grant_note_retention()
returns interval
language sql
immutable
parallel safe
security invoker
set search_path = ''
as $$
  select interval '24 months';
$$;

create or replace function app_private.llm_analysis_cache_retention()
returns interval
language sql
immutable
parallel safe
security invoker
set search_path = ''
as $$
  select interval '180 days';
$$;

revoke all on function app_private.licitor_capture_retention() from public, anon, authenticated;
revoke all on function app_private.admin_grant_note_retention() from public, anon, authenticated;
revoke all on function app_private.llm_analysis_cache_retention() from public, anon, authenticated;
grant execute on function app_private.licitor_capture_retention() to service_role;
grant execute on function app_private.admin_grant_note_retention() to service_role;
grant execute on function app_private.llm_analysis_cache_retention() to service_role;

comment on function app_private.licitor_capture_retention() is
  'Durée de conservation d''une capture HTML du collecteur d''historique Licitor, comptée depuis sa dernière observation : 90 jours (à confirmer par juridique-rgpd).';
comment on function app_private.admin_grant_note_retention() is
  'Durée de conservation du motif libre d''une prolongation d''essai ou d''une attribution manuelle d''accès, comptée depuis la fin de la prolongation ou de l''accès (à défaut, la date de la décision) : 24 mois (à confirmer par juridique-rgpd).';
comment on function app_private.llm_analysis_cache_retention() is
  'Durée de conservation d''un résultat du cache d''analyse LLM (public.llm_analysis_cache), comptée depuis created_at : 180 jours (à confirmer par juridique-rgpd).';

-- 2. Purges -------------------------------------------------------------------------------------------------
create or replace function app_private.purge_licitor_captures(
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
  delete from licitor_ingestion.captures
  where last_seen_at < p_now - app_private.licitor_capture_retention();
  get diagnostics v_deleted = row_count;
  return pg_catalog.jsonb_build_object('licitor_captures', v_deleted);
end;
$$;

create or replace function app_private.purge_trial_extension_notes(
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
  delete from app_private.trial_extension_notes
  where greatest(ends_at, created_at) < p_now - app_private.admin_grant_note_retention();
  get diagnostics v_deleted = row_count;
  return pg_catalog.jsonb_build_object('trial_extension_notes', v_deleted);
end;
$$;

create or replace function app_private.purge_manual_grant_notes(
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
  delete from app_private.manual_grant_notes
  where greatest(coalesce(current_period_end, created_at), created_at)
    < p_now - app_private.admin_grant_note_retention();
  get diagnostics v_deleted = row_count;
  return pg_catalog.jsonb_build_object('manual_grant_notes', v_deleted);
end;
$$;

create or replace function app_private.purge_llm_analysis_cache(
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
  delete from public.llm_analysis_cache
  where created_at < p_now - app_private.llm_analysis_cache_retention();
  get diagnostics v_deleted = row_count;
  return pg_catalog.jsonb_build_object('llm_analysis_cache', v_deleted);
end;
$$;

revoke all on function app_private.purge_licitor_captures(timestamptz) from public, anon, authenticated;
revoke all on function app_private.purge_trial_extension_notes(timestamptz) from public, anon, authenticated;
revoke all on function app_private.purge_manual_grant_notes(timestamptz) from public, anon, authenticated;
revoke all on function app_private.purge_llm_analysis_cache(timestamptz) from public, anon, authenticated;
grant execute on function app_private.purge_licitor_captures(timestamptz) to service_role;
grant execute on function app_private.purge_trial_extension_notes(timestamptz) to service_role;
grant execute on function app_private.purge_manual_grant_notes(timestamptz) to service_role;
grant execute on function app_private.purge_llm_analysis_cache(timestamptz) to service_role;

-- 3. run_data_retention : dernière définition (20261102110100) + les quatre parties ---------------------------
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

  if v_errors <> '{}'::jsonb then
    v_result := v_result || pg_catalog.jsonb_build_object('purge_errors', v_errors);
  end if;
  return v_result;
end;
$$;

comment on function public.run_data_retention(timestamptz) is
  'Runs the fifteen retention purges, each isolated: a failing purge is logged and reported under purge_errors while the others still run and commit.';

revoke all on function public.run_data_retention(timestamptz)
  from public, anon, authenticated;
grant execute on function public.run_data_retention(timestamptz) to service_role;

notify pgrst, 'reload schema';

commit;
