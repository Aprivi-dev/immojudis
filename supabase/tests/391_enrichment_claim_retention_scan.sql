begin;

select plan(18);

select has_function(
  'public',
  'claim_auction_enrichment_jobs_family',
  array['text', 'integer']::text[],
  'the family claim RPC remains available'
);

select has_function(
  'public',
  'claim_auction_enrichment_jobs',
  array['integer']::text[],
  'the legacy all-family claim wrapper remains available'
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
  'only the trusted worker can lease enrichment jobs'
);

select ok(
  position(
    'with sales_with_deadline as materialized' in lower(
      pg_get_functiondef(
        'public.claim_auction_enrichment_jobs_family(text,integer)'::regprocedure
      )
    )
  ) > 0,
  'retention cleanup materializes one deadline calculation per sale'
);

select ok(
  position('from live_sales' in lower(
    pg_get_functiondef(
      'public.claim_auction_enrichment_jobs_family(text,integer)'::regprocedure
    )
  )) > 0
  and position(
    'retention_deadline is null' in lower(
      pg_get_functiondef(
        'public.claim_auction_enrichment_jobs_family(text,integer)'::regprocedure
      )
    )
  ) > 0
  and position(
    'retention_deadline > now()' in lower(
      pg_get_functiondef(
        'public.claim_auction_enrichment_jobs_family(text,integer)'::regprocedure
      )
    )
  ) > 0,
  'retention cleanup keeps the null-or-future deadline rule'
);

select ok(
  position(
    's.status in (''active'', ''unknown'', ''upcoming'', ''postponed'', ''past'')'
    in lower(
      pg_get_functiondef(
        'public.claim_auction_enrichment_jobs_family(text,integer)'::regprocedure
      )
    )
  ) > 0,
  'retention cleanup keeps the existing sale status eligibility set'
);

select ok(
  position('attempt_count < j.max_attempts' in lower(
    pg_get_functiondef(
      'public.claim_auction_enrichment_jobs_family(text,integer)'::regprocedure
    )
  )) > 0
  and position('attempt_count = j.attempt_count + 1' in lower(
    pg_get_functiondef(
      'public.claim_auction_enrichment_jobs_family(text,integer)'::regprocedure
    )
  )) > 0,
  'claim retry eligibility and attempt accounting remain bounded'
);

select ok(
  position(
    'claim_auction_enrichment_jobs_family(' in lower(
      pg_get_functiondef(
        'public.claim_auction_enrichment_jobs(integer)'::regprocedure
      )
    )
  ) > 0,
  'legacy callers still delegate to the final family claim'
);

select throws_ok(
  $$select * from public.claim_auction_enrichment_jobs_family('invalid', 1)$$,
  '22023',
  'Unknown enrichment queue family: invalid',
  'unknown queue families remain rejected before cleanup'
);

set local role service_role;

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
    'f3910000-0000-4000-8000-000000000001',
    'pgtap-retention-live',
    'https://example.test/pgtap/retention/live',
    'upcoming',
    statement_timestamp() + interval '7 days',
    '{}'::jsonb
  ),
  (
    'f3910000-0000-4000-8000-000000000002',
    'pgtap-retention-expired',
    'https://example.test/pgtap/retention/expired',
    'upcoming',
    '2000-01-01 12:00:00+00',
    '{}'::jsonb
  ),
  (
    'f3910000-0000-4000-8000-000000000003',
    'pgtap-retention-ineligible',
    'https://example.test/pgtap/retention/ineligible',
    'cancelled',
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
values
  (
    'https://example.test/pgtap/retention/live',
    'display_description',
    'queued',
    10000,
    'pgtap-retention-live-v1',
    statement_timestamp()
  ),
  (
    'https://example.test/pgtap/retention/expired',
    'display_description',
    'queued',
    10000,
    'pgtap-retention-expired-v1',
    statement_timestamp()
  ),
  (
    'https://example.test/pgtap/retention/ineligible',
    'display_description',
    'queued',
    10000,
    'pgtap-retention-ineligible-v1',
    statement_timestamp()
  );

select lives_ok(
  $$select count(*)
      from public.claim_auction_enrichment_jobs_family('enrichment', 100)$$,
  'claim cleanup and lease run with the optimized retention scan'
);

select is(
  (
    select status
      from public.auction_enrichment_jobs
     where input_hash = 'pgtap-retention-live-v1'
  ),
  'running',
  'a job attached to a live sale remains claimable'
);

select is(
  (
    select attempt_count
      from public.auction_enrichment_jobs
     where input_hash = 'pgtap-retention-live-v1'
  ),
  1,
  'a live sale claim consumes exactly one attempt'
);

select is(
  (
    select status
      from public.auction_enrichment_jobs
     where input_hash = 'pgtap-retention-expired-v1'
  ),
  'cancelled',
  'a job attached to an expired sale is cancelled before a network call'
);

select is(
  (
    select attempt_count
      from public.auction_enrichment_jobs
     where input_hash = 'pgtap-retention-expired-v1'
  ),
  0,
  'retention cancellation does not consume a retry'
);

select is(
  (
    select status
      from public.auction_enrichment_jobs
     where input_hash = 'pgtap-retention-ineligible-v1'
  ),
  'cancelled',
  'a job without an eligible live sale is cancelled before a network call'
);

select is(
  (
    select attempt_count
      from public.auction_enrichment_jobs
     where input_hash = 'pgtap-retention-ineligible-v1'
  ),
  0,
  'ineligible-sale cancellation does not consume a retry'
);

select is(
  (
    select last_error
      from public.auction_enrichment_jobs
     where input_hash = 'pgtap-retention-expired-v1'
  ),
  'Listing removed, expired or explicitly cancelled',
  'expired cleanup retains the existing audit reason'
);

select is(
  (
    select last_error
      from public.auction_enrichment_jobs
     where input_hash = 'pgtap-retention-ineligible-v1'
  ),
  'Listing removed, expired or explicitly cancelled',
  'ineligible cleanup retains the existing audit reason'
);

select * from finish();

rollback;
