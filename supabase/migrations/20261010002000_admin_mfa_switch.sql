-- P0-02: require a second factor (aal2) for administrator rights in the database.
--
-- The requirement is behind a switch that defaults to OFF, so deploying this migration can never
-- lock the administrator out before a TOTP factor is enrolled (/admin/securite). Once a factor is
-- verified, an operator turns it on with:
--
--   select app_private.set_admin_mfa_required(true);
--
-- and off again with set_admin_mfa_required(false). While ON, app_private.current_user_is_admin()
-- (and therefore public.is_admin(), which delegates to it, and the ~70 RLS policies built on it)
-- only returns true for a session whose JWT carries aal = 'aal2'. The Next.js middleware enforces the
-- same rule through ADMIN_MFA_REQUIRED (default false).
begin;
set local lock_timeout = '5s';

create table if not exists app_private.security_switches (
  switch_name text primary key check (switch_name in ('admin_mfa_required')),
  enabled boolean not null default false,
  updated_at timestamptz not null default now(),
  updated_by text
);

alter table app_private.security_switches enable row level security;
revoke all on table app_private.security_switches from public, anon, authenticated;
grant select on table app_private.security_switches to service_role;

insert into app_private.security_switches (switch_name, enabled)
values ('admin_mfa_required', false)
on conflict (switch_name) do nothing;

create or replace function app_private.current_user_is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.user_profiles profile
    where profile.user_id = (select auth.uid())
      and profile.user_role = 'admin'
  )
  and (
    not coalesce((
      select switch.enabled
      from app_private.security_switches switch
      where switch.switch_name = 'admin_mfa_required'
    ), false)
    or coalesce((select auth.jwt() ->> 'aal'), 'aal1') = 'aal2'
  );
$$;

comment on function app_private.current_user_is_admin() is
  'True for the signed-in administrator. When app_private.security_switches.admin_mfa_required is on, the JWT must also carry aal = aal2 (TOTP verified). public.is_admin() delegates here.';

-- Operator helper (run as the migration/postgres role). Enabling is refused unless at least one
-- administrator already has a verified factor, so the switch cannot orphan the admin area.
create or replace function app_private.set_admin_mfa_required(p_enabled boolean)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if p_enabled and not exists (
    select 1
    from auth.mfa_factors factor
    join public.user_profiles profile on profile.user_id = factor.user_id
    where factor.status = 'verified'
      and profile.user_role = 'admin'
  ) then
    raise exception 'No administrator has a verified MFA factor: enrol one at /admin/securite first'
      using errcode = 'P0001';
  end if;

  update app_private.security_switches
     set enabled = p_enabled,
         updated_at = now(),
         updated_by = current_user
   where switch_name = 'admin_mfa_required';

  return p_enabled;
end;
$$;

revoke all on function app_private.set_admin_mfa_required(boolean)
  from public, anon, authenticated, service_role;

comment on function app_private.set_admin_mfa_required(boolean) is
  'Turns the database-side administrator MFA requirement on or off. Refuses to turn it on while no administrator has a verified TOTP factor.';

commit;
