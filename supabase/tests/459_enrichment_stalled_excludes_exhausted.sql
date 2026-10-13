begin;

select plan(15);

select ok(
  position('exhausted' in lower(pg_get_functiondef(
    'public.observe_autonomous_pipeline(timestamptz)'::regprocedure
  ))) > 0
  and position('attempt_count >= max_attempts' in lower(pg_get_functiondef(
    'public.observe_autonomous_pipeline(timestamptz)'::regprocedure
  ))) > 0
  and position('claimable_due' in lower(pg_get_functiondef(
    'public.observe_autonomous_pipeline(timestamptz)'::regprocedure
  ))) > 0
  and position('interval ''18 hours''' in lower(pg_get_functiondef(
    'public.observe_autonomous_pipeline(timestamptz)'::regprocedure
  ))) > 0,
  'the observer counts exhausted jobs apart and keeps the earlier patches'
);

select ok(
  (
    select procedure_row.prosecdef
      and procedure_row.proconfig @> array['search_path=""']::text[]
      and has_function_privilege(
        'service_role',
        'public.observe_autonomous_pipeline(timestamptz)',
        'execute'
      )
      and not has_function_privilege(
        'anon',
        'public.observe_autonomous_pipeline(timestamptz)',
        'execute'
      )
      and not has_function_privilege(
        'authenticated',
        'public.observe_autonomous_pipeline(timestamptz)',
        'execute'
      )
    from pg_proc procedure_row
    where procedure_row.oid =
      'public.observe_autonomous_pipeline(timestamptz)'::regprocedure
  ),
  'the observer remains SECURITY DEFINER with its private service-only boundary'
);

set local role service_role;

-- Rollback-only fixture: isolate the queue, then create only the jobs under test.
delete from public.auction_enrichment_jobs;
delete from public.auction_runs where status in ('queued', 'running');
update public.auction_pipeline_control
   set enabled = true
 where id;

insert into public.auction_source_state (
  source_name,
  enabled,
  suspended_until,
  next_inventory_at
)
values (
  'pgtap-459-origin',
  false,
  null,
  statement_timestamp() + interval '1 day'
);

insert into public.auction_sales (
  source_name,
  source_url,
  status,
  sale_date,
  raw_payload
)
values
  ('pgtap-459-origin', 'https://example.test/pgtap/459/exhausted', 'upcoming', statement_timestamp() + interval '7 days', '{}'::jsonb),
  ('pgtap-459-origin', 'https://example.test/pgtap/459/over-limit', 'upcoming', statement_timestamp() + interval '7 days', '{}'::jsonb),
  ('pgtap-459-origin', 'https://example.test/pgtap/459/fresh', 'upcoming', statement_timestamp() + interval '7 days', '{}'::jsonb),
  ('pgtap-459-origin', 'https://example.test/pgtap/459/retryable', 'upcoming', statement_timestamp() + interval '7 days', '{}'::jsonb);

-- Sale triggers can create ordinary revisions; remove that side effect.
delete from public.auction_enrichment_jobs;

-- Two exhausted failed jobs (exactly at, and beyond, the attempt limit), both
-- older than 24 hours, plus one fresh queued job.
insert into public.auction_enrichment_jobs (
  source_url,
  job_type,
  status,
  priority,
  input_hash,
  attempt_count,
  max_attempts,
  next_attempt_at,
  created_at,
  updated_at
)
values
  ('https://example.test/pgtap/459/exhausted', 'pdf', 'failed', 10, 'pgtap-459-exhausted-v1', 4, 4, statement_timestamp() - interval '1 day', statement_timestamp() - interval '3 days', statement_timestamp() - interval '2 days'),
  ('https://example.test/pgtap/459/over-limit', 'pdf', 'failed', 10, 'pgtap-459-over-limit-v1', 5, 4, statement_timestamp() - interval '1 day', statement_timestamp() - interval '3 days', statement_timestamp() - interval '2 days'),
  ('https://example.test/pgtap/459/fresh', 'pdf', 'queued', 10, 'pgtap-459-fresh-v1', 0, 4, statement_timestamp(), statement_timestamp() - interval '1 hour', statement_timestamp() - interval '1 hour');

create temporary table pgtap_459_context (
  case_name text primary key,
  p_now timestamptz not null,
  payload jsonb
) on commit drop;

insert into pgtap_459_context(case_name, p_now)
values ('exhausted-only', statement_timestamp());

select lives_ok(
  $sql$
    update pgtap_459_context
       set payload = public.observe_autonomous_pipeline(p_now)
     where case_name = 'exhausted-only';
  $sql$,
  'the observer runs on a queue holding exhausted failed jobs'
);

select is(
  (
    select (payload->'queue'->>'exhausted')::integer
      from pgtap_459_context
     where case_name = 'exhausted-only'
  ),
  2,
  'exhausted failed jobs (at or beyond max_attempts) are counted apart'
);

select is(
  (
    select (payload->'queue'->>'older_than_24h')::integer
      from pgtap_459_context
     where case_name = 'exhausted-only'
  ),
  0,
  'exhausted jobs are left out of older_than_24h'
);

select is(
  (
    select (payload->'queue'->>'backlog')::integer
      from pgtap_459_context
     where case_name = 'exhausted-only'
  ),
  3,
  'the raw backlog still includes the exhausted jobs'
);

select is(
  (
    select count(*)
      from public.operational_alerts
     where alert_key = 'pipeline.enrichment.stalled'
       and status = 'open'
  ),
  0::bigint,
  'exhausted failed jobs alone no longer hold pipeline.enrichment.stalled open'
);

-- A failed job with attempts left will be retried: it still counts as delayed.
insert into public.auction_enrichment_jobs (
  source_url,
  job_type,
  status,
  priority,
  input_hash,
  attempt_count,
  max_attempts,
  next_attempt_at,
  created_at,
  updated_at
)
values (
  'https://example.test/pgtap/459/retryable',
  'pdf',
  'failed',
  10,
  'pgtap-459-retryable-v1',
  1,
  4,
  statement_timestamp() + interval '1 hour',
  statement_timestamp() - interval '3 days',
  statement_timestamp() - interval '2 days'
);

insert into pgtap_459_context(case_name, p_now)
values ('retryable', statement_timestamp() + interval '1 minute');

select lives_ok(
  $sql$
    update pgtap_459_context
       set payload = public.observe_autonomous_pipeline(p_now)
     where case_name = 'retryable';
  $sql$,
  'the observer runs again with a retryable old failed job'
);

select is(
  (
    select (payload->'queue'->>'older_than_24h')::integer
      from pgtap_459_context
     where case_name = 'retryable'
  ),
  1,
  'a failed job with attempts left is still counted as older than 24 hours'
);

select is(
  (
    select (payload->'queue'->>'exhausted')::integer
      from pgtap_459_context
     where case_name = 'retryable'
  ),
  2,
  'the exhausted count is unchanged by the retryable job'
);

select is(
  (
    select count(*)
      from public.operational_alerts
     where alert_key = 'pipeline.enrichment.stalled'
       and status = 'open'
  ),
  1::bigint,
  'a retryable old job opens pipeline.enrichment.stalled'
);

-- Once the retryable job completes, only exhausted jobs remain: the alert goes inactive, then
-- closes after the two-hour hysteresis of app_private.sync_operational_alert.
update public.auction_enrichment_jobs
   set status = 'completed',
       completed_at = statement_timestamp(),
       updated_at = statement_timestamp()
 where input_hash = 'pgtap-459-retryable-v1';

insert into pgtap_459_context(case_name, p_now)
values ('recovered', statement_timestamp() + interval '2 minutes');

select lives_ok(
  $sql$
    update pgtap_459_context
       set payload = public.observe_autonomous_pipeline(p_now)
     where case_name = 'recovered';
  $sql$,
  'the observer runs once the retryable job is completed'
);

select ok(
  (
    select inactive_since is not null
      from public.operational_alerts
     where alert_key = 'pipeline.enrichment.stalled'
       and status = 'open'
  ),
  'with only exhausted jobs left, pipeline.enrichment.stalled turns inactive'
);

insert into pgtap_459_context(case_name, p_now)
values ('closed', statement_timestamp() + interval '2 hours 5 minutes');

select lives_ok(
  $sql$
    update pgtap_459_context
       set payload = public.observe_autonomous_pipeline(p_now)
     where case_name = 'closed';
  $sql$,
  'the observer runs again after the hysteresis window'
);

select is(
  (
    select count(*)
      from public.operational_alerts
     where alert_key = 'pipeline.enrichment.stalled'
       and status = 'open'
  ),
  0::bigint,
  'pipeline.enrichment.stalled closes while exhausted jobs remain'
);

select * from finish();

rollback;
