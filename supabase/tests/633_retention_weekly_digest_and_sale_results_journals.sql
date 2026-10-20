-- 20261030120300 : les journaux du récapitulatif hebdomadaire et des alertes de résultat sont purgés par
-- public.run_data_retention, chacun comme partie isolée, sans retirer aucune des autres purges.
begin;

select plan(10);

select ok(
  position('purge_weekly_digest_dispatches' in pg_get_functiondef('public.run_data_retention(timestamptz)'::regprocedure)) > 0
  and position('purge_sale_result_dispatches' in pg_get_functiondef('public.run_data_retention(timestamptz)'::regprocedure)) > 0,
  'run_data_retention runs the two new journal purges'
);

select ok(
  position('purge_sale_reminder_dispatches' in pg_get_functiondef('public.run_data_retention(timestamptz)'::regprocedure)) > 0
  and position('purge_followed_sale_snapshots' in pg_get_functiondef('public.run_data_retention(timestamptz)'::regprocedure)) > 0
  and position('purge_account_product_events' in pg_get_functiondef('public.run_data_retention(timestamptz)'::regprocedure)) > 0
  and position('purge_sale_unlocks' in pg_get_functiondef('public.run_data_retention(timestamptz)'::regprocedure)) > 0
  and position('purge_offer_opening_notifications' in pg_get_functiondef('public.run_data_retention(timestamptz)'::regprocedure)) > 0
  and position('purge_information_agent_data' in pg_get_functiondef('public.run_data_retention(timestamptz)'::regprocedure)) > 0
  and position('purge_expired_operational_data' in pg_get_functiondef('public.run_data_retention(timestamptz)'::regprocedure)) > 0
  and position('purge_sale_signal_feedback' in pg_get_functiondef('public.run_data_retention(timestamptz)'::regprocedure)) > 0
  and position('purge_errors' in pg_get_functiondef('public.run_data_retention(timestamptz)'::regprocedure)) > 0,
  'it keeps its eight other purges and purge_errors'
);

select ok(
  (
    select procedure_row.prosecdef
      and procedure_row.proconfig @> array['search_path=""']::text[]
      and has_function_privilege('service_role', procedure_row.oid, 'execute')
      and not has_function_privilege('anon', procedure_row.oid, 'execute')
      and not has_function_privilege('authenticated', procedure_row.oid, 'execute')
    from pg_proc procedure_row
    where procedure_row.oid = 'public.run_data_retention(timestamptz)'::regprocedure
  ),
  'run_data_retention stays security definer, search_path empty and service-only'
);

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data
) values (
  '63300000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated', 'retention-633@example.test', '', now(), now(), now(),
  '{}'::jsonb, '{}'::jsonb
);

insert into public.weekly_digest_dispatches (user_id, week_key, mode, status, created_at)
values
  ('63300000-0000-4000-8000-000000000001', '2026-W10', 'on', 'sent', now() - interval '200 days'),
  ('63300000-0000-4000-8000-000000000001', '2026-W44', 'on', 'sent', now() - interval '2 days');
insert into public.sale_result_dispatches (user_id, sale_id, result_kind, mode, status, created_at)
values
  ('63300000-0000-4000-8000-000000000001', '63300000-1000-4000-8000-000000000001',
   'result_known', 'on', 'sent', now() - interval '200 days'),
  ('63300000-0000-4000-8000-000000000001', '63300000-1000-4000-8000-000000000002',
   'result_known', 'on', 'sent', now() - interval '2 days');

set local role service_role;

select is(
  (public.run_data_retention('2026-12-01T00:00:00Z'::timestamptz) ->> 'weekly_digest_dispatches')::integer,
  1,
  'the retention report names the weekly digest journal purge and counts the row older than 180 days'
);

reset role;

select is(
  (select array_agg(week_key order by week_key) from public.weekly_digest_dispatches
    where user_id = '63300000-0000-4000-8000-000000000001'),
  array['2026-W44'],
  'the retention run purged the weekly journal rows older than 180 days and kept the recent one'
);

-- Le même passage a purgé le journal des résultats : la ligne ancienne a disparu, la récente reste.
select is(
  (select array_agg(sale_id order by sale_id) from public.sale_result_dispatches
    where user_id = '63300000-0000-4000-8000-000000000001'),
  array['63300000-1000-4000-8000-000000000002']::uuid[],
  'the same run purged the sale result journal rows older than 180 days and kept the recent one'
);

select is(
  (select public.run_data_retention('2026-12-01T00:00:00Z'::timestamptz) ? 'purge_errors'),
  false,
  'a healthy run reports no purge error'
);

-- Une partie qui échoue n'arrête pas les autres.
create or replace function public.purge_weekly_digest_dispatches(
  p_older_than interval default interval '180 days'
)
returns integer
language plpgsql
as $$
begin
  raise exception 'forced failure of the weekly journal purge' using errcode = 'P0001';
end;
$$;

select is(
  public.run_data_retention('2026-12-01T00:00:00Z'::timestamptz) -> 'purge_errors',
  '{"purge_weekly_digest_dispatches": "P0001"}'::jsonb,
  'a failing weekly journal purge is reported under purge_errors with its SQLSTATE'
);

select ok(
  (public.run_data_retention('2026-12-01T00:00:00Z'::timestamptz)) ? 'sale_result_dispatches'
  and (public.run_data_retention('2026-12-01T00:00:00Z'::timestamptz)) ? 'sale_reminder_dispatches',
  'and the other journal purges still ran and reported'
);

create or replace function public.purge_sale_result_dispatches(
  p_older_than interval default interval '180 days'
)
returns integer
language plpgsql
as $$
begin
  raise exception 'forced failure of the sale result journal purge' using errcode = 'P0001';
end;
$$;

select is(
  public.run_data_retention('2026-12-01T00:00:00Z'::timestamptz) -> 'purge_errors',
  '{"purge_weekly_digest_dispatches": "P0001", "purge_sale_result_dispatches": "P0001"}'::jsonb,
  'both failing journal purges are reported, each under its own key'
);

select * from finish();
rollback;
