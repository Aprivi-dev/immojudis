begin;

-- The project revokes broad default grants. These marketplace tables are only
-- accessed by trusted server routes through the Supabase service role.
grant select, insert, update, delete
on table public.referenced_lawyers
to service_role;

grant select, insert, update, delete
on table public.referenced_lawyer_coverage
to service_role;

grant select, insert, update, delete
on table public.lawyer_referral_requests
to service_role;

notify pgrst, 'reload schema';

commit;
