-- 20261119101000 (14/11/2026, T6 et D12) : pipeline.enrichment.stalled compte à part les tâches immobiles depuis
-- 24 h (ni écrites ni attendues), budget IA atteint ou non. Avant, un report du budget dans les 24 h ne laissait
-- regarder que les tâches source_detail : une lecture de pièces restée en running, bail expiré, ne sonnait pas.
begin;

select plan(13);

select ok(
  position('immobile_24h' in pg_get_functiondef(
    'public.observe_autonomous_pipeline(timestamptz)'::regprocedure
  )) > 0
  and position('pipeline.scheduler.disabled' in pg_get_functiondef(
    'public.observe_autonomous_pipeline(timestamptz)'::regprocedure
  )) > 0
  and position('budget_deferred_24h' in pg_get_functiondef(
    'public.observe_autonomous_pipeline(timestamptz)'::regprocedure
  )) > 0
  and position('interval ''18 hours''' in lower(pg_get_functiondef(
    'public.observe_autonomous_pipeline(timestamptz)'::regprocedure
  ))) > 0,
  'the observer counts immobile jobs and keeps the earlier alerts'
);

select ok(
  (
    select procedure_row.prosecdef
      and procedure_row.proconfig @> array['search_path=""']::text[]
      and has_function_privilege('service_role', 'public.observe_autonomous_pipeline(timestamptz)', 'execute')
      and not has_function_privilege('anon', 'public.observe_autonomous_pipeline(timestamptz)', 'execute')
      and not has_function_privilege('authenticated', 'public.observe_autonomous_pipeline(timestamptz)', 'execute')
    from pg_proc procedure_row
    where procedure_row.oid = 'public.observe_autonomous_pipeline(timestamptz)'::regprocedure
  ),
  'the observer remains SECURITY DEFINER with its private service-only boundary'
);

set local role service_role;

-- Rollback-only fixture: isolate the queue and the alerts, then create only the jobs under test.
delete from public.operational_alerts;
delete from public.auction_enrichment_jobs;
delete from public.auction_runs where status in ('queued', 'running');
update public.auction_pipeline_control
   set enabled = true
 where id;

insert into public.auction_source_state (source_name, enabled, suspended_until, next_inventory_at)
values ('pgtap-897-origin', false, null, statement_timestamp() + interval '1 day');

insert into public.auction_sales (source_name, source_url, status, sale_date, raw_payload)
select 'pgtap-897-origin',
       'https://example.test/pgtap/897/' || sale_number,
       'upcoming',
       statement_timestamp() + interval '7 days',
       '{}'::jsonb
  from generate_series(1, 4) as sale_number;

-- Sale triggers can create ordinary revisions; remove that side effect.
delete from public.auction_enrichment_jobs;

insert into public.auction_enrichment_jobs (
  source_url, job_type, status, priority, input_hash, attempt_count, max_attempts,
  next_attempt_at, locked_at, last_error, created_at, updated_at
)
values
  -- Deferred today by the AI budget, until midnight UTC: the queue is budget-limited.
  ('https://example.test/pgtap/897/1', 'pdf', 'queued', 10, 'pgtap-897-budget', 0, 4,
   statement_timestamp() + interval '12 hours', null,
   'Daily LLM budget exhausted: 5.0000 EUR spent of 5 EUR, request needs up to 0.0100 EUR',
   statement_timestamp() - interval '3 days', statement_timestamp() - interval '1 hour'),
  -- A document reading stuck in running for three days: its 30-minute lease expired long ago.
  ('https://example.test/pgtap/897/2', 'pdf', 'running', 10, 'pgtap-897-stuck', 1, 4,
   statement_timestamp() - interval '3 days 1 minute', statement_timestamp() - interval '3 days', null,
   statement_timestamp() - interval '4 days', statement_timestamp() - interval '3 days'),
  -- Exhausted: reported by pipeline.enrichment.exhausted, never immobile.
  ('https://example.test/pgtap/897/3', 'fact_extraction', 'failed', 10, 'pgtap-897-exhausted', 4, 4,
   statement_timestamp() - interval '2 days', null, 'boom',
   statement_timestamp() - interval '3 days', statement_timestamp() - interval '2 days'),
  -- Untouched for three days but scheduled for tomorrow: waiting, not immobile.
  ('https://example.test/pgtap/897/4', 'pdf', 'failed', 10, 'pgtap-897-later', 1, 4,
   statement_timestamp() + interval '1 day', null, 'retry later',
   statement_timestamp() - interval '4 days', statement_timestamp() - interval '3 days'),
  -- Due and untouched for three days, but it waits for the document reading of its sale (claim guard of
  -- 20261111050000): held on purpose, not immobile.
  ('https://example.test/pgtap/897/2', 'fact_extraction', 'queued', 10, 'pgtap-897-dependent', 0, 4,
   statement_timestamp() - interval '3 days', null, null,
   statement_timestamp() - interval '3 days', statement_timestamp() - interval '3 days');

create temporary table pgtap_897_context (
  case_name text primary key,
  p_now timestamptz not null,
  payload jsonb
) on commit drop;

insert into pgtap_897_context(case_name, p_now)
values ('stuck', statement_timestamp());

select lives_ok(
  $sql$
    update pgtap_897_context
       set payload = public.observe_autonomous_pipeline(p_now)
     where case_name = 'stuck';
  $sql$,
  'the observer runs on a budget-limited queue holding a stuck document reading'
);

select ok(
  (
    select (payload->'queue'->>'budget_limited')::boolean
       and (payload->'queue'->>'immobile_24h')::integer = 1
       and (payload->'queue'->>'older_than_24h')::integer = 4
      from pgtap_897_context
     where case_name = 'stuck'
  ),
  'only the stuck running job is immobile: not the budget deferral, the exhausted job, the scheduled retry nor '
  || 'the job that waits for the document reading of its sale'
);

select ok(
  (
    select status = 'open'
       and inactive_since is null
       and (details->>'immobile_24h')::integer = 1
      from public.operational_alerts
     where alert_key = 'pipeline.enrichment.stalled'
  ),
  'an immobile job opens pipeline.enrichment.stalled even when the AI budget deferred jobs'
);

-- The stuck reading is taken again (claim) and finishes, then its fact pass: what is left is a budget deferral and a
-- scheduled retry.
update public.auction_enrichment_jobs
   set status = 'completed',
       completed_at = statement_timestamp(),
       updated_at = statement_timestamp()
 where input_hash in ('pgtap-897-stuck', 'pgtap-897-dependent');

insert into pgtap_897_context(case_name, p_now)
values ('recovered', statement_timestamp() + interval '1 minute');

select lives_ok(
  $sql$
    update pgtap_897_context
       set payload = public.observe_autonomous_pipeline(p_now)
     where case_name = 'recovered';
  $sql$,
  'the observer runs once the stuck job is done'
);

select is(
  (
    select (payload->'queue'->>'immobile_24h')::integer
      from pgtap_897_context
     where case_name = 'recovered'
  ),
  0,
  'nothing is immobile once the stuck job moved'
);

select ok(
  (
    select inactive_since is not null
      from public.operational_alerts
     where alert_key = 'pipeline.enrichment.stalled'
  ),
  'under the AI budget, old document jobs that wait for their turn no longer hold the alert'
);

select ok(
  (
    select (observation.metrics->>'immobile_24h')::integer = 0
       and (observation.metrics->>'budget_deferred_24h')::integer = 1
      from public.auction_pipeline_observations observation
     where observation.source_name = 'enrichment-queue'
     order by observation.observed_at desc
     limit 1
  ),
  'the measure is kept in the enrichment-queue observation'
);

-- Second review (14/11/2026): case (b), a claimable job left untouched for 24 h. After the first budget refusal the
-- worker only claims source_detail jobs, so under budget_limited the others wait on purpose: (b) counts source_detail
-- jobs only. A display pass of sale 3, due and untouched for two days, nothing ahead of it.
insert into public.auction_enrichment_jobs (
  source_url, job_type, status, priority, input_hash, attempt_count, max_attempts,
  next_attempt_at, locked_at, last_error, created_at, updated_at
)
values
  ('https://example.test/pgtap/897/3', 'display_description', 'queued', 10, 'pgtap-897-untouched', 0, 4,
   statement_timestamp() - interval '2 days', null, null,
   statement_timestamp() - interval '2 days', statement_timestamp() - interval '2 days');

insert into pgtap_897_context(case_name, p_now)
values ('untouched-under-budget', statement_timestamp() + interval '2 minutes');

select lives_ok(
  $sql$
    update pgtap_897_context
       set payload = public.observe_autonomous_pipeline(p_now)
     where case_name = 'untouched-under-budget';
  $sql$,
  'the observer runs on a budget-limited queue holding an untouched claimable job'
);

select ok(
  (
    select (payload->'queue'->>'budget_limited')::boolean
       and (payload->'queue'->>'claimable_due')::integer = 1
       and (payload->'queue'->>'immobile_24h')::integer = 0
      from pgtap_897_context
     where case_name = 'untouched-under-budget'
  ),
  'under the AI budget, a claimable job that waits for its turn is not immobile'
);

-- The budget deferral is now more than 24 hours old: the queue is no longer budget-limited.
update public.auction_enrichment_jobs
   set updated_at = statement_timestamp() - interval '25 hours'
 where input_hash = 'pgtap-897-budget';

insert into pgtap_897_context(case_name, p_now)
values ('untouched', statement_timestamp() + interval '3 minutes');

select lives_ok(
  $sql$
    update pgtap_897_context
       set payload = public.observe_autonomous_pipeline(p_now)
     where case_name = 'untouched';
  $sql$,
  'the observer runs once the budget deferral is over'
);

select ok(
  (
    select not (payload->'queue'->>'budget_limited')::boolean
       and (payload->'queue'->>'immobile_24h')::integer = 1
       and (
         select alert.status = 'open' and alert.inactive_since is null
           from public.operational_alerts alert
          where alert.alert_key = 'pipeline.enrichment.stalled'
       )
      from pgtap_897_context
     where case_name = 'untouched'
  ),
  'without the AI budget, a claimable job untouched for 24 hours is immobile and opens the alert'
);

select * from finish();

rollback;
