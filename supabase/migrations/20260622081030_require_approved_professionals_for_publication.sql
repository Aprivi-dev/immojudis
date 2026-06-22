begin;

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
        and profile.professional_status = 'approved'
    )
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
        and profile.professional_status = 'approved'
    )
  )
);

notify pgrst, 'reload schema';

commit;
