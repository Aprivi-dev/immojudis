begin;

create or replace function public.is_admin()
returns boolean
language sql
stable
security invoker
set search_path = public
as $$
  select
    coalesce((select auth.jwt()) -> 'app_metadata' ->> 'role', '') = 'admin'
    or lower(coalesce((select auth.jwt()) ->> 'email', '')) = 'a.privileggio@gmail.com';
$$;

revoke all on function public.is_admin() from public;
grant execute on function public.is_admin() to authenticated;

drop policy if exists user_profiles_select_own on public.user_profiles;
drop policy if exists user_profiles_select_admin on public.user_profiles;
drop policy if exists user_profiles_select_authorized on public.user_profiles;
create policy user_profiles_select_authorized
on public.user_profiles
for select
to authenticated
using (
  user_id = (select auth.uid())
  or public.is_admin()
);

drop policy if exists listing_publication_requests_select_own
on public.listing_publication_requests;
drop policy if exists listing_publication_requests_select_admin
on public.listing_publication_requests;
drop policy if exists listing_publication_requests_select_authorized
on public.listing_publication_requests;
create policy listing_publication_requests_select_authorized
on public.listing_publication_requests
for select
to authenticated
using (
  requester_id = (select auth.uid())
  or public.is_admin()
);

drop policy if exists listing_publication_requests_insert_pro
on public.listing_publication_requests;
create policy listing_publication_requests_insert_pro
on public.listing_publication_requests
for insert
to authenticated
with check (
  requester_id = (select auth.uid())
  and (
    public.is_admin()
    or exists (
      select 1
      from public.user_profiles profile
      where profile.user_id = (select auth.uid())
        and profile.account_type = 'b2b'
        and profile.professional_status = 'approved'
    )
  )
);

drop policy if exists listing_publication_requests_update_admin
on public.listing_publication_requests;
create policy listing_publication_requests_update_admin
on public.listing_publication_requests
for update
to authenticated
using (public.is_admin())
with check (public.is_admin());

drop policy if exists listing_request_documents_select_own
on storage.objects;
drop policy if exists listing_request_documents_select_admin
on storage.objects;
drop policy if exists listing_request_documents_select_authorized
on storage.objects;
create policy listing_request_documents_select_authorized
on storage.objects
for select
to authenticated
using (
  bucket_id = 'listing-request-documents'
  and (
    (storage.foldername(name))[1] = (select auth.uid())::text
    or public.is_admin()
  )
);

drop policy if exists listing_request_documents_insert_pro
on storage.objects;
create policy listing_request_documents_insert_pro
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'listing-request-documents'
  and (storage.foldername(name))[1] = (select auth.uid())::text
  and (
    public.is_admin()
    or exists (
      select 1
      from public.user_profiles profile
      where profile.user_id = (select auth.uid())
        and profile.account_type = 'b2b'
        and profile.professional_status = 'approved'
    )
  )
);

notify pgrst, 'reload schema';

commit;
