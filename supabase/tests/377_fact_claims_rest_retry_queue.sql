begin;

select plan(11);

select has_table(
  'public',
  'auction_enrichment_jobs',
  'the existing enrichment queue is available for REST claim replay'
);

select has_column(
  'public',
  'auction_enrichment_jobs',
  'job_type',
  'the replay queue retains a typed job discriminator'
);

select has_column(
  'public',
  'auction_enrichment_jobs',
  'fact_claims_snapshot',
  'fact claim retries retain the extracted candidate snapshot'
);

select ok(
  position(
    'fact_claims' in pg_get_constraintdef(
      (
        select constraint_row.oid
        from pg_constraint constraint_row
        where constraint_row.conrelid = 'public.auction_enrichment_jobs'::regclass
          and constraint_row.conname = 'auction_enrichment_jobs_job_type_check'
      )
    )
  ) > 0,
  'the bounded queue accepts fact_claims replay jobs'
);

select has_function(
  'public',
  'claim_auction_enrichment_jobs_family',
  array['text', 'integer']::text[],
  'the existing family lease RPC can claim fact replay work'
);

select ok(
  has_function_privilege(
    'service_role',
    'public.claim_auction_enrichment_jobs_family(text,integer)',
    'execute'
  )
  and not has_function_privilege(
    'authenticated',
    'public.claim_auction_enrichment_jobs_family(text,integer)',
    'execute'
  ),
  'only the trusted worker can lease replay jobs'
);

select ok(
  position('job_type <> ''source_detail''' in pg_get_functiondef(
    'public.claim_auction_enrichment_jobs_family(text,integer)'::regprocedure
  )) > 0,
  'the enrichment family includes non-source-detail replay jobs'
);

select ok(
  position('attempt_count < j.max_attempts' in pg_get_functiondef(
    'public.claim_auction_enrichment_jobs_family(text,integer)'::regprocedure
  )) > 0,
  'replay leases remain bounded by the existing attempt budget'
);

select ok(
  position('jsonb_typeof(fact_claims_snapshot)' in pg_get_constraintdef(
    (
      select constraint_row.oid
      from pg_constraint constraint_row
      where constraint_row.conrelid = 'public.auction_enrichment_jobs'::regclass
        and constraint_row.conname = 'auction_enrichment_jobs_fact_claims_snapshot_check'
    )
  )) > 0,
  'candidate snapshots are constrained to non-empty JSON arrays'
);

select ok(
  exists (
    select 1
    from pg_trigger trigger_row
    where trigger_row.tgrelid = 'public.auction_enrichment_jobs'::regclass
      and trigger_row.tgname = 'protect_fact_claim_retry_snapshot'
      and not trigger_row.tgisinternal
  ),
  'superseded-revision cleanup cannot cancel fact claim observations'
);

select ok(
  exists (
    select 1
    from pg_constraint constraint_row
    where constraint_row.conrelid = 'public.auction_enrichment_jobs'::regclass
      and constraint_row.contype = 'u'
      and position('source_url' in pg_get_constraintdef(constraint_row.oid)) > 0
      and position('job_type' in pg_get_constraintdef(constraint_row.oid)) > 0
      and position('input_hash' in pg_get_constraintdef(constraint_row.oid)) > 0
  ),
  'the queue identity prevents duplicate replay rows'
);

select * from finish();

rollback;
