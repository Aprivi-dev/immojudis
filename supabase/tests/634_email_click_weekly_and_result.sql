-- 20261030120400 : les liens suivis du récapitulatif hebdomadaire (weekly) et de l'alerte de résultat
-- (result) rejoignent la liste fermée des détails d'un clic d'email, sans rien ouvrir d'autre.
begin;

select plan(10);

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data
) values (
  '63400000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated', 'click-634@example.test', '', now(), now(), now(),
  '{}'::jsonb, '{}'::jsonb
);

insert into public.auction_sales (id, source_name, source_url, title, status, sale_date)
values ('63400000-1000-4000-8000-000000000001', 'click-634', 'https://example.test/click634/1',
        'Click kinds sale', 'upcoming', '2099-01-01 12:00:00Z');

select is(
  (select count(*) from pg_constraint
    where conrelid = 'public.account_product_events'::regclass
      and conname = 'account_product_events_type_detail_check'
      and convalidated),
  1::bigint,
  'the type and detail constraint exists and is validated'
);

select ok(
  (select pg_get_constraintdef(oid) ~ 'weekly' and pg_get_constraintdef(oid) ~ 'result'
          and pg_get_constraintdef(oid) ~ 'reminder' and pg_get_constraintdef(oid) ~ 'daily_account'
     from pg_constraint
    where conrelid = 'public.account_product_events'::regclass
      and conname = 'account_product_events_type_detail_check'),
  'the closed list holds the two new click kinds and keeps the former ones'
);

set local role service_role;

select is(
  public.record_account_product_event(
    '63400000-0000-4000-8000-000000000001', 'email_clicked', 'weekly', '63400000-1000-4000-8000-000000000001'
  ),
  true,
  'a click on the weekly digest is recorded'
);
select is(
  public.record_account_product_event(
    '63400000-0000-4000-8000-000000000001', 'email_clicked', 'result', '63400000-1000-4000-8000-000000000001'
  ),
  true,
  'a click on the sale result alert is recorded'
);
select is(
  public.record_account_product_event(
    '63400000-0000-4000-8000-000000000001', 'email_clicked', 'weekly', '63400000-1000-4000-8000-000000000001'
  ),
  false,
  'it counts once a day per account, kind and sale'
);
select is(
  public.record_account_product_event(
    '63400000-0000-4000-8000-000000000001', 'email_clicked', 'alert', '63400000-1000-4000-8000-000000000001'
  ),
  true,
  'the former alert kind still works'
);

select throws_ok(
  $$select public.record_account_product_event('63400000-0000-4000-8000-000000000001', 'email_clicked', 'newsletter', '63400000-1000-4000-8000-000000000001')$$,
  '23514', null, 'a kind outside the closed list is still refused'
);
select throws_ok(
  $$select public.record_account_product_event('63400000-0000-4000-8000-000000000001', 'email_clicked', 'WEEKLY', '63400000-1000-4000-8000-000000000001')$$,
  '23514', null, 'the list is case sensitive'
);
select throws_ok(
  $$select public.record_account_product_event('63400000-0000-4000-8000-000000000001', 'quota_reached', 'weekly')$$,
  '23514', null, 'a click kind on a quota event is refused'
);

reset role;

select is(
  (select array_agg(detail order by detail) from public.account_product_events
    where user_id = '63400000-0000-4000-8000-000000000001' and event_type = 'email_clicked'),
  array['alert', 'result', 'weekly'],
  'exactly the three recorded click kinds are stored'
);

select * from finish();
rollback;
