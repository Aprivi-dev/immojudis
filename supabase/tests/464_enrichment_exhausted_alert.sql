begin;

select plan(16);

select ok(
  position('pipeline.enrichment.exhausted' in lower(pg_get_functiondef(
    'public.observe_autonomous_pipeline(timestamptz)'::regprocedure
  ))) > 0
  and position('exhausted_24h' in lower(pg_get_functiondef(
    'public.observe_autonomous_pipeline(timestamptz)'::regprocedure
  ))) > 0
  and position('pipeline.enrichment.stalled' in lower(pg_get_functiondef(
    'public.observe_autonomous_pipeline(timestamptz)'::regprocedure
  ))) > 0
  and position('claimable_due' in lower(pg_get_functiondef(
    'public.observe_autonomous_pipeline(timestamptz)'::regprocedure
  ))) > 0
  and position('interval ''18 hours''' in lower(pg_get_functiondef(
    'public.observe_autonomous_pipeline(timestamptz)'::regprocedure
  ))) > 0,
  'the observer raises the exhausted alert apart and keeps the earlier patches'
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
  'pgtap-464-origin',
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
select
  'pgtap-464-origin',
  'https://example.test/pgtap/464/' || sale_number,
  'upcoming',
  statement_timestamp() + interval '7 days',
  '{}'::jsonb
from generate_series(1, 5) as sale_number;

-- Sale triggers can create ordinary revisions; remove that side effect.
delete from public.auction_enrichment_jobs;

-- Two old dead letters: exhausted for days, not a new failure.
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
select
  'https://example.test/pgtap/464/' || job_number,
  'pdf',
  'failed',
  10,
  'pgtap-464-old-' || job_number,
  4,
  4,
  statement_timestamp() - interval '5 days',
  statement_timestamp() - interval '6 days',
  statement_timestamp() - interval '5 days'
from generate_series(1, 2) as job_number;

create temporary table pgtap_464_context (
  case_name text primary key,
  p_now timestamptz not null,
  payload jsonb
) on commit drop;

insert into pgtap_464_context(case_name, p_now)
values ('old-dead-letters', statement_timestamp());

select lives_ok(
  $sql$
    update pgtap_464_context
       set payload = public.observe_autonomous_pipeline(p_now)
     where case_name = 'old-dead-letters';
  $sql$,
  'the observer runs on a queue holding only old dead letters'
);

select is(
  (
    select (payload->'queue'->>'exhausted')::integer
      from pgtap_464_context
     where case_name = 'old-dead-letters'
  ),
  2,
  'the old dead letters are counted as exhausted'
);

select is(
  (
    select (payload->'queue'->>'exhausted_24h')::integer
      from pgtap_464_context
     where case_name = 'old-dead-letters'
  ),
  0,
  'none of them became exhausted during the last 24 hours'
);

select is(
  (
    select count(*)
      from public.operational_alerts
     where alert_key = 'pipeline.enrichment.exhausted'
       and status = 'open'
  ),
  0::bigint,
  'a few old dead letters do not open pipeline.enrichment.exhausted'
);

-- A rise: three more jobs used their last attempt during the last 24 hours (the third one is
-- beyond the attempt limit).
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
  ('https://example.test/pgtap/464/3', 'pdf', 'failed', 10, 'pgtap-464-new-1', 4, 4, statement_timestamp() - interval '1 hour', statement_timestamp() - interval '2 days', statement_timestamp() - interval '1 hour'),
  ('https://example.test/pgtap/464/4', 'pdf', 'failed', 10, 'pgtap-464-new-2', 4, 4, statement_timestamp() - interval '1 hour', statement_timestamp() - interval '2 days', statement_timestamp() - interval '2 hours'),
  ('https://example.test/pgtap/464/5', 'pdf', 'failed', 10, 'pgtap-464-new-3', 5, 4, statement_timestamp() - interval '1 hour', statement_timestamp() - interval '2 days', statement_timestamp() - interval '3 hours');

insert into pgtap_464_context(case_name, p_now)
values ('rise', statement_timestamp() + interval '1 minute');

select lives_ok(
  $sql$
    update pgtap_464_context
       set payload = public.observe_autonomous_pipeline(p_now)
     where case_name = 'rise';
  $sql$,
  'the observer runs again with three fresh dead letters'
);

select is(
  (
    select (payload->'queue'->>'exhausted_24h')::integer
      from pgtap_464_context
     where case_name = 'rise'
  ),
  3,
  'three jobs became exhausted during the last 24 hours'
);

select is(
  (
    select count(*)
      from public.operational_alerts
     where alert_key = 'pipeline.enrichment.exhausted'
       and status = 'open'
       and inactive_since is null
       and (details->>'exhausted')::integer = 5
       and (details->>'exhausted_24h')::integer = 3
       and (details->>'exhausted_24h_threshold')::integer = 3
  ),
  1::bigint,
  'a rise of three dead letters opens pipeline.enrichment.exhausted with its evidence'
);

select is(
  (
    select count(*)
      from public.operational_alerts
     where alert_key = 'pipeline.enrichment.stalled'
       and status = 'open'
  ),
  0::bigint,
  'dead letters alone still do not hold pipeline.enrichment.stalled open'
);

-- Twenty-five hours later nothing new failed: the rise is over, the alert turns inactive...
insert into pgtap_464_context(case_name, p_now)
values ('rise-over', statement_timestamp() + interval '25 hours');

select lives_ok(
  $sql$
    update pgtap_464_context
       set payload = public.observe_autonomous_pipeline(p_now)
     where case_name = 'rise-over';
  $sql$,
  'the observer runs once the rise is older than 24 hours'
);

select ok(
  (
    select inactive_since is not null
      from public.operational_alerts
     where alert_key = 'pipeline.enrichment.exhausted'
       and status = 'open'
  ),
  'five old dead letters below the backlog threshold turn the alert inactive'
);

-- ... and closes after the two-hour hysteresis of app_private.sync_operational_alert.
insert into pgtap_464_context(case_name, p_now)
values ('closed', statement_timestamp() + interval '27 hours 5 minutes');

select lives_ok(
  $sql$
    update pgtap_464_context
       set payload = public.observe_autonomous_pipeline(p_now)
     where case_name = 'closed';
  $sql$,
  'the observer runs again after the hysteresis window'
);

select is(
  (
    select count(*)
      from public.operational_alerts
     where alert_key = 'pipeline.enrichment.exhausted'
       and status = 'open'
  ),
  0::bigint,
  'pipeline.enrichment.exhausted closes once the rise is over'
);

-- A backlog of dead letters nobody handled opens the alert whatever their age.
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
select
  'https://example.test/pgtap/464/1',
  'pdf',
  'failed',
  10,
  'pgtap-464-backlog-' || job_number,
  4,
  4,
  statement_timestamp() - interval '9 days',
  statement_timestamp() - interval '10 days',
  statement_timestamp() - interval '9 days'
from generate_series(1, 48) as job_number;

insert into pgtap_464_context(case_name, p_now)
values ('backlog', statement_timestamp() + interval '28 hours');

select lives_ok(
  $sql$
    update pgtap_464_context
       set payload = public.observe_autonomous_pipeline(p_now)
     where case_name = 'backlog';
  $sql$,
  'the observer runs with 53 dead letters'
);

select is(
  (
    select count(*)
      from public.operational_alerts
     where alert_key = 'pipeline.enrichment.exhausted'
       and status = 'open'
       and (details->>'exhausted')::integer = 53
       and (details->>'exhausted_24h')::integer = 0
  ),
  1::bigint,
  '50 dead letters or more open pipeline.enrichment.exhausted even without a recent rise'
);

select * from finish();

rollback;
