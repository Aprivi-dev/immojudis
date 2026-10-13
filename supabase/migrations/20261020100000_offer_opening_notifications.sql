begin;

set local lock_timeout = '5s';

-- Opt-in list for "Me prévenir de l'ouverture" on /offres while subscriptions are
-- closed.  One row per account.  The user ticks nothing hidden: the row exists only
-- after an explicit click, with the timestamp and the wording version shown at that
-- time.  Sending the opening email is NOT implemented here: this table only collects.
create table if not exists public.offer_opening_notifications (
  user_id uuid primary key references auth.users(id) on delete cascade,
  offer_code text not null default 'analyse' check (offer_code in ('analyse')),
  notify_enabled boolean not null default true,
  consented_at timestamptz not null default now(),
  revoked_at timestamptz,
  consent_text_version text not null check (length(consent_text_version) between 1 and 64),
  consent_source text not null default 'offers_page' check (consent_source in ('offers_page')),
  notified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint offer_opening_notifications_revoked_check
    check (notify_enabled = false or revoked_at is null)
);

comment on table public.offer_opening_notifications is
  'Explicit, timestamped requests to be told once when paid subscriptions open. Collection only; no email is sent from this table yet.';
comment on column public.offer_opening_notifications.consented_at is
  'When the user clicked "Me prévenir de l''ouverture" (explicit consent), kept as proof.';
comment on column public.offer_opening_notifications.consent_text_version is
  'Version of the wording displayed next to the button when consent was given.';
comment on column public.offer_opening_notifications.notified_at is
  'Set by the future sender once the opening email went out, so nobody is notified twice.';

create index if not exists offer_opening_notifications_enabled_idx
  on public.offer_opening_notifications (offer_code, consented_at)
  where notify_enabled and notified_at is null;

alter table public.offer_opening_notifications enable row level security;

revoke all on table public.offer_opening_notifications from anon, authenticated;
grant select, insert, update on table public.offer_opening_notifications to authenticated;
grant select, insert, update, delete on table public.offer_opening_notifications to service_role;

drop trigger if exists immojudis_offer_opening_notifications_updated_at
on public.offer_opening_notifications;
create trigger immojudis_offer_opening_notifications_updated_at
before update on public.offer_opening_notifications
for each row
execute function app_private.set_user_profiles_updated_at();

-- The owner reads and writes their own row; an administrator can read the list.
drop policy if exists offer_opening_notifications_select_own_or_admin
on public.offer_opening_notifications;
create policy offer_opening_notifications_select_own_or_admin
on public.offer_opening_notifications
for select
to authenticated
using (
  user_id = (select auth.uid())
  or public.is_admin()
);

drop policy if exists offer_opening_notifications_insert_own
on public.offer_opening_notifications;
create policy offer_opening_notifications_insert_own
on public.offer_opening_notifications
for insert
to authenticated
with check (user_id = (select auth.uid()));

drop policy if exists offer_opening_notifications_update_own
on public.offer_opening_notifications;
create policy offer_opening_notifications_update_own
on public.offer_opening_notifications
for update
to authenticated
using (user_id = (select auth.uid()))
with check (user_id = (select auth.uid()));

notify pgrst, 'reload schema';

commit;
