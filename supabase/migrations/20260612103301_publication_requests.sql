begin;

create table if not exists public.listing_publication_requests (
  id uuid primary key default gen_random_uuid(),
  requester_id uuid not null references auth.users(id) on delete cascade,
  requester_email text,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  title text not null,
  location text,
  starting_price_eur numeric,
  hearing_date date,
  court text,
  description text,
  strengths text,
  cautions text,
  anonymize_documents boolean not null default true,
  document_types text[] not null default '{}',
  promotion_options text[] not null default '{}',
  submitted_documents jsonb not null default '[]'::jsonb,
  admin_notes text,
  reviewed_by uuid references auth.users(id) on delete set null,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.listing_publication_requests enable row level security;

revoke all on table public.listing_publication_requests from anon, authenticated;
grant select, insert on table public.listing_publication_requests to authenticated;
grant update (
  status,
  admin_notes,
  reviewed_by,
  reviewed_at,
  updated_at
) on public.listing_publication_requests to authenticated;

drop trigger if exists immojudis_listing_publication_requests_updated_at
on public.listing_publication_requests;
create trigger immojudis_listing_publication_requests_updated_at
before update on public.listing_publication_requests
for each row
execute function app_private.set_user_profiles_updated_at();

drop policy if exists listing_publication_requests_select_own
on public.listing_publication_requests;
create policy listing_publication_requests_select_own
on public.listing_publication_requests
for select
to authenticated
using (requester_id = auth.uid());

drop policy if exists listing_publication_requests_select_admin
on public.listing_publication_requests;
create policy listing_publication_requests_select_admin
on public.listing_publication_requests
for select
to authenticated
using (lower(coalesce(auth.jwt() ->> 'email', '')) = 'a.privileggio@gmail.com');

drop policy if exists listing_publication_requests_insert_pro
on public.listing_publication_requests;
create policy listing_publication_requests_insert_pro
on public.listing_publication_requests
for insert
to authenticated
with check (
  requester_id = auth.uid()
  and (
    lower(coalesce(auth.jwt() ->> 'email', '')) = 'a.privileggio@gmail.com'
    or exists (
      select 1
      from public.user_profiles profile
      where profile.user_id = auth.uid()
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
using (lower(coalesce(auth.jwt() ->> 'email', '')) = 'a.privileggio@gmail.com')
with check (lower(coalesce(auth.jwt() ->> 'email', '')) = 'a.privileggio@gmail.com');

insert into storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
)
values (
  'listing-request-documents',
  'listing-request-documents',
  false,
  52428800,
  array[
    'application/pdf',
    'image/jpeg',
    'image/png',
    'image/webp',
    'image/heic',
    'image/heif'
  ]
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

grant select on table storage.buckets to authenticated;
grant select, insert on table storage.objects to authenticated;

drop policy if exists listing_request_documents_insert_pro
on storage.objects;
create policy listing_request_documents_insert_pro
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'listing-request-documents'
  and (storage.foldername(name))[1] = auth.uid()::text
  and (
    lower(coalesce(auth.jwt() ->> 'email', '')) = 'a.privileggio@gmail.com'
    or exists (
      select 1
      from public.user_profiles profile
      where profile.user_id = auth.uid()
        and profile.account_type = 'b2b'
    )
  )
);

drop policy if exists listing_request_documents_select_own
on storage.objects;
create policy listing_request_documents_select_own
on storage.objects
for select
to authenticated
using (
  bucket_id = 'listing-request-documents'
  and (storage.foldername(name))[1] = auth.uid()::text
);

drop policy if exists listing_request_documents_select_admin
on storage.objects;
create policy listing_request_documents_select_admin
on storage.objects
for select
to authenticated
using (
  bucket_id = 'listing-request-documents'
  and lower(coalesce(auth.jwt() ->> 'email', '')) = 'a.privileggio@gmail.com'
);

notify pgrst, 'reload schema';

commit;
