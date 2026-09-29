begin;

select plan(29);

set local role service_role;

select has_function(
  'public',
  'claim_auction_enrichment_jobs_family',
  array['text', 'integer'],
  'the family claim RPC remains available after retention optimization'
);

select has_column(
  'public',
  'auction_sales',
  'retention_deadline',
  'the claim uses the materialized sale-retention deadline'
);

select has_column(
  'public',
  'auction_sales',
  'retention_deadline_materialized',
  'the claim uses the materialized sale-retention fence'
);

select ok(
  (
    select column_row.is_nullable = 'NO'
    from information_schema.columns column_row
    where column_row.table_schema = 'public'
      and column_row.table_name = 'auction_sales'
      and column_row.column_name = 'retention_deadline_materialized'
  ),
  'the claim retention fence is mandatory'
);

select ok(
  position('retention_deadline_materialized' in lower(
    pg_get_functiondef(
      'public.claim_auction_enrichment_jobs_family(text,integer)'::regprocedure
    )
  )) > 0
  and position('s.retention_deadline' in lower(
    pg_get_functiondef(
      'public.claim_auction_enrichment_jobs_family(text,integer)'::regprocedure
    )
  )) > 0,
  'retention admission and obsolete-job cleanup read the persisted deadline'
);

select ok(
  position('not s.retention_deadline_materialized' in lower(
    pg_get_functiondef(
      'public.claim_auction_enrichment_jobs_family(text,integer)'::regprocedure
    )
  )) > 0,
  'unfenced sales are conservatively retained during obsolete-job cleanup'
);

select ok(
  position('app_private.sale_retention_deadline(' in lower(
    pg_get_functiondef(
      'public.claim_auction_enrichment_jobs_family(text,integer)'::regprocedure
    )
  )) = 0
  and position('cross join lateral' in lower(
    pg_get_functiondef(
      'public.claim_auction_enrichment_jobs_family(text,integer)'::regprocedure
    )
  )) = 0,
  'the claim no longer reparses sale JSON or calls a lateral retention parser'
);

select ok(
  position('s.retention_deadline_materialized' in lower(
    pg_get_functiondef(
      'public.claim_auction_enrichment_jobs_family(text,integer)'::regprocedure
    )
  )) > 0
  and position('s.retention_deadline > now()' in lower(
    pg_get_functiondef(
      'public.claim_auction_enrichment_jobs_family(text,integer)'::regprocedure
    )
  )) > 0,
  'admission requires a ready fence and keeps NULL or future deadlines'
);

select ok(
  exists (
    select 1
    from pg_class index_relation
    join pg_index index_row on index_row.indexrelid = index_relation.oid
    where index_relation.relname = 'auction_enrichment_jobs_running_source_lease_idx'
      and index_row.indrelid = 'public.auction_enrichment_jobs'::regclass
      and index_row.indisvalid
  ),
  'the running lease anti-join has a valid index'
);

select ok(
  (
    select position('coalesce(locked_at, updated_at)' in lower(
      pg_get_indexdef(index_relation.oid)
    )) > 0
    from pg_class index_relation
    where index_relation.relname = 'auction_enrichment_jobs_running_source_lease_idx'
      and index_relation.relnamespace = 'public'::regnamespace
  )
  and (
    select position('status = ''running''' in lower(
      pg_get_expr(index_row.indpred, index_row.indrelid)
    )) > 0
    from pg_class index_relation
    join pg_index index_row on index_row.indexrelid = index_relation.oid
    where index_relation.relname = 'auction_enrichment_jobs_running_source_lease_idx'
      and index_relation.relnamespace = 'public'::regnamespace
  ),
  'the lease index keys source_url and the exact running lease-age predicate'
);

select ok(
  position('active.source_url = j.source_url' in lower(
    pg_get_functiondef(
      'public.claim_auction_enrichment_jobs_family(text,integer)'::regprocedure
    )
  )) > 0
  and position('active.status = ''running''' in lower(
    pg_get_functiondef(
      'public.claim_auction_enrichment_jobs_family(text,integer)'::regprocedure
    )
  )) > 0
  and position('coalesce(active.locked_at, active.updated_at)' in lower(
    pg_get_functiondef(
      'public.claim_auction_enrichment_jobs_family(text,integer)'::regprocedure
    )
  )) > 0,
  'the claim keeps the source-scoped active lease guard'
);

select ok(
  position('pg_advisory_xact_lock' in lower(
    pg_get_functiondef(
      'public.claim_auction_enrichment_jobs_family(text,integer)'::regprocedure
    )
  )) > 0
  and position('for update of j, s skip locked' in lower(
    pg_get_functiondef(
      'public.claim_auction_enrichment_jobs_family(text,integer)'::regprocedure
    )
  )) > 0,
  'claim serialization and skip-locked concurrency are preserved'
);

select ok(
  position('attempt_count = j.attempt_count + 1' in lower(
    pg_get_functiondef(
      'public.claim_auction_enrichment_jobs_family(text,integer)'::regprocedure
    )
  )) > 0
  and position('where c.id = j.id' in lower(
    pg_get_functiondef(
      'public.claim_auction_enrichment_jobs_family(text,integer)'::regprocedure
    )
  )) > 0
  and position('locked_at = statement_timestamp()' in lower(
    pg_get_functiondef(
      'public.claim_auction_enrichment_jobs_family(text,integer)'::regprocedure
    )
  )) > 0,
  'the claim keeps its lease CAS fields'
);

select ok(
  position('row_number() over' in lower(
    pg_get_functiondef(
      'public.claim_auction_enrichment_jobs_family(text,integer)'::regprocedure
    )
  )) > 0
  and position('partition by source_url, job_type, detail_source_name, detail_source_url' in lower(
    pg_get_functiondef(
      'public.claim_auction_enrichment_jobs_family(text,integer)'::regprocedure
    )
  )) > 0
  and position('r.revision_rank > 1' in lower(
    pg_get_functiondef(
      'public.claim_auction_enrichment_jobs_family(text,integer)'::regprocedure
    )
  )) > 0,
  'obsolete input revisions remain ranked and cancelled'
);

select ok(
  position('superseded by a newer input revision' in lower(
    pg_get_functiondef(
      'public.claim_auction_enrichment_jobs_family(text,integer)'::regprocedure
    )
  )) > 0
  and position('status <> ''cancelled''' in lower(
    pg_get_functiondef(
      'public.claim_auction_enrichment_jobs_family(text,integer)'::regprocedure
    )
  )) > 0,
  'revision cancellation keeps the non-cancelled history as its ranking input'
);

select ok(
  position('ranked_details' in lower(
    pg_get_functiondef(
      'public.claim_auction_enrichment_jobs_family(text,integer)'::regprocedure
    )
  )) > 0
  and position('partition by e.detail_source_name' in lower(
    pg_get_functiondef(
      'public.claim_auction_enrichment_jobs_family(text,integer)'::regprocedure
    )
  )) > 0
  and position('last_detail_claim_at nulls first' in lower(
    pg_get_functiondef(
      'public.claim_auction_enrichment_jobs_family(text,integer)'::regprocedure
    )
  )) > 0,
  'source-detail ordering and round-robin fairness remain intact'
);

select ok(
  position('status in (''queued'', ''failed'')' in lower(
    pg_get_functiondef(
      'public.claim_auction_enrichment_jobs_family(text,integer)'::regprocedure
    )
  )) > 0
  and position('interval ''30 minutes''' in lower(
    pg_get_functiondef(
      'public.claim_auction_enrichment_jobs_family(text,integer)'::regprocedure
    )
  )) > 0,
  'queued, failed, and stale-running lease eligibility remain bounded'
);

select ok(
  has_function_privilege(
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
  ),
  'only service role can invoke the optimized family claim'
);

select has_function(
  'public',
  'claim_auction_enrichment_jobs',
  array['integer'],
  'the historical all-family claim wrapper remains available'
);

select ok(
  position('v_family = ''source_detail''' in lower(
    pg_get_functiondef(
      'public.claim_auction_enrichment_jobs_family(text,integer)'::regprocedure
    )
  )) > 0
  and position('v_family = ''enrichment''' in lower(
    pg_get_functiondef(
      'public.claim_auction_enrichment_jobs_family(text,integer)'::regprocedure
    )
  )) > 0,
  'the requested source-detail and enrichment families keep separate admission paths'
);

select ok(
  position('select * from public.claim_auction_enrichment_jobs_family(''all'', p_limit)' in lower(
    pg_get_functiondef(
      'public.claim_auction_enrichment_jobs(integer)'::regprocedure
    )
  )) > 0,
  'the historical wrapper still delegates to the all-family claim'
);

-- Behavioural proof: a NULL materialized deadline (postponed sale) remains
-- live, an expired sale is cancelled before claim, and a fresh running lease
-- blocks a second job for the same source URL.
-- The whole test is transactional, so clearing the baseline queue gives the
-- second claim a deterministic empty result and is restored by the rollback.
delete from public.auction_enrichment_jobs;

insert into public.auction_sales (
  id,
  source_name,
  source_url,
  status,
  sale_date,
  raw_payload
)
values
  (
    '39900000-0000-4000-8000-000000000001',
    'pgtap-claim-retention-postponed',
    'https://example.test/pgtap/claim-retention/postponed',
    'postponed',
    statement_timestamp() - interval '90 days',
    '{}'::jsonb
  ),
  (
    '39900000-0000-4000-8000-000000000002',
    'pgtap-claim-retention-expired',
    'https://example.test/pgtap/claim-retention/expired',
    'upcoming',
    '2000-01-01 12:00:00+00',
    '{}'::jsonb
  ),
  (
    '39900000-0000-4000-8000-000000000003',
    'pgtap-claim-retention-lease',
    'https://example.test/pgtap/claim-retention/lease',
    'upcoming',
    statement_timestamp() + interval '7 days',
    '{}'::jsonb
  );

-- Sale triggers may enqueue ordinary revisions. Remove those rows so this
-- isolated fixture controls every candidate seen by the family claim.
delete from public.auction_enrichment_jobs
 where source_url like 'https://example.test/pgtap/claim-retention/%';

insert into public.auction_enrichment_jobs (
  source_url,
  job_type,
  status,
  priority,
  input_hash,
  attempt_count,
  next_attempt_at,
  locked_at
)
values
  (
    'https://example.test/pgtap/claim-retention/postponed',
    'display_description',
    'queued',
    100,
    'pgtap-399-postponed-v1',
    0,
    statement_timestamp() - interval '1 minute',
    null
  ),
  (
    'https://example.test/pgtap/claim-retention/expired',
    'display_description',
    'queued',
    100,
    'pgtap-399-expired-v1',
    0,
    statement_timestamp() - interval '1 minute',
    null
  ),
  (
    'https://example.test/pgtap/claim-retention/lease',
    'pdf',
    'running',
    100,
    'pgtap-399-lease-running-v1',
    1,
    statement_timestamp() - interval '1 minute',
    statement_timestamp()
  ),
  (
    'https://example.test/pgtap/claim-retention/lease',
    'display_description',
    'queued',
    90,
    'pgtap-399-lease-queued-v1',
    0,
    statement_timestamp() - interval '1 minute',
    null
  );

select is(
  (
    select retention_deadline
      from public.auction_sales
     where id = '39900000-0000-4000-8000-000000000001'
  ),
  null::timestamptz,
  'a postponed sale keeps a NULL materialized retention deadline'
);

select ok(
  (
    select retention_deadline_materialized
      from public.auction_sales
     where id = '39900000-0000-4000-8000-000000000001'
  ),
  'a NULL deadline is still protected by the ready fence'
);

select lives_ok(
  $$select count(*)
      from public.claim_auction_enrichment_jobs_family('enrichment', 20)$$,
  'the claim completes with retained, expired, and leased fixtures'
);

select is(
  (
    select count(*)
      from public.claim_auction_enrichment_jobs_family('enrichment', 20)
  ),
  0::bigint,
  'a second claim finds no duplicate fixture lease after the first claim'
);

select ok(
  (
    select status = 'running' and attempt_count = 1
      from public.auction_enrichment_jobs
     where input_hash = 'pgtap-399-postponed-v1'
  ),
  'a sale with a NULL deadline remains claimable'
);

select ok(
  (
    select status = 'cancelled'
       and attempt_count = 0
       and last_error = 'Listing removed, expired or explicitly cancelled'
      from public.auction_enrichment_jobs
     where input_hash = 'pgtap-399-expired-v1'
  ),
  'an expired sale is cancelled without consuming a retry'
);

select ok(
  (
    select status = 'running'
       and attempt_count = 1
       and locked_at >= statement_timestamp() - interval '5 minutes'
      from public.auction_enrichment_jobs
     where input_hash = 'pgtap-399-lease-running-v1'
  ),
  'the fresh running lease remains owned by its original worker'
);

select ok(
  (
    select status = 'queued' and attempt_count = 0
      from public.auction_enrichment_jobs
     where input_hash = 'pgtap-399-lease-queued-v1'
  ),
  'an active source lease prevents a second job from being claimed'
);

select * from finish();

rollback;
