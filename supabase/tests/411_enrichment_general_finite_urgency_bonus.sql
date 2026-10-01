begin;

select plan(17);

set local role service_role;

select has_function(
  'public',
  'claim_auction_enrichment_jobs_family',
  array['text', 'integer'],
  'the family claim remains available after the finite urgency patch'
);

select ok(
  position('then 168' in lower(pg_get_functiondef(
    'public.claim_auction_enrichment_jobs_family(text,integer)'::regprocedure
  ))) > 0
  and position('r.is_near desc' in lower(pg_get_functiondef(
    'public.claim_auction_enrichment_jobs_family(text,integer)'::regprocedure
  ))) > 0
  and position('created_at' in lower(pg_get_functiondef(
    'public.claim_auction_enrichment_jobs_family(text,integer)'::regprocedure
  ))) > 0
  and position('j.id' in lower(pg_get_functiondef(
    'public.claim_auction_enrichment_jobs_family(text,integer)'::regprocedure
  ))) > 0,
  'general urgency is finite while source-detail ordering and final tie-breakers remain present'
);

select ok(
  (
    select not procedure_row.prosecdef
      and procedure_row.proconfig @> array['search_path=""']::text[]
      and has_function_privilege(
        'service_role',
        'public.claim_auction_enrichment_jobs_family(text,integer)',
        'execute'
      )
      and not has_function_privilege(
        'anon',
        'public.claim_auction_enrichment_jobs_family(text,integer)',
        'execute'
      )
      and not has_function_privilege(
        'authenticated',
        'public.claim_auction_enrichment_jobs_family(text,integer)',
        'execute'
      )
    from pg_proc procedure_row
    where procedure_row.oid =
      'public.claim_auction_enrichment_jobs_family(text,integer)'::regprocedure
  ),
  'the claim keeps invoker security, empty search_path, and service-only ACLs'
);

select ok(
  position('pg_advisory_xact_lock' in lower(pg_get_functiondef(
    'public.claim_auction_enrichment_jobs_family(text,integer)'::regprocedure
  ))) > 0
  and position('revision_rank > 1' in lower(pg_get_functiondef(
    'public.claim_auction_enrichment_jobs_family(text,integer)'::regprocedure
  ))) > 0
  and position('s.retention_deadline_materialized' in lower(pg_get_functiondef(
    'public.claim_auction_enrichment_jobs_family(text,integer)'::regprocedure
  ))) > 0
  and position('active.status = ''running''' in lower(pg_get_functiondef(
    'public.claim_auction_enrichment_jobs_family(text,integer)'::regprocedure
  ))) > 0
  and position('for update of j, s skip locked' in lower(pg_get_functiondef(
    'public.claim_auction_enrichment_jobs_family(text,integer)'::regprocedure
  ))) > 0
  and position('v_family = ''all'' and j.job_type = ''source_detail''' in lower(pg_get_functiondef(
    'public.claim_auction_enrichment_jobs_family(text,integer)'::regprocedure
  ))) > 0,
  'advisory, revision, retention, lease, source-lane, and row-lock guards remain'
);

-- The fixtures below are isolated by the surrounding rollback.  Sale triggers
-- may enqueue their own rows, so the queue is cleared after each sale batch.
delete from public.auction_enrichment_jobs;
update public.auction_pipeline_control
   set enabled = true,
       source_details_enabled = true
 where id;
insert into public.auction_source_state(source_name, enabled, suspended_until)
values
  ('pgtap-411-a', true, null),
  ('pgtap-411-b', true, null),
  ('pgtap-411-disabled', false, null);

insert into public.auction_sales(source_name, source_url, status, sale_date, raw_payload)
values
  ('pgtap-411-a', 'https://example.test/pgtap/411/near-equal', 'upcoming', now() + interval '3 days', '{}'::jsonb),
  ('pgtap-411-a', 'https://example.test/pgtap/411/far-equal', 'upcoming', now() + interval '30 days', '{}'::jsonb),
  ('pgtap-411-a', 'https://example.test/pgtap/411/old-non-near', 'upcoming', now() + interval '30 days', '{}'::jsonb),
  ('pgtap-411-a', 'https://example.test/pgtap/411/recent-near', 'upcoming', now() + interval '3 days', '{}'::jsonb),
  ('pgtap-411-a', 'https://example.test/pgtap/411/superseded', 'upcoming', now() + interval '30 days', '{}'::jsonb),
  ('pgtap-411-a', 'https://example.test/pgtap/411/expired', 'past', now() - interval '100 days', '{}'::jsonb),
  ('pgtap-411-disabled', 'https://example.test/pgtap/411/disabled', 'upcoming', now() + interval '3 days', '{}'::jsonb),
  ('pgtap-411-a', 'https://example.test/pgtap/411/quarantined', 'quarantined', now() + interval '3 days', '{}'::jsonb),
  ('pgtap-411-a', 'https://example.test/pgtap/411/fresh-lease', 'upcoming', now() + interval '30 days', '{}'::jsonb),
  ('pgtap-411-a', 'https://example.test/pgtap/411/round-a-1', 'upcoming', now() + interval '30 days', '{}'::jsonb),
  ('pgtap-411-a', 'https://example.test/pgtap/411/round-a-2', 'upcoming', now() + interval '30 days', '{}'::jsonb),
  ('pgtap-411-b', 'https://example.test/pgtap/411/round-b-1', 'upcoming', now() + interval '30 days', '{}'::jsonb),
  ('pgtap-411-b', 'https://example.test/pgtap/411/round-b-2', 'upcoming', now() + interval '30 days', '{}'::jsonb);

delete from public.auction_enrichment_jobs;

create temporary table pgtap_411_claims (
  case_name text,
  job_id uuid,
  source_url text,
  detail_source_name text
) on commit drop;

-- Near urgency wins when age and priority are equal.
insert into public.auction_enrichment_jobs (
  source_url, job_type, status, priority, input_hash,
  next_attempt_at, created_at, updated_at
)
values
  ('https://example.test/pgtap/411/near-equal', 'display_description', 'queued', 20, 'pgtap-411-near-equal',
   now() - interval '1 minute', now() - interval '2 days', now() - interval '2 days'),
  ('https://example.test/pgtap/411/far-equal', 'display_description', 'queued', 20, 'pgtap-411-far-equal',
   now() - interval '1 minute', now() - interval '2 days', now() - interval '2 days');

insert into pgtap_411_claims(case_name, job_id, source_url)
select 'near-equal', id, source_url
  from public.claim_auction_enrichment_jobs_family('enrichment', 1);

select is(
  (select source_url from pgtap_411_claims where case_name = 'near-equal'),
  'https://example.test/pgtap/411/near-equal',
  'a near sale wins when priority and age are equal'
);

select is(
  (select count(*) from public.auction_enrichment_jobs
    where source_url = 'https://example.test/pgtap/411/far-equal'
      and status = 'queued'),
  1::bigint,
  'the equal-age non-near job remains queued after the urgent claim'
);

-- A finite bonus lets a sufficiently old non-near job beat a recent urgent one.
delete from public.auction_enrichment_jobs;
insert into public.auction_enrichment_jobs (
  source_url, job_type, status, priority, input_hash,
  next_attempt_at, created_at, updated_at
)
values
  ('https://example.test/pgtap/411/old-non-near', 'display_description', 'queued', 20, 'pgtap-411-old',
   now() - interval '1 minute', now() - interval '42 days', now() - interval '42 days'),
  ('https://example.test/pgtap/411/recent-near', 'display_description', 'queued', 20, 'pgtap-411-recent',
   now() - interval '1 minute', now() - interval '1 day', now() - interval '1 day');

insert into pgtap_411_claims(case_name, job_id, source_url)
select 'old-vs-recent', id, source_url
  from public.claim_auction_enrichment_jobs_family('enrichment', 1);

select is(
  (select source_url from pgtap_411_claims where case_name = 'old-vs-recent'),
  'https://example.test/pgtap/411/old-non-near',
  'a sufficiently old non-near job outranks a recent urgent job'
);

-- Revision cleanup still cancels the older row before ordering the winner.
delete from public.auction_enrichment_jobs;
insert into public.auction_enrichment_jobs (
  source_url, job_type, status, priority, input_hash,
  next_attempt_at, created_at, updated_at
)
values
  ('https://example.test/pgtap/411/superseded', 'display_description', 'queued', 20, 'legacy-revision',
   now() - interval '1 minute', now() - interval '2 days', now() - interval '2 days'),
  ('https://example.test/pgtap/411/superseded', 'display_description', 'queued', 20, 'pipeline_v2:winning-revision',
   now() - interval '1 minute', now() - interval '1 minute', now() - interval '1 minute');

insert into pgtap_411_claims(case_name, job_id, source_url)
select 'superseded', id, source_url
  from public.claim_auction_enrichment_jobs_family('enrichment', 1);

select is(
  (select source_url from pgtap_411_claims where case_name = 'superseded'),
  'https://example.test/pgtap/411/superseded',
  'the winning revision remains claimable'
);

select is(
  (select count(*) from public.auction_enrichment_jobs
    where source_url = 'https://example.test/pgtap/411/superseded'
      and input_hash = 'legacy-revision'
      and status = 'cancelled'),
  1::bigint,
  'the superseded revision is excluded before the claim'
);

-- Retention and quarantine remain hard admission fences.
delete from public.auction_enrichment_jobs;
insert into public.auction_enrichment_jobs (
  source_url, job_type, status, priority, input_hash,
  next_attempt_at, created_at, updated_at
)
values
  ('https://example.test/pgtap/411/expired', 'display_description', 'queued', 20, 'expired-v1',
   now() - interval '1 minute', now() - interval '2 days', now() - interval '2 days'),
  ('https://example.test/pgtap/411/quarantined', 'display_description', 'queued', 20, 'quarantine-v1',
   now() - interval '1 minute', now() - interval '2 days', now() - interval '2 days');

select is(
  (select count(*) from public.claim_auction_enrichment_jobs_family('enrichment', 2)),
  0::bigint,
  'expired and quarantined sales produce no enrichment claims'
);

select is(
  (select count(*) from public.auction_enrichment_jobs
    where source_url in (
      'https://example.test/pgtap/411/expired',
      'https://example.test/pgtap/411/quarantined'
    )
      and status = 'cancelled'),
  2::bigint,
  'expired and quarantined rows are retained as cancelled audit history'
);

-- Disabled source-detail admission and a fresh same-sale lease remain blocked.
delete from public.auction_enrichment_jobs;
insert into public.auction_enrichment_jobs (
  source_url, job_type, status, priority, input_hash,
  next_attempt_at, created_at, updated_at, detail_source_name, detail_source_url
)
values
  ('https://example.test/pgtap/411/disabled', 'source_detail', 'queued', 20, 'disabled-v1',
   now() - interval '1 minute', now() - interval '2 days', now() - interval '2 days',
   'pgtap-411-disabled', 'https://example.test/pgtap/411/detail/disabled'),
  ('https://example.test/pgtap/411/fresh-lease', 'display_description', 'running', 20, 'fresh-running-v1',
   now() - interval '1 minute', now() - interval '2 days', now(), null, null),
  ('https://example.test/pgtap/411/fresh-lease', 'display_description', 'queued', 20, 'fresh-queued-v1',
   now() - interval '1 minute', now() - interval '1 minute', now() - interval '1 minute', null, null);

select is(
  (select count(*) from public.claim_auction_enrichment_jobs_family('source_detail', 1)),
  0::bigint,
  'a disabled source-detail row is not claimed'
);

select is(
  (select status from public.auction_enrichment_jobs
    where input_hash = 'disabled-v1'),
  'queued',
  'a disabled source-detail row remains queued for a later enabled cycle'
);

select is(
  (select count(*) from public.claim_auction_enrichment_jobs_family('enrichment', 1)),
  0::bigint,
  'a fresh same-sale lease blocks a second general claim'
);

select is(
  (select status from public.auction_enrichment_jobs
    where input_hash = 'fresh-queued-v1'),
  'queued',
  'the job behind a fresh lease remains queued'
);

-- The specialized source-detail lane still claims one row per source rank.
delete from public.auction_enrichment_jobs;
insert into public.auction_enrichment_jobs (
  source_url, job_type, status, priority, input_hash,
  next_attempt_at, created_at, updated_at, detail_source_name, detail_source_url
)
values
  ('https://example.test/pgtap/411/round-a-1', 'source_detail', 'queued', 20, 'round-a-1',
   now() - interval '1 minute', now() - interval '2 days', now() - interval '2 days',
   'pgtap-411-a', 'https://example.test/pgtap/411/detail/round-a-1'),
  ('https://example.test/pgtap/411/round-a-2', 'source_detail', 'queued', 20, 'round-a-2',
   now() - interval '1 minute', now() - interval '1 day', now() - interval '1 day',
   'pgtap-411-a', 'https://example.test/pgtap/411/detail/round-a-2'),
  ('https://example.test/pgtap/411/round-b-1', 'source_detail', 'queued', 20, 'round-b-1',
   now() - interval '1 minute', now() - interval '2 days', now() - interval '2 days',
   'pgtap-411-b', 'https://example.test/pgtap/411/detail/round-b-1'),
  ('https://example.test/pgtap/411/round-b-2', 'source_detail', 'queued', 20, 'round-b-2',
   now() - interval '1 minute', now() - interval '1 day', now() - interval '1 day',
   'pgtap-411-b', 'https://example.test/pgtap/411/detail/round-b-2');

insert into pgtap_411_claims(case_name, job_id, source_url, detail_source_name)
select 'round-robin', id, source_url, detail_source_name
  from public.claim_auction_enrichment_jobs_family('source_detail', 2);

select is(
  (select count(*) from pgtap_411_claims where case_name = 'round-robin'),
  2::bigint,
  'the source-detail lane claims the requested bounded batch'
);

select is(
  (select count(distinct detail_source_name)
     from pgtap_411_claims
    where case_name = 'round-robin'),
  2::bigint,
  'the source-detail lane keeps one rank per source before a second rank'
);

select * from finish();
rollback;
