-- Bail du traitement d'inondation (migration 20261106100500) : une seule passe à la fois.
--   * table privée à une ligne, RLS activée, service_role seul ;
--   * un deuxième bail est refusé tant que le premier court ; il est rendu avec son jeton ; il expire seul ;
--   * un mauvais jeton ne rend rien ; une durée absurde est refusée ;
--   * ni anon ni authenticated n'exécutent les fonctions.
begin;

select plan(16);

select has_table('public', 'sale_flood_risk_lease', 'the flood lease table exists');
select ok(
  (select relrowsecurity from pg_class where oid = 'public.sale_flood_risk_lease'::regclass),
  'row level security is enabled on the lease table'
);
select ok(
  not has_table_privilege('anon', 'public.sale_flood_risk_lease', 'SELECT')
  and not has_table_privilege('anon', 'public.sale_flood_risk_lease', 'UPDATE')
  and not has_table_privilege('authenticated', 'public.sale_flood_risk_lease', 'SELECT')
  and not has_table_privilege('authenticated', 'public.sale_flood_risk_lease', 'UPDATE'),
  'neither a visitor nor an account holds any right on the lease table'
);
select ok(
  has_table_privilege('service_role', 'public.sale_flood_risk_lease', 'SELECT')
  and has_table_privilege('service_role', 'public.sale_flood_risk_lease', 'UPDATE'),
  'service_role reads and updates the lease table'
);
select is(
  (select count(*) from public.sale_flood_risk_lease),
  1::bigint,
  'the lease table holds exactly one row'
);
select ok(
  not has_function_privilege('anon', 'public.claim_sale_flood_risk_lease(integer)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.claim_sale_flood_risk_lease(integer)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.release_sale_flood_risk_lease(uuid)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.release_sale_flood_risk_lease(uuid)', 'EXECUTE'),
  'neither a visitor nor an account can take or release the lease'
);
select ok(
  has_function_privilege('service_role', 'public.claim_sale_flood_risk_lease(integer)', 'EXECUTE')
  and has_function_privilege('service_role', 'public.release_sale_flood_risk_lease(uuid)', 'EXECUTE'),
  'service_role can take and release the lease'
);

-- Prise, refus, restitution ----------------------------------------------------------------------
create temp table lease_tokens (name text primary key, token uuid);

insert into lease_tokens values ('first', public.claim_sale_flood_risk_lease(360));
select isnt((select token from lease_tokens where name = 'first'), null::uuid, 'a free lease is taken');
select is(
  public.claim_sale_flood_risk_lease(360),
  null::uuid,
  'a second pass is refused while the first holds the lease'
);
select is(
  public.release_sale_flood_risk_lease('00000000-0000-4000-8000-000000000000'::uuid),
  false,
  'a wrong token releases nothing'
);
select is(
  public.claim_sale_flood_risk_lease(360),
  null::uuid,
  'the lease is still held after a wrong release'
);
select is(
  public.release_sale_flood_risk_lease((select token from lease_tokens where name = 'first')),
  true,
  'the holder releases the lease with its token'
);
insert into lease_tokens values ('second', public.claim_sale_flood_risk_lease(360));
select isnt((select token from lease_tokens where name = 'second'), null::uuid, 'the lease is free again');

-- Expiration ---------------------------------------------------------------------------------------
update public.sale_flood_risk_lease set leased_until = now() - interval '1 minute';
insert into lease_tokens values ('third', public.claim_sale_flood_risk_lease(360));
select isnt(
  (select token from lease_tokens where name = 'third'),
  null::uuid,
  'an expired lease is taken over'
);
select is(
  public.release_sale_flood_risk_lease((select token from lease_tokens where name = 'second')),
  false,
  'the former holder cannot release a lease that was taken over'
);

-- Durée absurde -----------------------------------------------------------------------------------
select throws_ok(
  $$select public.claim_sale_flood_risk_lease(5)$$,
  '22023',
  'invalid lease duration',
  'a lease shorter than 30 seconds is refused'
);

select * from finish();
rollback;
