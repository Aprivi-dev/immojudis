begin;

select plan(16);

select has_table('public', 'auction_surface_measurements', 'surface measurements are persisted');
select has_table('public', 'auction_surface_derivations', 'surface derivations are persisted');
select has_table('public', 'auction_enrichment_jobs', 'enrichment work has an independent queue');
select has_function(
  'public',
  'claim_auction_enrichment_jobs',
  array['integer'],
  'the worker can atomically claim enrichment jobs'
);

select ok(
  not has_table_privilege('anon', 'public.auction_surface_measurements', 'SELECT'),
  'anonymous users cannot read detailed measurements'
);
select ok(
  has_table_privilege('authenticated', 'public.auction_surface_measurements', 'SELECT'),
  'analysis subscribers can reach measurements subject to RLS'
);
select ok(
  not has_table_privilege('authenticated', 'public.auction_enrichment_jobs', 'SELECT'),
  'subscribers cannot inspect the internal worker queue'
);
select ok(
  has_table_privilege('service_role', 'public.auction_enrichment_jobs', 'SELECT')
  and has_table_privilege('service_role', 'public.auction_enrichment_jobs', 'UPDATE'),
  'the trusted worker can claim and update jobs'
);
select ok(
  has_function_privilege('service_role', 'public.claim_auction_enrichment_jobs(integer)', 'EXECUTE'),
  'the trusted worker can call the claim function'
);
select ok(
  not has_function_privilege('authenticated', 'public.claim_auction_enrichment_jobs(integer)', 'EXECUTE'),
  'subscribers cannot claim internal work'
);

set local role service_role;

select lives_ok(
  $$insert into public.auction_sales (
      source_name,
      source_url,
      status,
      content_hash,
      documents
    ) values (
      'surface-reasoning-test',
      'https://example.test/surface-reasoning-queue',
      'upcoming',
      'surface-reasoning-hash',
      '[]'::jsonb
    )$$,
  'inserting a sale queues non-document enrichment safely'
);

select is(
  (
    select count(*)::integer
    from public.auction_enrichment_jobs
    where source_url = 'https://example.test/surface-reasoning-queue'
  ),
  1,
  'fact extraction is queued once and includes the subsequent display synthesis'
);

update public.auction_sales
set documents = '[{"label":"PV descriptif","url":"https://example.test/pv.pdf"}]'::jsonb
where source_url = 'https://example.test/surface-reasoning-queue';

select is(
  (
    select count(*)::integer
    from public.auction_enrichment_jobs
    where source_url = 'https://example.test/surface-reasoning-queue'
      and job_type = 'pdf'
  ),
  1,
  'adding a document queues PDF extraction'
);

select is(
  (
    select job_type
    from public.claim_auction_enrichment_jobs(1)
  ),
  'pdf',
  'the highest-priority PDF work is claimed first'
);

select is(
  (
    select status
    from public.auction_enrichment_jobs
    where source_url = 'https://example.test/surface-reasoning-queue'
      and job_type = 'pdf'
  ),
  'running',
  'claiming marks a job running'
);

select is(
  (
    select attempt_count
    from public.auction_enrichment_jobs
    where source_url = 'https://example.test/surface-reasoning-queue'
      and job_type = 'pdf'
  ),
  1,
  'claiming increments the attempt counter'
);

select * from finish();

rollback;
