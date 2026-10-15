begin;
select plan(7);

select has_function('public', 'get_public_sale_calendar_event', array['uuid'], 'calendar event RPC exists');

select ok(
  has_function_privilege('anon', 'public.get_public_sale_calendar_event(uuid)', 'execute'),
  'signed-out visitors may ask for the calendar file of a public sale'
);

select ok(
  (select prosecdef from pg_proc where oid = 'app_private.get_public_sale_calendar_event(uuid)'::regprocedure),
  'the event is read through a security definer function'
);

select is(
  (select pg_get_functiondef('app_private.get_public_sale_calendar_event(uuid)'::regprocedure) ~ 's\.(address|latitude|longitude|lawyer_contact|documents|visit_dates)\b'),
  false,
  'address, coordinates, contacts, documents and visit text stay out of the calendar event'
);

select is(
  (select pg_get_functiondef('app_private.get_public_sale_calendar_event(uuid)'::regprocedure) ~ 's\.status = ''upcoming'''),
  true,
  'only an upcoming sale can be exported (a postponed sale keeps its old date)'
);

select is(
  (select pg_get_functiondef('app_private.get_public_sale_calendar_event(uuid)'::regprocedure) ~ 'sale_date_unverified'),
  true,
  'a date rejected as unverified is never exported'
);

select is(
  (select count(*) from public.get_public_sale_calendar_event('00000000-0000-0000-0000-000000000000')),
  0::bigint,
  'an unknown sale returns no row'
);

select * from finish();
rollback;
