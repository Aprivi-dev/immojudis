-- 20261201100000 (16/11/2026) : recalibrage des alertes d'exploitation du pipeline.
--   * politique de relecture : app_private.listing_review_policy() (72 h, 24 h pour Licitor, 6 h pour une audience
--     dans les 7 jours), jumelle de services/data-pipeline/src/freshness.py ; la santé (auction_all_source_freshness)
--     applique la politique et, pour une audience proche, une tolérance de 24 h nommée à part ;
--   * stale_listings ne s'ouvre pas pour une source dont .missed est vraie ou ouverte (une cause = une alerte) ;
--   * .missed relaie la cause d'arrêt écrite par la collecte (stop_reason, stop_cause, robots_policy, erreurs,
--     échecs), jamais robots_policy_copies ;
--   * pipeline.enrichment.stalled : tâches prenables non servies depuis 72 h dont le nombre n'a pas baissé en 24 h ;
--   * pipeline.enrichment.exhausted : hausse à partir de greatest(10, 2 % de la file vivante).
-- Les seuils de pipeline.import.unhealthy (5 400 s) et le lot Licitor sur deux évaluations sont dans les tests 599 et
-- 872 ; le bail expiré depuis 24 h dans 459 et 897.
begin;

select plan(16);

-- 1. La politique de relecture -------------------------------------------------------------------------------------

select is(
  app_private.listing_review_policy(),
  '{"reread_hours": 72, "source_reread_hours": {"licitor": 24}, "near_sale_reread_hours": 6, "near_sale_days": 7,
    "source_detail_lead_hours": 1, "near_sale_health_window_hours": 24}'::jsonb,
  'the reread policy (72 h, Licitor 24 h, 6 h within 7 days), the source-detail lead and the near-sale health tolerance'
);

select ok(
  has_function_privilege('service_role', 'app_private.listing_review_policy()', 'execute')
  and not has_function_privilege('anon', 'app_private.listing_review_policy()', 'execute')
  and not has_function_privilege('authenticated', 'app_private.listing_review_policy()', 'execute'),
  'the review policy is closed to the browser'
);

select ok(
  (
    select bool_and(
      procedure_row.prosecdef
      and procedure_row.proconfig @> array['search_path=""']::text[]
      and has_function_privilege('service_role', procedure_row.oid, 'execute')
      and not has_function_privilege('anon', procedure_row.oid, 'execute')
      and not has_function_privilege('authenticated', procedure_row.oid, 'execute')
    )
    from pg_proc procedure_row
    where procedure_row.oid in (
      'public.observe_autonomous_pipeline(timestamptz)'::regprocedure,
      'public.auction_all_source_freshness(timestamptz)'::regprocedure,
      'app_private.evaluate_catalogue_quality_health(timestamptz)'::regprocedure,
      'app_private.evaluate_operational_health(timestamptz)'::regprocedure
    )
  ),
  'the redefined functions stay SECURITY DEFINER with an empty search_path, for the service role only'
);

-- 2. La fraîcheur suit la politique --------------------------------------------------------------------------------

insert into public.auction_sales (source_name, source_url, status, sale_date, raw_payload)
values
  ('pgtap-903-far', 'https://example.test/pgtap/903/far-48h', 'upcoming', '2026-10-30T12:00:00Z',
   '{"source_checks": {"https://example.test/pgtap/903/far-48h":
     {"source_name": "pgtap-903-far", "checked_at": "2026-09-26T12:00:00Z"}}}'::jsonb),
  ('pgtap-903-far', 'https://example.test/pgtap/903/far-74h', 'upcoming', '2026-10-30T12:00:00Z',
   '{"source_checks": {"https://example.test/pgtap/903/far-74h":
     {"source_name": "pgtap-903-far", "checked_at": "2026-09-25T10:00:00Z"}}}'::jsonb),
  ('pgtap-903-near', 'https://example.test/pgtap/903/near-22h', 'upcoming', '2026-09-30T12:00:00Z',
   '{"source_checks": {"https://example.test/pgtap/903/near-22h":
     {"source_name": "pgtap-903-near", "checked_at": "2026-09-27T14:00:00Z"}}}'::jsonb),
  ('pgtap-903-near', 'https://example.test/pgtap/903/near-26h', 'upcoming', '2026-09-30T12:00:00Z',
   '{"source_checks": {"https://example.test/pgtap/903/near-26h":
     {"source_name": "pgtap-903-near", "checked_at": "2026-09-27T10:00:00Z"}}}'::jsonb);

select is(
  (
    select fresh_listings || '/' || active_listings
    from public.auction_all_source_freshness('2026-09-28T12:00:00Z')
    where source_name = 'pgtap-903-far'
  ),
  '1/2',
  'a sale beyond 7 days is fresh when reviewed 48 hours ago, stale at 74 hours'
);

select is(
  (
    select fresh_listings || '/' || active_listings
    from public.auction_all_source_freshness('2026-09-28T12:00:00Z')
    where source_name = 'pgtap-903-near'
  ),
  '1/2',
  'a sale within 7 days is fresh when reviewed 22 hours ago, stale at 26 hours'
);

-- 3. Une cause, une alerte ; la cause d'arrêt dans .missed ---------------------------------------------------------
-- La fraîcheur est remplacée par une table de fixtures (annulée par le rollback), comme dans le test 597.

delete from public.operational_alerts;
delete from public.auction_pipeline_observations;
delete from public.auction_enrichment_jobs;
delete from public.auction_runs where status in ('queued', 'running');
update public.auction_source_state set enabled = false;
update public.auction_pipeline_control
set enabled = true, source_details_enabled = true, observation_started_at = '2026-10-16T00:00:00Z'
where id;

create table public.pgtap_903_freshness (
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
  from public.pgtap_903_freshness fixture;
$$;

insert into public.auction_source_state (
  source_name, enabled, next_inventory_at, last_inventory_complete_at, last_publication_complete_at,
  coverage, consecutive_failures, last_error
) values
  -- Inventaire complet il y a 19 h : .missed. Ses annonces ne sont plus revues, par la même cause.
  ('pgtap-903-missed', true, '2026-10-24T00:00:00Z', '2026-10-22T14:00:00Z', '2026-10-23T08:00:00Z',
   '{"stop_reason": "page_limit_or_count_mismatch", "errors": 2, "http_attempts_including_retries": 41,
     "publication_blocker_details": {"inventory_incomplete": {"stop_cause": "robots_unavailable"}},
     "robots_policy": {"state": "unavailable", "transient": true, "error_type": "timeout"},
     "robots_policy_copies": {"https://example.test": {"verified_at": "2026-10-22T00:00:00Z"}}}'::jsonb,
   3, repeat('x', 500)),
  -- Inventaire récent, annonces non revues : stale_listings seule.
  ('pgtap-903-stale', true, '2026-10-24T00:00:00Z', '2026-10-23T08:00:00Z', '2026-10-23T08:00:00Z',
   '{}'::jsonb, 0, null);

insert into public.pgtap_903_freshness (source_name, active_listings, fresh_listings) values
  ('pgtap-903-missed', 20, 5),
  ('pgtap-903-stale', 20, 5);

select public.observe_autonomous_pipeline('2026-10-23T09:00:00Z');
select public.observe_autonomous_pipeline('2026-10-23T09:30:00Z');

select ok(
  (
    select status = 'open'
      and details->>'stop_reason' = 'page_limit_or_count_mismatch'
      and details->>'stop_cause' = 'robots_unavailable'
      and details->'robots_policy' = '{"state": "unavailable", "transient": true, "error_type": "timeout"}'::jsonb
      and not details ? 'robots_policy_copies'
      and (details->>'coverage_errors')::integer = 2
      and (details->>'consecutive_failures')::integer = 3
      and (details->>'http_attempts')::integer = 41
      and length(details->>'last_error') = 300
    from public.operational_alerts
    where alert_key = 'pipeline.source.pgtap-903-missed.missed'
  ),
  '.missed carries the stop reason and cause, the robots policy (not its copies), the errors and the failures'
);

select is(
  (
    select count(*)
    from public.operational_alerts
    where alert_key = 'pipeline.source.pgtap-903-missed.stale_listings'
  ),
  0::bigint,
  'a source whose .missed is true does not also open stale_listings'
);

select ok(
  (
    select status = 'open'
      and not (details->>'suppressed_by_missed')::boolean
      and (details->>'reread_hours')::integer = 72
      and (details->>'near_sale_health_window_hours')::integer = 24
    from public.operational_alerts
    where alert_key = 'pipeline.source.pgtap-903-stale.stale_listings'
  ),
  'a source with a recent inventory opens stale_listings, with its reread window and near-sale tolerance'
);

-- L'inventaire revient : .missed devient inactive mais reste ouverte deux heures ; stale_listings attend.
update public.auction_source_state
set last_inventory_complete_at = '2026-10-23T09:50:00Z'
where source_name = 'pgtap-903-missed';
select public.observe_autonomous_pipeline('2026-10-23T10:00:00Z');

select is(
  (
    select count(*)
    from public.operational_alerts
    where alert_key = 'pipeline.source.pgtap-903-missed.stale_listings'
  ),
  0::bigint,
  'while .missed is still open (two-hour hysteresis), stale_listings stays closed'
);

-- 4. pipeline.enrichment.stalled : non servies depuis 72 h ET pas de baisse en 24 h --------------------------------

delete from public.operational_alerts;
delete from public.auction_pipeline_observations;
delete from public.pgtap_903_freshness;
update public.auction_source_state set enabled = false where source_name like 'pgtap-903-%';

create temporary table pgtap_903_context (p_now timestamptz not null) on commit drop;
insert into pgtap_903_context values (statement_timestamp() + interval '1 hour');

insert into public.auction_sales (source_name, source_url, status, sale_date, raw_payload)
select 'pgtap-903-queue', 'https://example.test/pgtap/903/queue/' || sale_number, 'upcoming',
       statement_timestamp() + interval '30 days', '{}'::jsonb
from generate_series(1, 3) as sale_number;

-- Sale triggers can create ordinary revisions; remove that side effect.
delete from public.auction_enrichment_jobs;

-- Deux lectures de pièces prenables, jamais servies depuis quatre jours.
insert into public.auction_enrichment_jobs (
  source_url, job_type, status, priority, input_hash, attempt_count, max_attempts,
  next_attempt_at, created_at, updated_at
)
select 'https://example.test/pgtap/903/queue/' || job_number, 'pdf', 'queued', 10, 'pgtap-903-unserved-' || job_number,
       0, 4,
       statement_timestamp() - interval '4 days',
       statement_timestamp() - interval '4 days',
       statement_timestamp() - interval '4 days'
from generate_series(1, 2) as job_number;

select public.observe_autonomous_pipeline((select p_now from pgtap_903_context));

select ok(
  (
    select (metrics->>'unserved_72h')::integer = 2
      and (metrics->>'expired_lease_24h')::integer = 0
    from public.auction_pipeline_observations
    where source_name = 'enrichment-queue'
    order by observed_at desc
    limit 1
  )
  and not exists (
    select 1 from public.operational_alerts where alert_key = 'pipeline.enrichment.stalled'
  ),
  'two jobs unserved for 72 hours, no observation 24 hours earlier: nothing to compare, no alert'
);

update pgtap_903_context set p_now = p_now + interval '24 hours';
select public.observe_autonomous_pipeline((select p_now from pgtap_903_context));

select ok(
  (
    select status = 'open'
      and inactive_since is null
      and (details->>'unserved_72h')::integer = 2
      and (details->>'unserved_72h_24h_before')::integer = 2
      and (details->>'unserved_72h_compared_at')::timestamptz
        = (select p_now - interval '24 hours' from pgtap_903_context)
      and (details->>'unserved_after_hours')::integer = 72
    from public.operational_alerts
    where alert_key = 'pipeline.enrichment.stalled'
  ),
  'the same two jobs a day later, count not lower: pipeline.enrichment.stalled opens with its comparison'
);

-- Une des deux est servie : la file avance, ce n'est plus un blocage.
update public.auction_enrichment_jobs
set status = 'completed', completed_at = statement_timestamp(), updated_at = statement_timestamp()
where input_hash = 'pgtap-903-unserved-1';
update pgtap_903_context set p_now = p_now + interval '24 hours';
select public.observe_autonomous_pipeline((select p_now from pgtap_903_context));

select ok(
  (
    select inactive_since is not null
    from public.operational_alerts
    where alert_key = 'pipeline.enrichment.stalled'
  ),
  'a count lower than 24 hours earlier turns the alert inactive'
);

-- Une description qui attend la lecture des pièces de sa vente n'est pas « non servie ».
insert into public.auction_enrichment_jobs (
  source_url, job_type, status, priority, input_hash, attempt_count, max_attempts,
  next_attempt_at, created_at, updated_at
) values (
  'https://example.test/pgtap/903/queue/2', 'fact_extraction', 'queued', 10, 'pgtap-903-waits', 0, 4,
  statement_timestamp() - interval '4 days', statement_timestamp() - interval '4 days',
  statement_timestamp() - interval '4 days'
);

select is(
  (
    select (public.observe_autonomous_pipeline(
      (select p_now + interval '1 minute' from pgtap_903_context)
    )->'queue'->>'unserved_72h')::integer
  ),
  1,
  'a fact pass waiting for the document reading of its sale is not counted as unserved'
);

-- 5. pipeline.enrichment.exhausted : greatest(10, 2 % de la file vivante) -----------------------------------------

delete from public.operational_alerts;
delete from public.auction_pipeline_observations;
delete from public.auction_enrichment_jobs;

-- 600 tâches vivantes (pas encore dues) : seuil de hausse ceil(600 x 2 %) = 12.
insert into public.auction_enrichment_jobs (
  source_url, job_type, status, priority, input_hash, attempt_count, max_attempts,
  next_attempt_at, created_at, updated_at
)
select 'https://example.test/pgtap/903/queue/3', 'pdf', 'queued', 10, 'pgtap-903-live-' || job_number, 0, 4,
       statement_timestamp() + interval '1 day', statement_timestamp(), statement_timestamp()
from generate_series(1, 600) as job_number;

insert into public.auction_enrichment_jobs (
  source_url, job_type, status, priority, input_hash, attempt_count, max_attempts,
  next_attempt_at, created_at, updated_at
)
select 'https://example.test/pgtap/903/queue/1', 'pdf', 'failed', 10, 'pgtap-903-dead-' || job_number, 4, 4,
       statement_timestamp() - interval '1 hour', statement_timestamp() - interval '2 days',
       statement_timestamp() - interval '1 hour'
from generate_series(1, 10) as job_number;

select public.observe_autonomous_pipeline(statement_timestamp() + interval '1 minute');

select is(
  (select count(*) from public.operational_alerts where alert_key = 'pipeline.enrichment.exhausted'),
  0::bigint,
  'ten dead letters in 24 hours stay under 2 % of a live queue of 600 jobs'
);

insert into public.auction_enrichment_jobs (
  source_url, job_type, status, priority, input_hash, attempt_count, max_attempts,
  next_attempt_at, created_at, updated_at
)
select 'https://example.test/pgtap/903/queue/1', 'pdf', 'failed', 10, 'pgtap-903-dead-more-' || job_number, 4, 4,
       statement_timestamp() - interval '1 hour', statement_timestamp() - interval '2 days',
       statement_timestamp() - interval '1 hour'
from generate_series(1, 2) as job_number;

select public.observe_autonomous_pipeline(statement_timestamp() + interval '2 minutes');

select ok(
  (
    select status = 'open'
      and (details->>'exhausted_24h')::integer = 12
      and (details->>'exhausted_24h_threshold')::integer = 12
      and (details->>'exhausted_24h_minimum')::integer = 10
      and (details->>'exhausted_threshold')::integer = 50
    from public.operational_alerts
    where alert_key = 'pipeline.enrichment.exhausted'
  ),
  'twelve dead letters reach 2 % of the live queue and open pipeline.enrichment.exhausted'
);

select is(
  (select count(*) from public.operational_alerts where alert_key = 'pipeline.enrichment.stalled'),
  0::bigint,
  'a long queue that is not yet due is not a blockage'
);

select * from finish();

rollback;
