begin;

select plan(7);

insert into auth.users (
  id,
  instance_id,
  aud,
  role,
  email,
  encrypted_password,
  email_confirmed_at,
  created_at,
  updated_at,
  raw_app_meta_data,
  raw_user_meta_data
) values
  (
    '10000000-0000-0000-0000-000000000001',
    '00000000-0000-0000-0000-000000000000',
    'authenticated',
    'authenticated',
    'owner-one@example.test',
    '',
    now(),
    now(),
    now(),
    '{}'::jsonb,
    '{}'::jsonb
  ),
  (
    '10000000-0000-0000-0000-000000000002',
    '00000000-0000-0000-0000-000000000000',
    'authenticated',
    'authenticated',
    'owner-two@example.test',
    '',
    now(),
    now(),
    now(),
    '{}'::jsonb,
    '{}'::jsonb
  ),
  (
    '10000000-0000-0000-0000-000000000003',
    '00000000-0000-0000-0000-000000000000',
    'authenticated',
    'authenticated',
    'collaborator@example.test',
    '',
    now(),
    now(),
    now(),
    '{}'::jsonb,
    '{}'::jsonb
  );

insert into public.auction_sales (id, source_name, source_url) values
  ('20000000-0000-0000-0000-000000000001', 'test', 'https://example.test/sale-one'),
  ('20000000-0000-0000-0000-000000000002', 'test', 'https://example.test/sale-two');

insert into public.sale_workspaces (id, user_id, sale_id) values
  (
    '30000000-0000-0000-0000-000000000001',
    '10000000-0000-0000-0000-000000000001',
    '20000000-0000-0000-0000-000000000001'
  ),
  (
    '30000000-0000-0000-0000-000000000002',
    '10000000-0000-0000-0000-000000000002',
    '20000000-0000-0000-0000-000000000002'
  );

insert into public.sale_workspace_collaborators (
  id,
  workspace_id,
  owner_id,
  invited_by,
  invited_email,
  collaborator_user_id,
  role,
  status
) values (
  '40000000-0000-0000-0000-000000000001',
  '30000000-0000-0000-0000-000000000001',
  '10000000-0000-0000-0000-000000000001',
  '10000000-0000-0000-0000-000000000001',
  'collaborator@example.test',
  '10000000-0000-0000-0000-000000000003',
  'commenter',
  'accepted'
);

insert into public.sale_workspace_annotations (
  id,
  workspace_id,
  sale_id,
  author_id,
  body
) values (
  '50000000-0000-0000-0000-000000000001',
  '30000000-0000-0000-0000-000000000001',
  '20000000-0000-0000-0000-000000000001',
  '10000000-0000-0000-0000-000000000001',
  'Initial annotation'
);

set local role authenticated;
set local "request.jwt.claim.sub" = '10000000-0000-0000-0000-000000000001';
set local "request.jwt.claim.role" = 'authenticated';

select lives_ok(
  $$update public.sale_workspace_collaborators
    set role = 'editor'
    where id = '40000000-0000-0000-0000-000000000001'$$,
  'workspace owner may update mutable collaborator fields'
);

select throws_ok(
  $$update public.sale_workspace_collaborators
    set workspace_id = '30000000-0000-0000-0000-000000000002'
    where id = '40000000-0000-0000-0000-000000000001'$$,
  '42501',
  'permission denied for table sale_workspace_collaborators',
  'workspace owner cannot re-parent a collaborator row'
);

select throws_ok(
  $$update public.sale_workspace_collaborators
    set owner_id = '10000000-0000-0000-0000-000000000002'
    where id = '40000000-0000-0000-0000-000000000001'$$,
  '42501',
  'permission denied for table sale_workspace_collaborators',
  'workspace owner cannot transfer collaborator ownership'
);

select lives_ok(
  $$update public.sale_workspace_annotations
    set body = 'Updated annotation'
    where id = '50000000-0000-0000-0000-000000000001'$$,
  'annotation author may update mutable annotation fields'
);

select throws_ok(
  $$update public.sale_workspace_annotations
    set workspace_id = '30000000-0000-0000-0000-000000000002'
    where id = '50000000-0000-0000-0000-000000000001'$$,
  '42501',
  'permission denied for table sale_workspace_annotations',
  'annotation author cannot re-parent an annotation row'
);

select throws_ok(
  $$update public.sale_workspace_annotations
    set author_id = '10000000-0000-0000-0000-000000000002'
    where id = '50000000-0000-0000-0000-000000000001'$$,
  '42501',
  'permission denied for table sale_workspace_annotations',
  'annotation author cannot transfer annotation authorship'
);

set local "request.jwt.claim.sub" = '10000000-0000-0000-0000-000000000003';

select throws_ok(
  $$insert into public.sale_workspace_annotations (
      workspace_id,
      sale_id,
      author_id,
      body
    ) values (
      '30000000-0000-0000-0000-000000000001',
      '20000000-0000-0000-0000-000000000002',
      '10000000-0000-0000-0000-000000000003',
      'Cross-sale annotation'
    )$$,
  '42501',
  'new row violates row-level security policy for table "sale_workspace_annotations"',
  'a collaborator cannot attach an annotation to another sale'
);

select * from finish();

rollback;
