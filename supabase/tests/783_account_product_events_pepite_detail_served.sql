-- Mesure du parcours par compte : le détail de la pépite servi (migration 20261108180000).
--   * pepite_detail_served s'enregistre avec une vente et sans détail, une fois par jour ;
--   * avec un détail, ou sous un autre nom, la contrainte refuse ;
--   * les événements existants restent acceptés.
begin;

select plan(8);

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data
) values
  ('c7800000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'pepite-served-one@example.test', '', now(), now(), now(),
   '{}'::jsonb, '{}'::jsonb);

insert into public.auction_sales (id, source_name, source_url, title, status, sale_date)
values
  ('c7800000-1000-4000-8000-000000000001', 'pepite-served-test',
   'https://example.test/pepite-served/1', 'Pepite served sale one', 'upcoming', '2099-01-01 12:00:00Z');

select is(
  (select count(*) from pg_constraint
    where conrelid = 'public.account_product_events'::regclass
      and conname = 'account_product_events_type_detail_check'
      and convalidated
      and pg_get_constraintdef(oid) ~ 'pepite_detail_served'),
  1::bigint,
  'the validated constraint lists pepite_detail_served'
);

set local role service_role;

select is(
  public.record_account_product_event('c7800000-0000-4000-8000-000000000001', 'pepite_detail_served', null, 'c7800000-1000-4000-8000-000000000001'),
  true,
  'the served detail is recorded for the account and the sale'
);
select is(
  public.record_account_product_event('c7800000-0000-4000-8000-000000000001', 'pepite_detail_served', null, 'c7800000-1000-4000-8000-000000000001'),
  false,
  'it counts once a day per account and sale'
);
select throws_ok(
  $$select public.record_account_product_event('c7800000-0000-4000-8000-000000000001', 'pepite_detail_served', 'detail', 'c7800000-1000-4000-8000-000000000001')$$,
  '23514', null, 'a detail on the served event is refused'
);
select throws_ok(
  $$select public.record_account_product_event('c7800000-0000-4000-8000-000000000001', 'pepite_detail_viewed', null, 'c7800000-1000-4000-8000-000000000001')$$,
  '23514', null, 'an event outside the closed list is refused'
);
select is(
  public.record_account_product_event('c7800000-0000-4000-8000-000000000001', 'bid_ceiling_calculated', null, 'c7800000-1000-4000-8000-000000000001'),
  true,
  'the existing ceiling event is unchanged'
);
select is(
  public.record_account_product_event('c7800000-0000-4000-8000-000000000001', 'email_clicked', 'weekly', 'c7800000-1000-4000-8000-000000000001'),
  true,
  'the existing email click details are unchanged'
);

reset role;

select is(
  (select array_agg(event_type order by event_type) from public.account_product_events
    where user_id = 'c7800000-0000-4000-8000-000000000001'),
  array['bid_ceiling_calculated', 'email_clicked', 'pepite_detail_served'],
  'exactly the three accepted events are stored'
);

select * from finish();
rollback;
