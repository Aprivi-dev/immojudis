begin;

select plan(7);

select has_function(
  'public',
  'enqueue_orphan_information_agent_portal_uploads',
  array['timestamptz', 'integer'],
  'portal upload cleanup is callable by the retention worker'
);
select ok(
  not has_function_privilege(
    'anon',
    'public.enqueue_orphan_information_agent_portal_uploads(timestamptz,integer)',
    'execute'
  ) and not has_function_privilege(
    'authenticated',
    'public.enqueue_orphan_information_agent_portal_uploads(timestamptz,integer)',
    'execute'
  ),
  'browser roles cannot enqueue Storage deletions'
);

set local role service_role;

insert into storage.objects(bucket_id, name, created_at) values
  (
    'information-agent-evidence',
    '37100000-0000-4000-8000-000000000001/portal/37100000-0000-4000-8000-000000000002/old.pdf',
    '2030-01-01 00:00:00+00'
  ),
  (
    'information-agent-evidence',
    '37100000-0000-4000-8000-000000000001/portal/37100000-0000-4000-8000-000000000003/fresh.pdf',
    '2030-01-01 01:00:00+00'
  ),
  (
    'information-agent-evidence',
    '37100000-0000-4000-8000-000000000001/email/nonportal.pdf',
    '2030-01-01 00:00:00+00'
  );

select is(
  public.enqueue_orphan_information_agent_portal_uploads('2030-01-02 00:00:00+00', 100),
  1,
  'only an expired portal object is enqueued'
);
select is(
  (select count(*) from public.sale_retention_storage_queue
   where object_path like '37100000-%/portal/%'),
  1::bigint,
  'the old portal object enters the durable Storage outbox'
);
select is(
  public.enqueue_orphan_information_agent_portal_uploads('2030-01-02 00:00:00+00', 100),
  0,
  'cleanup replay is idempotent'
);
select throws_ok(
  $$select public.enqueue_orphan_information_agent_portal_uploads(now(), 101)$$,
  '22023',
  'Portal upload cleanup requires a timestamp and batch size between 1 and 100.',
  'cleanup batch remains bounded'
);
select is(
  (select count(*) from public.sale_retention_storage_queue
   where object_path like '37100000-%/email/%'),
  0::bigint,
  'mail attachments are not touched by portal orphan cleanup'
);

select * from finish();
rollback;
