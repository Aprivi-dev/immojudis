begin;

select plan(14);

-- Voie d'enrichissement séparée des collectes (migration 20261203100000) : une exécution active au plus par voie,
-- un bail d'exécution propre à la file écrit dans son résumé, et une nouvelle tentative de lancement par voie.

select ok(
  not has_function_privilege('anon', 'public.claim_autonomous_pipeline_run()', 'execute')
  and not has_function_privilege('authenticated', 'public.claim_autonomous_pipeline_run()', 'execute')
  and has_function_privilege('service_role', 'public.claim_autonomous_pipeline_run()', 'execute'),
  'only the worker role can claim scheduled pipeline work'
);

set local role service_role;

delete from public.auction_enrichment_jobs;
delete from public.auction_runs where status in ('queued', 'running');
update public.auction_source_state
   set enabled = false,
       next_inventory_at = statement_timestamp() + interval '1 day';
update public.auction_pipeline_control
   set enabled = true,
       source_details_enabled = false,
       enrichment_drain_until = null,
       source_dispatch_streak = 0,
       next_enrichment_at = statement_timestamp() - interval '5 minutes'
 where id;

insert into public.auction_source_state (source_name, enabled, next_inventory_at)
values
  ('pgtap-lane-a', true, statement_timestamp() - interval '10 minutes'),
  ('pgtap-lane-b', true, statement_timestamp() - interval '5 minutes');

insert into public.auction_sales (source_name, source_url, status, sale_date, raw_payload)
values (
  'pgtap-lane-queue',
  'https://example.test/pgtap/lane/queue',
  'upcoming',
  statement_timestamp() + interval '7 days',
  '{}'::jsonb
);

insert into public.auction_enrichment_jobs (source_url, job_type, status, priority, input_hash, next_attempt_at)
values (
  'https://example.test/pgtap/lane/queue',
  'display_description',
  'queued',
  100,
  'pgtap-lane-queue-v1',
  statement_timestamp() - interval '1 minute'
);

create temporary table pgtap_lane_claims (
  ordinal integer primary key,
  payload jsonb
) on commit drop;

-- One tick, one claim per lane: a collection, then the queue, then nothing.
insert into pgtap_lane_claims values (1, public.claim_autonomous_pipeline_run());
insert into pgtap_lane_claims values (2, public.claim_autonomous_pipeline_run());
insert into pgtap_lane_claims values (3, public.claim_autonomous_pipeline_run());

select is(
  (select payload->>'source' from pgtap_lane_claims where ordinal = 1),
  'pgtap-lane-a',
  'the first claim of a tick collects the most overdue source'
);

select is(
  (select payload->>'mode' from pgtap_lane_claims where ordinal = 2),
  'enrichment',
  'the second claim gives the due queue its own lane beside the collection'
);

select is(
  (select payload from pgtap_lane_claims where ordinal = 3),
  null::jsonb,
  'with both lanes busy a third claim dispatches nothing (pgtap-lane-b waits for the collection lane)'
);

select is(
  (
    select summary->>'running_lease_seconds'
      from public.auction_runs
     where id = (select (payload->>'id')::uuid from pgtap_lane_claims where ordinal = 2)
  ),
  '7200',
  'the queue run carries its own two-hour execution lease'
);

select is(
  (
    select summary ? 'running_lease_seconds'
      from public.auction_runs
     where id = (select (payload->>'id')::uuid from pgtap_lane_claims where ordinal = 1)
  ),
  false,
  'a collection run keeps the default one-hour execution lease'
);

-- Both runs start.  After 90 minutes the collection lease (60 min) has expired, the queue lease (120 min) has not.
update public.auction_runs
   set status = 'running',
       started_at = statement_timestamp() - interval '90 minutes'
 where id in (select (payload->>'id')::uuid from pgtap_lane_claims where ordinal in (1, 2));

insert into pgtap_lane_claims values (4, public.claim_autonomous_pipeline_run());

select is(
  (
    select summary->>'completion_status'
      from public.auction_runs
     where id = (select (payload->>'id')::uuid from pgtap_lane_claims where ordinal = 1)
  ),
  'lease_expired',
  'a collection running for 90 minutes has lost its one-hour lease'
);

select is(
  (
    select status
      from public.auction_runs
     where id = (select (payload->>'id')::uuid from pgtap_lane_claims where ordinal = 2)
  ),
  'running',
  'a queue unit running for 90 minutes keeps its two-hour lease'
);

select is(
  (select payload->>'source' from pgtap_lane_claims where ordinal = 4),
  'pgtap-lane-b',
  'a running queue unit does not hold back the next due collection'
);

-- Past its two-hour lease, the queue unit is expired like any automatic run.
update public.auction_runs
   set started_at = statement_timestamp() - interval '121 minutes'
 where id = (select (payload->>'id')::uuid from pgtap_lane_claims where ordinal = 2);
update public.auction_pipeline_control
   set next_enrichment_at = statement_timestamp() - interval '5 minutes'
 where id;

insert into pgtap_lane_claims values (5, public.claim_autonomous_pipeline_run());

select is(
  (
    select status
      from public.auction_runs
     where id = (select (payload->>'id')::uuid from pgtap_lane_claims where ordinal = 2)
  ),
  'failed',
  'a queue unit past its two-hour lease is expired'
);

select is(
  (select payload->>'mode' from pgtap_lane_claims where ordinal = 5),
  'enrichment',
  'the queue lane is free again once its unit has expired'
);

-- A due retry of the queue lane is returned while a collection is still active.
update public.auction_runs
   set summary = jsonb_set(
         jsonb_set(summary, '{github_dispatch,state}', '"retry_wait"'),
         '{github_dispatch,next_attempt_at}',
         to_jsonb((statement_timestamp() - interval '1 minute')::text)
       )
 where id = (select (payload->>'id')::uuid from pgtap_lane_claims where ordinal = 5);

insert into pgtap_lane_claims values (6, public.claim_autonomous_pipeline_run());

select is(
  (select payload->>'id' from pgtap_lane_claims where ordinal = 6),
  (select payload->>'id' from pgtap_lane_claims where ordinal = 5),
  'a due retry of the queue lane is dispatched beside an active collection'
);

select is(
  (select payload->>'attempt' from pgtap_lane_claims where ordinal = 6),
  '2',
  'the queue retry increments its own dispatch attempt'
);

-- A manual run still blocks the whole scheduler.
delete from public.auction_runs where status in ('queued', 'running');
insert into public.auction_runs (status, source, scheduler_owned, started_at, summary, errors)
values ('running', 'all', false, statement_timestamp(), '{}'::jsonb, '{}'::jsonb);
update public.auction_source_state
   set next_inventory_at = statement_timestamp() - interval '1 minute'
 where source_name in ('pgtap-lane-a', 'pgtap-lane-b');

select is(
  public.claim_autonomous_pipeline_run(),
  null::jsonb,
  'a manual run keeps both lanes blocked'
);

select * from finish();

rollback;
