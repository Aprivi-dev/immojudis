begin;

create table if not exists public.user_watched_zones (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (
    char_length(btrim(name)) between 2 and 120
  ),
  zone_kind text not null default 'city' check (
    zone_kind in ('department', 'city', 'postal_code', 'radius', 'custom')
  ),
  department text,
  city text,
  postal_code_prefix text,
  center_lat double precision,
  center_lng double precision,
  radius_km numeric check (
    radius_km is null or (radius_km > 0 and radius_km <= 200)
  ),
  alert_defaults jsonb not null default '{}'::jsonb,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    zone_kind <> 'department'
    or nullif(btrim(coalesce(department, '')), '') is not null
  ),
  check (
    zone_kind <> 'city'
    or nullif(btrim(coalesce(city, '')), '') is not null
  ),
  check (
    zone_kind <> 'postal_code'
    or nullif(btrim(coalesce(postal_code_prefix, '')), '') is not null
  ),
  check (
    zone_kind <> 'radius'
    or (
      center_lat is not null
      and center_lng is not null
      and radius_km is not null
      and center_lat between -90 and 90
      and center_lng between -180 and 180
    )
  ),
  unique (user_id, name),
  unique (user_id, id)
);

comment on table public.user_watched_zones is
  'User-owned watched geographic zones reused by smart alerts and investor monitoring.';

comment on column public.user_watched_zones.alert_defaults is
  'Default advanced alert criteria applied when a watched zone is converted into a smart alert.';

alter table public.user_alerts
  add column if not exists watched_zone_id uuid;

alter table public.user_alerts
  drop constraint if exists user_alerts_watched_zone_owner_fkey;

alter table public.user_alerts
  add constraint user_alerts_watched_zone_owner_fkey
  foreign key (user_id, watched_zone_id)
  references public.user_watched_zones (user_id, id);

comment on column public.user_alerts.watched_zone_id is
  'Optional user-owned watched zone used to scope smart alert matching.';

create index if not exists user_watched_zones_user_active_idx
  on public.user_watched_zones (user_id, is_active, updated_at desc);

create index if not exists user_watched_zones_location_idx
  on public.user_watched_zones (department, city, postal_code_prefix)
  where is_active;

create index if not exists user_alerts_watched_zone_idx
  on public.user_alerts (user_id, watched_zone_id)
  where watched_zone_id is not null;

alter table public.user_watched_zones enable row level security;

revoke all on table public.user_watched_zones from anon, authenticated;
grant select, insert, update, delete on table public.user_watched_zones to authenticated;
grant select, insert, update, delete on table public.user_watched_zones to service_role;

drop trigger if exists immojudis_user_watched_zones_updated_at
on public.user_watched_zones;
create trigger immojudis_user_watched_zones_updated_at
before update on public.user_watched_zones
for each row
execute function app_private.set_user_profiles_updated_at();

drop policy if exists user_watched_zones_select_authorized
on public.user_watched_zones;
create policy user_watched_zones_select_authorized
on public.user_watched_zones
for select
to authenticated
using (
  user_id = (select auth.uid())
  or public.is_admin()
);

drop policy if exists user_watched_zones_insert_own
on public.user_watched_zones;
create policy user_watched_zones_insert_own
on public.user_watched_zones
for insert
to authenticated
with check (user_id = (select auth.uid()));

drop policy if exists user_watched_zones_update_own
on public.user_watched_zones;
create policy user_watched_zones_update_own
on public.user_watched_zones
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

drop policy if exists user_watched_zones_delete_own
on public.user_watched_zones;
create policy user_watched_zones_delete_own
on public.user_watched_zones
for delete
to authenticated
using (
  user_id = (select auth.uid())
  or public.is_admin()
);

notify pgrst, 'reload schema';

commit;
