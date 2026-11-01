-- Bilan après adjudication (20261110160000) : le prix final noté par un compte sur l'instantané d'une
-- vente suivie (facultatif, seulement avec un statut won ou lost). RLS stricte : propriétaire seul, deux
-- colonnes modifiables, rien d'autre ; prix remis à null sans résultat.
begin;

select plan(15);

-- Fixtures -------------------------------------------------------------------------------------
insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data
) values
  ('c8160000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'final-one@example.test', '', null, now(), now(),
   '{}'::jsonb, '{}'::jsonb),
  ('c8160000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'final-two@example.test', '', null, now(), now(),
   '{}'::jsonb, '{}'::jsonb);

-- Les instantanés ne s'écrivent que par le déclencheur de capture : on les crée ici avec le rôle de la
-- base (les comptes n'ont aucun droit d'insertion).
insert into public.user_followed_sale_snapshots (
  id, user_id, sale_id, expires_at, result_status, personal_status, bid_ceiling_eur
) values
  ('c8160000-3000-4000-8000-000000000001', 'c8160000-0000-4000-8000-000000000001',
   'c8160000-1000-4000-8000-000000000001', now() + interval '3 months', 'adjudicated', 'won', 180000),
  ('c8160000-3000-4000-8000-000000000002', 'c8160000-0000-4000-8000-000000000002',
   'c8160000-1000-4000-8000-000000000001', now() + interval '3 months', 'unknown', 'lost', 90000);

-- Structure -------------------------------------------------------------------------------------
select has_column('public', 'user_followed_sale_snapshots', 'final_price_eur', 'snapshots store the final price');
select ok(
  has_column_privilege('authenticated', 'public.user_followed_sale_snapshots', 'final_price_eur', 'UPDATE')
  and has_column_privilege('authenticated', 'public.user_followed_sale_snapshots', 'personal_status', 'UPDATE')
  and not has_column_privilege('authenticated', 'public.user_followed_sale_snapshots', 'user_id', 'UPDATE')
  and not has_column_privilege('authenticated', 'public.user_followed_sale_snapshots', 'sale_id', 'UPDATE')
  and not has_column_privilege('authenticated', 'public.user_followed_sale_snapshots', 'adjudication_price_eur', 'UPDATE')
  and not has_column_privilege('authenticated', 'public.user_followed_sale_snapshots', 'bid_ceiling_eur', 'UPDATE')
  and not has_column_privilege('authenticated', 'public.user_followed_sale_snapshots', 'expires_at', 'UPDATE')
  and not has_table_privilege('authenticated', 'public.user_followed_sale_snapshots', 'INSERT')
  and not has_table_privilege('anon', 'public.user_followed_sale_snapshots', 'SELECT'),
  'an account edits the status and the final price of its snapshot, nothing else; visitors read nothing'
);
select has_trigger('public', 'user_followed_sale_snapshots', 'clear_final_price_unless_result', 'a price without result is cleared by a trigger');
select ok(
  exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'user_followed_sale_snapshots'
       and policyname = 'user_followed_sale_snapshots_update_own' and cmd = 'UPDATE'
  ),
  'an update policy limited to the owner exists'
);

-- RLS : le compte 1 écrit sur son instantané ----------------------------------------------------------
set local role authenticated;
set local "request.jwt.claim.role" = 'authenticated';
set local "request.jwt.claim.sub" = 'c8160000-0000-4000-8000-000000000001';

select lives_ok(
  $$update public.user_followed_sale_snapshots set final_price_eur = 190000
     where id = 'c8160000-3000-4000-8000-000000000001'$$,
  'an account stores its final price on a snapshot marked won'
);
select is(
  (select final_price_eur from public.user_followed_sale_snapshots
    where id = 'c8160000-3000-4000-8000-000000000001'),
  190000::numeric,
  'the stored final price is the one saved'
);
select throws_ok(
  $$update public.user_followed_sale_snapshots set final_price_eur = 0
     where id = 'c8160000-3000-4000-8000-000000000001'$$,
  '23514', null, 'a final price below 1 euro is refused'
);
select throws_ok(
  $$update public.user_followed_sale_snapshots set final_price_eur = 10000000001
     where id = 'c8160000-3000-4000-8000-000000000001'$$,
  '23514', null, 'a final price above the bound is refused'
);
select lives_ok(
  $$update public.user_followed_sale_snapshots set personal_status = 'lost'
     where id = 'c8160000-3000-4000-8000-000000000001'$$,
  'the status moves from won to lost: the price stays'
);
select is(
  (select final_price_eur from public.user_followed_sale_snapshots
    where id = 'c8160000-3000-4000-8000-000000000001'),
  190000::numeric,
  'a lost sale keeps its final price (the winning bid of someone else)'
);
select lives_ok(
  $$update public.user_followed_sale_snapshots set personal_status = 'archived'
     where id = 'c8160000-3000-4000-8000-000000000001'$$,
  'the status leaves won and lost'
);
select is(
  (select final_price_eur from public.user_followed_sale_snapshots
    where id = 'c8160000-3000-4000-8000-000000000001'),
  null::numeric,
  'the final price does not survive a status that is neither won nor lost'
);
select throws_ok(
  $$update public.user_followed_sale_snapshots set adjudication_price_eur = 1
     where id = 'c8160000-3000-4000-8000-000000000001'$$,
  '42501', null, 'an account cannot edit the published result of its snapshot'
);
select throws_ok(
  $$update public.user_followed_sale_snapshots set user_id = 'c8160000-0000-4000-8000-000000000002'
     where id = 'c8160000-3000-4000-8000-000000000001'$$,
  '42501', null, 'an account cannot hand a snapshot to another account'
);

-- Le compte 1 ne voit ni ne modifie l'instantané du compte 2.
select is(
  (select count(*) from public.user_followed_sale_snapshots
    where user_id = 'c8160000-0000-4000-8000-000000000002'),
  0::bigint,
  'an account does not see the snapshots of another account'
);

select * from finish();
rollback;
