-- Mesure du parcours par compte : le plafond quotidien d'un compte se distingue de celui d'une adresse
-- ou du site entier (migration 20261029120100).
--   * la liste fermée des détails d'un quota atteint gagne daily_account et daily_shared, et garde
--     daily pour les lignes d'avant ;
--   * un détail hors liste, ou sur un autre type d'événement, reste refusé par la contrainte ;
--   * un événement par compte, détail et jour : les deux nouveaux détails comptent chacun leur fois.
begin;

select plan(14);

-- Fixtures -------------------------------------------------------------------------------------
insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data
) values
  ('c5460000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'daily-detail-one@example.test', '', now(), now(), now(),
   '{}'::jsonb, '{}'::jsonb);

insert into public.auction_sales (id, source_name, source_url, title, status, sale_date)
values
  ('c5460000-1000-4000-8000-000000000001', 'daily-detail-test',
   'https://example.test/daily-detail/1', 'Daily detail sale one', 'upcoming', '2099-01-01 12:00:00Z');

-- La contrainte ------------------------------------------------------------------------------------
select is(
  (select count(*) from pg_constraint
    where conrelid = 'public.account_product_events'::regclass
      and conname = 'account_product_events_type_detail_check'
      and convalidated),
  1::bigint,
  'the type and detail constraint exists and is validated'
);
select ok(
  (select pg_get_constraintdef(oid) ~ 'daily_account' and pg_get_constraintdef(oid) ~ 'daily_shared'
          and pg_get_constraintdef(oid) ~ '''daily'''
     from pg_constraint
    where conrelid = 'public.account_product_events'::regclass
      and conname = 'account_product_events_type_detail_check'),
  'the closed list holds the account cap, the shared cap and the former daily detail'
);
select ok(
  (select col_description('public.account_product_events'::regclass, attnum) ~ 'daily_account'
     from pg_attribute
    where attrelid = 'public.account_product_events'::regclass and attname = 'detail'),
  'the column comment documents the two details'
);

-- L'enregistrement -------------------------------------------------------------------------------------
set local role service_role;

select is(
  public.record_account_product_event('c5460000-0000-4000-8000-000000000001', 'quota_reached', 'daily_account'),
  true,
  'the daily cap of an account is recorded'
);
select is(
  public.record_account_product_event('c5460000-0000-4000-8000-000000000001', 'quota_reached', 'daily_account'),
  false,
  'it counts once a day per account'
);
select is(
  public.record_account_product_event('c5460000-0000-4000-8000-000000000001', 'quota_reached', 'daily_shared'),
  true,
  'the cap of an address or of the whole site is another event, the same day'
);
select is(
  public.record_account_product_event('c5460000-0000-4000-8000-000000000001', 'quota_reached', 'daily'),
  true,
  'the former undistinguished daily detail is still accepted'
);

-- Hors liste : refusé ----------------------------------------------------------------------------------
select throws_ok(
  $$select public.record_account_product_event('c5460000-0000-4000-8000-000000000001', 'quota_reached', 'daily_global')$$,
  '23514', null, 'a detail outside the closed list is refused'
);
select throws_ok(
  $$select public.record_account_product_event('c5460000-0000-4000-8000-000000000001', 'quota_reached', 'DAILY_ACCOUNT')$$,
  '23514', null, 'the list is case sensitive'
);
select throws_ok(
  $$select public.record_account_product_event('c5460000-0000-4000-8000-000000000001', 'quota_reached', null)$$,
  '23514', null, 'a quota reached without detail is refused'
);
select throws_ok(
  $$select public.record_account_product_event('c5460000-0000-4000-8000-000000000001', 'sale_unlocked', 'daily_account', 'c5460000-1000-4000-8000-000000000001')$$,
  '23514', null, 'a daily detail on an unlock is refused'
);
select throws_ok(
  $$select public.record_account_product_event('c5460000-0000-4000-8000-000000000001', 'email_clicked', 'daily_shared', 'c5460000-1000-4000-8000-000000000001')$$,
  '23514', null, 'a daily detail on an email click is refused'
);
select throws_ok(
  $$select public.record_account_product_event('c5460000-0000-4000-8000-000000000001', 'quota_reached', 'daily_account', 'c5460000-1000-4000-8000-000000000001')$$,
  '23514', null, 'a quota still designates no sale'
);

reset role;

select is(
  (select array_agg(detail order by detail) from public.account_product_events
    where user_id = 'c5460000-0000-4000-8000-000000000001' and event_type = 'quota_reached'),
  array['daily', 'daily_account', 'daily_shared'],
  'exactly the three recorded details are stored'
);

select * from finish();
rollback;
