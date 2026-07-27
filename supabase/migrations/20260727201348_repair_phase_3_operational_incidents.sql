begin;

-- The sale-change cron discovers eligible users through the service-role
-- client. RLS bypass does not replace the underlying table privilege.
grant select on table public.user_profiles to service_role;

commit;
