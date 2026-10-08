begin;

select plan(24);

select has_column(
  'public',
  'auction_sales',
  'retention_deadline',
  'auction sales persist the computed retention deadline'
);

select has_column(
  'public',
  'auction_sales',
  'retention_deadline_materialized',
  'auction sales expose the backfill completion fence'
);

select ok(
  exists (
    select 1
    from information_schema.columns column_row
    where column_row.table_schema = 'public'
      and column_row.table_name = 'auction_sales'
      and column_row.column_name = 'retention_deadline_materialized'
      and column_row.is_nullable = 'NO'
  ),
  'the materialization fence cannot be NULL'
);

select has_function(
  'app_private',
  'set_auction_sale_retention_deadline',
  array[]::text[],
  'the retention deadline trigger function exists'
);

select ok(
  position('new.sale_date' in pg_get_functiondef(
    'app_private.set_auction_sale_retention_deadline()'::regprocedure
  )) > 0
  and position('new.status' in pg_get_functiondef(
    'app_private.set_auction_sale_retention_deadline()'::regprocedure
  )) > 0
  and position('new.sale_procedure' in pg_get_functiondef(
    'app_private.set_auction_sale_retention_deadline()'::regprocedure
  )) > 0
  and position('new.raw_payload' in pg_get_functiondef(
    'app_private.set_auction_sale_retention_deadline()'::regprocedure
  )) > 0,
  'all four retention inputs feed the materialized deadline'
);

select ok(
  exists (
    select 1
    from pg_trigger trigger_row
    where trigger_row.tgrelid = 'public.auction_sales'::regclass
      and trigger_row.tgname in (
        'zzzz_auction_sales_retention_deadline_insert',
        'zzzz_auction_sales_retention_deadline_update'
      )
      and not trigger_row.tgisinternal
  )
  and (
    select count(*)
    from pg_trigger trigger_row
    where trigger_row.tgrelid = 'public.auction_sales'::regclass
      and trigger_row.tgname in (
        'zzzz_auction_sales_retention_deadline_insert',
        'zzzz_auction_sales_retention_deadline_update'
      )
      and not trigger_row.tgisinternal
  ) = 2
  and exists (
    select 1
    from pg_trigger trigger_row
    where trigger_row.tgrelid = 'public.auction_sales'::regclass
      and trigger_row.tgname = 'zzzz_auction_sales_retention_deadline_insert'
      and position(
        'before insert on public.auction_sales' in lower(
          pg_get_triggerdef(trigger_row.oid)
        )
      ) > 0
  )
  and exists (
    select 1
    from pg_trigger trigger_row
    where trigger_row.tgrelid = 'public.auction_sales'::regclass
      and trigger_row.tgname = 'zzzz_auction_sales_retention_deadline_update'
      and position(
        'before update on public.auction_sales' in lower(
          pg_get_triggerdef(trigger_row.oid)
        )
      ) > 0
  ),
  'auction sales recompute the deadline after earlier guards on insert and update'
);

select ok(
  exists (
    select 1
    from pg_class index_relation
    join pg_index index_row on index_row.indexrelid = index_relation.oid
    where index_relation.relname = 'auction_sales_retention_deadline_idx'
      and index_row.indrelid = 'public.auction_sales'::regclass
      and index_row.indisvalid
      and position(
        'retention_deadline' in lower(
          pg_get_expr(index_row.indpred, index_row.indrelid)
        )
      ) > 0
  ),
  'the retention deadline has a valid partial B-tree index'
);

select is(
  (
    select count(*)
    from public.auction_sales sale
    where not sale.retention_deadline_materialized
  ),
  0::bigint,
  'the bounded backfill leaves no unfenced catalogue rows'
);

set local role service_role;

insert into public.auction_sales (
  id,
  source_name,
  source_url,
  status,
  sale_date,
  sale_procedure,
  raw_payload
)
values
  (
    '39800000-0000-4000-8000-000000000001',
    'retention-deadline-pgtap',
    'https://example.test/retention-deadline/regular',
    'upcoming',
    '2026-09-10 12:00:00+00',
    '{}'::jsonb,
    '{}'::jsonb
  ),
  (
    '39800000-0000-4000-8000-000000000002',
    'retention-deadline-pgtap',
    'https://example.test/retention-deadline/date-only',
    'upcoming',
    '2026-09-10 00:00:00+00',
    '{}'::jsonb,
    '{"sale_date":"2026-09-10","date_precision":"day"}'::jsonb
  ),
  (
    '39800000-0000-4000-8000-000000000003',
    'retention-deadline-pgtap',
    'https://example.test/retention-deadline/postponed',
    'postponed',
    '2026-09-10 12:00:00+00',
    '{}'::jsonb,
    '{}'::jsonb
  ),
  (
    '39800000-0000-4000-8000-000000000004',
    'retention-deadline-pgtap',
    'https://example.test/retention-deadline/scheduled',
    'upcoming',
    '2026-09-30 12:00:00+00',
    '{"sale_window":{"opens_at":"2026-10-01T12:00:00Z","closes_at":"2026-10-02T12:00:00Z"}}'::jsonb,
    '{}'::jsonb
  );

select is(
  (
    select retention_deadline
    from public.auction_sales
    where id = '39800000-0000-4000-8000-000000000001'
  ),
  '2026-09-11 12:00:00+00'::timestamptz,
  'a regular sale deadline is materialized from sale_date'
);

select ok(
  (
    select retention_deadline_materialized
    from public.auction_sales
    where id = '39800000-0000-4000-8000-000000000001'
  ),
  'new rows cross the materialization fence'
);

select is(
  (
    select retention_deadline
    from public.auction_sales
    where id = '39800000-0000-4000-8000-000000000002'
  ),
  '2026-09-11 22:00:00+00'::timestamptz,
  'date-only JSON keeps the Paris civil-day retention rule'
);

select is(
  (
    select retention_deadline
    from public.auction_sales
    where id = '39800000-0000-4000-8000-000000000003'
  ),
  null::timestamptz,
  'a postponed status retains the sale'
);

select is(
  (
    select retention_deadline
    from public.auction_sales
    where id = '39800000-0000-4000-8000-000000000004'
  ),
  '2026-10-03 12:00:00+00'::timestamptz,
  'an explicit sale window overrides the headline date'
);

update public.auction_sales
   set sale_date = '2026-09-12 12:00:00+00'
 where id = '39800000-0000-4000-8000-000000000001';

select is(
  (
    select retention_deadline
    from public.auction_sales
    where id = '39800000-0000-4000-8000-000000000001'
  ),
  '2026-09-13 12:00:00+00'::timestamptz,
  'changing sale_date refreshes the deadline'
);

update public.auction_sales
   set status = 'postponed'
 where id = '39800000-0000-4000-8000-000000000001';

select is(
  (
    select retention_deadline
    from public.auction_sales
    where id = '39800000-0000-4000-8000-000000000001'
  ),
  null::timestamptz,
  'changing status refreshes a postponed deadline to NULL'
);

update public.auction_sales
   set status = 'upcoming',
       raw_payload = '{"status":"Vente reportée"}'::jsonb
 where id = '39800000-0000-4000-8000-000000000001';

select is(
  (
    select retention_deadline
    from public.auction_sales
    where id = '39800000-0000-4000-8000-000000000001'
  ),
  null::timestamptz,
  'reported status in JSON also fences the sale'
);

update public.auction_sales
   set raw_payload = '{}'::jsonb,
       sale_procedure = '{"sale_window":{"opens_at":"2026-09-20T12:00:00Z","closes_at":"2026-09-21T12:00:00Z"}}'::jsonb
 where id = '39800000-0000-4000-8000-000000000001';

select is(
  (
    select retention_deadline
    from public.auction_sales
    where id = '39800000-0000-4000-8000-000000000001'
  ),
  '2026-09-22 12:00:00+00'::timestamptz,
  'changing sale_procedure refreshes the JSON deadline'
);

update public.auction_sales
   set retention_deadline = '2000-01-01 00:00:00+00',
       retention_deadline_materialized = false
 where id = '39800000-0000-4000-8000-000000000001';

select is(
  (
    select retention_deadline
    from public.auction_sales
    where id = '39800000-0000-4000-8000-000000000001'
  ),
  '2026-09-22 12:00:00+00'::timestamptz,
  'direct deadline tampering is fenced by the trigger'
);

select ok(
  (
    select retention_deadline_materialized
    from public.auction_sales
    where id = '39800000-0000-4000-8000-000000000001'
  ),
  'direct fence tampering is repaired by the trigger'
);

savepoint retention_deadline_rollback;
update public.auction_sales
   set sale_date = '2099-01-01 00:00:00+00'
 where id = '39800000-0000-4000-8000-000000000001';
rollback to retention_deadline_rollback;

select is(
  (
    select retention_deadline
    from public.auction_sales
    where id = '39800000-0000-4000-8000-000000000001'
  ),
  '2026-09-22 12:00:00+00'::timestamptz,
  'a rolled-back source update does not leak a deadline change'
);

select is(
  (
    select count(*)
    from public.auction_sales sale
    where sale.id in (
      '39800000-0000-4000-8000-000000000001',
      '39800000-0000-4000-8000-000000000002',
      '39800000-0000-4000-8000-000000000003',
      '39800000-0000-4000-8000-000000000004'
    )
      and sale.retention_deadline_materialized
      and sale.retention_deadline <= '2026-09-29 00:00:00+00'::timestamptz
  ),
  2::bigint,
  'the materialized deadline gives the exact due count without JSON evaluation'
);

-- UPDATE OF only considers columns named by the original UPDATE statement.
-- This fixture models an earlier guard that changes retention inputs while a
-- caller updates an unrelated field.  The production zzzz trigger must see
-- those NEW values and recompute after this fixture trigger runs.
set local role postgres;

create or replace function app_private.pgtap398_mutate_retention_inputs()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.id = '39800000-0000-4000-8000-000000000001' then
    new.status := 'postponed';
    new.raw_payload := coalesce(new.raw_payload, '{}'::jsonb)
      || jsonb_build_object('status', 'Vente reportée');
  end if;
  return new;
end;
$$;

revoke all on function app_private.pgtap398_mutate_retention_inputs()
  from public, anon, authenticated, service_role;
grant execute on function app_private.pgtap398_mutate_retention_inputs()
  to service_role;

drop trigger if exists pgtap398_mutate_retention_inputs on public.auction_sales;
create trigger pgtap398_mutate_retention_inputs
before update of description on public.auction_sales
for each row
execute function app_private.pgtap398_mutate_retention_inputs();

set local role service_role;
update public.auction_sales
   set description = 'pgtap398 unrelated update'
 where id = '39800000-0000-4000-8000-000000000001';

select is(
  (
    select retention_deadline
    from public.auction_sales
    where id = '39800000-0000-4000-8000-000000000001'
  ),
  null::timestamptz,
  'a prior guard changing status and raw_payload still refreshes the deadline'
);

reset role;

select ok(
  position('catalogue_expiry_materialized' in lower(pg_get_functiondef(
    'public.purge_expired_auction_sales(timestamptz,integer)'::regprocedure
  ))) > 0
  and position('catalogue_expiry_deadline <= p_now' in lower(pg_get_functiondef(
    'public.purge_expired_auction_sales(timestamptz,integer)'::regprocedure
  ))) > 0
  and position('sale.status = ''postponed''' in lower(pg_get_functiondef(
    'public.purge_expired_auction_sales(timestamptz,integer)'::regprocedure
  ))) > 0
  and position('app_private.sale_catalogue_expiry(' in lower(pg_get_functiondef(
    'public.purge_expired_auction_sales(timestamptz,integer)'::regprocedure
  ))) > 0
  and position('retention_deadline <= p_now' in lower(pg_get_functiondef(
    'public.purge_expired_auction_sales(timestamptz,integer)'::regprocedure
  ))) = 0
  and position('+ interval ''24 hours''' in lower(pg_get_functiondef(
    'public.purge_expired_auction_sales(timestamptz,integer)'::regprocedure
  ))) = 0,
  'purge uses the indexed catalogue deadline with a postponed-only compatibility fallback'
);

select ok(
  position('lock table public.auction_sales in share row exclusive mode nowait' in lower(pg_get_functiondef(
    'public.purge_expired_auction_sales(timestamptz,integer)'::regprocedure
  ))) > 0
  and position('limit least(p_limit, 1)' in lower(pg_get_functiondef(
    'public.purge_expired_auction_sales(timestamptz,integer)'::regprocedure
  ))) > 0,
  'purge keeps non-blocking locking and one-row statement bounds'
);

select * from finish();

rollback;
