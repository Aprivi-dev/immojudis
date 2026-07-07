begin;

alter table public.saved_property_reports
  add column if not exists share_token text unique,
  add column if not exists share_enabled boolean not null default false,
  add column if not exists shared_at timestamptz,
  add column if not exists share_expires_at timestamptz,
  add column if not exists share_view_count integer not null default 0 check (share_view_count >= 0);

comment on column public.saved_property_reports.share_token is
  'Opaque token used by the server-side public report sharing endpoint. Reports are not public unless share_enabled is true.';

comment on column public.saved_property_reports.share_enabled is
  'Opt-in flag for public report sharing. RLS remains unchanged; anonymous access is served only through application routes.';

comment on column public.saved_property_reports.share_expires_at is
  'Optional expiration timestamp for shared report links.';

create index if not exists saved_property_reports_share_lookup_idx
  on public.saved_property_reports (share_token)
  where share_enabled = true
    and share_token is not null;

notify pgrst, 'reload schema';

commit;
