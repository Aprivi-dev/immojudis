-- 14/11/2026 (D12) : une tâche « running » dont le bail de 30 minutes a expiré est reprise par la revendication,
-- avec une tentative de plus, et passe en échec à sa dernière tentative au lieu de tourner sans fin
-- (public.claim_auction_enrichment_jobs_family, définition de 20260929220000 et ses correctifs). Preuve de
-- comportement ; les tests 399 et 410 ne vérifient que le texte de ces conditions.
begin;

select plan(5);

set local role service_role;

-- Rollback-only fixture: isolate the queue.
delete from public.auction_enrichment_jobs;

insert into public.auction_sales (source_name, source_url, status, sale_date, raw_payload)
values
  ('pgtap-898-origin', 'https://example.test/pgtap/898/stuck', 'upcoming', statement_timestamp() + interval '7 days',
   '{}'::jsonb),
  ('pgtap-898-origin', 'https://example.test/pgtap/898/spent', 'upcoming', statement_timestamp() + interval '7 days',
   '{}'::jsonb);

-- Sale triggers can create ordinary revisions; remove that side effect.
delete from public.auction_enrichment_jobs;

insert into public.auction_enrichment_jobs (
  source_url, job_type, status, priority, input_hash, attempt_count, max_attempts,
  next_attempt_at, locked_at, created_at, updated_at
)
values
  -- A worker died three days ago during the first attempt.
  ('https://example.test/pgtap/898/stuck', 'pdf', 'running', 10, 'pgtap-898-stuck', 1, 4,
   statement_timestamp() - interval '3 days 1 minute', statement_timestamp() - interval '3 days',
   statement_timestamp() - interval '3 days 1 minute', statement_timestamp() - interval '3 days'),
  -- Same, during its last allowed attempt.
  ('https://example.test/pgtap/898/spent', 'pdf', 'running', 10, 'pgtap-898-spent', 4, 4,
   statement_timestamp() - interval '3 days 1 minute', statement_timestamp() - interval '3 days',
   statement_timestamp() - interval '3 days 1 minute', statement_timestamp() - interval '3 days');

select is(
  (select count(*) from public.claim_auction_enrichment_jobs_family('enrichment', 5)),
  1::bigint,
  'one expired lease is claimed again: the job with attempts left'
);

select ok(
  (
    select status = 'running'
       and attempt_count = 2
       and locked_at >= statement_timestamp() - interval '5 minutes'
      from public.auction_enrichment_jobs
     where input_hash = 'pgtap-898-stuck'
  ),
  'a running job whose lease expired is taken again and counts one more attempt'
);

select ok(
  (
    select status = 'failed'
       and attempt_count = 4
       and locked_at is null
       and last_error = 'Worker lease expired and retry budget exhausted'
      from public.auction_enrichment_jobs
     where input_hash = 'pgtap-898-spent'
  ),
  'at its last attempt, an expired lease fails instead of being claimed again'
);

select is(
  (select count(*) from public.claim_auction_enrichment_jobs_family('enrichment', 5)),
  0::bigint,
  'the fresh lease of the reclaimed job is not claimed twice'
);

select is(
  (select count(*) from public.claim_auction_enrichment_jobs_family('all', 5)),
  0::bigint,
  'the failed job stays out of every lane'
);

select * from finish();

rollback;
