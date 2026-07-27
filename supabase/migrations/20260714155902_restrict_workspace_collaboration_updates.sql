begin;

-- RLS decides which rows an authenticated user may update. Column privileges
-- independently prevent an authorized row from being re-parented or re-authored.
revoke update on table public.sale_workspace_collaborators from authenticated;
grant update (role, status, revoked_at)
on table public.sale_workspace_collaborators to authenticated;

revoke update on table public.sale_workspace_annotations from authenticated;
grant update (body, status, resolved_at)
on table public.sale_workspace_annotations to authenticated;

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
      where workspace.id = sale_workspace_annotations.workspace_id
        and workspace.user_id = (select auth.uid())
        and workspace.sale_id = sale_workspace_annotations.sale_id
    )
    or exists (
      select 1
      from public.sale_workspace_collaborators collaborator
      join public.sale_workspaces workspace
        on workspace.id = collaborator.workspace_id
      where collaborator.workspace_id = sale_workspace_annotations.workspace_id
        and workspace.sale_id = sale_workspace_annotations.sale_id
        and collaborator.collaborator_user_id = (select auth.uid())
        and collaborator.status = 'accepted'
        and collaborator.role in ('commenter', 'editor')
    )
    or public.is_admin()
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
  public.is_admin()
  or (
    owner_id = (select auth.uid())
    and exists (
      select 1
      from public.sale_workspaces workspace
      where workspace.id = sale_workspace_collaborators.workspace_id
        and workspace.user_id = (select auth.uid())
    )
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
    where workspace.id = sale_workspace_annotations.workspace_id
      and workspace.user_id = (select auth.uid())
      and workspace.sale_id = sale_workspace_annotations.sale_id
  )
  or public.is_admin()
)
with check (
  public.is_admin()
  or exists (
    select 1
    from public.sale_workspaces workspace
    where workspace.id = sale_workspace_annotations.workspace_id
      and workspace.user_id = (select auth.uid())
      and workspace.sale_id = sale_workspace_annotations.sale_id
  )
  or (
    author_id = (select auth.uid())
    and exists (
      select 1
      from public.sale_workspace_collaborators collaborator
      join public.sale_workspaces workspace
        on workspace.id = collaborator.workspace_id
      where collaborator.workspace_id = sale_workspace_annotations.workspace_id
        and workspace.sale_id = sale_workspace_annotations.sale_id
        and collaborator.collaborator_user_id = (select auth.uid())
        and collaborator.status = 'accepted'
        and collaborator.role in ('commenter', 'editor')
    )
  )
);

notify pgrst, 'reload schema';

commit;
