begin;

select plan(31);

select has_table(
  'app_private',
  'auction_enrichment_delete_receipts',
  'private deletion receipts table exists'
);

select ok(
  (
    select relrowsecurity
    from pg_class
    where oid = 'app_private.auction_enrichment_delete_receipts'::regclass
  ),
  'deletion receipts retain row level security'
);

select ok(
  not exists (
    select 1
    from pg_constraint constraint_row
    where constraint_row.conrelid =
      'app_private.auction_enrichment_delete_receipts'::regclass
      and constraint_row.contype = 'f'
  )
  and not exists (
    select 1
    from information_schema.columns column_row
    where column_row.table_schema = 'app_private'
      and column_row.table_name = 'auction_enrichment_delete_receipts'
      and column_row.column_name in (
        'source_url', 'input_hash', 'last_error', 'error',
        'error_message', 'raw_payload', 'payload'
      )
  ),
  'receipts have no foreign key or URL, hash, error, or payload column'
);

select ok(
  not has_table_privilege('anon', 'app_private.auction_enrichment_delete_receipts', 'SELECT')
  and not has_table_privilege('anon', 'app_private.auction_enrichment_delete_receipts', 'INSERT')
  and not has_table_privilege('anon', 'app_private.auction_enrichment_delete_receipts', 'UPDATE')
  and not has_table_privilege('anon', 'app_private.auction_enrichment_delete_receipts', 'DELETE')
  and not has_table_privilege('authenticated', 'app_private.auction_enrichment_delete_receipts', 'SELECT')
  and not has_table_privilege('authenticated', 'app_private.auction_enrichment_delete_receipts', 'INSERT')
  and not has_table_privilege('authenticated', 'app_private.auction_enrichment_delete_receipts', 'UPDATE')
  and not has_table_privilege('authenticated', 'app_private.auction_enrichment_delete_receipts', 'DELETE'),
  'API roles cannot read or mutate deletion receipts'
);

select ok(
  has_table_privilege('service_role', 'app_private.auction_enrichment_delete_receipts', 'SELECT')
  and not has_table_privilege('service_role', 'app_private.auction_enrichment_delete_receipts', 'INSERT')
  and not has_table_privilege('service_role', 'app_private.auction_enrichment_delete_receipts', 'UPDATE')
  and not has_table_privilege('service_role', 'app_private.auction_enrichment_delete_receipts', 'DELETE')
  and not has_table_privilege('service_role', 'app_private.auction_enrichment_delete_receipts', 'TRUNCATE'),
  'service role has SELECT only on deletion receipts'
);

select ok(
  not has_table_privilege('anon', 'public.auction_enrichment_jobs', 'TRUNCATE')
  and not has_table_privilege('authenticated', 'public.auction_enrichment_jobs', 'TRUNCATE')
  and not has_table_privilege('service_role', 'public.auction_enrichment_jobs', 'TRUNCATE'),
  'API and service roles cannot TRUNCATE the enrichment queue'
);

select has_function(
  'app_private',
  'record_auction_enrichment_job_delete',
  array[]::text[],
  'the private delete trigger function exists'
);

select ok(
  (
    select procedure_row.prosecdef
      and procedure_row.proconfig @> array['search_path=""']::text[]
      and not has_function_privilege(
        'anon',
        'app_private.record_auction_enrichment_job_delete()',
        'execute'
      )
      and not has_function_privilege(
        'authenticated',
        'app_private.record_auction_enrichment_job_delete()',
        'execute'
      )
      and not has_function_privilege(
        'service_role',
        'app_private.record_auction_enrichment_job_delete()',
        'execute'
      )
    from pg_proc procedure_row
    where procedure_row.oid =
      'app_private.record_auction_enrichment_job_delete()'::regprocedure
  ),
  'the delete trigger is SECURITY DEFINER, search_path empty, and trigger-only'
);

select has_function(
  'app_private',
  'reject_auction_enrichment_jobs_truncate',
  array[]::text[],
  'the private TRUNCATE rejection function exists'
);

select ok(
  (
    select procedure_row.proconfig @> array['search_path=""']::text[]
      and not has_function_privilege(
        'anon',
        'app_private.reject_auction_enrichment_jobs_truncate()',
        'execute'
      )
      and not has_function_privilege(
        'authenticated',
        'app_private.reject_auction_enrichment_jobs_truncate()',
        'execute'
      )
      and not has_function_privilege(
        'service_role',
        'app_private.reject_auction_enrichment_jobs_truncate()',
        'execute'
      )
    from pg_proc procedure_row
    where procedure_row.oid =
      'app_private.reject_auction_enrichment_jobs_truncate()'::regprocedure
  ),
  'the TRUNCATE rejection function keeps its private empty search_path'
);

select has_function(
  'app_private',
  'purge_auction_enrichment_delete_receipts',
  array['integer']::text[],
  'the bounded receipt purge function keeps its integer limit signature'
);

select ok(
  (
    select procedure_row.prosecdef
      and procedure_row.proconfig @> array['search_path=""']::text[]
      and has_function_privilege(
        'service_role',
        'app_private.purge_auction_enrichment_delete_receipts(integer)',
        'execute'
      )
      and not has_function_privilege(
        'anon',
        'app_private.purge_auction_enrichment_delete_receipts(integer)',
        'execute'
      )
      and not has_function_privilege(
        'authenticated',
        'app_private.purge_auction_enrichment_delete_receipts(integer)',
        'execute'
      )
    from pg_proc procedure_row
    where procedure_row.oid =
      'app_private.purge_auction_enrichment_delete_receipts(integer)'::regprocedure
  ),
  'the bounded purge is SECURITY DEFINER with service-role execution only'
);

select ok(
  exists (
    select 1
    from pg_trigger trigger_row
    where trigger_row.tgrelid = 'public.auction_enrichment_jobs'::regclass
      and trigger_row.tgname = 'auction_enrichment_jobs_delete_receipt'
      and trigger_row.tgenabled = 'O'
      and not trigger_row.tgisinternal
      and trigger_row.tgfoid =
        'app_private.record_auction_enrichment_job_delete()'::regprocedure
  ),
  'the enabled row-delete receipt trigger remains attached to the queue'
);

select ok(
  exists (
    select 1
    from pg_trigger trigger_row
    where trigger_row.tgrelid = 'public.auction_enrichment_jobs'::regclass
      and trigger_row.tgname = 'auction_enrichment_jobs_no_truncate'
      and trigger_row.tgenabled = 'O'
      and not trigger_row.tgisinternal
      and trigger_row.tgtype = 34
      and trigger_row.tgfoid =
        'app_private.reject_auction_enrichment_jobs_truncate()'::regprocedure
  ),
  'the enabled BEFORE TRUNCATE guard remains attached to the queue'
);

select ok(
  position(
    'statement_timestamp() - interval ''30 days''' in lower(
      pg_get_functiondef(
        'app_private.purge_auction_enrichment_delete_receipts(integer)'::regprocedure
      )
    )
  ) > 0
  and not exists (
    select 1
    from pg_proc procedure_row
    join pg_namespace namespace_row
      on namespace_row.oid = procedure_row.pronamespace
    where namespace_row.nspname = 'app_private'
      and procedure_row.proname = 'purge_auction_enrichment_delete_receipts'
      and 'p_now' = any(coalesce(procedure_row.proargnames, '{}'::text[]))
  ),
  'retention uses the database clock and exposes no caller-controlled p_now'
);

select ok(
  (
    select count(*) = 1
      and count(*) filter (
        where length(command) - length(
          replace(command, 'purge_auction_enrichment_delete_receipts', '')
        ) = length('purge_auction_enrichment_delete_receipts')
      ) = 1
    from cron.job
    where jobname = 'immojudis-operational-history-retention'
  ),
  'the existing history cron has exactly one bounded receipt purge hook'
);

-- Direct deletion records the observed running state and does not invent a
-- completed timestamp. The parent remains present for this path.
insert into public.auction_sales (
  id, source_name, source_url, status, sale_date, starting_price_eur
) values (
  'f4090000-0000-4000-8000-000000000001',
  'pgtap-409-direct',
  'https://example.test/pgtap/409/direct',
  'upcoming',
  statement_timestamp() + interval '7 days',
  10000
);

insert into public.auction_enrichment_jobs (
  id, source_url, job_type, status, priority, input_hash,
  attempt_count, max_attempts, next_attempt_at, locked_at, completed_at,
  created_at, updated_at
) values (
  'f4090000-0000-4000-8000-000000000101',
  'https://example.test/pgtap/409/direct',
  'pdf',
  'running',
  100,
  'pgtap-409-direct-v1',
  2,
  4,
  statement_timestamp() - interval '1 minute',
  statement_timestamp() - interval '1 minute',
  null,
  statement_timestamp() - interval '2 minutes',
  statement_timestamp() - interval '1 minute'
);

create temporary table pgtap409_direct_snapshot on commit drop as
select id, status, attempt_count, max_attempts, next_attempt_at,
       locked_at, completed_at, created_at, updated_at
  from public.auction_enrichment_jobs
 where id = 'f4090000-0000-4000-8000-000000000101';

savepoint pgtap409_direct_delete;
delete from public.auction_enrichment_jobs
 where id = 'f4090000-0000-4000-8000-000000000101';
rollback to savepoint pgtap409_direct_delete;
release savepoint pgtap409_direct_delete;

select ok(
  (select count(*) from public.auction_enrichment_jobs
    where id = 'f4090000-0000-4000-8000-000000000101') = 1
  and (select count(*) from app_private.auction_enrichment_delete_receipts
    where job_id = 'f4090000-0000-4000-8000-000000000101') = 0,
  'rolling back a DELETE restores the job and removes its receipt atomically'
);

set local role service_role;
delete from public.auction_enrichment_jobs
 where id = 'f4090000-0000-4000-8000-000000000101';
reset role;

select ok(
  (
    select receipt.status_before_delete = snapshot.status
       and receipt.attempt_count = snapshot.attempt_count
       and receipt.max_attempts = snapshot.max_attempts
       and receipt.next_attempt_at = snapshot.next_attempt_at
       and receipt.locked_at is not distinct from snapshot.locked_at
       and receipt.completed_at is not distinct from snapshot.completed_at
       and receipt.job_created_at = snapshot.created_at
       and receipt.job_updated_at = snapshot.updated_at
       and receipt.deletion_context = 'catalogue_row_present'
      from app_private.auction_enrichment_delete_receipts receipt
      join pgtap409_direct_snapshot snapshot
        on snapshot.id = receipt.job_id
     where receipt.job_id = 'f4090000-0000-4000-8000-000000000101'
  ),
  'direct DELETE preserves the exact running row snapshot and NULL completed_at'
);

select is(
  (
    select count(*)
      from app_private.auction_enrichment_delete_receipts
     where job_id = 'f4090000-0000-4000-8000-000000000101'
  ),
  1::bigint,
  'direct DELETE creates one receipt'
);

-- A parent DELETE is rejected until its immutable Outcome Graph archive bridge
-- exists. The failed cascade must leave both parent and queue row intact.
insert into public.auction_sales (
  id, source_name, source_url, status, sale_date, starting_price_eur
) values (
  'f4090000-0000-4000-8000-000000000002',
  'pgtap-409-cascade',
  'https://example.test/pgtap/409/cascade',
  'upcoming',
  statement_timestamp() + interval '7 days',
  20000
);

insert into public.auction_enrichment_jobs (
  id, source_url, job_type, status, priority, input_hash,
  attempt_count, max_attempts, next_attempt_at, completed_at
) values (
  'f4090000-0000-4000-8000-000000000102',
  'https://example.test/pgtap/409/cascade',
  'pdf',
  'queued',
  100,
  'pgtap-409-cascade-v1',
  0,
  4,
  statement_timestamp() - interval '1 minute',
  null
);

select throws_ok(
  $$delete from public.auction_sales
     where id = 'f4090000-0000-4000-8000-000000000002'$$,
  '55000',
  'auction_sales rows must have a complete Outcome Graph bridge before deletion.',
  'parent deletion requires the archive bridge'
);

select ok(
  (
    (select count(*) from public.auction_sales
      where id = 'f4090000-0000-4000-8000-000000000002') = 1
    and (select count(*) from public.auction_enrichment_jobs
      where id = 'f4090000-0000-4000-8000-000000000102') = 1
    and (select count(*) from app_private.auction_enrichment_delete_receipts
      where job_id = 'f4090000-0000-4000-8000-000000000102') = 0
  ),
  'a rejected parent cascade rolls back the parent, child, and receipt atomically'
);

select lives_ok(
  $$select * from public.bridge_auction_sales_to_outcome_graph_batch(
    'f408ffff-ffff-4fff-8fff-ffffffffffff'::uuid,
    25
  )$$,
  'the bounded archive bridge can prepare the parent deletion fixture'
);

delete from public.auction_sales
 where id = 'f4090000-0000-4000-8000-000000000002';

select ok(
  (
    select status_before_delete = 'queued'
       and attempt_count = 0
       and completed_at is null
       and deletion_context = 'catalogue_row_absent'
      from app_private.auction_enrichment_delete_receipts
     where job_id = 'f4090000-0000-4000-8000-000000000102'
  ),
  'an archived parent cascade records the child before deletion without fake completion'
);

select ok(
  (select count(*) from public.auction_sales
    where id = 'f4090000-0000-4000-8000-000000000002') = 0
  and (select count(*) from public.auction_enrichment_jobs
    where id = 'f4090000-0000-4000-8000-000000000102') = 0,
  'the archived parent cascade removes the parent and child after recording evidence'
);

select throws_ok(
  $$truncate table public.auction_enrichment_jobs$$,
  '55000',
  'Enrichment queue requires DELETE with transactional evidence.',
  'TRUNCATE cannot bypass row deletion evidence'
);

insert into app_private.auction_enrichment_delete_receipts (
  job_id, job_type, status_before_delete, attempt_count, max_attempts,
  next_attempt_at, locked_at, completed_at, job_created_at, job_updated_at,
  deleted_at, deletion_context
) values
  (
    'f4090000-0000-4000-8000-000000000201', 'pdf', 'queued', 0, 4,
    statement_timestamp(), null, null,
    statement_timestamp() - interval '31 days',
    statement_timestamp() - interval '31 days',
    statement_timestamp() - interval '31 days', 'catalogue_row_absent'
  ),
  (
    'f4090000-0000-4000-8000-000000000202', 'pdf', 'queued', 0, 4,
    statement_timestamp(), null, null,
    statement_timestamp() - interval '31 days',
    statement_timestamp() - interval '31 days',
    statement_timestamp() - interval '31 days' + interval '1 second',
    'catalogue_row_absent'
  ),
  (
    'f4090000-0000-4000-8000-000000000203', 'pdf', 'queued', 0, 4,
    statement_timestamp(), null, null,
    statement_timestamp() - interval '29 days',
    statement_timestamp() - interval '29 days',
    statement_timestamp() - interval '29 days', 'catalogue_row_absent'
  );

select throws_ok(
  $$select app_private.purge_auction_enrichment_delete_receipts(0)$$,
  '22023',
  'Deletion receipt retention requires a batch size between 1 and 100000.',
  'receipt purge rejects a zero batch'
);

select throws_ok(
  $$select app_private.purge_auction_enrichment_delete_receipts(100001)$$,
  '22023',
  'Deletion receipt retention requires a batch size between 1 and 100000.',
  'receipt purge rejects an oversized batch'
);

set local role service_role;

select is(
  app_private.purge_auction_enrichment_delete_receipts(1),
  1::bigint,
  'receipt purge deletes one expired row per bounded call'
);

select is(
  (
    select count(*)
      from app_private.auction_enrichment_delete_receipts
     where job_id in (
       'f4090000-0000-4000-8000-000000000202',
       'f4090000-0000-4000-8000-000000000203'
     )
  ),
  2::bigint,
  'the first bounded purge keeps the next expired row and the fresh row'
);

select is(
  app_private.purge_auction_enrichment_delete_receipts(1),
  1::bigint,
  'the second bounded call deletes the next expired row'
);

select is(
  (
    select count(*)
      from app_private.auction_enrichment_delete_receipts
     where job_id = 'f4090000-0000-4000-8000-000000000203'
  ),
  1::bigint,
  'the database clock keeps the less-than-30-day receipt'
);

reset role;
select * from finish();

rollback;
