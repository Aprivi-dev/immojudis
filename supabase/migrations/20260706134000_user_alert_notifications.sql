begin;

create table if not exists public.user_alert_notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  alert_id uuid not null references public.user_alerts(id) on delete cascade,
  match_id uuid not null references public.user_alert_matches(id) on delete cascade,
  sale_id uuid not null references public.auction_sales(id) on delete cascade,
  notification_kind text not null default 'instant_match' check (
    notification_kind in ('instant_match', 'daily_digest', 'weekly_digest')
  ),
  delivery_channel text not null default 'in_app' check (
    delivery_channel in ('in_app', 'email')
  ),
  delivery_status text not null default 'queued' check (
    delivery_status in ('queued', 'sent', 'failed', 'cancelled')
  ),
  scheduled_for timestamptz not null default now(),
  sent_at timestamptz,
  read_at timestamptz,
  dismissed_at timestamptz,
  notification_snapshot jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, match_id, notification_kind, delivery_channel)
);

comment on table public.user_alert_notifications is
  'User-owned delivery inbox/outbox for smart alert matches, including instant alerts and scheduled digests.';

comment on column public.user_alert_notifications.notification_snapshot is
  'Stable alert notification payload used by the UI and future email delivery workers.';

create index if not exists user_alert_notifications_user_scheduled_idx
  on public.user_alert_notifications (user_id, scheduled_for desc);

create index if not exists user_alert_notifications_status_scheduled_idx
  on public.user_alert_notifications (delivery_status, scheduled_for);

create index if not exists user_alert_notifications_alert_idx
  on public.user_alert_notifications (alert_id, scheduled_for desc);

alter table public.user_alert_notifications enable row level security;

revoke all on table public.user_alert_notifications from anon, authenticated;
grant select, insert, update, delete on table public.user_alert_notifications to authenticated;
grant select, insert, update, delete on table public.user_alert_notifications to service_role;

drop trigger if exists immojudis_user_alert_notifications_updated_at
on public.user_alert_notifications;
create trigger immojudis_user_alert_notifications_updated_at
before update on public.user_alert_notifications
for each row
execute function app_private.set_user_profiles_updated_at();

drop policy if exists user_alert_notifications_select_authorized
on public.user_alert_notifications;
create policy user_alert_notifications_select_authorized
on public.user_alert_notifications
for select
to authenticated
using (
  user_id = (select auth.uid())
  or public.is_admin()
);

drop policy if exists user_alert_notifications_insert_own
on public.user_alert_notifications;
create policy user_alert_notifications_insert_own
on public.user_alert_notifications
for insert
to authenticated
with check (
  user_id = (select auth.uid())
  and exists (
    select 1
    from public.user_alert_matches match
    where match.id = match_id
      and match.user_id = (select auth.uid())
  )
  and exists (
    select 1
    from public.user_alerts alert
    where alert.id = alert_id
      and alert.user_id = (select auth.uid())
  )
);

drop policy if exists user_alert_notifications_update_own
on public.user_alert_notifications;
create policy user_alert_notifications_update_own
on public.user_alert_notifications
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

drop policy if exists user_alert_notifications_delete_own
on public.user_alert_notifications;
create policy user_alert_notifications_delete_own
on public.user_alert_notifications
for delete
to authenticated
using (
  user_id = (select auth.uid())
  or public.is_admin()
);

notify pgrst, 'reload schema';

commit;
