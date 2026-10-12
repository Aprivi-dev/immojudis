begin;

select plan(8);

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data
) values (
  '44300000-0000-4000-8000-000000000001',
  '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated', 'mfa-admin@example.test', '', now(),
  now(), now(), '{}'::jsonb, '{}'::jsonb
);

insert into public.user_profiles (user_id, email, user_role)
values ('44300000-0000-4000-8000-000000000001', 'mfa-admin@example.test', 'admin')
on conflict (user_id) do update set user_role = 'admin';

select is(
  (select enabled from app_private.security_switches where switch_name = 'admin_mfa_required'),
  false,
  'the administrator MFA requirement is OFF by default (no lockout on deploy)'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"44300000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal1"}',
  true
);

select ok(public.is_admin(), 'with the switch off an aal1 administrator keeps admin rights');

select throws_ok(
  $$select app_private.set_admin_mfa_required(true)$$,
  'P0001',
  null,
  'the switch cannot be turned on while no administrator has a verified factor'
);

-- Simulate an enrolled administrator, then turn the requirement on.
insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at)
values (
  '44300000-0000-4000-8000-0000000000f1',
  '44300000-0000-4000-8000-000000000001',
  'pgtap', 'totp', 'verified', now(), now()
);

select is(app_private.set_admin_mfa_required(true), true, 'the switch can be turned on once a factor is verified');

select ok(
  not public.is_admin() and not app_private.current_user_is_admin(),
  'with the switch on an aal1 administrator loses admin rights'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"44300000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal2"}',
  true
);

select ok(public.is_admin(), 'with the switch on an aal2 administrator keeps admin rights');

select set_config(
  'request.jwt.claims',
  '{"sub":"44300000-0000-4000-8000-000000000001","role":"authenticated"}',
  true
);

select ok(not public.is_admin(), 'a JWT without an aal claim is treated as aal1');

select is(app_private.set_admin_mfa_required(false), false, 'the switch can be turned back off');

select * from finish();
rollback;
