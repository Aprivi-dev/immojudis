begin;

set local lock_timeout = '5s';

-- Rétention incomplète (point 6 de la session du 20/10/2026, chantier W1).
--
-- Constat en production : 220 ventes « quarantined » (dont 28 échues depuis plus d'un jour et 7 depuis
-- plus de 30 jours) et 179 ventes « past » n'ont pas d'échéance et ne sont jamais purgées par
-- sale-retention.
--
-- La purge des ventes (public.purge_expired_auction_sales) supprime sur la date limite exacte
-- catalogue_expiry_deadline (app_private.sale_catalogue_retention_deadline, 20261003130000), et
-- retention_deadline (app_private.sale_retention_deadline, avec 24 h de grâce) sert de garde aux files
-- d'enrichissement. Les deux fonctions rendent null, donc « jamais purgée », dans des cas qui n'ont
-- de sens que pour une vente à venir :
--   * un conflit de sources sur la date de vente : la fonction du catalogue en exempte déjà les statuts
--     terminaux (past, adjudicated, cancelled, withdrawn) mais pas « quarantined » ; la fonction de la
--     garde n'en exempte aucun, pas même « past » ;
--   * une fenêtre de vente en ligne illisible (dates mal formées ou inversées) : la vente est conservée
--     « pour examen », ce qui est prudent pour une vente à venir, mais une vente passée ou en
--     quarantaine n'a plus rien à attendre.
-- Pour les statuts « past » et « quarantined » seulement, ces deux cas ne bloquent plus : l'échéance est
-- celle des ventes à venir (la fin de la fenêtre en ligne si elle est lisible, sinon l'audience : la
-- date limite exacte du catalogue, et cette date + 24 h pour la garde). Rien d'autre ne change :
--   * une vente reportée (statut ou statut brut) garde son absence d'échéance (le test 320 le fige : « la
--     reprogrammation survit à la normalisation héritée ») ; la purge la traite par son repli dédié ;
--   * une vente à venir ou inconnue, avec un conflit ou une fenêtre illisible, reste conservée ;
--   * une vente sans date d'audience reste sans échéance : sans date, rien ne permet d'en déduire une
--     (à décider séparément, par exemple sur la date de dernière observation).
--
-- Aucune donnée n'est réparée ici : les déclencheurs ne recalculent une échéance qu'à l'écriture de la
-- ligne. Le rattrapage des lignes existantes est dans
-- supabase/repairs/20261029100200_recompute_past_quarantined_deadlines.sql (comptage par défaut, non
-- lancé).
--
-- Même migration : purge_sale_reminder_dispatches (journal des rappels, 180 jours) n'était appelée que
-- par le cron des rappels, donc jamais quand les rappels sont en mode « off ». Elle devient une sixième
-- partie, isolée, de public.run_data_retention (dernière définition : 20261028190100).

-- 1. Échéance de garde (retention_deadline) ------------------------------------------------------------
-- Même corps que 20260913113416, avec v_terminal (past, quarantined).
create or replace function app_private.sale_retention_deadline(
  p_sale_date timestamptz, p_status text, p_procedure jsonb, p_raw jsonb
) returns timestamptz language plpgsql stable security invoker set search_path = '' as $$
declare
  schedule jsonb;
  start_at timestamptz;
  end_at timestamptz;
  v_raw jsonb := case
    when jsonb_typeof(p_raw) = 'object' then p_raw || '{}'::jsonb
    else p_raw
  end;
  raw_date text := coalesce(v_raw->>'sale_date', '');
  raw_precision text := lower(coalesce(
    nullif(btrim(v_raw->>'date_precision'), ''),
    nullif(btrim(v_raw->>'sale_date_precision'), ''),
    ''
  ));
  -- Une vente passée ou en quarantaine n'attend plus rien : ni conflit de date à instruire, ni fenêtre
  -- en ligne à comprendre. Elle suit la règle des ventes à venir (échéance après l'audience).
  v_terminal boolean := lower(coalesce(p_status, '')) in ('past', 'quarantined');
begin
  if lower(coalesce(v_raw->>'status','')) ~ '(postponed|reported|report[eé]e?)' then return null; end if;
  if jsonb_path_exists(coalesce(v_raw,'{}'), '$.source_conflicts[*] ? (@.field == "sale_date")')
     and not v_terminal then return null; end if;
  if lower(coalesce(p_status,'')) in ('postponed','reported','reportee','reporté','reportée') then return null; end if;
  foreach schedule in array array[p_procedure->'sale_window', p_procedure->'sale_session', v_raw->'source_sale_schedule'] loop
    if schedule is not null and schedule <> 'null'::jsonb then
      begin
        if (schedule->>'opens_at') !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}([.]\d+)?(Z|[+-]\d{2}:\d{2})$'
          or (schedule->>'closes_at') !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}([.]\d+)?(Z|[+-]\d{2}:\d{2})$'
          or schedule->>'opens_at' is null or schedule->>'closes_at' is null then
          if not v_terminal then return null; end if;
        else
          start_at := (schedule->>'opens_at')::timestamptz;
          end_at := (schedule->>'closes_at')::timestamptz;
          if not isfinite(start_at) or not isfinite(end_at) or end_at <= start_at then
            if not v_terminal then return null; end if;
          else
            return end_at + interval '24 hours';
          end if;
        end if;
      exception when invalid_datetime_format or datetime_field_overflow then
        if not v_terminal then return null; end if;
      end;
    end if;
  end loop;
  if p_sale_date is null or not isfinite(p_sale_date) then return null; end if;
  if raw_precision in ('day', 'date', 'day_only', 'date_only', 'unknown_time', 'time_unknown')
     or (raw_date <> '' and raw_date !~ '[0-9]{1,2}[[:space:]]*([hH]|:[0-9]{2})') then
    -- Legacy collectors stored an identified date-only value at UTC midnight.
    -- Move to the following Paris midnight, then add 24 elapsed hours.
    return ((((p_sale_date at time zone 'Europe/Paris')::date + 1)::timestamp at time zone 'Europe/Paris')
      + interval '24 hours');
  end if;
  return p_sale_date + interval '24 hours';
end;
$$;
revoke all on function app_private.sale_retention_deadline(timestamptz,text,jsonb,jsonb) from public, anon, authenticated;
grant execute on function app_private.sale_retention_deadline(timestamptz,text,jsonb,jsonb) to service_role;

-- 2. Date limite exacte du catalogue (catalogue_expiry_deadline) ------------------------------------------
-- Même corps que 20261003130000, avec « quarantined » parmi les statuts qui lèvent le conflit de date et
-- v_terminal (past, quarantined) pour la fenêtre de vente en ligne illisible.
create or replace function app_private.sale_catalogue_retention_deadline(
  p_sale_date timestamptz,
  p_status text,
  p_procedure jsonb,
  p_raw jsonb
)
returns timestamptz
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_raw jsonb := case
    when jsonb_typeof(coalesce(p_raw, '{}'::jsonb)) = 'object' then coalesce(p_raw, '{}'::jsonb)
    else '{}'::jsonb
  end;
  v_schedule jsonb;
  v_start_at timestamptz;
  v_end_at timestamptz;
  v_terminal boolean := lower(coalesce(p_status, '')) in ('past', 'quarantined');
begin
  -- A source-level postponement is not enough evidence to expire the old
  -- hearing.  A row carrying a concrete rescheduled date remains visible
  -- through sale_catalogue_expiry and is handled by the explicit postponed
  -- fallback in the purge below.
  if lower(coalesce(v_raw->>'status', '')) ~ '(postponed|reported|report[eé]e?)'
     or lower(coalesce(p_status, '')) in ('postponed', 'reported', 'reportee', 'reporté', 'reportée') then
    return null;
  end if;

  -- A contradictory upcoming/unknown date is retained for investigation.
  -- Terminal status is positive evidence that the contradiction is stale and
  -- may be archived at its exact catalogue cutoff.  A quarantined sale is out
  -- of the catalogue: it no longer waits for the contradiction to be settled.
  if jsonb_path_exists(
       coalesce(v_raw, '{}'::jsonb),
       '$.source_conflicts[*] ? (@.field == "sale_date")'
     )
     and lower(coalesce(p_status, '')) not in (
       'past', 'adjudicated', 'cancelled', 'withdrawn', 'quarantined'
     ) then
    return null;
  end if;

  foreach v_schedule in array array[
    coalesce(p_procedure, '{}'::jsonb)->'sale_window',
    coalesce(p_procedure, '{}'::jsonb)->'sale_session',
    v_raw->'source_sale_schedule'
  ] loop
    if v_schedule is not null and v_schedule <> 'null'::jsonb then
      begin
        if (v_schedule->>'opens_at') !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}([.]\d+)?(Z|[+-]\d{2}:\d{2})$'
           or (v_schedule->>'closes_at') !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}([.]\d+)?(Z|[+-]\d{2}:\d{2})$'
           or v_schedule->>'opens_at' is null
           or v_schedule->>'closes_at' is null then
          -- An unreadable window keeps an upcoming sale for investigation; a past or
          -- quarantined sale falls back to its hearing date.
          if not v_terminal then return null; end if;
        else
          v_start_at := (v_schedule->>'opens_at')::timestamptz;
          v_end_at := (v_schedule->>'closes_at')::timestamptz;
          if not isfinite(v_start_at) or not isfinite(v_end_at) or v_end_at <= v_start_at then
            if not v_terminal then return null; end if;
          else
            return v_end_at;
          end if;
        end if;
      exception
        when invalid_datetime_format or datetime_field_overflow then
          if not v_terminal then return null; end if;
      end;
    end if;
  end loop;

  return app_private.sale_catalogue_expiry(p_sale_date, v_raw);
end;
$$;

revoke all on function app_private.sale_catalogue_retention_deadline(timestamptz, text, jsonb, jsonb)
  from public, anon, authenticated;
grant execute on function app_private.sale_catalogue_retention_deadline(timestamptz, text, jsonb, jsonb)
  to service_role;

-- 3. Rétention des données : le journal des rappels devient une partie isolée -------------------------------
-- Même corps que 20261028190100, plus la purge du journal des rappels d'audience. Une migration ultérieure
-- qui redéfinit cette fonction doit garder les sept parties isolées et la clé purge_errors.
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

  if v_errors <> '{}'::jsonb then
    v_result := v_result || pg_catalog.jsonb_build_object('purge_errors', v_errors);
  end if;
  return v_result;
end;
$$;

comment on function public.run_data_retention(timestamptz) is
  'Runs the seven retention purges, each isolated: a failing purge is logged and reported under purge_errors while the others still run and commit.';

revoke all on function public.run_data_retention(timestamptz)
  from public, anon, authenticated;
grant execute on function public.run_data_retention(timestamptz) to service_role;

notify pgrst, 'reload schema';

commit;
