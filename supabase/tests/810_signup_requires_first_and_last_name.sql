-- 20261110110000 : l'inscription publique par email exige un prénom et un nom (garantie côté base).
-- Tout compte de fournisseur email est concerné, y compris créé par un administrateur ou invité :
-- à l'INSERT, GoTrue ne les distingue pas (email_confirmed_at et invited_at sont posés après).
-- Seuls les autres fournisseurs et les fixtures SQL sans fournisseur ne sont pas concernés.
begin;

select plan(14);

-- Inscription publique : app_metadata posé par l'API d'inscription, compte non confirmé.
create function pg_temp.c810_insert(
  p_id uuid,
  p_names jsonb,
  p_provider text default 'email'
) returns void
language sql
as $$
  insert into auth.users (
    id, instance_id, aud, role, email, encrypted_password, created_at, updated_at,
    raw_app_meta_data, raw_user_meta_data
  ) values (
    p_id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
    p_id::text || '@c810.example.test', '',
    now(), now(),
    case when p_provider is null then '{}'::jsonb
      else jsonb_build_object('provider', p_provider, 'providers', jsonb_build_array(p_provider))
    end,
    p_names
  );
$$;

-- Refus ---------------------------------------------------------------------------------------------
select throws_ok(
  $$ select pg_temp.c810_insert('81000000-0000-4000-8000-000000000001', '{}'::jsonb) $$,
  '23514',
  'Le prénom et le nom sont obligatoires pour créer un compte.',
  'an email signup without any name is refused'
);
select throws_ok(
  $$ select pg_temp.c810_insert('81000000-0000-4000-8000-000000000002',
       '{"first_name": "Marie"}'::jsonb) $$,
  '23514',
  'Le prénom et le nom sont obligatoires pour créer un compte.',
  'an email signup without last name is refused'
);
select throws_ok(
  $$ select pg_temp.c810_insert('81000000-0000-4000-8000-000000000003',
       '{"last_name": "Dupont"}'::jsonb) $$,
  '23514',
  'Le prénom et le nom sont obligatoires pour créer un compte.',
  'an email signup without first name is refused'
);
select throws_ok(
  $$ select pg_temp.c810_insert('81000000-0000-4000-8000-000000000004',
       jsonb_build_object('first_name', E'  \t ', 'last_name', 'Dupont')) $$,
  '23514',
  'Le prénom et le nom sont obligatoires pour créer un compte.',
  'a first name made of spaces only is refused'
);
select throws_ok(
  $$ select pg_temp.c810_insert('81000000-0000-4000-8000-000000000005',
       jsonb_build_object('first_name', 'Marie', 'last_name', E'   ')) $$,
  '23514',
  'Le prénom et le nom sont obligatoires pour créer un compte.',
  'a last name made of spaces and a no-break space only is refused'
);
select throws_ok(
  $$ select pg_temp.c810_insert('81000000-0000-4000-8000-000000000006',
       '{"first_name": null, "last_name": null}'::jsonb) $$,
  '23514',
  'Le prénom et le nom sont obligatoires pour créer un compte.',
  'null names are refused (the form sends null when the name is missing)'
);
select is(
  (select count(*)::int from auth.users where email like '%@c810.example.test'),
  0,
  'a refused signup leaves no account behind'
);

-- Acceptation ---------------------------------------------------------------------------------------
select lives_ok(
  $$ select pg_temp.c810_insert('81000000-0000-4000-8000-000000000011',
       '{"first_name": "Marie", "last_name": "Dupont", "full_name": "Marie Dupont"}'::jsonb) $$,
  'an email signup with first and last name is accepted'
);
select is(
  (select full_name from public.user_profiles where user_id = '81000000-0000-4000-8000-000000000011'),
  'Marie Dupont',
  'the accepted signup gets its profile, with the full name'
);

-- Hors fournisseur email -----------------------------------------------------------------------------
select lives_ok(
  $$ select pg_temp.c810_insert('81000000-0000-4000-8000-000000000021', '{}'::jsonb, 'google') $$,
  'a signup through another provider without name is not blocked'
);
select lives_ok(
  $$ select pg_temp.c810_insert('81000000-0000-4000-8000-000000000022', '{}'::jsonb, null) $$,
  'an account without provider (SQL fixtures, scripts) is not blocked'
);
-- Création par un administrateur ou invitation : même INSERT que l'inscription publique.
select throws_ok(
  $$ select pg_temp.c810_insert('81000000-0000-4000-8000-000000000023', '{}'::jsonb, 'email') $$,
  '23514',
  'Le prénom et le nom sont obligatoires pour créer un compte.',
  'an administrator-created or invited email account without name is refused'
);
select lives_ok(
  $$ select pg_temp.c810_insert('81000000-0000-4000-8000-000000000024',
       '{"first_name": "Marie", "last_name": "Dupont"}'::jsonb, 'email') $$,
  'an administrator-created or invited email account with first and last name is accepted'
);
select is(
  (select count(*)::int from public.user_profiles
    where user_id in (
      '81000000-0000-4000-8000-000000000021', '81000000-0000-4000-8000-000000000022',
      '81000000-0000-4000-8000-000000000024')),
  3,
  'the accepted accounts get a profile'
);

select * from finish();
rollback;
