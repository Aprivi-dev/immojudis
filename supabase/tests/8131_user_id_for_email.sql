-- 20261110130100 : retrouver le compte d'une adresse email, pour le webhook Resend des rebonds et plaintes.
begin;

select plan(7);

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data
) values
  ('81310000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'confirmed-8131@example.test', '', now(), now(), now(),
   '{}'::jsonb, '{}'::jsonb),
  ('81310000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'pending-8131@example.test', '', null, now(), now(),
   '{}'::jsonb, '{}'::jsonb);

select is(
  public.user_id_for_email('confirmed-8131@example.test'),
  '81310000-0000-4000-8000-000000000001'::uuid,
  'a confirmed address gives its account'
);

select is(
  public.user_id_for_email('  Confirmed-8131@Example.test '),
  '81310000-0000-4000-8000-000000000001'::uuid,
  'the match ignores case and surrounding spaces'
);

select is(
  public.user_id_for_email('pending-8131@example.test'),
  null::uuid,
  'an unconfirmed address is not matched'
);

select is(
  public.user_id_for_email('nobody-8131@example.test'),
  null::uuid,
  'an unknown address gives null'
);

select ok(
  has_function_privilege('service_role', 'public.user_id_for_email(text)', 'execute'),
  'the service role can call it'
);

select ok(
  not has_function_privilege('anon', 'public.user_id_for_email(text)', 'execute')
  and not has_function_privilege('authenticated', 'public.user_id_for_email(text)', 'execute'),
  'neither anon nor authenticated can call it'
);

select is(
  (select proconfig from pg_proc where oid = 'public.user_id_for_email(text)'::regprocedure),
  array['search_path=""']::text[],
  'it pins an empty search_path'
);

select * from finish();
rollback;
