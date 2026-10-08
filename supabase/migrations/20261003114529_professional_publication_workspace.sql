begin;

alter table public.listing_publication_requests
  add column if not exists published_sale_id uuid references public.auction_sales(id) on delete set null,
  add column if not exists published_at timestamptz;

create index if not exists listing_publication_requests_published_sale_id_idx
  on public.listing_publication_requests (published_sale_id)
  where published_sale_id is not null;

-- Existing legacy rows may predate the required email capture. The NOT VALID
-- check still applies to every new insert while allowing those rows to remain
-- visible to their owner and to administrators.
alter table public.listing_publication_requests
  drop constraint if exists listing_publication_requests_requester_email_check,
  add constraint listing_publication_requests_requester_email_check
    check (requester_email is not null and btrim(requester_email) <> '') not valid;

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
  and requester_email is not null
  and btrim(requester_email) <> ''
  and lower(btrim(requester_email)) = lower(coalesce((select auth.jwt()) ->> 'email', ''))
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
