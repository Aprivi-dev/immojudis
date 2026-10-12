begin;

select plan(4);

select is(
  (select public from storage.buckets where id = 'information-agent-approved'),
  false,
  'the approved evidence bucket is private'
);

select is(
  (select count(*)::integer from pg_trigger where tgname = 'information_agent_fact_redaction_guard' and not tgisinternal),
  1,
  'the redaction guard trigger exists'
);

select ok(
  not has_function_privilege(
    'authenticated', 'app_private.guard_information_agent_redaction_verified()', 'execute'
  ),
  'the redaction guard function is not callable by the browser roles'
);

select is(
  (
    select p.proconfig @> array['search_path=""']
    from pg_proc p
    where p.oid = 'app_private.guard_information_agent_redaction_verified()'::regprocedure
  ),
  true,
  'the redaction guard runs with an empty search_path'
);

select * from finish();
rollback;
