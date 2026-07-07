begin;

create table if not exists public.sale_data_exports (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  export_kind text not null default 'sales_csv' check (
    export_kind in ('sales_csv', 'sales_api')
  ),
  search_snapshot jsonb not null default '{}'::jsonb,
  row_count integer not null default 0 check (row_count >= 0),
  created_at timestamptz not null default now()
);

comment on table public.sale_data_exports is
  'Audit trail for Analyse/Investisseur data exports such as filtered sales CSV and future light API usage.';

create index if not exists sale_data_exports_user_created_idx
  on public.sale_data_exports (user_id, created_at desc);

create index if not exists sale_data_exports_kind_created_idx
  on public.sale_data_exports (export_kind, created_at desc);

alter table public.sale_data_exports enable row level security;

revoke all on table public.sale_data_exports from anon, authenticated;
grant select, insert on table public.sale_data_exports to authenticated;
grant select, insert, update, delete on table public.sale_data_exports to service_role;

drop policy if exists sale_data_exports_select_authorized
on public.sale_data_exports;
create policy sale_data_exports_select_authorized
on public.sale_data_exports
for select
to authenticated
using (
  user_id = (select auth.uid())
  or public.is_admin()
);

drop policy if exists sale_data_exports_insert_own
on public.sale_data_exports;
create policy sale_data_exports_insert_own
on public.sale_data_exports
for insert
to authenticated
with check (user_id = (select auth.uid()));

notify pgrst, 'reload schema';

commit;
