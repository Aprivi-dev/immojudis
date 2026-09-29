begin;

select plan(22);

set local role service_role;

select ok(
  exists (
    select 1
      from information_schema.columns
     where table_schema = 'public'
       and table_name = 'auction_pipeline_control'
       and column_name = 'enrichment_drain_until'
  ),
  'the pipeline control exposes a bounded enrichment drain window'
);

select is(
  (
    select column_default::text
      from information_schema.columns
     where table_schema = 'public'
       and table_name = 'auction_pipeline_control'
       and column_name = 'enrichment_drain_until'
  ),
  null::text,
  'the drain window defaults to off'
);

select is(
  (select enrichment_drain_until from public.auction_pipeline_control where id),
  null::timestamptz,
  'the existing control row starts with no drain window'
);

select ok(
  exists (
    select 1
      from pg_trigger
     where tgrelid = 'public.auction_pipeline_control'::regclass
       and tgname = 'auction_pipeline_control_validate_enrichment_drain'
       and not tgisinternal
  ),
  'direct control writes are bounded by a drain-window trigger'
);

select ok(
  to_regprocedure('app_private.set_enrichment_drain_until(timestamptz)') is not null,
  'operators have a dedicated drain-window setter'
);

select ok(
  position(
    'six hours' in pg_get_functiondef(
      'app_private.validate_enrichment_drain_window()'::regprocedure
    )
  ) > 0
  and position(
    'six hours' in pg_get_functiondef(
      'app_private.set_enrichment_drain_until(timestamptz)'::regprocedure
    )
  ) > 0,
  'both direct writes and the operator setter enforce the six-hour bound'
);

select ok(
  has_function_privilege(
    'service_role',
    'app_private.set_enrichment_drain_until(timestamptz)',
    'execute'
  )
  and not has_function_privilege(
    'anon',
    'app_private.set_enrichment_drain_until(timestamptz)',
    'execute'
  )
  and not has_function_privilege(
    'authenticated',
    'app_private.set_enrichment_drain_until(timestamptz)',
    'execute'
  ),
  'drain-window control is restricted to the worker role'
);

select throws_ok(
  $$select app_private.set_enrichment_drain_until(
      statement_timestamp() + interval '7 hours'
    )$$,
  '22023',
  'Enrichment drain window cannot exceed six hours.',
  'the setter rejects a window longer than six hours'
);

select lives_ok(
  $$select app_private.set_enrichment_drain_until(
      statement_timestamp() + interval '2 hours'
    )$$,
  'the setter accepts a bounded maintenance window'
);

select ok(
  (
    select enrichment_drain_until > statement_timestamp()
      and enrichment_drain_until <= statement_timestamp() + interval '2 hours'
      and enrichment_drain_until > statement_timestamp() + interval '1 hour'
    from public.auction_pipeline_control
    where id
  ),
  'the bounded maintenance window is persisted'
);

select is(
  app_private.set_enrichment_drain_until(null),
  null::timestamptz,
  'the same setter can turn drain mode off'
);

select is(
  (select enrichment_drain_until from public.auction_pipeline_control where id),
  null::timestamptz,
  'deactivation clears the control value'
);

select ok(
  position(
    'pg_try_advisory_xact_lock' in pg_get_functiondef(
      'public.claim_autonomous_pipeline_run()'::regprocedure
    )
  ) > 0,
  'drain mode keeps the single pipeline advisory lock'
);

select ok(
  position(
    'enrichment_drain_until' in pg_get_functiondef(
      'public.claim_autonomous_pipeline_run()'::regprocedure
    )
  ) > 0
  and position(
    'active_id' in pg_get_functiondef(
      'public.claim_autonomous_pipeline_run()'::regprocedure
    )
  ) > 0,
  'drain mode keeps the active-run single-writer guard'
);

-- A queue claim is allowed even when the ordinary 30-minute cadence is still
-- in the future. The source is recent enough to be fairly preempted.
update public.auction_pipeline_control
   set enabled = true,
       source_details_enabled = false,
       source_dispatch_streak = 0,
       next_enrichment_at = statement_timestamp() + interval '1 hour'
 where id;
select app_private.set_enrichment_drain_until(
  statement_timestamp() + interval '2 hours'
);

insert into public.auction_source_state (
  source_name,
  enabled,
  next_inventory_at
)
values (
  'pgtap-drain-recent',
  true,
  statement_timestamp() - interval '30 minutes'
);

insert into public.auction_sales (
  id,
  source_name,
  source_url,
  status,
  sale_date,
  raw_payload
)
values (
  'f3880000-0000-4000-8000-000000000001',
  'pgtap-drain-queue',
  'https://example.test/pgtap/drain/queue',
  'upcoming',
  statement_timestamp() + interval '7 days',
  '{}'::jsonb
);

insert into public.auction_enrichment_jobs (
  source_url,
  job_type,
  status,
  priority,
  input_hash,
  next_attempt_at
)
values (
  'https://example.test/pgtap/drain/queue',
  'display_description',
  'queued',
  100,
  'pgtap-drain-queue-v1',
  statement_timestamp()
);

create temporary table pgtap_drain_claims (
  case_name text primary key,
  payload jsonb
) on commit drop;

insert into pgtap_drain_claims (case_name, payload)
values ('recent-source', public.claim_autonomous_pipeline_run());

select is(
  (select payload->>'mode' from pgtap_drain_claims where case_name = 'recent-source'),
  'enrichment',
  'an active drain uses a queue tick before next_enrichment_at'
);

select ok(
  (
    select next_enrichment_at > statement_timestamp() + interval '29 minutes'
      and next_enrichment_at < statement_timestamp() + interval '31 minutes'
    from public.auction_pipeline_control
    where id
  ),
  'a queue claim still advances the normal next-enrichment cadence'
);

delete from public.auction_runs
 where id = (
   select (payload->>'id')::uuid
     from pgtap_drain_claims
    where case_name = 'recent-source'
 );

-- An overdue source gets its collection turn while the streak is below the
-- fair threshold, even though drain mode is active and the queue is due.
update public.auction_pipeline_control
   set source_dispatch_streak = 0,
       next_enrichment_at = statement_timestamp() + interval '1 hour'
 where id;
update public.auction_source_state
   set next_inventory_at = statement_timestamp() - interval '2 hours'
 where source_name = 'pgtap-drain-recent';

insert into pgtap_drain_claims (case_name, payload)
values ('overdue-source', public.claim_autonomous_pipeline_run());

select is(
  (select payload->>'mode' from pgtap_drain_claims where case_name = 'overdue-source'),
  'collect',
  'drain mode preserves a fair collection turn for a source overdue by more than one hour'
);

select is(
  (select source_dispatch_streak from public.auction_pipeline_control where id),
  1,
  'the fair source turn advances the persisted collection streak'
);

delete from public.auction_runs
 where id = (
   select (payload->>'id')::uuid
     from pgtap_drain_claims
    where case_name = 'overdue-source'
 );

-- Once the bounded source fairness threshold is met, the queue receives a
-- turn and the trigger resets the streak. The queue remains available after
-- a collection claim.
update public.auction_pipeline_control
   set source_dispatch_streak = 3,
       next_enrichment_at = statement_timestamp() + interval '1 hour'
 where id;
update public.auction_source_state
   set next_inventory_at = statement_timestamp() - interval '2 hours'
 where source_name = 'pgtap-drain-recent';

insert into pgtap_drain_claims (case_name, payload)
values ('fair-queue', public.claim_autonomous_pipeline_run());

select is(
  (select payload->>'mode' from pgtap_drain_claims where case_name = 'fair-queue'),
  'enrichment',
  'the queue receives a fair turn after three source claims'
);

select is(
  (select source_dispatch_streak from public.auction_pipeline_control where id),
  0,
  'the fair queue turn resets the source streak'
);

select is(
  (
    select count(*)
     from public.auction_enrichment_jobs
     where source_url = 'https://example.test/pgtap/drain/queue'
       and job_type = 'display_description'
       and status in ('queued', 'failed')
       and attempt_count < max_attempts
       and next_attempt_at <= statement_timestamp()
  ),
  1::bigint,
  'a scheduler collection turn leaves the due queue available'
);

delete from public.auction_runs
 where id = (
   select (payload->>'id')::uuid
     from pgtap_drain_claims
    where case_name = 'fair-queue'
 );

-- An expired window immediately returns to the normal next_enrichment_at
-- cadence. The source is recent, but the queue is not due on this tick.
select app_private.set_enrichment_drain_until(
  statement_timestamp() - interval '1 minute'
);
update public.auction_pipeline_control
   set source_dispatch_streak = 0,
       next_enrichment_at = statement_timestamp() + interval '1 hour'
 where id;
insert into public.auction_source_state (
  source_name,
  enabled,
  next_inventory_at
)
values (
  'pgtap-drain-expired',
  true,
  statement_timestamp() - interval '30 minutes'
);

insert into pgtap_drain_claims (case_name, payload)
values ('expired-window', public.claim_autonomous_pipeline_run());

select is(
  (select payload->>'mode' from pgtap_drain_claims where case_name = 'expired-window'),
  'collect',
  'an expired drain window restores the normal source-first cadence'
);

select app_private.set_enrichment_drain_until(null);

select * from finish();

rollback;
