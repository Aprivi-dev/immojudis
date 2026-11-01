begin;

set local lock_timeout = '5s';

-- Branche la purge du journal des envois (20261110210000) sur public.run_data_retention, comme dix-septième
-- purge isolée.
--
-- run_data_retention est reprise À L'IDENTIQUE de sa dernière définition (20261110200000, seize parties) avec UN
-- bloc en plus, juste avant le calcul de purge_errors (seul le commentaire de fin, qui compte les purges, passe à
-- dix-sept). Une migration plus récente qui la redéfinit doit reprendre SA définition et y garder ce bloc. Le test
-- pgTAP supabase/tests/866_email_send_log.sql vérifie que les seize purges précédentes y sont toujours.
--
-- Aucune ligne existante n'est modifiée.

-- run_data_retention : dernière définition (20261110200000) + la dix-septième partie --------------------------
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

  if v_errors <> '{}'::jsonb then
    v_result := v_result || pg_catalog.jsonb_build_object('purge_errors', v_errors);
  end if;
  return v_result;
end;
$$;

comment on function public.run_data_retention(timestamptz) is
  'Runs the seventeen retention purges, each isolated: a failing purge is logged and reported under purge_errors while the others still run and commit.';

revoke all on function public.run_data_retention(timestamptz)
  from public, anon, authenticated;
grant execute on function public.run_data_retention(timestamptz) to service_role;

notify pgrst, 'reload schema';

commit;
