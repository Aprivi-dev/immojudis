-- calendar_exported (20261029100300) : au plus 50 exports d'agenda par compte et par jour UTC, comptés par
-- record_account_product_event ; les autres comptes, les autres types d'événement et les jours passés ne
-- sont pas touchés ; une vente reste requise pour un événement de vente.
begin;

select plan(11);

-- Fixtures -------------------------------------------------------------------------------------
insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data
) values
  ('c5330000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'cap-one@example.test', '', now(), now(), now(),
   '{}'::jsonb, '{}'::jsonb),
  ('c5330000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'cap-two@example.test', '', now(), now(), now(),
   '{}'::jsonb, '{}'::jsonb),
  ('c5330000-0000-4000-8000-000000000003', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'cap-three@example.test', '', now(), now(), now(),
   '{}'::jsonb, '{}'::jsonb);

-- 52 ventes à venir.
insert into public.auction_sales (id, source_name, source_url, title, status, sale_date)
select
  ('c5330000-1000-4000-8000-' || lpad(g::text, 12, '0'))::uuid,
  'cap-test', 'https://example.test/cap/' || g, 'Cap sale ' || g, 'upcoming',
  '2099-01-01 12:00:00Z'::timestamptz + g * interval '1 hour'
from generate_series(1, 52) as g;

select ok(
  to_regclass('public.account_product_events_user_type_time_idx') is not null,
  'the count is served by an index on (account, type, time)'
);

-- Plafond --------------------------------------------------------------------------------------
set local role service_role;
select lives_ok(
  $sql$do $loop$
    begin
      for i in 1..50 loop
        if not public.record_account_product_event(
          'c5330000-0000-4000-8000-000000000001', 'calendar_exported', null,
          ('c5330000-1000-4000-8000-' || lpad(i::text, 12, '0'))::uuid
        ) then
          raise exception 'export % was not recorded', i;
        end if;
      end loop;
    end
  $loop$$sql$,
  'an account records its first 50 exports of the day'
);
select is(
  public.record_account_product_event(
    'c5330000-0000-4000-8000-000000000001', 'calendar_exported', null,
    'c5330000-1000-4000-8000-000000000051'
  ),
  false,
  'the 51st export of the day is not recorded'
);
select is(
  public.record_account_product_event(
    'c5330000-0000-4000-8000-000000000001', 'calendar_exported', null,
    'c5330000-1000-4000-8000-000000000052'
  ),
  false,
  'nor is the 52nd'
);
select is(
  public.record_account_product_event(
    'c5330000-0000-4000-8000-000000000001', 'calendar_exported', null,
    'c5330000-1000-4000-8000-000000000001'
  ),
  false,
  'an export already recorded today still answers false'
);
select is(
  public.record_account_product_event(
    'c5330000-0000-4000-8000-000000000001', 'sale_unlocked', null,
    'c5330000-1000-4000-8000-000000000051'
  ),
  true,
  'the cap concerns the calendar exports only: another event type is recorded'
);
select is(
  public.record_account_product_event(
    'c5330000-0000-4000-8000-000000000002', 'calendar_exported', null,
    'c5330000-1000-4000-8000-000000000051'
  ),
  true,
  'another account is not affected'
);
reset role;

select is(
  (select count(*) from public.account_product_events
    where user_id = 'c5330000-0000-4000-8000-000000000001' and event_type = 'calendar_exported'),
  50::bigint,
  'the account holds exactly 50 exports'
);

-- Les jours passés ne comptent pas -----------------------------------------------------------------------
insert into public.account_product_events (user_id, event_type, sale_id, occurred_at)
select
  'c5330000-0000-4000-8000-000000000003', 'calendar_exported',
  ('c5330000-1000-4000-8000-' || lpad(g::text, 12, '0'))::uuid,
  now() - interval '2 days'
from generate_series(1, 50) as g;

set local role service_role;
select is(
  public.record_account_product_event(
    'c5330000-0000-4000-8000-000000000003', 'calendar_exported', null,
    'c5330000-1000-4000-8000-000000000051'
  ),
  true,
  'exports of the previous days do not count against today'
);

-- Les règles précédentes restent --------------------------------------------------------------------------
select throws_ok(
  $$select public.record_account_product_event('c5330000-0000-4000-8000-000000000002', 'calendar_exported')$$,
  '23514', null, 'an export without a sale is still refused'
);
select is(
  public.record_account_product_event('c5330000-0000-4000-8000-000000000002', 'quota_reached', 'daily'),
  true,
  'a quota reached is still recorded without a sale'
);
reset role;

select * from finish();
rollback;
