begin;

create index if not exists listing_publication_requests_requester_id_idx
on public.listing_publication_requests (requester_id);

create index if not exists listing_publication_requests_reviewed_by_idx
on public.listing_publication_requests (reviewed_by)
where reviewed_by is not null;

create index if not exists listing_publication_requests_status_created_at_idx
on public.listing_publication_requests (status, created_at desc);

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
  or lower(coalesce((select auth.jwt()) ->> 'email', '')) = 'a.privileggio@gmail.com'
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
    lower(coalesce((select auth.jwt()) ->> 'email', '')) = 'a.privileggio@gmail.com'
    or exists (
      select 1
      from public.user_profiles profile
      where profile.user_id = (select auth.uid())
        and profile.account_type = 'b2b'
    )
  )
);

drop policy if exists listing_publication_requests_update_admin
on public.listing_publication_requests;
create policy listing_publication_requests_update_admin
on public.listing_publication_requests
for update
to authenticated
using (lower(coalesce((select auth.jwt()) ->> 'email', '')) = 'a.privileggio@gmail.com')
with check (lower(coalesce((select auth.jwt()) ->> 'email', '')) = 'a.privileggio@gmail.com');

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
    or lower(coalesce((select auth.jwt()) ->> 'email', '')) = 'a.privileggio@gmail.com'
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
    lower(coalesce((select auth.jwt()) ->> 'email', '')) = 'a.privileggio@gmail.com'
    or exists (
      select 1
      from public.user_profiles profile
      where profile.user_id = (select auth.uid())
        and profile.account_type = 'b2b'
    )
  )
);

notify pgrst, 'reload schema';

commit;
