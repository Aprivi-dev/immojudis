begin;

set local lock_timeout = '5s';

-- Rétention : les journaux du récapitulatif hebdomadaire et des alertes de résultat deviennent deux parties
-- isolées de public.run_data_retention (points 70 et 73 de la session du 20/10/2026).
--
-- Même corps que 20261030110200 (dernière définition au moment de l'écriture, huit parties dont
-- purge_sale_signal_feedback : si une migration plus récente la redéfinit, reprendre SA définition et y
-- ajouter ces deux blocs), plus la purge de public.weekly_digest_dispatches et de
-- public.sale_result_dispatches. Chaque purge reste isolée : un échec est journalisé et signalé sous
-- purge_errors sans arrêter les autres. Les deux journaux sont aussi purgés quand les interrupteurs d'envoi
-- valent « off » : c'est pourquoi la purge est ici et pas dans les crons d'envoi.

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

  if v_errors <> '{}'::jsonb then
    v_result := v_result || pg_catalog.jsonb_build_object('purge_errors', v_errors);
  end if;
  return v_result;
end;
$$;

comment on function public.run_data_retention(timestamptz) is
  'Runs the ten retention purges, each isolated: a failing purge is logged and reported under purge_errors while the others still run and commit.';

revoke all on function public.run_data_retention(timestamptz)
  from public, anon, authenticated;
grant execute on function public.run_data_retention(timestamptz) to service_role;

notify pgrst, 'reload schema';

commit;
