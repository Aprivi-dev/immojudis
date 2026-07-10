begin;

-- Keep business access data in the application schema. Supabase's auth.users
-- table is managed by Auth and should not receive custom columns.
alter table public.user_profiles
  add column if not exists account_tier text not null default 'free',
  add column if not exists user_role text not null default 'user';

alter table public.user_profiles
  drop constraint if exists user_profiles_account_tier_check,
  drop constraint if exists user_profiles_user_role_check;

alter table public.user_profiles
  add constraint user_profiles_account_tier_check
    check (account_tier in ('free', 'premium')),
  add constraint user_profiles_user_role_check
    check (user_role in ('user', 'admin'));

comment on column public.user_profiles.account_tier is
  'Manual access tier: free or premium. Premium also remains available through an active Stripe-backed user_subscriptions row.';
comment on column public.user_profiles.user_role is
  'Application role managed by an operator in Supabase Table Editor: user or admin.';

-- Preserve the existing production admin and any active paid access when the
-- new columns are introduced.
update public.user_profiles profile
set user_role = 'admin'
from auth.users auth_user
where auth_user.id = profile.user_id
  and auth_user.raw_app_meta_data ->> 'role' = 'admin';

update public.user_profiles profile
set account_tier = 'premium'
where profile.user_role = 'admin'
   or exists (
     select 1
     from public.user_subscriptions subscription
     where subscription.user_id = profile.user_id
       and subscription.plan_code = 'analyse'
       and subscription.status in ('trialing', 'active')
       and (
         subscription.current_period_end is null
         or subscription.current_period_end > now()
       )
   );

-- End users may read their own access fields, but cannot promote themselves.
-- Dashboard owners and service_role can still edit them manually.
revoke update (account_tier, user_role)
on public.user_profiles
from anon, authenticated;

-- A private SECURITY DEFINER helper avoids recursive RLS when user_profiles
-- policies need to determine whether the current caller is an administrator.
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
  );
$$;

revoke all on function app_private.current_user_is_admin()
from public, anon, authenticated;
grant usage on schema app_private to authenticated, service_role;
grant execute on function app_private.current_user_is_admin()
to authenticated, service_role;

create or replace function public.is_admin()
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select app_private.current_user_is_admin();
$$;

revoke all on function public.is_admin() from public, anon;
grant execute on function public.is_admin() to authenticated, service_role;

-- Manual premium, Stripe premium and admin all unlock the paid feature set.
create or replace function app_private.current_user_has_premium_access()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    exists (
      select 1
      from public.user_profiles profile
      where profile.user_id = (select auth.uid())
        and (
          profile.user_role = 'admin'
          or profile.account_tier = 'premium'
        )
    )
    or exists (
      select 1
      from public.user_subscriptions subscription
      where subscription.user_id = (select auth.uid())
        and subscription.plan_code = 'analyse'
        and subscription.status in ('trialing', 'active')
        and (
          subscription.current_period_end is null
          or subscription.current_period_end > now()
        )
    );
$$;

revoke all on function app_private.current_user_has_premium_access()
from public, anon, authenticated;
grant execute on function app_private.current_user_has_premium_access()
to authenticated, service_role;

create or replace function public.has_analysis_access()
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select app_private.current_user_has_premium_access();
$$;

revoke all on function public.has_analysis_access() from public, anon;
grant execute on function public.has_analysis_access() to authenticated, service_role;

notify pgrst, 'reload schema';

commit;
