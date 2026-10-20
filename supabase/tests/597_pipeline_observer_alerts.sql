-- 20261029170100 (W9, points 14, 48 et 49) : nouvelles alertes de observe_autonomous_pipeline :
--   * pipeline.scheduler.disabled (pilote coupé depuis plus de 24 h) et pipeline.inventory.stale
--     (aucune source activée avec un inventaire complet de moins de 18 h), évaluées même pilote coupé ;
--   * pipeline.source.<source>.publication_stale (source activée, publication complète de plus de 36 h) ;
--   * pipeline.source.<source>.stale_listings (moins de 80 % d'annonces revues sur deux observations
--     consécutives, source activée d'au moins 10 ventes actives) ;
--   * pipeline.enrichment.stalled : un report voulu par le budget IA du jour n'est plus un blocage.
-- La fraîcheur des annonces (public.auction_all_source_freshness) est remplacée, dans ce test seulement
-- (annulé par le rollback), par une lecture d'une table de fixtures : on teste la logique d'alerte, pas le
-- calcul de fraîcheur, déjà couvert par les tests 402 et 403.
begin;

select plan(38);

select ok(
  position('pipeline.scheduler.disabled' in pg_get_functiondef(
    'public.observe_autonomous_pipeline(timestamptz)'::regprocedure
  )) > 0
  and position('pipeline.inventory.stale' in pg_get_functiondef(
    'public.observe_autonomous_pipeline(timestamptz)'::regprocedure
  )) > 0
  and position('.publication_stale' in pg_get_functiondef(
    'public.observe_autonomous_pipeline(timestamptz)'::regprocedure
  )) > 0
  and position('.stale_listings' in pg_get_functiondef(
    'public.observe_autonomous_pipeline(timestamptz)'::regprocedure
  )) > 0,
  'l''observateur porte les quatre nouvelles familles d''alertes'
);

-- Les correctifs antérieurs sont conservés (seuil .missed à 18 h, tâches épuisées, métriques de file).
select ok(
  position('interval ''18 hours''' in lower(pg_get_functiondef(
    'public.observe_autonomous_pipeline(timestamptz)'::regprocedure
  ))) > 0
  and position('pipeline.enrichment.exhausted' in pg_get_functiondef(
    'public.observe_autonomous_pipeline(timestamptz)'::regprocedure
  )) > 0
  and position('claimable_due' in pg_get_functiondef(
    'public.observe_autonomous_pipeline(timestamptz)'::regprocedure
  )) > 0
  and position('baseline_projection as materialized' in pg_get_functiondef(
    'public.observe_autonomous_pipeline(timestamptz)'::regprocedure
  )) > 0
  and position('revision_ranked as materialized' in pg_get_functiondef(
    'public.observe_autonomous_pipeline(timestamptz)'::regprocedure
  )) > 0,
  'les correctifs antérieurs sont conservés dans la nouvelle définition'
);

select ok(
  (
    select procedure_row.prosecdef
      and procedure_row.proconfig @> array['search_path=""']::text[]
      and has_function_privilege(
        'service_role', 'public.observe_autonomous_pipeline(timestamptz)', 'execute'
      )
      and not has_function_privilege(
        'anon', 'public.observe_autonomous_pipeline(timestamptz)', 'execute'
      )
      and not has_function_privilege(
        'authenticated', 'public.observe_autonomous_pipeline(timestamptz)', 'execute'
      )
    from pg_proc procedure_row
    where procedure_row.oid = 'public.observe_autonomous_pipeline(timestamptz)'::regprocedure
  ),
  'l''observateur reste SECURITY DEFINER, fermé au navigateur, ouvert au service'
);

-- Fixtures : aucune alerte, aucune observation, aucune source activée, aucune file.
delete from public.operational_alerts;
delete from public.auction_pipeline_observations;
delete from public.auction_enrichment_jobs;
delete from public.auction_runs where status in ('queued', 'running');
update public.auction_source_state set enabled = false;

create table public.pgtap_597_freshness (
  source_name text primary key,
  active_listings bigint not null,
  fresh_listings bigint not null
);

create or replace function public.auction_all_source_freshness(p_now timestamptz default now())
returns table(source_name text, active_listings bigint, fresh_listings bigint)
language sql
stable
security definer
set search_path = ''
as $$
  select fixture.source_name, fixture.active_listings, fixture.fresh_listings
  from public.pgtap_597_freshness fixture;
$$;

create temporary table pgtap_597_context (p_now timestamptz not null) on commit drop;

-- ---------------------------------------------------------------------------------------------
-- 1. Pilote coupé
-- ---------------------------------------------------------------------------------------------
insert into pgtap_597_context values ('2026-10-20T10:00:00Z');
update public.auction_pipeline_control
set enabled = false,
    observation_started_at = '2026-10-01T00:00:00Z',
    updated_at = '2026-10-19T09:00:00Z'
where id;

select is(
  public.observe_autonomous_pipeline((select p_now from pgtap_597_context)),
  '{"enabled": false}'::jsonb,
  'pilote coupé : le résultat reste {"enabled": false}'
);

select ok(
  (
    select status = 'open' and severity = 'warning'
      and (details->>'enabled')::boolean = false
      and (details->>'disabled_since')::timestamptz = '2026-10-19T09:00:00Z'::timestamptz
    from public.operational_alerts
    where alert_key = 'pipeline.scheduler.disabled'
  ),
  'pilote coupé depuis 25 h : pipeline.scheduler.disabled s''ouvre (avertissement), avec la date de coupure'
);

select ok(
  (
    select status = 'open' and severity = 'critical'
      and (details->>'enabled_sources')::integer = 0
      and (details->>'sources_with_recent_inventory')::integer = 0
    from public.operational_alerts
    where alert_key = 'pipeline.inventory.stale'
  ),
  'sans source activée, pipeline.inventory.stale s''ouvre (critique) même pilote coupé'
);

-- Pilote coupé depuis moins de 24 h : pas d'avertissement.
delete from public.operational_alerts where alert_key = 'pipeline.scheduler.disabled';
update public.auction_pipeline_control set updated_at = '2026-10-19T11:00:00Z' where id;
select public.observe_autonomous_pipeline((select p_now from pgtap_597_context));

select is(
  (select count(*) from public.operational_alerts where alert_key = 'pipeline.scheduler.disabled'),
  0::bigint,
  'pilote coupé depuis 23 h : pas d''avertissement'
);

update public.auction_pipeline_control set updated_at = '2026-10-19T09:00:00Z' where id;

-- Une source activée termine un inventaire : pipeline.inventory.stale se calme, le pilote reste coupé.
insert into public.auction_source_state (
  source_name, enabled, next_inventory_at, last_inventory_complete_at, last_publication_complete_at
) values (
  'pgtap-597-a', true, '2026-10-21T00:00:00Z', '2026-10-20T08:00:00Z', '2026-10-20T08:00:00Z'
);
update pgtap_597_context set p_now = '2026-10-20T10:10:00Z';
select public.observe_autonomous_pipeline((select p_now from pgtap_597_context));

select ok(
  (
    select status = 'open' and inactive_since is not null
    from public.operational_alerts
    where alert_key = 'pipeline.inventory.stale'
  ),
  'un inventaire complet de moins de 18 h rend pipeline.inventory.stale inactive'
);

select ok(
  (
    select status = 'open' and inactive_since is null
    from public.operational_alerts
    where alert_key = 'pipeline.scheduler.disabled'
  ),
  'pipeline.scheduler.disabled reste active tant que le pilote est coupé'
);

update pgtap_597_context set p_now = '2026-10-20T12:30:00Z';
update public.auction_source_state
set last_inventory_complete_at = '2026-10-20T12:00:00Z'
where source_name = 'pgtap-597-a';
select public.observe_autonomous_pipeline((select p_now from pgtap_597_context));

select is(
  (select status from public.operational_alerts where alert_key = 'pipeline.inventory.stale'),
  'resolved',
  'pipeline.inventory.stale se referme d''elle-même'
);

-- Plus aucune source n'a d'inventaire de moins de 18 h : l'alerte revient.
update pgtap_597_context set p_now = '2026-10-21T08:00:00Z';
select public.observe_autonomous_pipeline((select p_now from pgtap_597_context));

select ok(
  (
    select status = 'open' and inactive_since is null
      and (details->>'enabled_sources')::integer = 1
      and (details->>'sources_with_recent_inventory')::integer = 0
    from public.operational_alerts
    where alert_key = 'pipeline.inventory.stale'
  ),
  'une source activée dont l''inventaire date de plus de 18 h rouvre pipeline.inventory.stale'
);

-- Pilote rétabli : l'avertissement se calme puis se ferme, le résultat redevient complet.
update public.auction_pipeline_control
set enabled = true, updated_at = '2026-10-21T08:05:00Z'
where id;
update public.auction_source_state
set last_inventory_complete_at = '2026-10-21T07:50:00Z',
    last_publication_complete_at = '2026-10-21T07:50:00Z'
where source_name = 'pgtap-597-a';
update pgtap_597_context set p_now = '2026-10-21T08:10:00Z';

select is(
  (
    select public.observe_autonomous_pipeline((select p_now from pgtap_597_context))->>'enabled'
  ),
  'true',
  'pilote rétabli : l''observation complète reprend'
);

select ok(
  (
    select inactive_since is not null
    from public.operational_alerts
    where alert_key = 'pipeline.scheduler.disabled'
  ),
  'pilote rétabli : pipeline.scheduler.disabled devient inactive'
);

update pgtap_597_context set p_now = '2026-10-21T10:30:00Z';
select public.observe_autonomous_pipeline((select p_now from pgtap_597_context));

select is(
  (select status from public.operational_alerts where alert_key = 'pipeline.scheduler.disabled'),
  'resolved',
  'pipeline.scheduler.disabled se referme d''elle-même'
);

-- ---------------------------------------------------------------------------------------------
-- 2. publication_stale
-- ---------------------------------------------------------------------------------------------
delete from public.operational_alerts;
delete from public.auction_pipeline_observations;
update public.auction_source_state set enabled = false;
update public.auction_pipeline_control
set enabled = true, observation_started_at = '2026-10-16T00:00:00Z', updated_at = '2026-10-21T08:05:00Z'
where id;
update pgtap_597_context set p_now = '2026-10-22T12:00:00Z';

delete from public.auction_source_state where source_name like 'pgtap-597-%';
insert into public.auction_source_state (
  source_name, enabled, next_inventory_at, last_inventory_complete_at, last_publication_complete_at
) values
  -- Inventaire terminé, publication figée depuis 37 h (Enchères Immobilières, figée au 08/10).
  ('pgtap-597-frozen', true, '2026-10-23T00:00:00Z', '2026-10-22T11:00:00Z', '2026-10-20T23:00:00Z'),
  -- Publication d'il y a 35 h : encore dans la limite.
  ('pgtap-597-recent', true, '2026-10-23T00:00:00Z', '2026-10-22T11:00:00Z', '2026-10-21T01:00:00Z'),
  -- Aucune publication complète, jamais (Agrasc) : la date d'activation de l'observation fait foi.
  ('pgtap-597-never', true, '2026-10-23T00:00:00Z', '2026-10-22T11:00:00Z', null),
  -- Source désactivée, publication très ancienne : aucune alerte.
  ('pgtap-597-off', false, '2026-10-23T00:00:00Z', '2026-10-22T11:00:00Z', '2026-10-20T00:00:00Z');

select public.observe_autonomous_pipeline((select p_now from pgtap_597_context));

select ok(
  (
    select status = 'open' and severity = 'critical'
      and (details->>'maximum_publication_age_hours')::integer = 36
    from public.operational_alerts
    where alert_key = 'pipeline.source.pgtap-597-frozen.publication_stale'
  ),
  'une publication complète de 37 h ouvre publication_stale (critique)'
);

select is(
  (
    select count(*)
    from public.operational_alerts
    where alert_key = 'pipeline.source.pgtap-597-recent.publication_stale'
  ),
  0::bigint,
  'une publication complète de 35 h n''ouvre rien'
);

select is(
  (
    select count(*)
    from public.operational_alerts
    where alert_key = 'pipeline.source.pgtap-597-never.publication_stale'
      and status = 'open'
  ),
  1::bigint,
  'une source activée qui n''a jamais publié complètement ouvre publication_stale'
);

select is(
  (
    select count(*)
    from public.operational_alerts
    where alert_key = 'pipeline.source.pgtap-597-off.publication_stale'
  ),
  0::bigint,
  'une source désactivée n''ouvre pas publication_stale'
);

select is(
  (
    select count(*)
    from public.operational_alerts
    where alert_key like 'pipeline.source.pgtap-597-%.missed'
      and status = 'open'
  ),
  0::bigint,
  'les inventaires récents n''ouvrent pas .missed : publication_stale est le seul signal'
);

-- La source publie à nouveau : l'alerte se calme puis se ferme.
update public.auction_source_state
set last_publication_complete_at = '2026-10-22T12:30:00Z',
    last_inventory_complete_at = '2026-10-22T12:30:00Z'
where source_name = 'pgtap-597-frozen';
update pgtap_597_context set p_now = '2026-10-22T13:00:00Z';
select public.observe_autonomous_pipeline((select p_now from pgtap_597_context));

select ok(
  (
    select inactive_since is not null
    from public.operational_alerts
    where alert_key = 'pipeline.source.pgtap-597-frozen.publication_stale'
  ),
  'une publication complète récente rend l''alerte inactive'
);

update pgtap_597_context set p_now = '2026-10-22T15:10:00Z';
select public.observe_autonomous_pipeline((select p_now from pgtap_597_context));

select is(
  (
    select status
    from public.operational_alerts
    where alert_key = 'pipeline.source.pgtap-597-frozen.publication_stale'
  ),
  'resolved',
  'publication_stale se referme d''elle-même'
);

-- ---------------------------------------------------------------------------------------------
-- 3. stale_listings
-- ---------------------------------------------------------------------------------------------
delete from public.operational_alerts;
delete from public.auction_pipeline_observations;
delete from public.auction_source_state where source_name like 'pgtap-597-%';
update pgtap_597_context set p_now = '2026-10-23T09:00:00Z';

insert into public.auction_source_state (
  source_name, enabled, next_inventory_at, last_inventory_complete_at, last_publication_complete_at
) values
  ('pgtap-597-low', true, '2026-10-24T00:00:00Z', '2026-10-23T08:00:00Z', '2026-10-23T08:00:00Z'),
  ('pgtap-597-small', true, '2026-10-24T00:00:00Z', '2026-10-23T08:00:00Z', '2026-10-23T08:00:00Z'),
  ('pgtap-597-blip', true, '2026-10-24T00:00:00Z', '2026-10-23T08:00:00Z', '2026-10-23T08:00:00Z'),
  ('pgtap-597-off', false, '2026-10-24T00:00:00Z', '2026-10-23T08:00:00Z', '2026-10-23T08:00:00Z'),
  ('pgtap-597-ok', true, '2026-10-24T00:00:00Z', '2026-10-23T08:00:00Z', '2026-10-23T08:00:00Z');

insert into public.pgtap_597_freshness (source_name, active_listings, fresh_listings) values
  ('pgtap-597-low', 20, 10),
  ('pgtap-597-small', 5, 0),
  ('pgtap-597-blip', 20, 18),
  ('pgtap-597-off', 20, 0),
  ('pgtap-597-ok', 20, 17);

select public.observe_autonomous_pipeline((select p_now from pgtap_597_context));

select is(
  (select count(*) from public.operational_alerts where alert_key like '%.stale_listings'),
  0::bigint,
  'une première observation basse n''ouvre rien : il en faut deux consécutives'
);

-- Deuxième observation : « low » reste à 50 %, « blip » tombe à 50 % pour la première fois.
update public.pgtap_597_freshness set fresh_listings = 10 where source_name = 'pgtap-597-blip';
update pgtap_597_context set p_now = '2026-10-23T09:15:00Z';
select public.observe_autonomous_pipeline((select p_now from pgtap_597_context));

select ok(
  (
    select status = 'open' and severity = 'warning'
      and (details->>'freshness_ratio')::numeric = 0.5
      and (details->>'previous_freshness_ratio')::numeric = 0.5
      and (details->>'freshness_ratio_threshold')::numeric = 0.8
      and (details->>'minimum_active_listings')::integer = 10
    from public.operational_alerts
    where alert_key = 'pipeline.source.pgtap-597-low.stale_listings'
  ),
  'moins de 80 % d''annonces revues sur deux observations consécutives : stale_listings (avertissement)'
);

select is(
  (
    select count(*)
    from public.operational_alerts
    where alert_key = 'pipeline.source.pgtap-597-blip.stale_listings'
  ),
  0::bigint,
  'une observation basse après une observation saine n''ouvre rien'
);

select is(
  (
    select count(*)
    from public.operational_alerts
    where alert_key = 'pipeline.source.pgtap-597-small.stale_listings'
  ),
  0::bigint,
  'une source de moins de 10 ventes actives n''ouvre rien'
);

select is(
  (
    select count(*)
    from public.operational_alerts
    where alert_key = 'pipeline.source.pgtap-597-off.stale_listings'
  ),
  0::bigint,
  'une source désactivée n''ouvre rien'
);

select is(
  (
    select count(*)
    from public.operational_alerts
    where alert_key = 'pipeline.source.pgtap-597-ok.stale_listings'
  ),
  0::bigint,
  'une source à 85 % d''annonces revues n''ouvre rien'
);

-- Troisième observation : « blip » reste bas, deuxième observation consécutive.
update pgtap_597_context set p_now = '2026-10-23T09:30:00Z';
select public.observe_autonomous_pipeline((select p_now from pgtap_597_context));

select is(
  (
    select count(*)
    from public.operational_alerts
    where alert_key = 'pipeline.source.pgtap-597-blip.stale_listings'
      and status = 'open'
  ),
  1::bigint,
  'une seconde observation basse de suite ouvre stale_listings'
);

-- 80 % exactement n'est pas « inférieur à 80 % ».
update public.pgtap_597_freshness set fresh_listings = 16 where source_name = 'pgtap-597-low';
update pgtap_597_context set p_now = '2026-10-23T09:45:00Z';
select public.observe_autonomous_pipeline((select p_now from pgtap_597_context));

select ok(
  (
    select inactive_since is not null
    from public.operational_alerts
    where alert_key = 'pipeline.source.pgtap-597-low.stale_listings'
  ),
  'à 80 % exactement (seuil strict), l''alerte devient inactive'
);

update pgtap_597_context set p_now = '2026-10-23T12:00:00Z';
select public.observe_autonomous_pipeline((select p_now from pgtap_597_context));

select is(
  (
    select status
    from public.operational_alerts
    where alert_key = 'pipeline.source.pgtap-597-low.stale_listings'
  ),
  'resolved',
  'stale_listings se referme d''elle-même'
);

-- ---------------------------------------------------------------------------------------------
-- 4. pipeline.enrichment.stalled et le budget IA du jour
-- ---------------------------------------------------------------------------------------------
delete from public.operational_alerts;
delete from public.auction_pipeline_observations;
delete from public.auction_source_state where source_name like 'pgtap-597-%';
delete from public.pgtap_597_freshness;
update pgtap_597_context set p_now = statement_timestamp() + interval '1 hour';

insert into public.auction_source_state (source_name, enabled, next_inventory_at)
values ('pgtap-597-origin', true, statement_timestamp() + interval '1 day');
update public.auction_source_state
set last_inventory_complete_at = statement_timestamp(),
    last_publication_complete_at = statement_timestamp()
where source_name = 'pgtap-597-origin';

insert into public.auction_sales (source_name, source_url, status, sale_date, raw_payload)
select
  'pgtap-597-origin',
  'https://example.test/pgtap/597/' || sale_number,
  'upcoming',
  statement_timestamp() + interval '7 days',
  '{}'::jsonb
from generate_series(1, 4) as sale_number;

-- Les déclencheurs des ventes peuvent créer des révisions ordinaires : on les retire.
delete from public.auction_enrichment_jobs;

-- Deux tâches de lecture de documents en file depuis trois jours.
insert into public.auction_enrichment_jobs (
  source_url, job_type, status, priority, input_hash, attempt_count, max_attempts,
  next_attempt_at, created_at, updated_at
)
select
  'https://example.test/pgtap/597/' || job_number,
  'pdf',
  'queued',
  10,
  'pgtap-597-pdf-' || job_number,
  0,
  4,
  statement_timestamp() - interval '1 hour',
  statement_timestamp() - interval '3 days',
  statement_timestamp() - interval '3 days'
from generate_series(1, 2) as job_number;

select public.observe_autonomous_pipeline((select p_now from pgtap_597_context));

select ok(
  (
    select status = 'open'
      and (details->>'older_than_24h')::integer = 2
      and (details->>'budget_limited')::boolean = false
      and (details->>'budget_deferred_24h')::integer = 0
    from public.operational_alerts
    where alert_key = 'pipeline.enrichment.stalled'
  ),
  'sans report par le budget, deux tâches de plus de 24 h ouvrent pipeline.enrichment.stalled'
);

-- Le budget du jour est atteint : le travailleur remet les tâches en file avec l'erreur du budget, sans
-- consommer de tentative, pour minuit UTC (defer_budget_jobs).
update public.auction_enrichment_jobs
set last_error = 'Daily LLM budget exhausted: 5.0000 EUR spent of 5 EUR, request needs up to 0.0100 EUR',
    next_attempt_at = statement_timestamp() + interval '12 hours',
    updated_at = statement_timestamp()
where job_type = 'pdf';
update pgtap_597_context set p_now = statement_timestamp() + interval '1 hour 15 minutes';

select is(
  public.observe_autonomous_pipeline((select p_now from pgtap_597_context))->'queue'->>'budget_limited',
  'true',
  'des tâches reportées par le budget du jour : l''évidence le dit (budget_limited)'
);

select ok(
  (
    select inactive_since is not null
    from public.operational_alerts
    where alert_key = 'pipeline.enrichment.stalled'
  ),
  'un report voulu par le budget n''est plus un blocage : l''alerte devient inactive'
);

select ok(
  (
    select (observation.metrics->>'budget_deferred_24h')::integer = 2
      and (observation.metrics->>'older_than_24h')::integer = 2
      and (observation.metrics->>'backlog')::integer = 2
    from public.auction_pipeline_observations observation
    where observation.source_name = 'enrichment-queue'
    order by observation.observed_at desc
    limit 1
  ),
  'la mesure reste visible dans l''observation : deux tâches reportées, deux de plus de 24 h'
);

-- Une tâche de collecte de fiche (aucune IA) en file depuis trois jours reste un blocage.
insert into public.auction_enrichment_jobs (
  source_url, job_type, status, priority, input_hash, attempt_count, max_attempts,
  next_attempt_at, created_at, updated_at, detail_source_name, detail_source_url
) values (
  'https://example.test/pgtap/597/3',
  'source_detail',
  'queued',
  10,
  'pgtap-597-detail-1',
  0,
  4,
  statement_timestamp() - interval '1 hour',
  statement_timestamp() - interval '3 days',
  statement_timestamp() - interval '3 days',
  'pgtap-597-origin',
  'https://example.test/pgtap/597/3/detail'
);
update pgtap_597_context set p_now = statement_timestamp() + interval '1 hour 30 minutes';
select public.observe_autonomous_pipeline((select p_now from pgtap_597_context));

select ok(
  (
    select status = 'open' and inactive_since is null
    from public.operational_alerts
    where alert_key = 'pipeline.enrichment.stalled'
  ),
  'même sous budget atteint, une tâche source_detail trop ancienne rouvre l''alerte'
);

-- Les tâches épuisées ne viennent pas du budget (le report ne consomme pas de tentative) : l'alerte
-- pipeline.enrichment.exhausted garde son comportement.
delete from public.operational_alerts where alert_key = 'pipeline.enrichment.exhausted';
insert into public.auction_enrichment_jobs (
  source_url, job_type, status, priority, input_hash, attempt_count, max_attempts,
  next_attempt_at, created_at, updated_at
)
select
  'https://example.test/pgtap/597/4',
  'fact_extraction',
  'failed',
  10,
  'pgtap-597-dead-' || job_number,
  4,
  4,
  statement_timestamp() - interval '1 hour',
  statement_timestamp() - interval '2 days',
  statement_timestamp() - job_number * interval '1 hour'
from generate_series(1, 3) as job_number;
update pgtap_597_context set p_now = statement_timestamp() + interval '1 hour 45 minutes';
select public.observe_autonomous_pipeline((select p_now from pgtap_597_context));

select is(
  (
    select count(*)
    from public.operational_alerts
    where alert_key = 'pipeline.enrichment.exhausted'
      and status = 'open'
      and (details->>'exhausted_24h')::integer = 3
  ),
  1::bigint,
  'trois tâches épuisées dans les 24 h ouvrent toujours pipeline.enrichment.exhausted, budget atteint ou non'
);

-- Les alertes du pilote ne se déclenchent pas quand tout va bien.
select is(
  (
    select count(*)
    from public.operational_alerts
    where alert_key in ('pipeline.scheduler.disabled', 'pipeline.inventory.stale')
      and status = 'open'
      and inactive_since is null
  ),
  0::bigint,
  'pilote actif et source récente : ni pipeline.scheduler.disabled ni pipeline.inventory.stale'
);

select ok(
  (
    select (result->>'enabled')::boolean
      and result->'queue' ? 'budget_deferred_24h'
      and result->'queue' ? 'exhausted'
      and result->'queue' ? 'claimable_due'
    from (
      select public.observe_autonomous_pipeline((select p_now from pgtap_597_context)) as result
    ) observation
  ),
  'le résultat garde {enabled, queue} et ses mesures, avec la mesure du budget en plus'
);

select * from finish();

rollback;
