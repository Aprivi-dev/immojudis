-- Conservation des événements produit par compte (point 65) : 90 jours, purgés par la rétention
-- existante (public.run_data_retention, appelée chaque jour par le cron « data-retention »).
--
-- run_data_retention garde ses purges isolées (20261025110100) : chacune dans son bloc
-- d'exception, une purge qui échoue est journalisée et rendue sous « purge_errors » sans empêcher les
-- autres. Cette migration reprend le corps de 20261025110100 à l'identique et ajoute une cinquième
-- purge, isolée de la même façon. Une migration ultérieure qui redéfinit la fonction doit garder les
-- cinq parties et la clé purge_errors.
begin;

set local lock_timeout = '5s';

create or replace function app_private.purge_account_product_events(
  p_now timestamptz default statement_timestamp()
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  deleted_events integer := 0;
begin
  delete from public.account_product_events event_row
  where event_row.occurred_at < p_now - interval '90 days';
  get diagnostics deleted_events = row_count;

  return pg_catalog.jsonb_build_object('account_product_events', deleted_events);
end;
$$;

revoke all on function app_private.purge_account_product_events(timestamptz)
  from public, anon, authenticated;
grant execute on function app_private.purge_account_product_events(timestamptz) to service_role;

comment on function app_private.purge_account_product_events(timestamptz) is
  'Supprime les événements produit par compte de plus de 90 jours. Appelée par run_data_retention.';

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

  if v_errors <> '{}'::jsonb then
    v_result := v_result || pg_catalog.jsonb_build_object('purge_errors', v_errors);
  end if;
  return v_result;
end;
$$;

comment on function public.run_data_retention(timestamptz) is
  'Runs the five retention purges, each isolated: a failing purge is logged and reported under purge_errors while the others still run and commit.';

revoke all on function public.run_data_retention(timestamptz)
  from public, anon, authenticated;
grant execute on function public.run_data_retention(timestamptz) to service_role;

notify pgrst, 'reload schema';

commit;
