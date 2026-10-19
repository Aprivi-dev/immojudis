-- Actualisations de données à la demande : plafond global de 150 demandes créées sur 24 heures,
-- en plus des plafonds par compte (3 en cours, 6 par 24 h) et de la contre-pression (12 en cours).
-- Message DATA_REFRESH_GLOBAL_DAILY_LIMIT ; une demande réutilisée ne compte pas ; les plafonds par
-- compte passent avant ; les demandes de plus de 24 heures sortent du compte.
begin;

select plan(12);

-- Fixtures -------------------------------------------------------------------------------------
insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data
) values
  ('c5060000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'refresh-a@example.test', '', now(), now(), now(),
   '{}'::jsonb, '{}'::jsonb),
  ('c5060000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'refresh-b@example.test', '', now(), now(), now(),
   '{}'::jsonb, '{}'::jsonb);

insert into public.user_subscriptions (user_id, plan_code, status)
values
  ('c5060000-0000-4000-8000-000000000001', 'analyse', 'active'),
  ('c5060000-0000-4000-8000-000000000002', 'analyse', 'active');

insert into public.auction_sales (id, source_name, source_url, title)
values (
  'c5060000-1000-4000-8000-000000000001',
  'refresh-limit-test', 'https://example.test/refresh-limit/sale-1', 'Refresh limit sale'
);

-- 149 demandes déjà terminées dans les dernières 24 heures, créées par le compte B : le compte A
-- n'a aucune demande, il ne peut être arrêté que par le plafond global.
insert into public.data_refresh_requests (user_id, sale_id, source_url, request_kind, status)
select
  'c5060000-0000-4000-8000-000000000002',
  'c5060000-1000-4000-8000-000000000001',
  'https://example.test/refresh-limit/sale-1',
  'full',
  'completed'
from generate_series(1, 149);

-- Structure et droits ----------------------------------------------------------------------------
select is(
  (select p.prosecdef and p.proconfig = array['search_path=""']
   from pg_proc p
   where p.oid = 'public.enqueue_data_refresh_bounded(uuid,uuid,text,boolean)'::regprocedure),
  true,
  'the admission function stays security definer with an empty search_path'
);
select ok(
  not has_function_privilege(
    'authenticated', 'public.enqueue_data_refresh_bounded(uuid,uuid,text,boolean)', 'EXECUTE'
  )
  and not has_function_privilege(
    'anon', 'public.enqueue_data_refresh_bounded(uuid,uuid,text,boolean)', 'EXECUTE'
  )
  and has_function_privilege(
    'service_role', 'public.enqueue_data_refresh_bounded(uuid,uuid,text,boolean)', 'EXECUTE'
  ),
  'only the service role can call the admission function'
);
select has_index(
  'public', 'data_refresh_requests', 'data_refresh_requests_created_idx',
  'the 24-hour global count has its index'
);
select is(
  (select count(*) from public.data_refresh_requests
   where created_at >= statement_timestamp() - interval '24 hours'),
  149::bigint,
  'the fixtures hold 149 requests created in the last 24 hours'
);

-- Le plafond global ------------------------------------------------------------------------------
set local role service_role;

select is(
  (select reused from public.enqueue_data_refresh_bounded(
    'c5060000-0000-4000-8000-000000000001',
    'c5060000-1000-4000-8000-000000000001',
    'cadastre',
    false
  )),
  false,
  'the 150th request of the day is admitted'
);

select throws_ok(
  $$select * from public.enqueue_data_refresh_bounded(
      'c5060000-0000-4000-8000-000000000001',
      'c5060000-1000-4000-8000-000000000001',
      'dpe',
      false
    )$$,
  'P0001',
  'DATA_REFRESH_GLOBAL_DAILY_LIMIT',
  'the 151st request of the day is refused, whoever asks'
);

select is(
  (select reused from public.enqueue_data_refresh_bounded(
    'c5060000-0000-4000-8000-000000000001',
    'c5060000-1000-4000-8000-000000000001',
    'cadastre',
    false
  )),
  true,
  'an identical active request is still reused at the cap (it creates nothing)'
);

select throws_ok(
  $$select * from public.enqueue_data_refresh_bounded(
      'c5060000-0000-4000-8000-000000000002',
      'c5060000-1000-4000-8000-000000000001',
      'cadastre',
      false
    )$$,
  'P0001',
  'DATA_REFRESH_USER_DAILY_LIMIT',
  'the per-account limits come first: an account over its own quota gets its own message'
);

select is(
  (select count(*) from public.data_refresh_requests
   where created_at >= statement_timestamp() - interval '24 hours'),
  150::bigint,
  'the refused calls created nothing: the day holds exactly 150 requests'
);

-- Les demandes de plus de 24 heures sortent du compte ---------------------------------------------
reset role;
update public.data_refresh_requests
set created_at = statement_timestamp() - interval '25 hours'
where id in (
  select id from public.data_refresh_requests
  where user_id = 'c5060000-0000-4000-8000-000000000002'
  limit 5
);
set local role service_role;

select is(
  (select reused from public.enqueue_data_refresh_bounded(
    'c5060000-0000-4000-8000-000000000001',
    'c5060000-1000-4000-8000-000000000001',
    'dpe',
    false
  )),
  false,
  'requests older than 24 hours leave the count: the account can ask again'
);

reset role;
select is(
  (select count(*) from public.data_refresh_requests
   where created_at >= statement_timestamp() - interval '24 hours'),
  146::bigint,
  'the sliding window now holds 146 requests (150 - 5 aged out + 1 new)'
);

select is(
  (select count(*) from public.data_refresh_requests
   where user_id = 'c5060000-0000-4000-8000-000000000001'),
  2::bigint,
  'the account created two requests in total (cadastre, then dpe)'
);

select * from finish();
rollback;
