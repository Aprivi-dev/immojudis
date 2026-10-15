begin;

select plan(11);

select ok(
  (
    select procedure_row.prosecdef
      and procedure_row.proconfig @> array['search_path=""']::text[]
      and position('purge_errors' in pg_get_functiondef(procedure_row.oid)) > 0
      and position('purge_information_agent_data' in pg_get_functiondef(procedure_row.oid)) > 0
      and position('purge_sale_unlocks' in pg_get_functiondef(procedure_row.oid)) > 0
      and has_function_privilege('service_role', procedure_row.oid, 'execute')
      and not has_function_privilege('anon', procedure_row.oid, 'execute')
      and not has_function_privilege('authenticated', procedure_row.oid, 'execute')
    from pg_proc procedure_row
    where procedure_row.oid = 'public.run_data_retention(timestamptz)'::regprocedure
  ),
  'run_data_retention reports purge_errors, keeps its four purges and its service-only boundary'
);

create temporary table pgtap_465_result (
  case_name text primary key,
  payload jsonb
) on commit drop;

-- Sales that scope the registry rows (a sale-scoped contact must match its sale at insertion).
insert into public.auction_sales (id, source_name, source_url, status)
values
  ('46500000-0000-4000-8000-000000000001', 'retention-pgtap', 'https://example.test/retention/1', 'upcoming'),
  ('46500000-0000-4000-8000-000000000002', 'retention-pgtap', 'https://example.test/retention/2', 'upcoming'),
  ('46500000-0000-4000-8000-000000000003', 'retention-pgtap', 'https://example.test/retention/3', 'upcoming');

-- Registry rows: two old sale-scoped addresses never used for a mission (purged 21 days after
-- their observation) and one global address that no purge touches.
insert into public.information_agent_contacts (
  sale_id, scope_sale_id, email, opposition_status, observed_at, source_kind, observed_by
)
values
  ('46500000-0000-4000-8000-000000000001', '46500000-0000-4000-8000-000000000001', 'purge-a@example.test', 'none', '2026-09-01T00:00:00Z', 'sale_listing', 'agent'),
  ('46500000-0000-4000-8000-000000000002', '46500000-0000-4000-8000-000000000002', 'purge-b@example.test', 'none', '2026-09-01T00:00:00Z', 'sale_listing', 'agent');
insert into public.information_agent_contacts (email, opposition_status)
values ('rollback@example.test', 'none');

-- Healthy run: every purge reports, nothing is flagged.
select lives_ok(
  $sql$
    insert into pgtap_465_result(case_name, payload)
    select 'healthy', public.run_data_retention('2026-12-01T00:00:00Z'::timestamptz)
  $sql$,
  'the retention run succeeds when every purge succeeds'
);

select is(
  (select payload ? 'purge_errors' from pgtap_465_result where case_name = 'healthy'),
  false,
  'a healthy run reports no purge_errors'
);

select is(
  (select count(*) from public.information_agent_contacts
    where email in ('purge-a@example.test', 'purge-b@example.test')),
  0::bigint,
  'a healthy run purges the old registry addresses'
);

select ok(
  (select payload ?& array['information_agent_contacts', 'offer_opening_notifications', 'user_sale_unlocks']
     from pgtap_465_result where case_name = 'healthy'),
  'a healthy run reports the registry, opening-request and unlock purges'
);

-- Forced failures: the first purge raises at once; the last one deletes a row and then raises.
insert into public.information_agent_contacts (
  sale_id, scope_sale_id, email, opposition_status, observed_at, source_kind, observed_by
)
values ('46500000-0000-4000-8000-000000000003', '46500000-0000-4000-8000-000000000003', 'purge-c@example.test', 'none', '2026-09-01T00:00:00Z', 'sale_listing', 'agent');

create or replace function app_private.purge_expired_operational_data(
  p_now timestamptz default statement_timestamp()
)
returns jsonb
language plpgsql
as $$
begin
  raise exception 'pgtap forced failure of the operational purge';
end;
$$;

create or replace function app_private.purge_sale_unlocks(
  p_now timestamptz default statement_timestamp()
)
returns jsonb
language plpgsql
as $$
begin
  delete from public.information_agent_contacts where email = 'rollback@example.test';
  raise exception 'pgtap forced failure of the unlock purge';
end;
$$;

select lives_ok(
  $sql$
    insert into pgtap_465_result(case_name, payload)
    select 'failing', public.run_data_retention('2026-12-01T00:00:00Z'::timestamptz)
  $sql$,
  'the retention call returns even though two purges raise'
);

select is(
  (select payload->'purge_errors' from pgtap_465_result where case_name = 'failing'),
  '{"purge_expired_operational_data": "P0001", "purge_sale_unlocks": "P0001"}'::jsonb,
  'the failed purges are reported by name with their SQLSTATE, so the cron monitor can fail'
);

select is(
  (select count(*) from public.information_agent_contacts where email = 'purge-c@example.test'),
  0::bigint,
  'the registry purge still runs after the first purge raised'
);

select ok(
  (select payload ?& array['information_agent_contacts', 'offer_opening_notifications']
     from pgtap_465_result where case_name = 'failing'),
  'the purges between the two failures still report'
);

select is(
  (select count(*) from public.information_agent_contacts where email = 'rollback@example.test'),
  1::bigint,
  'what a failing purge deleted before raising is rolled back'
);

select ok(
  (select not (payload ? 'user_sale_unlocks') from pgtap_465_result where case_name = 'failing'),
  'a failed purge adds no result of its own'
);

select * from finish();

rollback;
