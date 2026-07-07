begin;

create table if not exists public.sale_workspaces (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  sale_id uuid not null references public.auction_sales(id) on delete cascade,
  tracking_status text not null default 'watching' check (
    tracking_status in ('watching', 'reviewing', 'bidding', 'won', 'lost', 'archived')
  ),
  user_max_bid_eur numeric check (
    user_max_bid_eur is null or user_max_bid_eur >= 0
  ),
  target_yield_pct numeric check (
    target_yield_pct is null or (target_yield_pct >= 0 and target_yield_pct <= 100)
  ),
  private_notes jsonb not null default '{}'::jsonb,
  checklist jsonb not null default '{}'::jsonb,
  alert_preferences jsonb not null default '{}'::jsonb,
  next_action text,
  next_action_due_at timestamptz,
  last_synced_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, sale_id)
);

comment on table public.sale_workspaces is
  'User-owned investor workspace for one judicial sale: private notes, checklist, alerts, status and bid ceiling follow-up.';

comment on column public.sale_workspaces.private_notes is
  'Structured private notes entered by the user while preparing an auction dossier.';

comment on column public.sale_workspaces.checklist is
  'Checklist items validated before the audience. Stored as a JSON object keyed by stable labels.';

comment on column public.sale_workspaces.alert_preferences is
  'Per-sale reminder and change-monitoring preferences selected by the user.';

create index if not exists sale_workspaces_user_updated_idx
  on public.sale_workspaces (user_id, updated_at desc);

create index if not exists sale_workspaces_sale_idx
  on public.sale_workspaces (sale_id);

create index if not exists sale_workspaces_status_due_idx
  on public.sale_workspaces (tracking_status, next_action_due_at)
  where next_action_due_at is not null;

alter table public.sale_workspaces enable row level security;

revoke all on table public.sale_workspaces from anon, authenticated;
grant select, insert, update, delete on table public.sale_workspaces to authenticated;
grant select, insert, update, delete on table public.sale_workspaces to service_role;

drop trigger if exists immojudis_sale_workspaces_updated_at
on public.sale_workspaces;
create trigger immojudis_sale_workspaces_updated_at
before update on public.sale_workspaces
for each row
execute function app_private.set_user_profiles_updated_at();

drop policy if exists sale_workspaces_select_authorized
on public.sale_workspaces;
create policy sale_workspaces_select_authorized
on public.sale_workspaces
for select
to authenticated
using (
  user_id = (select auth.uid())
  or public.is_admin()
);

drop policy if exists sale_workspaces_insert_own
on public.sale_workspaces;
create policy sale_workspaces_insert_own
on public.sale_workspaces
for insert
to authenticated
with check (user_id = (select auth.uid()));

drop policy if exists sale_workspaces_update_own
on public.sale_workspaces;
create policy sale_workspaces_update_own
on public.sale_workspaces
for update
to authenticated
using (
  user_id = (select auth.uid())
  or public.is_admin()
)
with check (
  user_id = (select auth.uid())
  or public.is_admin()
);

drop policy if exists sale_workspaces_delete_own
on public.sale_workspaces;
create policy sale_workspaces_delete_own
on public.sale_workspaces
for delete
to authenticated
using (
  user_id = (select auth.uid())
  or public.is_admin()
);

notify pgrst, 'reload schema';

commit;
