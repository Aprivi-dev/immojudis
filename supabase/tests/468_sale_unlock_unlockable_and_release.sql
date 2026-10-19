-- "3 déblocages par mois": `unlockable` in the status, the 24-month limit (also in unlock_sale_at,
-- 20261025160000) and the release of an unlock (20261025130000 and 20261025130100).
begin;
-- L'offre de lancement (active par défaut, 20261028120000) donne l'accès Analyse à tout compte
-- connecté : ce test vérifie les règles d'un compte gratuit, il la coupe (annulé par le rollback).
update app_private.launch_offer set active = false where singleton;

select plan(20);

-- Fixtures -------------------------------------------------------------------------------------
insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data
) values
  ('c4640000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'unlock-limit@example.test', '', now(), now(), now(),
   '{}'::jsonb, '{}'::jsonb);

insert into public.user_subscriptions (user_id, plan_code, status, current_period_end)
values ('c4640000-0000-4000-8000-000000000001', 'decouverte', 'active', null);

-- s1, s2, s4: online. s3: already past, so not online and not unlockable.
insert into public.auction_sales (id, source_name, source_url, title, status, sale_date)
select
  ('c4640000-1000-4000-8000-' || lpad(i::text, 12, '0'))::uuid,
  'sale-unlock-limit-test',
  'https://example.test/sale-unlock-limit/' || i,
  'Unlock limit title ' || i,
  case when i = 3 then 'past' else 'upcoming' end,
  case when i = 3 then now() - interval '30 days' else '2099-01-01 12:00:00Z'::timestamptz end
from generate_series(1, 4) i;

-- s1 unlocked 23 months ago (still valid), s2 unlocked 25 months ago (over the limit).
insert into public.user_sale_unlocks (id, user_id, sale_id, unlocked_at)
values
  ('c4640000-2000-4000-8000-000000000001', 'c4640000-0000-4000-8000-000000000001',
   'c4640000-1000-4000-8000-000000000001', now() - interval '23 months'),
  ('c4640000-2000-4000-8000-000000000002', 'c4640000-0000-4000-8000-000000000001',
   'c4640000-1000-4000-8000-000000000002', now() - interval '25 months');

-- Privileges -------------------------------------------------------------------------------------
select ok(
  has_function_privilege('authenticated', 'app_private.current_user_can_unlock_sale(uuid)', 'EXECUTE')
  and not has_function_privilege('anon', 'app_private.current_user_can_unlock_sale(uuid)', 'EXECUTE'),
  'the unlockable helper is callable by an account, not by anon'
);
select ok(
  has_function_privilege('service_role', 'app_private.release_sale_unlock(uuid, timestamptz)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'app_private.release_sale_unlock(uuid, timestamptz)', 'EXECUTE')
  and not has_function_privilege('anon', 'app_private.release_sale_unlock(uuid, timestamptz)', 'EXECUTE'),
  'only service_role can release an unlock'
);

-- A signed-in Découverte account -----------------------------------------------------------------
set local role authenticated;
set local "request.jwt.claim.role" = 'authenticated';
set local "request.jwt.claim.sub" = 'c4640000-0000-4000-8000-000000000001';

select is(
  (public.get_sale_unlock_status('c4640000-1000-4000-8000-000000000004') ->> 'unlockable')::boolean,
  true,
  'an online sale is unlockable'
);
select is(
  (public.get_sale_unlock_status('c4640000-1000-4000-8000-000000000003') ->> 'unlockable')::boolean,
  false,
  'a sale that is no longer online is not unlockable: the button is not offered'
);
select is(
  (public.get_sale_unlock_status() ->> 'unlockable')::boolean,
  true,
  'without a sale there is nothing to refuse'
);
select throws_ok(
  $$select public.unlock_sale('c4640000-1000-4000-8000-000000000003')$$,
  'P0002',
  'Vente introuvable ou plus en ligne.',
  'unlock_sale agrees with the flag: the not-unlockable sale is refused'
);

-- 24 months ------------------------------------------------------------------------------------
select is(
  (public.get_sale_unlock_status('c4640000-1000-4000-8000-000000000001') ->> 'unlocked')::boolean,
  true,
  'an unlock of 23 months ago still opens the sale'
);
select is(
  (public.get_sale_unlock_status('c4640000-1000-4000-8000-000000000002') ->> 'unlocked')::boolean,
  false,
  'an unlock of 25 months ago no longer opens the sale, even before the nightly purge'
);
select is(
  (select count(*) from public.v_auction_sales_unlocked where title like 'Unlock limit title%'),
  1::bigint,
  'the unlocked-sale view applies the same limit'
);

-- unlock_sale_at: an expired unlock is not "already unlocked" ------------------------------------
select is(
  public.unlock_sale('c4640000-1000-4000-8000-000000000001') ->> 'already_unlocked',
  'true',
  'unlocking again a sale unlocked 23 months ago is idempotent'
);
select is(
  (select count(*) from public.user_sale_unlocks
   where sale_id = 'c4640000-1000-4000-8000-000000000001' and unlocked_at < now() - interval '22 months'),
  1::bigint,
  'and keeps the original unlock date'
);
select is(
  public.unlock_sale('c4640000-1000-4000-8000-000000000002') ->> 'already_unlocked',
  'false',
  'unlocking again a sale unlocked 25 months ago is a new unlock, not an idempotent answer'
);
select is(
  (select count(*) from public.user_sale_unlocks
   where sale_id = 'c4640000-1000-4000-8000-000000000002' and unlocked_at > now() - interval '1 day'),
  1::bigint,
  'the expired row was replaced by a single new row of this month'
);
select is(
  (public.get_sale_unlock_status('c4640000-1000-4000-8000-000000000002') ->> 'used')::integer,
  1,
  'which consumed one unlock of the current month, and opens the sale again'
);
reset role;

-- Release ----------------------------------------------------------------------------------------
select is(
  app_private.release_sale_unlock('c4640000-2000-4000-8000-0000000000ff') ->> 'outcome',
  'not_found',
  'releasing an unknown unlock changes nothing'
);
select is(
  app_private.release_sale_unlock('c4640000-2000-4000-8000-000000000001') ->> 'outcome',
  'past_month',
  'an unlock of a past month is not given back (terms, article 2)'
);
select is(
  (select count(*) from public.user_sale_unlocks where id = 'c4640000-2000-4000-8000-000000000001'),
  1::bigint,
  'and the row is left as it was'
);

insert into public.user_sale_unlocks (id, user_id, sale_id, unlocked_at)
values ('c4640000-2000-4000-8000-000000000004', 'c4640000-0000-4000-8000-000000000001',
        'c4640000-1000-4000-8000-000000000004', now());
select is(
  app_private.release_sale_unlock('c4640000-2000-4000-8000-000000000004') ->> 'outcome',
  'released',
  'an unlock of the current month is given back'
);
select is(
  (select count(*) from public.user_sale_unlocks where id = 'c4640000-2000-4000-8000-000000000004'),
  0::bigint,
  'the row is gone, so the unlock no longer counts in the month'
);
select is(
  app_private.release_sale_unlock('c4640000-2000-4000-8000-000000000004') ->> 'outcome',
  'not_found',
  'releasing twice is harmless'
);

select * from finish();
rollback;
