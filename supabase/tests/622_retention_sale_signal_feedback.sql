-- Rétention des retours sur les signaux d'une vente (20261030110200) : 90 jours, purgés par
-- public.run_data_retention comme huitième partie isolée, les sept autres parties restant en place.
begin;

select plan(11);

-- Fixtures -------------------------------------------------------------------------------------
insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data
) values (
  'c6220000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated', 'retention-622@example.test', '', now(), now(), now(),
  '{}'::jsonb, '{}'::jsonb
);
insert into public.auction_sales (id, source_name, source_url, title, status, sale_date)
values
  ('c6220000-1000-4000-8000-000000000001', 'retention-622', 'https://example.test/r622/1',
   'Retention sale one', 'upcoming', '2099-01-01 12:00:00Z'),
  ('c6220000-1000-4000-8000-000000000002', 'retention-622', 'https://example.test/r622/2',
   'Retention sale two', 'upcoming', '2099-01-02 12:00:00Z'),
  ('c6220000-1000-4000-8000-000000000003', 'retention-622', 'https://example.test/r622/3',
   'Retention sale three', 'upcoming', '2099-01-03 12:00:00Z');

-- Trois retours : un de plus de 90 jours, un détaché de sa vente et ancien, un récent.
insert into public.sale_signal_feedback (user_id, sale_id, signal, value, reason, feedback_day, created_at)
values
  ('c6220000-0000-4000-8000-000000000001', 'c6220000-1000-4000-8000-000000000001',
   'market_gap_band', 'not_relevant', 'estimate_too_low', '2026-08-01', '2026-08-01T10:00:00Z'),
  ('c6220000-0000-4000-8000-000000000001', null,
   'points_to_verify', 'useful', null, '2026-08-02', '2026-08-02T10:00:00Z'),
  ('c6220000-0000-4000-8000-000000000001', 'c6220000-1000-4000-8000-000000000002',
   'points_to_verify', 'not_relevant', 'point_wrong', '2026-11-30', '2026-11-30T10:00:00Z');

-- La fonction ----------------------------------------------------------------------------------
select ok(
  not has_function_privilege('anon', 'app_private.purge_sale_signal_feedback(timestamptz)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'app_private.purge_sale_signal_feedback(timestamptz)', 'EXECUTE')
  and has_function_privilege('service_role', 'app_private.purge_sale_signal_feedback(timestamptz)', 'EXECUTE'),
  'the purge is closed to the browser roles'
);
select ok(
  (
    select p.prosecdef and p.proconfig @> array['search_path=""']::text[]
    from pg_proc p
    where p.oid = 'app_private.purge_sale_signal_feedback(timestamptz)'::regprocedure
  ),
  'the purge is security definer with an empty search_path'
);

-- run_data_retention : huit parties, la clé purge_errors, la frontière service seul ------------------------
select ok(
  (
    select p.prosecdef
      and p.proconfig @> array['search_path=""']::text[]
      and position('purge_expired_operational_data' in pg_get_functiondef(p.oid)) > 0
      and position('purge_information_agent_data' in pg_get_functiondef(p.oid)) > 0
      and position('purge_offer_opening_notifications' in pg_get_functiondef(p.oid)) > 0
      and position('purge_sale_unlocks' in pg_get_functiondef(p.oid)) > 0
      and position('purge_account_product_events' in pg_get_functiondef(p.oid)) > 0
      and position('purge_followed_sale_snapshots' in pg_get_functiondef(p.oid)) > 0
      and position('purge_sale_reminder_dispatches' in pg_get_functiondef(p.oid)) > 0
      and position('purge_sale_signal_feedback' in pg_get_functiondef(p.oid)) > 0
      and position('purge_errors' in pg_get_functiondef(p.oid)) > 0
    from pg_proc p
    where p.oid = 'public.run_data_retention(timestamptz)'::regprocedure
  ),
  'run_data_retention keeps its seven parts, adds the feedback purge and keeps purge_errors'
);
select ok(
  not has_function_privilege('anon', 'public.run_data_retention(timestamptz)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.run_data_retention(timestamptz)', 'EXECUTE')
  and has_function_privilege('service_role', 'public.run_data_retention(timestamptz)', 'EXECUTE'),
  'run_data_retention stays for the server (service role) only'
);

-- La purge ---------------------------------------------------------------------------------------------
set local role service_role;
select is(
  (public.run_data_retention('2026-12-01T00:00:00Z'::timestamptz) ->> 'sale_signal_feedback')::integer,
  2,
  'the retention report names the feedback purge and counts the two rows older than 90 days'
);
reset role;
select is(
  (select array_agg(reason order by reason) from public.sale_signal_feedback
    where user_id = 'c6220000-0000-4000-8000-000000000001'),
  array['point_wrong'],
  'the old feedback, detached or not, is purged and the recent one is kept'
);
set local role service_role;
select is(
  (select public.run_data_retention('2026-12-01T00:00:00Z'::timestamptz) ? 'purge_errors'),
  false,
  'a healthy run reports no purge error'
);
reset role;

-- Une partie qui échoue n'arrête pas les autres ---------------------------------------------------------------
create or replace function app_private.purge_sale_signal_feedback(
  p_now timestamptz default statement_timestamp()
)
returns jsonb
language plpgsql
as $$
begin
  raise exception 'forced failure of the feedback purge' using errcode = 'P0001';
end;
$$;
set local role service_role;
select is(
  public.run_data_retention('2026-12-01T00:00:00Z'::timestamptz) -> 'purge_errors',
  '{"purge_sale_signal_feedback": "P0001"}'::jsonb,
  'a failing feedback purge is reported under purge_errors with its SQLSTATE'
);
select ok(
  (public.run_data_retention('2026-12-01T00:00:00Z'::timestamptz)) ? 'account_product_events'
  and (public.run_data_retention('2026-12-01T00:00:00Z'::timestamptz)) ? 'sale_reminder_dispatches',
  'and the other purges still ran and reported'
);
reset role;

-- La vente à venir n'est pas touchée par la purge des retours ----------------------------------------------------
select is(
  (select count(*) from public.auction_sales where id = 'c6220000-1000-4000-8000-000000000003'),
  1::bigint,
  'the feedback purge touches no sale'
);
select is(
  (select count(*) from public.sale_signal_feedback
    where user_id = 'c6220000-0000-4000-8000-000000000001'),
  1::bigint,
  'the recent feedback is still there after the failing run'
);

select * from finish();
rollback;
