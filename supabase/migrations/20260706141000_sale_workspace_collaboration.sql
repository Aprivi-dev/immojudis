begin;

create table if not exists public.sale_workspace_collaborators (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.sale_workspaces(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  invited_by uuid not null references auth.users(id) on delete cascade,
  invited_email text not null,
  collaborator_user_id uuid references auth.users(id) on delete set null,
  role text not null default 'commenter' check (
    role in ('viewer', 'commenter', 'editor')
  ),
  status text not null default 'invited' check (
    status in ('invited', 'accepted', 'revoked')
  ),
  invited_at timestamptz not null default now(),
  accepted_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint sale_workspace_collaborators_email_check
    check (position('@' in invited_email) > 1)
);

comment on table public.sale_workspace_collaborators is
  'Invitations and accepted collaborators for investor sale workspaces. Separate from source-lawyer contacts.';

comment on column public.sale_workspace_collaborators.role is
  'Collaboration permission for dossier annotations: viewer, commenter or editor.';

create unique index if not exists sale_workspace_collaborators_active_email_idx
  on public.sale_workspace_collaborators (workspace_id, lower(trim(invited_email)))
  where status <> 'revoked';

create index if not exists sale_workspace_collaborators_owner_idx
  on public.sale_workspace_collaborators (owner_id, created_at desc);

create index if not exists sale_workspace_collaborators_user_idx
  on public.sale_workspace_collaborators (collaborator_user_id, status)
  where collaborator_user_id is not null;

create table if not exists public.sale_workspace_annotations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.sale_workspaces(id) on delete cascade,
  sale_id uuid not null references public.auction_sales(id) on delete cascade,
  author_id uuid not null references auth.users(id) on delete cascade,
  document_key text,
  document_label text,
  document_type text,
  document_url text,
  target_kind text not null default 'general' check (
    target_kind in ('general', 'document', 'page', 'excerpt')
  ),
  page_number integer check (page_number is null or page_number > 0),
  excerpt text,
  body text not null check (char_length(trim(body)) > 0),
  status text not null default 'open' check (
    status in ('open', 'resolved', 'archived')
  ),
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.sale_workspace_annotations is
  'Collaborative annotations attached to a judicial-sale workspace, documents, pages or excerpts.';

comment on column public.sale_workspace_annotations.excerpt is
  'Short source excerpt selected by a user; should not replace the official document.';

create index if not exists sale_workspace_annotations_workspace_idx
  on public.sale_workspace_annotations (workspace_id, created_at desc);

create index if not exists sale_workspace_annotations_sale_idx
  on public.sale_workspace_annotations (sale_id, status, created_at desc);

create index if not exists sale_workspace_annotations_author_idx
  on public.sale_workspace_annotations (author_id, created_at desc);

alter table public.sale_workspace_collaborators enable row level security;
alter table public.sale_workspace_annotations enable row level security;

revoke all on table public.sale_workspace_collaborators from anon, authenticated;
revoke all on table public.sale_workspace_annotations from anon, authenticated;

grant select, insert, update, delete on table public.sale_workspace_collaborators to authenticated;
grant select, insert, update, delete on table public.sale_workspace_annotations to authenticated;
grant select, insert, update, delete on table public.sale_workspace_collaborators to service_role;
grant select, insert, update, delete on table public.sale_workspace_annotations to service_role;

drop trigger if exists immojudis_sale_workspace_collaborators_updated_at
on public.sale_workspace_collaborators;
create trigger immojudis_sale_workspace_collaborators_updated_at
before update on public.sale_workspace_collaborators
for each row
execute function app_private.set_user_profiles_updated_at();

drop trigger if exists immojudis_sale_workspace_annotations_updated_at
on public.sale_workspace_annotations;
create trigger immojudis_sale_workspace_annotations_updated_at
before update on public.sale_workspace_annotations
for each row
execute function app_private.set_user_profiles_updated_at();

drop policy if exists sale_workspace_collaborators_select_authorized
on public.sale_workspace_collaborators;
create policy sale_workspace_collaborators_select_authorized
on public.sale_workspace_collaborators
for select
to authenticated
using (
  owner_id = (select auth.uid())
  or collaborator_user_id = (select auth.uid())
  or public.is_admin()
);

drop policy if exists sale_workspace_collaborators_insert_owner
on public.sale_workspace_collaborators;
create policy sale_workspace_collaborators_insert_owner
on public.sale_workspace_collaborators
for insert
to authenticated
with check (
  owner_id = (select auth.uid())
  and invited_by = (select auth.uid())
  and exists (
    select 1
    from public.sale_workspaces workspace
    where workspace.id = workspace_id
      and workspace.user_id = (select auth.uid())
  )
);

drop policy if exists sale_workspace_collaborators_update_owner
on public.sale_workspace_collaborators;
create policy sale_workspace_collaborators_update_owner
on public.sale_workspace_collaborators
for update
to authenticated
using (
  owner_id = (select auth.uid())
  or public.is_admin()
)
with check (
  owner_id = (select auth.uid())
  or public.is_admin()
);

drop policy if exists sale_workspace_collaborators_delete_owner
on public.sale_workspace_collaborators;
create policy sale_workspace_collaborators_delete_owner
on public.sale_workspace_collaborators
for delete
to authenticated
using (
  owner_id = (select auth.uid())
  or public.is_admin()
);

drop policy if exists sale_workspace_annotations_select_authorized
on public.sale_workspace_annotations;
create policy sale_workspace_annotations_select_authorized
on public.sale_workspace_annotations
for select
to authenticated
using (
  exists (
    select 1
    from public.sale_workspaces workspace
    where workspace.id = workspace_id
      and workspace.user_id = (select auth.uid())
  )
  or exists (
    select 1
    from public.sale_workspace_collaborators collaborator
    where collaborator.workspace_id = workspace_id
      and collaborator.collaborator_user_id = (select auth.uid())
      and collaborator.status = 'accepted'
  )
  or public.is_admin()
);

drop policy if exists sale_workspace_annotations_insert_authorized
on public.sale_workspace_annotations;
create policy sale_workspace_annotations_insert_authorized
on public.sale_workspace_annotations
for insert
to authenticated
with check (
  author_id = (select auth.uid())
  and (
    exists (
      select 1
      from public.sale_workspaces workspace
      where workspace.id = workspace_id
        and workspace.user_id = (select auth.uid())
        and workspace.sale_id = sale_id
    )
    or exists (
      select 1
      from public.sale_workspace_collaborators collaborator
      where collaborator.workspace_id = workspace_id
        and collaborator.collaborator_user_id = (select auth.uid())
        and collaborator.status = 'accepted'
        and collaborator.role in ('commenter', 'editor')
    )
    or public.is_admin()
  )
);

drop policy if exists sale_workspace_annotations_update_authorized
on public.sale_workspace_annotations;
create policy sale_workspace_annotations_update_authorized
on public.sale_workspace_annotations
for update
to authenticated
using (
  author_id = (select auth.uid())
  or exists (
    select 1
    from public.sale_workspaces workspace
    where workspace.id = workspace_id
      and workspace.user_id = (select auth.uid())
  )
  or public.is_admin()
)
with check (
  author_id = (select auth.uid())
  or exists (
    select 1
    from public.sale_workspaces workspace
    where workspace.id = workspace_id
      and workspace.user_id = (select auth.uid())
  )
  or public.is_admin()
);

drop policy if exists sale_workspace_annotations_delete_authorized
on public.sale_workspace_annotations;
create policy sale_workspace_annotations_delete_authorized
on public.sale_workspace_annotations
for delete
to authenticated
using (
  author_id = (select auth.uid())
  or exists (
    select 1
    from public.sale_workspaces workspace
    where workspace.id = workspace_id
      and workspace.user_id = (select auth.uid())
  )
  or public.is_admin()
);

notify pgrst, 'reload schema';

commit;
