begin;

create table if not exists public.user_sale_analysis_sets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (
    char_length(btrim(name)) between 2 and 140
  ),
  analysis_kind text not null default 'comparison' check (
    analysis_kind in ('comparison', 'watchlist', 'portfolio')
  ),
  notes text,
  assumptions jsonb not null default '{}'::jsonb,
  summary_snapshot jsonb not null default '{}'::jsonb,
  is_archived boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, name),
  unique (user_id, id)
);

create table if not exists public.user_sale_analysis_items (
  id uuid primary key default gen_random_uuid(),
  analysis_set_id uuid not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  sale_id uuid not null references public.auction_sales(id) on delete cascade,
  item_order integer not null default 0 check (
    item_order >= 0 and item_order < 50
  ),
  decision_status text not null default 'watching' check (
    decision_status in ('watching', 'shortlisted', 'bid_ready', 'rejected', 'won', 'lost')
  ),
  user_max_bid_eur numeric check (
    user_max_bid_eur is null or user_max_bid_eur >= 0
  ),
  target_yield_pct numeric check (
    target_yield_pct is null or (target_yield_pct >= 0 and target_yield_pct <= 100)
  ),
  expected_margin_pct numeric check (
    expected_margin_pct is null or (expected_margin_pct >= -100 and expected_margin_pct <= 500)
  ),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (user_id, analysis_set_id)
    references public.user_sale_analysis_sets (user_id, id)
    on delete cascade,
  unique (analysis_set_id, sale_id),
  unique (analysis_set_id, item_order)
);

comment on table public.user_sale_analysis_sets is
  'User-owned multi-property analysis sets for investor comparison, watchlists and portfolio preparation.';

comment on table public.user_sale_analysis_items is
  'Per-sale rows inside a multi-property analysis set, with bid, yield, margin and decision status.';

comment on column public.user_sale_analysis_sets.assumptions is
  'Shared assumptions used while comparing several judicial sales.';

comment on column public.user_sale_analysis_sets.summary_snapshot is
  'Client or server generated summary retained for exports and future collaborative review.';

create index if not exists user_sale_analysis_sets_user_archived_idx
  on public.user_sale_analysis_sets (user_id, is_archived, updated_at desc);

create index if not exists user_sale_analysis_items_set_order_idx
  on public.user_sale_analysis_items (analysis_set_id, item_order);

create index if not exists user_sale_analysis_items_sale_idx
  on public.user_sale_analysis_items (sale_id);

alter table public.user_sale_analysis_sets enable row level security;
alter table public.user_sale_analysis_items enable row level security;

revoke all on table public.user_sale_analysis_sets from anon, authenticated;
revoke all on table public.user_sale_analysis_items from anon, authenticated;
grant select, insert, update, delete on table public.user_sale_analysis_sets to authenticated;
grant select, insert, update, delete on table public.user_sale_analysis_items to authenticated;
grant select, insert, update, delete on table public.user_sale_analysis_sets to service_role;
grant select, insert, update, delete on table public.user_sale_analysis_items to service_role;

drop trigger if exists immojudis_user_sale_analysis_sets_updated_at
on public.user_sale_analysis_sets;
create trigger immojudis_user_sale_analysis_sets_updated_at
before update on public.user_sale_analysis_sets
for each row
execute function app_private.set_user_profiles_updated_at();

drop trigger if exists immojudis_user_sale_analysis_items_updated_at
on public.user_sale_analysis_items;
create trigger immojudis_user_sale_analysis_items_updated_at
before update on public.user_sale_analysis_items
for each row
execute function app_private.set_user_profiles_updated_at();

drop policy if exists user_sale_analysis_sets_select_authorized
on public.user_sale_analysis_sets;
create policy user_sale_analysis_sets_select_authorized
on public.user_sale_analysis_sets
for select
to authenticated
using (
  user_id = (select auth.uid())
  or public.is_admin()
);

drop policy if exists user_sale_analysis_sets_insert_own
on public.user_sale_analysis_sets;
create policy user_sale_analysis_sets_insert_own
on public.user_sale_analysis_sets
for insert
to authenticated
with check (user_id = (select auth.uid()));

drop policy if exists user_sale_analysis_sets_update_own
on public.user_sale_analysis_sets;
create policy user_sale_analysis_sets_update_own
on public.user_sale_analysis_sets
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

drop policy if exists user_sale_analysis_sets_delete_own
on public.user_sale_analysis_sets;
create policy user_sale_analysis_sets_delete_own
on public.user_sale_analysis_sets
for delete
to authenticated
using (
  user_id = (select auth.uid())
  or public.is_admin()
);

drop policy if exists user_sale_analysis_items_select_authorized
on public.user_sale_analysis_items;
create policy user_sale_analysis_items_select_authorized
on public.user_sale_analysis_items
for select
to authenticated
using (
  user_id = (select auth.uid())
  or public.is_admin()
);

drop policy if exists user_sale_analysis_items_insert_own
on public.user_sale_analysis_items;
create policy user_sale_analysis_items_insert_own
on public.user_sale_analysis_items
for insert
to authenticated
with check (user_id = (select auth.uid()));

drop policy if exists user_sale_analysis_items_update_own
on public.user_sale_analysis_items;
create policy user_sale_analysis_items_update_own
on public.user_sale_analysis_items
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

drop policy if exists user_sale_analysis_items_delete_own
on public.user_sale_analysis_items;
create policy user_sale_analysis_items_delete_own
on public.user_sale_analysis_items
for delete
to authenticated
using (
  user_id = (select auth.uid())
  or public.is_admin()
);

notify pgrst, 'reload schema';

commit;
