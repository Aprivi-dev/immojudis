begin;

create table if not exists public.user_alert_matches (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  alert_id uuid not null references public.user_alerts(id) on delete cascade,
  sale_id uuid not null references public.auction_sales(id) on delete cascade,
  match_reasons text[] not null default '{}'::text[],
  match_snapshot jsonb not null default '{}'::jsonb,
  matched_at timestamptz not null default now(),
  read_at timestamptz,
  dismissed_at timestamptz,
  unique (alert_id, sale_id)
);

comment on table public.user_alert_matches is
  'User-owned materialized matches produced by the ImmoJudis smart-alert engine.';

create index if not exists user_alert_matches_user_matched_idx
  on public.user_alert_matches (user_id, matched_at desc);

create index if not exists user_alert_matches_alert_matched_idx
  on public.user_alert_matches (alert_id, matched_at desc);

create index if not exists user_alert_matches_sale_idx
  on public.user_alert_matches (sale_id);

alter table public.user_alert_matches enable row level security;

revoke all on table public.user_alert_matches from anon, authenticated;
grant select, insert, update, delete on table public.user_alert_matches to authenticated;
grant select, insert, update, delete on table public.user_alert_matches to service_role;

drop policy if exists user_alert_matches_select_authorized
on public.user_alert_matches;
create policy user_alert_matches_select_authorized
on public.user_alert_matches
for select
to authenticated
using (
  user_id = (select auth.uid())
  or public.is_admin()
);

drop policy if exists user_alert_matches_insert_own
on public.user_alert_matches;
create policy user_alert_matches_insert_own
on public.user_alert_matches
for insert
to authenticated
with check (
  user_id = (select auth.uid())
  and exists (
    select 1
    from public.user_alerts alert
    where alert.id = alert_id
      and alert.user_id = (select auth.uid())
  )
);

drop policy if exists user_alert_matches_update_own
on public.user_alert_matches;
create policy user_alert_matches_update_own
on public.user_alert_matches
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

drop policy if exists user_alert_matches_delete_own
on public.user_alert_matches;
create policy user_alert_matches_delete_own
on public.user_alert_matches
for delete
to authenticated
using (
  user_id = (select auth.uid())
  or public.is_admin()
);

notify pgrst, 'reload schema';

commit;
