begin;

select plan(1);

select ok(
  has_table_privilege('service_role', 'public.user_profiles', 'select'),
  'service_role can discover investor profiles for the sale change monitor'
);

select * from finish();

rollback;
