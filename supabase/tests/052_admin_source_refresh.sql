begin;

select plan(13);

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
  not has_function_privilege(
    'authenticated',
    'public.enqueue_due_source_details(timestamptz,integer)',
    'EXECUTE'
  ),
  'authenticated callers cannot invoke the recurring source-detail admission'
);

select ok(
  not has_function_privilege(
    'anon',
    'public.enqueue_due_source_details(timestamptz,integer)',
    'EXECUTE'
  ),
  'anonymous callers cannot invoke the recurring source-detail admission'
);

select ok(
  to_regprocedure(
    'public.enqueue_due_source_details_unlocked(timestamptz,integer)'
  ) is not null,
  'the recurring source-detail implementation exists under the internal name'
);

select ok(
  has_function_privilege(
    'service_role',
    'public.enqueue_due_source_details_unlocked(timestamptz,integer)',
    'EXECUTE'
  ),
  'service role can invoke the internal recurring source-detail implementation'
);

select ok(
  not has_function_privilege(
    'authenticated',
    'public.enqueue_due_source_details_unlocked(timestamptz,integer)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'anon',
    'public.enqueue_due_source_details_unlocked(timestamptz,integer)',
    'EXECUTE'
  ),
  'untrusted callers cannot invoke the internal recurring source-detail implementation'
);

select ok(
  (
    select public_function.oid <> internal_function.oid
    from pg_catalog.pg_proc public_function
    join pg_catalog.pg_proc internal_function
      on internal_function.oid =
        'public.enqueue_due_source_details_unlocked(timestamptz,integer)'::regprocedure
    where public_function.oid =
      'public.enqueue_due_source_details(timestamptz,integer)'::regprocedure
  ),
  'public and internal recurring source-detail entry points have distinct function identities'
);

select lives_ok(
  $oid_check$
  do $oid_body$
  declare
    before_oid oid;
    after_oid oid;
  begin
    before_oid :=
      ('public.enqueue_due_source_details(timestamptz,integer)'::regprocedure)::oid;
    execute pg_catalog.pg_get_functiondef(
      'public.enqueue_due_source_details(timestamptz,integer)'::regprocedure
    );
    after_oid :=
      ('public.enqueue_due_source_details(timestamptz,integer)'::regprocedure)::oid;
    if after_oid is distinct from before_oid then
      raise exception
        'public recurring source-detail entry point changed OID during replacement (before %, after %)',
        before_oid,
        after_oid;
    end if;
  end;
  $oid_body$;
  $oid_check$,
  'public recurring source-detail entry point keeps its OID when replaced in place'
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
