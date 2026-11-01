-- Profil d'investisseur (20261110160100) : données personnelles financières d'un compte. Aucun droit pour
-- anon ni authenticated (accès par le rôle de service seulement, par les routes du compte), sécurité par
-- ligne « propriétaire seul » en plus, bornes, une ligne par compte, date posée par la base, effacement
-- avec le compte.
begin;

select plan(14);

-- Fixtures -------------------------------------------------------------------------------------
insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data
) values
  ('c8170000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'profile-one@example.test', '', null, now(), now(),
   '{}'::jsonb, '{}'::jsonb),
  ('c8170000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'profile-two@example.test', '', null, now(), now(),
   '{}'::jsonb, '{}'::jsonb);

insert into public.user_investor_profiles (user_id, down_payment_eur, target_margin_pct, works_per_m2_eur, strategy)
values ('c8170000-0000-4000-8000-000000000002', 50000, 15, 800, 'louer');

-- Structure -------------------------------------------------------------------------------------
select has_table('public', 'user_investor_profiles', 'the investor profile table exists');
select ok(
  (select relrowsecurity from pg_class where oid = 'public.user_investor_profiles'::regclass)
  and not has_table_privilege('anon', 'public.user_investor_profiles', 'SELECT')
  and not has_table_privilege('anon', 'public.user_investor_profiles', 'INSERT')
  and not has_table_privilege('authenticated', 'public.user_investor_profiles', 'SELECT')
  and not has_table_privilege('authenticated', 'public.user_investor_profiles', 'INSERT')
  and not has_table_privilege('authenticated', 'public.user_investor_profiles', 'UPDATE')
  and not has_table_privilege('authenticated', 'public.user_investor_profiles', 'DELETE')
  and has_table_privilege('service_role', 'public.user_investor_profiles', 'SELECT'),
  'row security is on; visitors and signed-in roles have no right on the table, only the service role'
);
select is(
  (select count(*) from pg_policies
    where schemaname = 'public' and tablename = 'user_investor_profiles'
      and roles = '{authenticated}'
      and (qual like '%auth.uid()%' or with_check like '%auth.uid()%')),
  4::bigint,
  'four owner-only policies stand behind the missing rights'
);
select has_trigger('public', 'user_investor_profiles', 'touch_investor_profile', 'the modification date is set by a trigger');

-- Aucun accès direct pour un compte connecté ----------------------------------------------------
set local role authenticated;
set local "request.jwt.claim.role" = 'authenticated';
set local "request.jwt.claim.sub" = 'c8170000-0000-4000-8000-000000000001';

select throws_ok(
  $$select * from public.user_investor_profiles$$,
  '42501', null, 'a signed-in account cannot read the table directly'
);
select throws_ok(
  $$insert into public.user_investor_profiles (user_id, strategy)
    values ('c8170000-0000-4000-8000-000000000001', 'louer')$$,
  '42501', null, 'a signed-in account cannot write the table directly'
);

set local role anon;
select throws_ok(
  $$select * from public.user_investor_profiles$$,
  '42501', null, 'a visitor cannot read the table'
);

reset role;

-- Contraintes et déclencheur (rôle de la base) -------------------------------------------------
select throws_ok(
  $$insert into public.user_investor_profiles (user_id, strategy)
    values ('c8170000-0000-4000-8000-000000000002', 'revendre')$$,
  '23505', null, 'one profile per account'
);
select throws_ok(
  $$update public.user_investor_profiles set target_margin_pct = 51
     where user_id = 'c8170000-0000-4000-8000-000000000002'$$,
  '23514', null, 'a margin above 50 percent is refused'
);
select throws_ok(
  $$update public.user_investor_profiles set works_per_m2_eur = -1
     where user_id = 'c8170000-0000-4000-8000-000000000002'$$,
  '23514', null, 'a negative works budget is refused'
);
select throws_ok(
  $$update public.user_investor_profiles set strategy = 'habiter'
     where user_id = 'c8170000-0000-4000-8000-000000000002'$$,
  '23514', null, 'only resale or rental are strategies'
);
select throws_ok(
  $$update public.user_investor_profiles
       set down_payment_eur = null, target_margin_pct = null, works_per_m2_eur = null, strategy = null
     where user_id = 'c8170000-0000-4000-8000-000000000002'$$,
  '23514', null, 'an empty profile is not kept: the account deletes it instead'
);

update public.user_investor_profiles
   set strategy = 'revendre', created_at = '2000-01-01', updated_at = '2000-01-01'
 where user_id = 'c8170000-0000-4000-8000-000000000002';
select is(
  (select updated_at > '2020-01-01' and created_at > '2020-01-01' from public.user_investor_profiles
    where user_id = 'c8170000-0000-4000-8000-000000000002'),
  true,
  'the database sets the modification date and keeps the creation date'
);

-- Effacement avec le compte ---------------------------------------------------------------------
delete from auth.users where id = 'c8170000-0000-4000-8000-000000000002';
select is(
  (select count(*) from public.user_investor_profiles),
  0::bigint,
  'the profile goes away with the account'
);

select * from finish();
rollback;
