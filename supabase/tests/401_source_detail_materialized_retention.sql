begin;

select plan(8);

select ok(
  position('s.retention_deadline_materialized' in lower(pg_get_functiondef(
    'public.enqueue_due_source_details_unlocked(timestamptz,integer)'::regprocedure
  ))) > 0
  and position('app_private.sale_retention_deadline(' in lower(pg_get_functiondef(
    'public.enqueue_due_source_details_unlocked(timestamptz,integer)'::regprocedure
  ))) = 0,
  'detail admission reuses the completed retention value without reparsing JSON'
);

select ok(
  has_function_privilege('service_role',
    'public.enqueue_due_source_details_unlocked(timestamptz,integer)', 'execute')
  and not has_function_privilege('anon',
    'public.enqueue_due_source_details_unlocked(timestamptz,integer)', 'execute')
  and not has_function_privilege('authenticated',
    'public.enqueue_due_source_details_unlocked(timestamptz,integer)', 'execute'),
  'only the service role retains detail admission privileges'
);

set local role service_role;
set local app.pipeline_queue_owner = 'python';

-- Isolate global admission inside this rollback-only transaction.
delete from public.auction_enrichment_jobs;
update public.auction_source_state set enabled = false;
update public.auction_pipeline_control
  set enabled = true, source_details_enabled = true
  where id;

insert into public.auction_source_state(source_name, enabled, suspended_until)
values ('pgtap-detail-retention', true, null);

insert into public.auction_sales(id, source_name, source_url, status, sale_date, raw_payload)
values
  ('f4010000-0000-4000-8000-000000000001', 'pgtap-detail-retention',
   'https://example.test/pgtap/detail-retention/future', 'upcoming',
   now() + interval '8 days', '{}'::jsonb),
  ('f4010000-0000-4000-8000-000000000002', 'pgtap-detail-retention',
   'https://example.test/pgtap/detail-retention/postponed', 'postponed',
   now() - interval '90 days', '{}'::jsonb),
  ('f4010000-0000-4000-8000-000000000003', 'pgtap-detail-retention',
   'https://example.test/pgtap/detail-retention/unknown', 'unknown',
   null, '{}'::jsonb),
  ('f4010000-0000-4000-8000-000000000004', 'pgtap-detail-retention',
   'https://example.test/pgtap/detail-retention/expired', 'upcoming',
   '2000-01-01 12:00:00+00', '{}'::jsonb);

-- Sale triggers may create ordinary enrichment revisions. Admission is the
-- only operation allowed to create jobs used by the assertions below.
delete from public.auction_enrichment_jobs;

select is(
  public.enqueue_due_source_details_unlocked(now(), 20),
  3,
  'future, postponed and undated sales are admitted, while expired sales are skipped'
);

select is(
  (select count(*) from public.auction_enrichment_jobs
   where detail_source_url = 'https://example.test/pgtap/detail-retention/future'),
  1::bigint,
  'a future materialized deadline remains eligible'
);

select is(
  (select count(*) from public.auction_enrichment_jobs
   where detail_source_url = 'https://example.test/pgtap/detail-retention/postponed'),
  1::bigint,
  'a postponed sale with a NULL materialized deadline remains eligible'
);

select is(
  (select count(*) from public.auction_enrichment_jobs
   where detail_source_url = 'https://example.test/pgtap/detail-retention/unknown'),
  1::bigint,
  'an undated sale with a NULL materialized deadline remains eligible'
);

select is(
  (select count(*) from public.auction_enrichment_jobs
   where detail_source_url = 'https://example.test/pgtap/detail-retention/expired'),
  0::bigint,
  'an expired materialized deadline never creates a detail job'
);

select is(
  public.enqueue_due_source_details_unlocked(now(), 20),
  0,
  'a second admission preserves the existing open identity instead of duplicating jobs'
);

select * from finish();
rollback;
