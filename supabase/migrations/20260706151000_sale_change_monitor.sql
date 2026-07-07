begin;

create table if not exists public.user_sale_watch_snapshots (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  sale_id uuid not null references public.auction_sales(id) on delete cascade,
  watch_kind text not null check (
    watch_kind in ('alert_match', 'favorite', 'workspace')
  ),
  watch_id uuid not null,
  snapshot jsonb not null default '{}'::jsonb,
  fingerprint text not null,
  last_checked_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, sale_id, watch_kind, watch_id)
);

comment on table public.user_sale_watch_snapshots is
  'Last known sale snapshots for investor real-time change monitoring across alert matches, favorites and workspaces.';

create index if not exists user_sale_watch_snapshots_user_checked_idx
  on public.user_sale_watch_snapshots (user_id, last_checked_at desc);

create index if not exists user_sale_watch_snapshots_sale_idx
  on public.user_sale_watch_snapshots (sale_id);

create table if not exists public.user_sale_change_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  sale_id uuid not null references public.auction_sales(id) on delete cascade,
  watch_kind text not null check (
    watch_kind in ('alert_match', 'favorite', 'workspace')
  ),
  watch_id uuid not null,
  event_kind text not null check (
    event_kind in (
      'price_changed',
      'audience_changed',
      'status_changed',
      'documents_changed',
      'score_changed'
    )
  ),
  severity text not null default 'info' check (
    severity in ('info', 'important', 'urgent')
  ),
  fingerprint text not null,
  summary_label text not null,
  old_snapshot jsonb not null default '{}'::jsonb,
  new_snapshot jsonb not null default '{}'::jsonb,
  change_summary jsonb not null default '{}'::jsonb,
  detected_at timestamptz not null default now(),
  read_at timestamptz,
  dismissed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (user_id, sale_id, event_kind, fingerprint)
);

comment on table public.user_sale_change_events is
  'Investor real-time change events detected on tracked judicial sales: price, audience date, status, documents and scoring changes.';

create index if not exists user_sale_change_events_user_detected_idx
  on public.user_sale_change_events (user_id, detected_at desc);

create index if not exists user_sale_change_events_user_unread_idx
  on public.user_sale_change_events (user_id, read_at, dismissed_at, detected_at desc);

create index if not exists user_sale_change_events_sale_idx
  on public.user_sale_change_events (sale_id, detected_at desc);

alter table public.user_sale_watch_snapshots enable row level security;
alter table public.user_sale_change_events enable row level security;

revoke all on table public.user_sale_watch_snapshots from anon, authenticated;
revoke all on table public.user_sale_change_events from anon, authenticated;

grant select, insert, update, delete on table public.user_sale_watch_snapshots to authenticated;
grant select, insert, update, delete on table public.user_sale_change_events to authenticated;
grant select, insert, update, delete on table public.user_sale_watch_snapshots to service_role;
grant select, insert, update, delete on table public.user_sale_change_events to service_role;

drop policy if exists user_sale_watch_snapshots_select_authorized
on public.user_sale_watch_snapshots;
create policy user_sale_watch_snapshots_select_authorized
on public.user_sale_watch_snapshots
for select
to authenticated
using (
  user_id = (select auth.uid())
  or public.is_admin()
);

drop policy if exists user_sale_watch_snapshots_insert_own
on public.user_sale_watch_snapshots;
create policy user_sale_watch_snapshots_insert_own
on public.user_sale_watch_snapshots
for insert
to authenticated
with check (
  user_id = (select auth.uid())
  or public.is_admin()
);

drop policy if exists user_sale_watch_snapshots_update_own
on public.user_sale_watch_snapshots;
create policy user_sale_watch_snapshots_update_own
on public.user_sale_watch_snapshots
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

drop policy if exists user_sale_watch_snapshots_delete_own
on public.user_sale_watch_snapshots;
create policy user_sale_watch_snapshots_delete_own
on public.user_sale_watch_snapshots
for delete
to authenticated
using (
  user_id = (select auth.uid())
  or public.is_admin()
);

drop policy if exists user_sale_change_events_select_authorized
on public.user_sale_change_events;
create policy user_sale_change_events_select_authorized
on public.user_sale_change_events
for select
to authenticated
using (
  user_id = (select auth.uid())
  or public.is_admin()
);

drop policy if exists user_sale_change_events_insert_own
on public.user_sale_change_events;
create policy user_sale_change_events_insert_own
on public.user_sale_change_events
for insert
to authenticated
with check (
  user_id = (select auth.uid())
  or public.is_admin()
);

drop policy if exists user_sale_change_events_update_own
on public.user_sale_change_events;
create policy user_sale_change_events_update_own
on public.user_sale_change_events
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

drop policy if exists user_sale_change_events_delete_own
on public.user_sale_change_events;
create policy user_sale_change_events_delete_own
on public.user_sale_change_events
for delete
to authenticated
using (
  user_id = (select auth.uid())
  or public.is_admin()
);

alter table public.feature_usage_events
  drop constraint if exists feature_usage_events_event_key_check;

alter table public.feature_usage_events
  add constraint feature_usage_events_event_key_check check (
    event_key in (
      'property_report.created',
      'property_report.pdf_exported',
      'sales.csv_exported',
      'sales.api_feed_requested',
      'sale_history.viewed',
      'market.analytics_viewed',
      'dpe.explorer_viewed',
      'sales.favorite_added',
      'sales.favorite_removed',
      'sales.statistics_viewed',
      'bid_ceiling.calculated',
      'workspace.audience_tracking_viewed',
      'sale_changes.monitored',
      'lawyer.referral_requested'
    )
  );

notify pgrst, 'reload schema';

commit;
