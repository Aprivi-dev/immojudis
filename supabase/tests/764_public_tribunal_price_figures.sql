begin;
select plan(6);

select has_function('public', 'get_public_tribunal_price_figures', 'public tribunal price figures RPC exists');

select ok(
  has_function_privilege('anon', 'public.get_public_tribunal_price_figures()', 'execute'),
  'signed-out visitors may read the public tribunal price figures'
);

select is(
  (select pg_get_functiondef('app_private.get_public_tribunal_price_figures()'::regprocedure) ~ 'adjudication'),
  false,
  'adjudication prices and results stay out of the public price figures'
);

select ok(
  (select pg_get_functiondef('app_private.get_public_tribunal_price_figures()'::regprocedure) ~ 'not s\.catalogue_quarantined'),
  'quarantined sales are not counted'
);

select ok(
  (select pg_get_functiondef('app_private.get_public_tribunal_price_figures()'::regprocedure)
    ~ 'count\(\*\) >= 5 and count\(\*\) < 10'),
  'the min-max range is published from 5 to 9 priced sales only'
);

select ok(
  (select pg_get_functiondef('app_private.get_public_tribunal_price_figures()'::regprocedure)
    ~ 'count\(\*\) >= 10'),
  'the median is published from 10 priced sales'
);

select * from finish();
rollback;
