begin;
select plan(4);

select has_function('public', 'get_public_tribunal_activity', 'public tribunal activity RPC exists');

select ok(
  has_function_privilege('anon', 'public.get_public_tribunal_activity()', 'execute'),
  'signed-out visitors may read the public tribunal activity'
);

select is(
  (select pg_get_functiondef('app_private.get_public_tribunal_activity()'::regprocedure) ~ 'adjudication'),
  false,
  'adjudication prices and results stay out of the public activity'
);

-- Since 20261020110045 the quarantine is read from the materialized column
-- (synchronised by trigger) instead of raw_payload->>'publication_quarantine'.
select ok(
  (select pg_get_functiondef('app_private.get_public_tribunal_activity()'::regprocedure) ~ 'not s\.catalogue_quarantined'),
  'quarantined sales are not counted'
);

select * from finish();
rollback;
