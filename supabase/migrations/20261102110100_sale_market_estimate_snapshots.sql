begin;

set local lock_timeout = '5s';

-- « Scénarios d'enchères », point 17 du compte-rendu du 23/10/2026 (décision du propriétaire : « commencer à
-- collecter »). Une référence « valeur de marché x ratio adjudication / valeur de marché du ressort » demande des
-- paires (valeur de marché estimée AVANT l'audience, prix d'adjudication publié APRÈS). Il n'en existe aucune : la
-- ligne d'estimation (public.auction_sale_market_estimates) est supprimée dès que la vente quitte les statuts
-- « active » / « upcoming » (déclencheur immojudis_queue_auction_sale_market_estimate) ou est purgée à l'heure de
-- l'audience (cascade de public.purge_expired_auction_sales), c'est-à-dire avant que le résultat soit publié. Le
-- cliché des lots Licitor n'a ni identifiant de vente ni estimation.
--
-- Cette migration commence à COLLECTER, rien d'autre : aucune lecture par l'application, aucun affichage.
--
-- 1. Table privée app_private.sale_market_estimate_snapshots : un instantané par vente, écrit juste avant la
--    disparition de la ligne d'estimation, sans donnée directement identifiante : ni adresse, ni commune, ni
--    code postal, ni identifiant de vente en clair. Colonnes : tribunal (code), département, type de bien et groupe de
--    comparaison (app_private.scenario_property_group, celui des scénarios), mise à prix, date d'audience (jour,
--    heure de Paris), estimation P10 / P50 / P90 (le moteur ne stocke pas de P25 / P75), actionable, nombre de
--    comparables, indice de confiance, moteur et version du modèle, date de l'instantané.
--    La clé d'unicité (snapshot_key) est l'empreinte SHA-256 non salée de l'identifiant de la vente : elle
--    garantit « une seule fois par vente » sans conserver l'identifiant en clair. C'est une pseudonymisation, pas
--    une anonymisation : tant que l'identifiant de la vente existe ailleurs, l'empreinte peut lui être
--    rattachée en la recalculant.
-- 2. Deux points d'écriture, tous deux AVANT la suppression de la ligne d'estimation :
--    * déclencheur BEFORE DELETE sur public.auction_sales : la purge à l'heure de l'audience (le cas de loin le plus
--      fréquent : la vente est encore « upcoming ») et la suppression d'un doublon ; c'est le seul point où la
--      ligne de la vente et celle de l'estimation sont lisibles ensemble avant la cascade ;
--    * déclencheur BEFORE UPDATE OF status sur public.auction_sales : la vente passe à « past », « adjudicated »,
--      « unknown »… et le déclencheur de file supprime alors l'estimation.
--    Même garde que l'instantané des ventes suivies (20261028190100) : audience passée, jamais une vente reportée,
--    annulée, retirée ou en quarantaine, jamais une fusion de doublons ; en plus, vente de tribunal avec code de
--    tribunal et mise à prix, et estimation « ready » à jour (une estimation en attente de recalcul porte une valeur
--    d'avant la modification du bien : écartée). Une panne de l'écriture ne bloque JAMAIS la purge ou la mise à jour
--    de la vente : l'erreur est journalisée en avertissement.
-- 3. Conservation : 36 mois après la date d'audience, la fenêtre des scénarios (app_private.
--    market_estimate_snapshot_retention). Purge hebdomadaire par public.run_data_retention (onzième partie isolée).
--    La matrice docs/data-retention-matrix.md est mise à jour.
-- 4. Accès : RLS activée, aucun droit pour anon / authenticated, lecture seule pour service_role (le test
--    confirmatoire de docs/runbooks/scenarios-encheres.md). L'écriture passe par les fonctions security definer.

-- 1. Table ------------------------------------------------------------------------------------------
create table if not exists app_private.sale_market_estimate_snapshots (
  snapshot_key text primary key check (snapshot_key ~ '^[0-9a-f]{64}$'),
  court_code text not null,
  department text,
  property_type text,
  property_group text,
  starting_price_eur numeric not null check (starting_price_eur > 0),
  sale_date date not null,
  value_p10_eur numeric check (value_p10_eur is null or value_p10_eur >= 0),
  value_p50_eur numeric not null check (value_p50_eur > 0),
  value_p90_eur numeric check (value_p90_eur is null or value_p90_eur >= 0),
  actionable boolean not null,
  comparable_count integer not null check (comparable_count >= 0),
  confidence_score integer check (confidence_score is null or confidence_score between 0 and 100),
  engine_kind text,
  model_version text,
  estimate_computed_at timestamptz,
  captured_at timestamptz not null default statement_timestamp()
);

create index if not exists sale_market_estimate_snapshots_sale_date_idx
  on app_private.sale_market_estimate_snapshots (sale_date);
create index if not exists sale_market_estimate_snapshots_court_date_idx
  on app_private.sale_market_estimate_snapshots (court_code, sale_date);

comment on table app_private.sale_market_estimate_snapshots is
  'Un instantané par vente de tribunal, écrit juste avant la disparition de la ligne d''estimation (purge à l''audience ou sortie des statuts active/upcoming) : tribunal, département, type de bien, mise à prix, date d''audience, estimation P10/P50/P90 et qualité. Ne contient pas de donnée directement identifiante : aucune adresse, aucun identifiant de vente en clair (snapshot_key = empreinte SHA-256 non salée de l''identifiant de la vente : pseudonymisation, pas anonymisation, tant que l''identifiant existe ailleurs). Sert à apparier plus tard estimation et prix d''adjudication agrégé. Conservé 36 mois après l''audience (app_private.market_estimate_snapshot_retention), purgé par run_data_retention.';

alter table app_private.sale_market_estimate_snapshots enable row level security;
revoke all on table app_private.sale_market_estimate_snapshots from public, anon, authenticated;
grant select on table app_private.sale_market_estimate_snapshots to service_role;

-- 2. Conservation ------------------------------------------------------------------------------------
create or replace function app_private.market_estimate_snapshot_retention()
returns interval
language sql
immutable
parallel safe
security invoker
set search_path = ''
as $$
  select interval '36 months';
$$;

revoke all on function app_private.market_estimate_snapshot_retention()
  from public, anon, authenticated;
grant execute on function app_private.market_estimate_snapshot_retention() to service_role;

comment on function app_private.market_estimate_snapshot_retention() is
  'Durée de conservation d''un instantané d''estimation, comptée depuis la date d''audience : 36 mois, la fenêtre des scénarios d''enchères.';

-- 3. Écriture ---------------------------------------------------------------------------------------
create or replace function app_private.snapshot_sale_market_estimate(p_sale public.auction_sales)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
begin
  -- Audience passée seulement, vente de tribunal maintenue, jamais une fusion de doublons.
  if p_sale.sale_date is null
    or p_sale.sale_date > pg_catalog.now()
    or coalesce(p_sale.status, '') in ('postponed', 'cancelled', 'withdrawn', 'quarantined')
    or coalesce(p_sale.catalogue_quarantined, false)
    or p_sale.sale_venue_type is distinct from 'tribunal'
    or p_sale.tribunal_code is null
    or coalesce(p_sale.starting_price_eur, 0) <= 0
    or exists (
      select 1 from app_private.auction_sale_merges merged where merged.old_sale_id = p_sale.id
    )
  then
    return;
  end if;

  begin
    insert into app_private.sale_market_estimate_snapshots (
      snapshot_key, court_code, department, property_type, property_group, starting_price_eur,
      sale_date, value_p10_eur, value_p50_eur, value_p90_eur, actionable, comparable_count,
      confidence_score, engine_kind, model_version, estimate_computed_at
    )
    select
      pg_catalog.encode(
        pg_catalog.sha256(
          pg_catalog.convert_to('sale-market-estimate-snapshot:v1:' || p_sale.id::text, 'UTF8')
        ),
        'hex'
      ),
      p_sale.tribunal_code,
      p_sale.department,
      p_sale.property_type,
      app_private.scenario_property_group(p_sale.property_type),
      p_sale.starting_price_eur,
      pg_catalog.timezone('Europe/Paris', p_sale.sale_date)::date,
      estimate.value_p10_eur,
      estimate.value_p50_eur,
      estimate.value_p90_eur,
      estimate.actionable,
      estimate.comparable_count,
      estimate.confidence_score,
      estimate.engine_kind,
      estimate.model_version,
      estimate.computed_at
    from public.auction_sale_market_estimates estimate
    where estimate.auction_sale_id = p_sale.id
      and estimate.status = 'ready'
      and estimate.value_p50_eur > 0
    on conflict (snapshot_key) do nothing;
  exception when others then
    -- Ne jamais bloquer la purge ni la mise à jour de la vente pour un instantané.
    raise warning 'snapshot_sale_market_estimate: not written (SQLSTATE %): %', sqlstate, sqlerrm;
  end;
end;
$function$;

revoke all on function app_private.snapshot_sale_market_estimate(public.auction_sales)
  from public, anon, authenticated;

comment on function app_private.snapshot_sale_market_estimate(public.auction_sales) is
  'Garde l''estimation de marché d''une vente de tribunal dont l''audience est passée, une seule fois (snapshot_key), juste avant la disparition de sa ligne d''estimation. Jamais pour une vente reportée, annulée, retirée, en quarantaine ou fusionnée ; une erreur n''empêche jamais l''opération appelante.';

-- Purge de la vente (à l'heure de l'audience) ou suppression d'un doublon. Les déclencheurs « before delete » d'une
-- même table s'exécutent par ordre alphabétique : auction_sales_carry_favorite_dossier et
-- auction_sales_carry_sale_user_data (fusion de doublons) passent avant ce déclencheur, qui lit alors la
-- correspondance de fusion et ne capture rien.
create or replace function app_private.snapshot_market_estimate_before_delete()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform app_private.snapshot_sale_market_estimate(old);
  return old;
end;
$$;

revoke all on function app_private.snapshot_market_estimate_before_delete()
  from public, anon, authenticated;

drop trigger if exists auction_sales_snapshot_market_estimate on public.auction_sales;
create trigger auction_sales_snapshot_market_estimate
before delete on public.auction_sales
for each row execute function app_private.snapshot_market_estimate_before_delete();

-- La vente quitte les statuts « active » / « upcoming » : le déclencheur de file supprime son estimation
-- (immojudis_queue_auction_sale_market_estimate, après la mise à jour) ; celui-ci passe avant.
create or replace function app_private.snapshot_market_estimate_on_status_exit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform app_private.snapshot_sale_market_estimate(new);
  return new;
end;
$$;

revoke all on function app_private.snapshot_market_estimate_on_status_exit()
  from public, anon, authenticated;

drop trigger if exists auction_sales_snapshot_market_estimate_on_status_exit on public.auction_sales;
create trigger auction_sales_snapshot_market_estimate_on_status_exit
before update of status on public.auction_sales
for each row
when (
  old.status is distinct from new.status
  and (new.status is null or new.status not in ('active', 'upcoming'))
)
execute function app_private.snapshot_market_estimate_on_status_exit();

-- 4. Purge ------------------------------------------------------------------------------------------
create or replace function app_private.purge_market_estimate_snapshots(
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
  delete from app_private.sale_market_estimate_snapshots
  where sale_date < (p_now - app_private.market_estimate_snapshot_retention())::date;
  get diagnostics v_deleted = row_count;
  return pg_catalog.jsonb_build_object('sale_market_estimate_snapshots', v_deleted);
end;
$$;

revoke all on function app_private.purge_market_estimate_snapshots(timestamptz)
  from public, anon, authenticated;
grant execute on function app_private.purge_market_estimate_snapshots(timestamptz) to service_role;

-- Même corps que 20261030120300 (dernière définition au moment de l'écriture : dix parties isolées), plus la
-- purge des instantanés d'estimation. Une migration plus récente qui redéfinit cette fonction doit reprendre SA
-- définition et y ajouter ce bloc.
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

  if v_errors <> '{}'::jsonb then
    v_result := v_result || pg_catalog.jsonb_build_object('purge_errors', v_errors);
  end if;
  return v_result;
end;
$$;

comment on function public.run_data_retention(timestamptz) is
  'Runs the eleven retention purges, each isolated: a failing purge is logged and reported under purge_errors while the others still run and commit.';

revoke all on function public.run_data_retention(timestamptz)
  from public, anon, authenticated;
grant execute on function public.run_data_retention(timestamptz) to service_role;

notify pgrst, 'reload schema';

commit;
