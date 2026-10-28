-- Motif des prolongations d'essai (20261108130200) : table privée, jamais lisible par le compte ni
-- par anon ; seul le serveur écrit, avec un motif obligatoire.
begin;

select plan(9);

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data
) values
  ('c7720000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'note@note772.example.test', '', now(),
   now(), now(), '{}'::jsonb, '{}'::jsonb);

select ok(
  (select relrowsecurity from pg_class where oid = 'app_private.trial_extension_notes'::regclass),
  'RLS is enabled on the notes table'
);
select ok(
  not has_table_privilege('anon', 'app_private.trial_extension_notes', 'select')
  and not has_table_privilege('authenticated', 'app_private.trial_extension_notes', 'select')
  and not has_table_privilege('authenticated', 'app_private.trial_extension_notes', 'insert'),
  'the browser roles have no right on the notes table'
);
select ok(
  not has_function_privilege('anon', 'public.record_trial_extension(uuid, uuid, timestamptz, text)', 'execute')
  and not has_function_privilege('authenticated', 'public.record_trial_extension(uuid, uuid, timestamptz, text)', 'execute')
  and has_function_privilege('service_role', 'public.record_trial_extension(uuid, uuid, timestamptz, text)', 'execute'),
  'only service_role records a trial extension'
);

select isnt(
  public.record_trial_extension(
    'c7720000-0000-4000-8000-000000000001',
    'c7720000-0000-4000-8000-0000000000aa',
    now() + interval '14 days',
    '  Demande reçue par email le 28/10  '
  ),
  null::uuid,
  'a reason is recorded and its id returned'
);
select is(
  (select note from app_private.trial_extension_notes
   where user_id = 'c7720000-0000-4000-8000-000000000001'),
  'Demande reçue par email le 28/10',
  'the reason is trimmed'
);
select throws_ok(
  $$select public.record_trial_extension(
      'c7720000-0000-4000-8000-000000000001',
      'c7720000-0000-4000-8000-0000000000aa',
      now() + interval '14 days',
      '  '
    )$$,
  '22023',
  'A trial extension needs a reason.',
  'a blank reason is refused'
);
select throws_ok(
  $$select public.record_trial_extension(
      null,
      'c7720000-0000-4000-8000-0000000000aa',
      now() + interval '14 days',
      'Motif'
    )$$,
  '22023',
  null,
  'a missing account is refused'
);

set local role authenticated;
select throws_ok(
  $$select count(*) from app_private.trial_extension_notes$$,
  '42501',
  null,
  'an authenticated user cannot read the notes'
);
reset role;

delete from auth.users where id = 'c7720000-0000-4000-8000-000000000001';
select is(
  (select count(*) from app_private.trial_extension_notes),
  0::bigint,
  'the notes leave with the account'
);

select * from finish();
rollback;
