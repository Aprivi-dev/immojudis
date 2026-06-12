begin;

create schema if not exists app_private;
revoke all on schema app_private from public;
revoke all on schema app_private from anon, authenticated;

create table if not exists public.user_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text,
  full_name text,
  account_type text not null default 'b2c' check (account_type in ('b2c', 'b2b')),
  professional_role text check (
    professional_role is null
    or professional_role in ('lawyer', 'notary', 'bailiff', 'court', 'other')
  ),
  organization_name text,
  professional_status text not null default 'not_applicable' check (
    professional_status in ('not_applicable', 'pending', 'approved', 'rejected')
  ),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.user_profiles enable row level security;

revoke all on table public.user_profiles from anon, authenticated;
grant select on table public.user_profiles to authenticated;
grant update (full_name, organization_name, professional_role) on public.user_profiles to authenticated;

create or replace function app_private.set_user_profiles_updated_at()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists immojudis_user_profiles_updated_at on public.user_profiles;
create trigger immojudis_user_profiles_updated_at
before update on public.user_profiles
for each row
execute function app_private.set_user_profiles_updated_at();

create or replace function app_private.handle_new_user_profile()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  requested_account_type text := coalesce(new.raw_user_meta_data ->> 'account_type', 'b2c');
  normalized_account_type text := case
    when requested_account_type in ('b2b', 'pro', 'professional') then 'b2b'
    else 'b2c'
  end;
  requested_role text := new.raw_user_meta_data ->> 'professional_role';
  normalized_role text := case
    when normalized_account_type = 'b2b'
      and requested_role in ('lawyer', 'notary', 'bailiff', 'court', 'other')
      then requested_role
    else null
  end;
begin
  insert into public.user_profiles (
    user_id,
    email,
    full_name,
    account_type,
    professional_role,
    organization_name,
    professional_status
  )
  values (
    new.id,
    new.email,
    nullif(btrim(new.raw_user_meta_data ->> 'full_name'), ''),
    normalized_account_type,
    normalized_role,
    case
      when normalized_account_type = 'b2b'
        then nullif(btrim(new.raw_user_meta_data ->> 'organization_name'), '')
      else null
    end,
    case
      when normalized_account_type = 'b2b' then 'pending'
      else 'not_applicable'
    end
  )
  on conflict (user_id) do nothing;

  return new;
end;
$$;

drop trigger if exists immojudis_handle_new_user_profile on auth.users;
create trigger immojudis_handle_new_user_profile
after insert on auth.users
for each row
execute function app_private.handle_new_user_profile();

drop policy if exists user_profiles_select_own on public.user_profiles;
create policy user_profiles_select_own
on public.user_profiles
for select
to authenticated
using (user_id = auth.uid());

drop policy if exists user_profiles_select_admin on public.user_profiles;
create policy user_profiles_select_admin
on public.user_profiles
for select
to authenticated
using (lower(coalesce(auth.jwt() ->> 'email', '')) = 'a.privileggio@gmail.com');

drop policy if exists user_profiles_update_own_limited on public.user_profiles;
create policy user_profiles_update_own_limited
on public.user_profiles
for update
to authenticated
using (user_id = auth.uid())
with check (user_id = auth.uid());

insert into public.user_profiles (
  user_id,
  email,
  full_name,
  account_type,
  professional_role,
  organization_name,
  professional_status
)
select
  u.id,
  u.email,
  nullif(btrim(u.raw_user_meta_data ->> 'full_name'), ''),
  case
    when coalesce(u.raw_user_meta_data ->> 'account_type', 'b2c') in ('b2b', 'pro', 'professional')
      then 'b2b'
    else 'b2c'
  end as account_type,
  case
    when coalesce(u.raw_user_meta_data ->> 'account_type', 'b2c') in ('b2b', 'pro', 'professional')
      and (u.raw_user_meta_data ->> 'professional_role') in ('lawyer', 'notary', 'bailiff', 'court', 'other')
      then u.raw_user_meta_data ->> 'professional_role'
    else null
  end as professional_role,
  case
    when coalesce(u.raw_user_meta_data ->> 'account_type', 'b2c') in ('b2b', 'pro', 'professional')
      then nullif(btrim(u.raw_user_meta_data ->> 'organization_name'), '')
    else null
  end as organization_name,
  case
    when coalesce(u.raw_user_meta_data ->> 'account_type', 'b2c') in ('b2b', 'pro', 'professional')
      then 'pending'
    else 'not_applicable'
  end as professional_status
from auth.users u
on conflict (user_id) do nothing;

notify pgrst, 'reload schema';

commit;
