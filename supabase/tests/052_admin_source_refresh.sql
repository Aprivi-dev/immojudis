begin;

select plan(6);

select ok(
  not has_function_privilege(
    'authenticated',
    'public.enqueue_admin_source_detail_bounded(uuid,uuid,boolean)',
    'EXECUTE'
  ),
  'authenticated callers cannot invoke the admin source refresh admission'
);

select ok(
  not has_function_privilege(
    'anon',
    'public.enqueue_admin_source_detail_bounded(uuid,uuid,boolean)',
    'EXECUTE'
  ),
  'anonymous callers cannot invoke the admin source refresh admission'
);

select ok(
  has_function_privilege(
    'service_role',
    'public.enqueue_admin_source_detail_bounded(uuid,uuid,boolean)',
    'EXECUTE'
  ),
  'service role can invoke the bounded admin source refresh admission'
);

select ok(
  not has_table_privilege('authenticated', 'public.auction_enrichment_jobs', 'INSERT'),
  'admin source refresh does not reopen direct enrichment queue inserts'
);

select ok(
  has_function_privilege(
    'service_role',
    'public.enqueue_due_source_details(timestamptz,integer)',
    'EXECUTE'
  ),
  'service role can invoke the serialized recurring source-detail admission'
);

select ok(
  position(
    'source-detail:global' in
      pg_get_functiondef(
        'public.enqueue_due_source_details(timestamptz,integer)'::regprocedure
      )
  ) > 0,
  'recurring source-detail admission uses the shared global lock'
);

select * from finish();
rollback;
