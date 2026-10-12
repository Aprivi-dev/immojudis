begin;
select plan(5);

select has_function('public', 'get_public_sale_details', array['uuid'], 'public sale details RPC exists');

select ok(
  has_function_privilege('anon', 'public.get_public_sale_details(uuid)', 'execute'),
  'signed-out visitors may read the public sale details'
);

select ok(
  (select prosecdef from pg_proc where oid = 'app_private.get_public_sale_details(uuid)'::regprocedure),
  'details are read through a security definer function'
);

select is(
  (select pg_get_functiondef('app_private.get_public_sale_details(uuid)'::regprocedure) ~ 's\.(address|latitude|longitude|lawyer_contact|documents)\b'),
  false,
  'address, coordinates, contacts and documents stay out of the public details'
);

select is(
  (select pg_get_functiondef('app_private.get_public_sale_details(uuid)'::regprocedure) ~ 'select[^;]*s\.visit_dates,'),
  false,
  'visit announcements (which may name the address) are reduced to a boolean'
);

select * from finish();
rollback;
