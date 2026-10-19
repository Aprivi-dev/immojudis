-- Mesure du parcours par compte (point 65) : table fermée aux rôles du navigateur (aucune lecture pour
-- anon ni authenticated), écriture par service_role seulement, liste d'événements fermée sans donnée
-- libre, un événement par compte, détail, vente et jour, conservation de 90 jours purgée par
-- public.run_data_retention, disparition avec le compte.
begin;

select plan(50);

-- Fixtures -------------------------------------------------------------------------------------
insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data
) values
  ('c5100000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'events-one@example.test', '', now(), now(), now(),
   '{}'::jsonb, '{}'::jsonb),
  ('c5100000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'events-two@example.test', '', now(), now(), now(),
   '{}'::jsonb, '{}'::jsonb);

insert into public.auction_sales (id, source_name, source_url, title, status, sale_date)
values
  ('c5100000-1000-4000-8000-000000000001', 'events-test',
   'https://example.test/events/1', 'Events sale one', 'upcoming', '2099-01-01 12:00:00Z'),
  ('c5100000-1000-4000-8000-000000000002', 'events-test',
   'https://example.test/events/2', 'Events sale two', 'upcoming', '2099-01-02 12:00:00Z');

-- Structure and privileges ----------------------------------------------------------------------
select has_table('public', 'account_product_events', 'the account events table exists');
select ok(
  (select relrowsecurity from pg_class where oid = 'public.account_product_events'::regclass),
  'row level security is enabled'
);
select is(
  (select count(*) from pg_policies
    where schemaname = 'public' and tablename = 'account_product_events'),
  0::bigint,
  'there is no policy at all: nothing is readable through row level security'
);
select ok(
  not has_table_privilege('anon', 'public.account_product_events', 'SELECT')
  and not has_table_privilege('anon', 'public.account_product_events', 'INSERT')
  and not has_table_privilege('anon', 'public.account_product_events', 'UPDATE')
  and not has_table_privilege('anon', 'public.account_product_events', 'DELETE'),
  'anon has no privilege on the table'
);
select ok(
  not has_table_privilege('authenticated', 'public.account_product_events', 'SELECT')
  and not has_table_privilege('authenticated', 'public.account_product_events', 'INSERT')
  and not has_table_privilege('authenticated', 'public.account_product_events', 'UPDATE')
  and not has_table_privilege('authenticated', 'public.account_product_events', 'DELETE'),
  'authenticated has no privilege on the table'
);
select ok(
  has_table_privilege('service_role', 'public.account_product_events', 'SELECT')
  and has_table_privilege('service_role', 'public.account_product_events', 'INSERT')
  and has_table_privilege('service_role', 'public.account_product_events', 'DELETE')
  and not has_table_privilege('service_role', 'public.account_product_events', 'UPDATE'),
  'service_role reads, writes and purges, and cannot edit a recorded event'
);
select is(
  (select array_agg(column_name::text order by ordinal_position)
     from information_schema.columns
    where table_schema = 'public' and table_name = 'account_product_events'),
  array['id', 'user_id', 'event_type', 'detail', 'sale_id', 'occurred_at'],
  'the table holds the account, the type, a closed detail, the sale and the time: no free column'
);
select ok(
  not has_function_privilege('anon', 'public.record_account_product_event(uuid,text,text,uuid)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.record_account_product_event(uuid,text,text,uuid)', 'EXECUTE')
  and has_function_privilege('service_role', 'public.record_account_product_event(uuid,text,text,uuid)', 'EXECUTE'),
  'the recording function is for the server (service role) only'
);
select is(
  (select not p.prosecdef and p.proconfig = array['search_path=""']
     from pg_proc p
    where p.oid = 'public.record_account_product_event(uuid,text,text,uuid)'::regprocedure),
  true,
  'the recording function is security invoker with an empty search_path'
);
select ok(
  not has_table_privilege('anon', 'app_private.account_product_events_measure', 'SELECT')
  and not has_table_privilege('authenticated', 'app_private.account_product_events_measure', 'SELECT'),
  'the measure start table is closed to the browser roles'
);
select is(
  (select count(*) from app_private.account_product_events_measure),
  1::bigint,
  'the measure start is a single row'
);

-- Browser roles: no read, no write ---------------------------------------------------------------
set local role anon;
select throws_ok(
  $$select count(*) from public.account_product_events$$,
  '42501', null, 'anon cannot read the events'
);
select throws_ok(
  $$insert into public.account_product_events (user_id, event_type) values ('c5100000-0000-4000-8000-000000000001', 'sale_unlocked')$$,
  '42501', null, 'anon cannot write an event'
);
select throws_ok(
  $$select public.record_account_product_event('c5100000-0000-4000-8000-000000000001', 'sale_unlocked')$$,
  '42501', null, 'anon cannot call the recording function'
);
reset role;

set local role authenticated;
set local "request.jwt.claims" = '{"sub":"c5100000-0000-4000-8000-000000000001","role":"authenticated"}';
select throws_ok(
  $$select count(*) from public.account_product_events$$,
  '42501', null, 'an account cannot read the events, not even its own'
);
select throws_ok(
  $$insert into public.account_product_events (user_id, event_type) values ('c5100000-0000-4000-8000-000000000001', 'sale_unlocked')$$,
  '42501', null, 'an account cannot forge an event'
);
select throws_ok(
  $$delete from public.account_product_events$$,
  '42501', null, 'an account cannot erase events'
);
select throws_ok(
  $$select public.record_account_product_event('c5100000-0000-4000-8000-000000000001', 'sale_unlocked')$$,
  '42501', null, 'an account cannot call the recording function'
);
reset role;

-- Recording: the server, the closed list, one event per day ----------------------------------------
set local role service_role;

select is(
  public.record_account_product_event(
    'c5100000-0000-4000-8000-000000000001', 'sale_unlocked', null,
    'c5100000-1000-4000-8000-000000000001'
  ),
  true,
  'the server records an unlock for an account and a sale'
);
select is(
  public.record_account_product_event(
    'c5100000-0000-4000-8000-000000000001', 'sale_unlocked', null,
    'c5100000-1000-4000-8000-000000000001'
  ),
  false,
  'the same event the same day is not recorded twice'
);
select is(
  public.record_account_product_event(
    'c5100000-0000-4000-8000-000000000001', 'sale_unlocked', null,
    'c5100000-1000-4000-8000-000000000002'
  ),
  true,
  'another sale is another event'
);
select is(
  public.record_account_product_event(
    'c5100000-0000-4000-8000-000000000002', 'sale_unlocked', null,
    'c5100000-1000-4000-8000-000000000001'
  ),
  true,
  'another account is another event'
);
select is(
  public.record_account_product_event('c5100000-0000-4000-8000-000000000001', 'quota_reached', 'unlocks'),
  true,
  'a quota reached is recorded with the quota, without any sale'
);
select is(
  public.record_account_product_event('c5100000-0000-4000-8000-000000000001', 'quota_reached', 'unlocks'),
  false,
  'a quota reached counts once a day per account and quota'
);
select is(
  public.record_account_product_event('c5100000-0000-4000-8000-000000000001', 'quota_reached', 'favorites'),
  true,
  'another quota is another event'
);
select is(
  public.record_account_product_event('c5100000-0000-4000-8000-000000000001', 'quota_reached', 'daily'),
  true,
  'the daily caps are a third quota'
);
select is(
  public.record_account_product_event(
    'c5100000-0000-4000-8000-000000000001', 'bid_ceiling_calculated', null,
    'c5100000-1000-4000-8000-000000000001'
  ),
  true,
  'a bid ceiling reference served is recorded'
);
select is(
  public.record_account_product_event(
    'c5100000-0000-4000-8000-000000000001', 'calendar_exported', null,
    'c5100000-1000-4000-8000-000000000001'
  ),
  true,
  'a calendar export is recorded'
);
select is(
  public.record_account_product_event(
    'c5100000-0000-4000-8000-000000000001', 'email_clicked', 'alert',
    'c5100000-1000-4000-8000-000000000001'
  ),
  true,
  'an alert email click is recorded'
);
select is(
  public.record_account_product_event(
    'c5100000-0000-4000-8000-000000000001', 'email_clicked', 'reminder',
    'c5100000-1000-4000-8000-000000000001'
  ),
  true,
  'a reminder email click is another event'
);
select is(
  (select count(*) from public.account_product_events
    where user_id = 'c5100000-0000-4000-8000-000000000001'),
  9::bigint,
  'the first account holds exactly its nine distinct events'
);

-- The list is closed: nothing outside it is accepted -----------------------------------------------
select throws_ok(
  $$select public.record_account_product_event('c5100000-0000-4000-8000-000000000001', 'page_viewed')$$,
  '23514', null, 'an unknown event type is refused'
);
select throws_ok(
  $$select public.record_account_product_event('c5100000-0000-4000-8000-000000000001', 'quota_reached')$$,
  '23514', null, 'a quota without its detail is refused'
);
select throws_ok(
  $$select public.record_account_product_event('c5100000-0000-4000-8000-000000000001', 'quota_reached', 'monthly')$$,
  '23514', null, 'a quota detail outside the list is refused'
);
select throws_ok(
  $$select public.record_account_product_event('c5100000-0000-4000-8000-000000000001', 'email_clicked', 'newsletter', 'c5100000-1000-4000-8000-000000000001')$$,
  '23514', null, 'an email kind outside the list is refused'
);
select throws_ok(
  $$select public.record_account_product_event('c5100000-0000-4000-8000-000000000001', 'sale_unlocked', 'free text')$$,
  '23514', null, 'a free detail on a sale event is refused'
);
select throws_ok(
  $$select public.record_account_product_event('c5100000-0000-4000-8000-000000000001', 'quota_reached', 'favorites', 'c5100000-1000-4000-8000-000000000001')$$,
  '23514', null, 'a quota reached does not designate a sale'
);
select throws_ok(
  $$select public.record_account_product_event(null, 'sale_unlocked')$$,
  '22004', null, 'no account, no event'
);
select throws_ok(
  $$select public.record_account_product_event('c5100000-0000-4000-8000-0000000000ff', 'sale_unlocked')$$,
  '23503', null, 'an unknown account is refused by the foreign key'
);

-- A new day is a new event ---------------------------------------------------------------------------
reset role;
update public.account_product_events
set occurred_at = occurred_at - interval '2 days'
where user_id = 'c5100000-0000-4000-8000-000000000001' and event_type = 'calendar_exported';
set local role service_role;
select is(
  public.record_account_product_event(
    'c5100000-0000-4000-8000-000000000001', 'calendar_exported', null,
    'c5100000-1000-4000-8000-000000000001'
  ),
  true,
  'the same export on another day is recorded again'
);
reset role;

-- Retention: 90 days, purged by the existing retention run -----------------------------------------------
insert into public.account_product_events (user_id, event_type, detail, sale_id, occurred_at)
values
  ('c5100000-0000-4000-8000-000000000002', 'email_clicked', 'alert',
   'c5100000-1000-4000-8000-000000000002', '2026-08-01T00:00:00Z'),
  ('c5100000-0000-4000-8000-000000000002', 'quota_reached', 'daily', null,
   '2026-09-01T00:00:00Z'),
  ('c5100000-0000-4000-8000-000000000002', 'bid_ceiling_calculated', null,
   'c5100000-1000-4000-8000-000000000002', '2026-11-30T00:00:00Z');

select ok(
  not has_function_privilege('anon', 'app_private.purge_account_product_events(timestamptz)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'app_private.purge_account_product_events(timestamptz)', 'EXECUTE')
  and has_function_privilege('service_role', 'app_private.purge_account_product_events(timestamptz)', 'EXECUTE'),
  'the purge is closed to the browser roles'
);
select ok(
  (
    select p.prosecdef
      and p.proconfig @> array['search_path=""']::text[]
      and position('purge_account_product_events' in pg_get_functiondef(p.oid)) > 0
      and position('purge_sale_unlocks' in pg_get_functiondef(p.oid)) > 0
      and position('purge_errors' in pg_get_functiondef(p.oid)) > 0
    from pg_proc p
    where p.oid = 'public.run_data_retention(timestamptz)'::regprocedure
  ),
  'run_data_retention runs the events purge next to the four others and keeps purge_errors'
);

set local role service_role;
select lives_ok(
  $$select public.run_data_retention('2026-12-01T00:00:00Z'::timestamptz)$$,
  'the scheduled retention run covers the account events'
);
reset role;

select is(
  (select count(*) from public.account_product_events
    where user_id = 'c5100000-0000-4000-8000-000000000002'
      and occurred_at in ('2026-08-01T00:00:00Z', '2026-09-01T00:00:00Z')),
  0::bigint,
  'events older than 90 days are purged'
);
select is(
  (select count(*) from public.account_product_events
    where user_id = 'c5100000-0000-4000-8000-000000000002'
      and occurred_at = '2026-11-30T00:00:00Z'),
  1::bigint,
  'a recent event is kept'
);
select is(
  public.run_data_retention('2026-12-01T00:00:00Z'::timestamptz) -> 'account_product_events',
  '0'::jsonb,
  'the retention report names the events purge (already done: nothing left to delete)'
);
select is(
  (select public.run_data_retention('2026-12-01T00:00:00Z'::timestamptz) ? 'purge_errors'),
  false,
  'a healthy run reports no purge error'
);

-- Boundary: exactly 90 days is kept, one second more is purged ----------------------------------------------
insert into public.account_product_events (user_id, event_type, detail, occurred_at)
values
  ('c5100000-0000-4000-8000-000000000002', 'quota_reached', 'unlocks', '2026-09-02T00:00:00Z'),
  ('c5100000-0000-4000-8000-000000000002', 'quota_reached', 'favorites', '2026-09-01T23:59:59Z');
select is(
  (select app_private.purge_account_product_events('2026-12-01T00:00:00Z'::timestamptz)),
  '{"account_product_events": 1}'::jsonb,
  'only the event older than 90 days is purged at the boundary'
);

-- The account and the sale: lifecycle ------------------------------------------------------------------------
-- Catalogue retention only deletes rows that already carry their Outcome Graph bridge.
do $$ begin perform public.bridge_auction_sales_to_outcome_graph(); end $$;
delete from public.auction_sales where id = 'c5100000-1000-4000-8000-000000000001';
select is(
  (select count(*) from public.account_product_events
    where user_id = 'c5100000-0000-4000-8000-000000000001' and event_type = 'sale_unlocked'
      and sale_id is null),
  1::bigint,
  'deleting a sale keeps the event and detaches it from the sale'
);
delete from auth.users where id = 'c5100000-0000-4000-8000-000000000001';
select is(
  (select count(*) from public.account_product_events
    where user_id = 'c5100000-0000-4000-8000-000000000001'),
  0::bigint,
  'deleting the account deletes its events'
);

select * from finish();
rollback;
