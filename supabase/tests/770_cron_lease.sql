-- Bail nommé des traitements planifiés (migration 20261108110000) : une seule passe à la fois.
--   * table privée à une ligne, RLS activée, service_role seul ;
--   * un deuxième bail est refusé tant que le premier court ; il est rendu avec son jeton ; il expire seul ;
--   * un mauvais jeton ne rend rien ; une durée absurde est refusée ;
--   * ni anon ni authenticated n'exécutent les fonctions.
begin;

select plan(19);

select has_table('public', 'cron_lease', 'the cron lease table exists');
select ok(
  (select relrowsecurity from pg_class where oid = 'public.cron_lease'::regclass),
  'row level security is enabled on the lease table'
);
select ok(
  not has_table_privilege('anon', 'public.cron_lease', 'SELECT')
  and not has_table_privilege('anon', 'public.cron_lease', 'UPDATE')
  and not has_table_privilege('authenticated', 'public.cron_lease', 'SELECT')
  and not has_table_privilege('authenticated', 'public.cron_lease', 'UPDATE'),
  'neither a visitor nor an account holds any right on the lease table'
);
select ok(
  has_table_privilege('service_role', 'public.cron_lease', 'SELECT')
  and has_table_privilege('service_role', 'public.cron_lease', 'UPDATE'),
  'service_role reads and updates the lease table'
);
select is(
  (select array_agg(name order by name) from public.cron_lease),
  array['sale-pepites']::text[],
  'the lease table holds one row per scheduled job (sale-pepites for now)'
);
select ok(
  not has_function_privilege('anon', 'public.claim_cron_lease(text, integer)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.claim_cron_lease(text, integer)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.release_cron_lease(text, uuid)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.release_cron_lease(text, uuid)', 'EXECUTE'),
  'neither a visitor nor an account can take or release the lease'
);
select ok(
  has_function_privilege('service_role', 'public.claim_cron_lease(text, integer)', 'EXECUTE')
  and has_function_privilege('service_role', 'public.release_cron_lease(text, uuid)', 'EXECUTE'),
  'service_role can take and release the lease'
);

-- Prise, refus, restitution ----------------------------------------------------------------------
create temp table lease_tokens (name text primary key, token uuid);

insert into lease_tokens values ('first', public.claim_cron_lease('sale-pepites', 360));
select isnt((select token from lease_tokens where name = 'first'), null::uuid, 'a free lease is taken');
select is(
  public.claim_cron_lease('sale-pepites', 360),
  null::uuid,
  'a second pass is refused while the first holds the lease'
);
select is(
  public.release_cron_lease('sale-pepites', '00000000-0000-4000-8000-000000000000'::uuid),
  false,
  'a wrong token releases nothing'
);
select is(
  public.claim_cron_lease('sale-pepites', 360),
  null::uuid,
  'the lease is still held after a wrong release'
);
select is(
  public.release_cron_lease('sale-pepites', (select token from lease_tokens where name = 'first')),
  true,
  'the holder releases the lease with its token'
);
insert into lease_tokens values ('second', public.claim_cron_lease('sale-pepites', 360));
select isnt((select token from lease_tokens where name = 'second'), null::uuid, 'the lease is free again');

-- Expiration ---------------------------------------------------------------------------------------
update public.cron_lease set leased_until = now() - interval '1 minute';
insert into lease_tokens values ('third', public.claim_cron_lease('sale-pepites', 360));
select isnt(
  (select token from lease_tokens where name = 'third'),
  null::uuid,
  'an expired lease is taken over'
);
select is(
  public.release_cron_lease('sale-pepites', (select token from lease_tokens where name = 'second')),
  false,
  'the former holder cannot release a lease that was taken over'
);

-- Durée absurde -----------------------------------------------------------------------------------
select throws_ok(
  $$select public.claim_cron_lease('sale-pepites', 5)$$,
  '22023',
  'invalid lease duration',
  'a lease shorter than 30 seconds is refused'
);

select throws_ok(
  $$select public.claim_cron_lease('unknown-job', 360)$$,
  '22023',
  'unknown lease',
  'a lease that has no row is refused (a caller never creates a row)'
);
select throws_ok(
  $$insert into public.cron_lease (name) values ('Bad Name')$$,
  '23514',
  null,
  'a lease name is a short lower-case slug'
);
select is(
  (select count(*) from public.cron_lease where name = 'sale-pepites' and token is not null),
  1::bigint,
  'the lease is held at the end of the test (the transaction is rolled back)'
);

select * from finish();
rollback;
