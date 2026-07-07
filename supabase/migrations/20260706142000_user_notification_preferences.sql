begin;

create table if not exists public.user_notification_preferences (
  user_id uuid primary key references auth.users(id) on delete cascade,
  alert_email_enabled boolean not null default false,
  alert_email_consented_at timestamptz,
  alert_email_revoked_at timestamptz,
  consent_source text not null default 'settings' check (
    consent_source in ('settings', 'alert_creation', 'import', 'admin')
  ),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint user_notification_preferences_email_consent_check
    check (
      (alert_email_enabled = false)
      or alert_email_consented_at is not null
    )
);

comment on table public.user_notification_preferences is
  'User-owned notification preferences and explicit email alert consent timestamps.';

comment on column public.user_notification_preferences.alert_email_consented_at is
  'Timestamp proving when the user explicitly enabled email alert notifications.';

comment on column public.user_notification_preferences.alert_email_revoked_at is
  'Timestamp proving when the user disabled email alert notifications.';

create index if not exists user_notification_preferences_email_enabled_idx
  on public.user_notification_preferences (alert_email_enabled, updated_at desc);

alter table public.user_notification_preferences enable row level security;

revoke all on table public.user_notification_preferences from anon, authenticated;
grant select, insert, update, delete on table public.user_notification_preferences to authenticated;
grant select, insert, update, delete on table public.user_notification_preferences to service_role;

drop trigger if exists immojudis_user_notification_preferences_updated_at
on public.user_notification_preferences;
create trigger immojudis_user_notification_preferences_updated_at
before update on public.user_notification_preferences
for each row
execute function app_private.set_user_profiles_updated_at();

drop policy if exists user_notification_preferences_select_own
on public.user_notification_preferences;
create policy user_notification_preferences_select_own
on public.user_notification_preferences
for select
to authenticated
using (
  user_id = (select auth.uid())
  or public.is_admin()
);

drop policy if exists user_notification_preferences_insert_own
on public.user_notification_preferences;
create policy user_notification_preferences_insert_own
on public.user_notification_preferences
for insert
to authenticated
with check (user_id = (select auth.uid()));

drop policy if exists user_notification_preferences_update_own
on public.user_notification_preferences;
create policy user_notification_preferences_update_own
on public.user_notification_preferences
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

drop policy if exists user_notification_preferences_delete_own
on public.user_notification_preferences;
create policy user_notification_preferences_delete_own
on public.user_notification_preferences
for delete
to authenticated
using (
  user_id = (select auth.uid())
  or public.is_admin()
);

notify pgrst, 'reload schema';

commit;
