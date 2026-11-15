-- Achat d'une vente à l'unité (20261122100000) : réservation, paiement idempotent, crédit (vente retirée ou
-- plus débloquable au paiement), remboursement, litige, déduction du premier mois d'abonnement, purge des
-- 24 mois, suppression d'une vente retirée, et fermeture de la table aux rôles du navigateur.
-- État de base : l'interrupteur de l'essai est coupé (20261120100000) ; le compte abonné a une fin de période
-- future.
begin;

select plan(73);

-- Fixtures -------------------------------------------------------------------------------------------------
-- 01 gratuit, déblocage gratuit utilisé (vente 0) ; 02 autre compte gratuit ; 03 abonné Analyse ;
-- 04 gratuit, déblocage gratuit disponible ; 05 et 06 déduction ; 07 purge des 24 mois ; 08 à 10 suppression
-- de ventes.
insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data
)
select
  ('c8520000-0000-4000-8000-' || lpad(i::text, 12, '0'))::uuid,
  '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated', 'unit-purchase-' || i || '@purchase852.example.test', '',
  now(), now(), now(), '{}'::jsonb, '{}'::jsonb
from generate_series(1, 10) i;

insert into public.user_subscriptions (user_id, plan_code, status, current_period_end)
values ('c8520000-0000-4000-8000-000000000003', 'analyse', 'active', now() + interval '30 days');

-- Ventes 0 à 5 et 7 à 9 en ligne ; vente 6 retirée dès le départ.
insert into public.auction_sales (id, source_name, source_url, title, status, sale_date)
select
  ('c8520000-1000-4000-8000-' || lpad(i::text, 12, '0'))::uuid,
  'unit-purchase-test',
  'https://example.test/unit-purchase/' || i,
  'Unit purchase title ' || i,
  case when i = 6 then 'withdrawn' else 'upcoming' end,
  '2099-01-01 12:00:00Z'::timestamptz
from generate_series(0, 9) i;

insert into public.user_sale_unlocks (user_id, sale_id)
values ('c8520000-0000-4000-8000-000000000001', 'c8520000-1000-4000-8000-000000000000');

create temp table ids (name text primary key, id uuid not null);

-- Détail (pg_exception_detail) de l'erreur levée par une requête, null si elle passe.
create function pg_temp.error_detail(p_sql text)
returns text
language plpgsql
as $$
declare
  v_detail text;
begin
  execute p_sql;
  return null;
exception when others then
  get stacked diagnostics v_detail = pg_exception_detail;
  return coalesce(nullif(v_detail, ''), sqlstate);
end;
$$;

-- Structure et droits --------------------------------------------------------------------------------------
select ok(
  (select relrowsecurity from pg_class where oid = 'public.sale_unlock_purchases'::regclass),
  'sale_unlock_purchases has row level security'
);
select ok(
  not has_table_privilege('authenticated', 'public.sale_unlock_purchases', 'SELECT, INSERT, UPDATE, DELETE')
  and not has_table_privilege('anon', 'public.sale_unlock_purchases', 'SELECT, INSERT, UPDATE, DELETE'),
  'the browser roles have no right on sale_unlock_purchases'
);
select ok(
  has_function_privilege(
    'service_role',
    'public.grant_purchased_sale_unlock(uuid,uuid,uuid,text,text,integer,text,text,timestamptz)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.grant_purchased_sale_unlock(uuid,uuid,uuid,text,text,integer,text,text,timestamptz)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'anon',
    'public.grant_purchased_sale_unlock(uuid,uuid,uuid,text,text,integer,text,text,timestamptz)',
    'EXECUTE'
  ),
  'only service_role can grant a bought unlock'
);
select ok(
  (
    select bool_and(
      has_function_privilege('service_role', signature, 'EXECUTE')
      and not has_function_privilege('authenticated', signature, 'EXECUTE')
      and not has_function_privilege('anon', signature, 'EXECUTE')
    )
    from unnest(array[
      'public.reserve_sale_unlock_purchase(uuid,uuid)',
      'public.attach_sale_unlock_checkout(uuid,text,uuid)',
      'public.expire_sale_unlock_purchase(text)',
      'public.record_sale_unlock_payment_state(text,text,text,bigint)',
      'public.reserve_unit_purchase_deduction(uuid,text,timestamptz)',
      'public.settle_unit_purchase_deduction(text,text)',
      'public.release_unit_purchase_deduction(text)',
      'app_private.sale_unlock_credits_available(uuid)'
    ]) signature
  ),
  'the reservation, payment and deduction functions are service_role only'
);
select ok(
  has_function_privilege('authenticated', 'public.redeem_sale_unlock_credit(uuid)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.redeem_sale_unlock_credit(uuid)', 'EXECUTE'),
  'an account can use a credit, anon cannot'
);
select is(
  app_private.sale_unlock_purchase_amount_cents() || ' ' || app_private.sale_unlock_purchase_currency(),
  '1900 eur',
  'one unlock costs 1 900 cents in eur'
);

-- Réservation ------------------------------------------------------------------------------------------------
select is(
  pg_temp.error_detail($$select * from public.reserve_sale_unlock_purchase(
    'c8520000-0000-4000-8000-000000000004', 'c8520000-1000-4000-8000-000000000001')$$),
  'free_unlock_available',
  'an account with its free unlock cannot buy'
);
select is(
  pg_temp.error_detail($$select * from public.reserve_sale_unlock_purchase(
    'c8520000-0000-4000-8000-000000000003', 'c8520000-1000-4000-8000-000000000001')$$),
  'analysis_access',
  'an Analyse account cannot buy'
);
select is(
  pg_temp.error_detail($$select * from public.reserve_sale_unlock_purchase(
    'c8520000-0000-4000-8000-000000000001', 'c8520000-1000-4000-8000-000000000000')$$),
  'already_unlocked',
  'a sale already unlocked cannot be bought'
);
select is(
  pg_temp.error_detail($$select * from public.reserve_sale_unlock_purchase(
    'c8520000-0000-4000-8000-000000000001', 'c8520000-1000-4000-8000-000000000006')$$),
  'sale_not_unlockable',
  'a sale that is not unlockable cannot be bought'
);

insert into ids
select 'p1', reservation.purchase_id
from public.reserve_sale_unlock_purchase(
  'c8520000-0000-4000-8000-000000000001', 'c8520000-1000-4000-8000-000000000001'
) reservation;

select is(
  (
    select reservation.purchase_id
    from public.reserve_sale_unlock_purchase(
      'c8520000-0000-4000-8000-000000000001', 'c8520000-1000-4000-8000-000000000001'
    ) reservation
  ),
  (select id from ids where name = 'p1'),
  'a second reservation returns the pending purchase'
);
select ok(
  public.attach_sale_unlock_checkout((select id from ids where name = 'p1'), 'cs_852_1'),
  'the Checkout Session is attached to the pending purchase'
);
select ok(
  not public.attach_sale_unlock_checkout((select id from ids where name = 'p1'), 'cs_852_other'),
  'another session is not attached over it'
);
select is(
  (
    select reservation.existing_session_id
    from public.reserve_sale_unlock_purchase(
      'c8520000-0000-4000-8000-000000000001', 'c8520000-1000-4000-8000-000000000001'
    ) reservation
  ),
  'cs_852_1',
  'the pending reservation is returned with its session'
);

-- Paiement ---------------------------------------------------------------------------------------------------
select is(
  pg_temp.error_detail($$select * from public.grant_purchased_sale_unlock(
    (select id from ids where name = 'p1'), 'c8520000-0000-4000-8000-000000000001',
    'c8520000-1000-4000-8000-000000000001', 'cs_852_1', 'pi_852_1', 1000, 'eur', 'evt_852_a', now())$$),
  'sale_unlock_purchase_mismatch',
  'a different amount is refused'
);
select is(
  pg_temp.error_detail($$select * from public.grant_purchased_sale_unlock(
    (select id from ids where name = 'p1'), 'c8520000-0000-4000-8000-000000000001',
    'c8520000-1000-4000-8000-000000000001', 'cs_852_1', 'pi_852_1', 1900, 'usd', 'evt_852_a', now())$$),
  'sale_unlock_purchase_mismatch',
  'a different currency is refused'
);
select is(
  pg_temp.error_detail($$select * from public.grant_purchased_sale_unlock(
    (select id from ids where name = 'p1'), 'c8520000-0000-4000-8000-000000000002',
    'c8520000-1000-4000-8000-000000000001', 'cs_852_1', 'pi_852_1', 1900, 'eur', 'evt_852_a', now())$$),
  'sale_unlock_purchase_mismatch',
  'the purchase of another account is refused'
);
select is(
  (
    select grant_row::text
    from public.grant_purchased_sale_unlock(
      (select id from ids where name = 'p1'), 'c8520000-0000-4000-8000-000000000001',
      'c8520000-1000-4000-8000-000000000001', 'cs_852_1', 'pi_852_1', 1900, 'eur', 'evt_852_a', now()
    ) grant_row
  ),
  '(t,unlocked)',
  'the payment unlocks the sale bought'
);
select is(
  (
    select grant_row::text
    from public.grant_purchased_sale_unlock(
      (select id from ids where name = 'p1'), 'c8520000-0000-4000-8000-000000000001',
      'c8520000-1000-4000-8000-000000000001', 'cs_852_1', 'pi_852_1', 1900, 'eur', 'evt_852_b', now()
    ) grant_row
  ),
  '(t,unlocked)',
  'the same session replayed gives the same answer'
);

insert into ids
select 'p2', reservation.purchase_id
from public.reserve_sale_unlock_purchase(
  'c8520000-0000-4000-8000-000000000001', 'c8520000-1000-4000-8000-000000000002'
) reservation;

select is(
  pg_temp.error_detail($$select * from public.grant_purchased_sale_unlock(
    (select id from ids where name = 'p2'), 'c8520000-0000-4000-8000-000000000001',
    'c8520000-1000-4000-8000-000000000002', 'cs_852_2', 'pi_852_1', 1900, 'eur', 'evt_852_c', now())$$),
  'sale_unlock_purchase_mismatch',
  'the same payment intent replayed on another purchase is refused'
);
select ok(
  (select count(*) from public.sale_unlock_purchases
    where user_id = 'c8520000-0000-4000-8000-000000000001' and state = 'paid') = 1
  and (select count(*) from public.user_sale_unlocks
    where user_id = 'c8520000-0000-4000-8000-000000000001' and source = 'purchase') = 1,
  'replays left one paid purchase and one bought unlock'
);
select is(
  app_private.sale_unlocks_used('c8520000-0000-4000-8000-000000000001'),
  1,
  'a purchase does not use the free unlock: only the free row counts'
);
select is(
  app_private.release_sale_unlock(
    (select id from public.user_sale_unlocks where purchase_id = (select id from ids where name = 'p1'))
  ) ->> 'outcome',
  'not_free',
  'release_sale_unlock refuses a bought unlock'
);

set local role authenticated;
set local "request.jwt.claim.role" = 'authenticated';
set local "request.jwt.claim.sub" = 'c8520000-0000-4000-8000-000000000001';

select is(
  (
    select pg_catalog.jsonb_build_array(status -> 'unlocked', status -> 'source', status -> 'credits')
    from public.get_sale_unlock_status('c8520000-1000-4000-8000-000000000001') status
  ),
  '[true, "purchase", 0]'::jsonb,
  'the bought sale is open, its source is purchase, no credit'
);
reset role;

-- Vente retirée après l'achat : crédit ---------------------------------------------------------------------
update public.auction_sales set status = 'withdrawn'
where id = 'c8520000-1000-4000-8000-000000000001';

select is(
  app_private.sale_unlock_credits_available('c8520000-0000-4000-8000-000000000001'),
  1,
  'the purchase of a withdrawn sale becomes a credit'
);

set local role authenticated;
select is(
  (public.get_sale_unlock_status() ->> 'credits')::integer,
  1,
  'the account reads its credit in the status'
);
select is(
  (
    select pg_catalog.jsonb_build_array(redeemed -> 'consumed', redeemed -> 'credits')
    from public.redeem_sale_unlock_credit('c8520000-1000-4000-8000-000000000003') redeemed
  ),
  '[true, 0]'::jsonb,
  'the credit opens another sale, once'
);
select throws_ok(
  $$select public.redeem_sale_unlock_credit('c8520000-1000-4000-8000-000000000004')$$,
  'P0001',
  'Vous n''avez pas de crédit de déblocage disponible.',
  'without a credit, a further sale is refused'
);
select is(
  public.get_sale_unlock_status('c8520000-1000-4000-8000-000000000003') ->> 'source',
  'credit',
  'the sale opened by the credit has source credit'
);
reset role;

select is(
  (select count(*) from public.user_sale_unlocks where purchase_id = (select id from ids where name = 'p1')),
  1::bigint,
  'the purchase carries one live unlock: the row of the withdrawn sale is gone'
);

-- Vente plus débloquable au paiement : crédit --------------------------------------------------------------
update public.auction_sales set status = 'withdrawn'
where id = 'c8520000-1000-4000-8000-000000000002';

select is(
  (
    select grant_row::text
    from public.grant_purchased_sale_unlock(
      (select id from ids where name = 'p2'), 'c8520000-0000-4000-8000-000000000001',
      'c8520000-1000-4000-8000-000000000002', 'cs_852_2', 'pi_852_2', 1900, 'eur', 'evt_852_d', now()
    ) grant_row
  ),
  '(t,credit)',
  'a sale no longer unlockable at payment leaves a credit'
);
select is(
  app_private.sale_unlock_credits_available('c8520000-0000-4000-8000-000000000001'),
  1,
  'the account has that credit'
);

-- Remboursement et litige ----------------------------------------------------------------------------------
select ok(
  public.record_sale_unlock_payment_state('pi_852_2', 'refunded', 'evt_852_r2', 1000),
  'the refund is recorded'
);
select is(
  app_private.sale_unlock_credits_available('c8520000-0000-4000-8000-000000000001'),
  0,
  'a refunded purchase is no longer a credit'
);
select ok(
  public.record_sale_unlock_payment_state('pi_852_1', 'disputed', 'evt_852_d1', 100),
  'the dispute is recorded'
);

set local role authenticated;
select is(
  public.get_sale_unlock_status('c8520000-1000-4000-8000-000000000003') ->> 'unlocked',
  'false',
  'a disputed purchase closes its sale'
);
reset role;

select ok(
  not public.record_sale_unlock_payment_state('pi_852_1', 'paid', 'evt_852_old', 50),
  'an event older than the last applied one is ignored'
);
select ok(
  public.record_sale_unlock_payment_state('pi_852_1', 'paid', 'evt_852_won', 200),
  'a won dispute is recorded'
);

set local role authenticated;
select is(
  public.get_sale_unlock_status('c8520000-1000-4000-8000-000000000003') ->> 'unlocked',
  'true',
  'a won dispute opens the sale again'
);
reset role;

select ok(
  public.record_sale_unlock_payment_state('pi_852_1', 'refunded', 'evt_852_r1', 300),
  'the refund of the first purchase is recorded'
);
select ok(
  (select count(*) from public.user_sale_unlocks where purchase_id = (select id from ids where name = 'p1')) = 0
  and app_private.sale_unlock_credits_available('c8520000-0000-4000-8000-000000000001') = 0,
  'a refunded purchase leaves neither unlock nor credit'
);
select ok(
  not public.record_sale_unlock_payment_state('pi_852_1', 'paid', 'evt_852_late', 400),
  'a refund is final'
);
select ok(
  not public.record_sale_unlock_payment_state('pi_852_unknown', 'refunded', 'evt_852_x', 1),
  'an unknown payment intent is not recorded'
);

-- Expiration du Checkout --------------------------------------------------------------------------------------
insert into ids
select 'p3', reservation.purchase_id
from public.reserve_sale_unlock_purchase(
  'c8520000-0000-4000-8000-000000000001', 'c8520000-1000-4000-8000-000000000005'
) reservation;
select public.attach_sale_unlock_checkout((select id from ids where name = 'p3'), 'cs_852_3');

select ok(
  public.expire_sale_unlock_purchase('cs_852_3'),
  'an expired Checkout closes the pending purchase'
);
select isnt(
  (
    select reservation.purchase_id
    from public.reserve_sale_unlock_purchase(
      'c8520000-0000-4000-8000-000000000001', 'c8520000-1000-4000-8000-000000000005'
    ) reservation
  ),
  (select id from ids where name = 'p3'),
  'the account can reserve again after the expiry'
);

-- Déduction du premier mois -----------------------------------------------------------------------------------
-- 06 : un achat de la veille, un de 31 jours, un remboursé de 2 jours.
insert into public.sale_unlock_purchases (
  user_id, payment_intent_id, amount_cents, currency, state, outcome, paid_at
) values
  ('c8520000-0000-4000-8000-000000000006', 'pi_852_61', 1900, 'eur', 'paid', 'credit', now() - interval '1 day'),
  ('c8520000-0000-4000-8000-000000000006', 'pi_852_62', 1900, 'eur', 'paid', 'credit', now() - interval '31 days'),
  ('c8520000-0000-4000-8000-000000000006', 'pi_852_63', 1900, 'eur', 'refunded', 'credit', now() - interval '2 days');
-- 05 : quatre achats dans les 30 jours (7 600 centimes).
insert into public.sale_unlock_purchases (
  user_id, payment_intent_id, amount_cents, currency, state, outcome, paid_at
)
select
  'c8520000-0000-4000-8000-000000000005', 'pi_852_5' || days, 1900, 'eur', 'paid', 'credit',
  now() - days * interval '1 day'
from unnest(array[2, 10, 20, 25]) days;

select is(
  public.reserve_unit_purchase_deduction('c8520000-0000-4000-8000-000000000006', 'token-852-66666666', now()),
  1900,
  'the deduction sums the paid purchases of the last 30 days, refunds excluded'
);
select is(
  public.reserve_unit_purchase_deduction('c8520000-0000-4000-8000-000000000005', 'token-852-aaaaaaaa', now()),
  5700,
  'oldest first, only the purchases whose running total fits under 5 900 cents are reserved'
);
select is(
  public.reserve_unit_purchase_deduction('c8520000-0000-4000-8000-000000000005', 'token-852-bbbbbbbb', now()),
  1900,
  'purchases reserved by a live token are not reserved twice; the one left out by the cap stays available'
);
select is(
  public.release_unit_purchase_deduction('token-852-aaaaaaaa'),
  3,
  'release gives the reservation back'
);
select is(
  public.reserve_unit_purchase_deduction('c8520000-0000-4000-8000-000000000005', 'token-852-bbbbbbbb', now()),
  5700,
  'the same token recomputes its reservation over the released purchases'
);
select is(
  public.reserve_unit_purchase_deduction(
    'c8520000-0000-4000-8000-000000000005', 'token-852-cccccccc', now() + interval '32 minutes'
  ),
  5700,
  'a reservation older than 31 minutes is no longer live'
);
select is(
  public.settle_unit_purchase_deduction('token-852-cccccccc', 'cs_analyse_852'),
  5700,
  'settle deducts the reserved purchases and returns their sum'
);
select is(
  public.reserve_unit_purchase_deduction(
    'c8520000-0000-4000-8000-000000000005', 'token-852-dddddddd', now() + interval '40 minutes'
  ),
  1900,
  'after settle, only the purchase left out by the cap remains to deduct'
);
select is(
  public.settle_unit_purchase_deduction('token-852-cccccccc', 'cs_analyse_852'),
  5700,
  'settle replayed answers the same'
);
select is(
  app_private.sale_unlock_credits_available('c8520000-0000-4000-8000-000000000005'),
  1,
  'deducted purchases are no longer credits; the one left out by the cap still is'
);

-- Remboursement entre la réservation et le règlement : l'achat n'est pas déduit, la somme le montre.
select public.record_sale_unlock_payment_state('pi_852_61', 'refunded', 'evt_852_r61', 10);
select is(
  public.settle_unit_purchase_deduction('token-852-66666666', 'cs_analyse_856'),
  0,
  'settle returns only the purchases still paid: the caller sees the gap with the discount'
);
select ok(
  (select deducted_checkout_session_id is null from public.sale_unlock_purchases
    where payment_intent_id = 'pi_852_61'),
  'a purchase refunded after its reservation is not marked deducted'
);

-- Compte devenu abonné pendant que sa session était ouverte : crédit, pas de déblocage -----------------
insert into public.user_sale_unlocks (user_id, sale_id)
values ('c8520000-0000-4000-8000-000000000002', 'c8520000-1000-4000-8000-000000000000');
insert into ids
select 'p4', reservation.purchase_id
from public.reserve_sale_unlock_purchase(
  'c8520000-0000-4000-8000-000000000002', 'c8520000-1000-4000-8000-000000000003'
) reservation;
insert into public.user_subscriptions (user_id, plan_code, status, current_period_end)
values ('c8520000-0000-4000-8000-000000000002', 'analyse', 'active', now() + interval '30 days');

select is(
  (
    select grant_row::text
    from public.grant_purchased_sale_unlock(
      (select id from ids where name = 'p4'), 'c8520000-0000-4000-8000-000000000002',
      'c8520000-1000-4000-8000-000000000003', 'cs_852_4', 'pi_852_4', 1900, 'eur', 'evt_852_g4', now()
    ) grant_row
  ),
  '(t,credit)',
  'an account that became Analyse before the payment gets a credit'
);
select ok(
  not exists (
    select 1 from public.user_sale_unlocks
    where user_id = 'c8520000-0000-4000-8000-000000000002'
      and sale_id = 'c8520000-1000-4000-8000-000000000003'
  )
  and app_private.sale_unlock_credits_available('c8520000-0000-4000-8000-000000000002') = 1,
  'no unlock row is written, the purchase is one credit'
);
select is(
  public.reserve_unit_purchase_deduction('c8520000-0000-4000-8000-000000000002', 'token-852-22222222', now()),
  1900,
  'that credit can be deducted from a first month'
);
select is(
  public.settle_unit_purchase_deduction('token-852-22222222', 'cs_analyse_852_2'),
  1900,
  'the deduction is settled'
);
select is(
  app_private.sale_unlock_credits_available('c8520000-0000-4000-8000-000000000002'),
  0,
  'once deducted, it is no longer a credit'
);

-- Suppression d'une vente retirée : ce que le retrait a rendu reste rendu --------------------------------
-- 08 achète la vente 7 ; 09 a débloqué gratuitement la vente 8 ; 10 a débloqué gratuitement la vente 9.
insert into public.user_sale_unlocks (user_id, sale_id) values
  ('c8520000-0000-4000-8000-000000000008', 'c8520000-1000-4000-8000-000000000000'),
  ('c8520000-0000-4000-8000-000000000009', 'c8520000-1000-4000-8000-000000000008'),
  ('c8520000-0000-4000-8000-000000000010', 'c8520000-1000-4000-8000-000000000009');
insert into ids
select 'p8', reservation.purchase_id
from public.reserve_sale_unlock_purchase(
  'c8520000-0000-4000-8000-000000000008', 'c8520000-1000-4000-8000-000000000007'
) reservation;
select * from public.grant_purchased_sale_unlock(
  (select id from ids where name = 'p8'), 'c8520000-0000-4000-8000-000000000008',
  'c8520000-1000-4000-8000-000000000007', 'cs_852_8', 'pi_852_8', 1900, 'eur', 'evt_852_g8', now()
);
update public.auction_sales set status = 'withdrawn'
where id in ('c8520000-1000-4000-8000-000000000007', 'c8520000-1000-4000-8000-000000000008');
-- La base exige le rattachement au graphe des issues avant toute suppression de fiche (comme la purge).
select count(*) from public.bridge_auction_sales_to_outcome_graph();
delete from public.auction_sales
where id in (
  'c8520000-1000-4000-8000-000000000007', 'c8520000-1000-4000-8000-000000000008',
  'c8520000-1000-4000-8000-000000000009'
);

select ok(
  (select count(*) from public.user_sale_unlocks where purchase_id = (select id from ids where name = 'p8')) = 0
  and app_private.sale_unlock_credits_available('c8520000-0000-4000-8000-000000000008') = 1,
  'a bought sale withdrawn then deleted leaves its purchase a credit'
);
select is(
  app_private.sale_unlocks_used('c8520000-0000-4000-8000-000000000009'),
  0,
  'a free unlock of a sale withdrawn then deleted stays given back'
);
select ok(
  app_private.sale_unlocks_used('c8520000-0000-4000-8000-000000000010') = 1
  and (select count(*) from public.user_sale_unlocks
        where user_id = 'c8520000-0000-4000-8000-000000000010' and sale_id is null) = 1,
  'a sale deleted while not withdrawn gives nothing back: its row is detached and keeps counting'
);

set local role authenticated;
set local "request.jwt.claim.sub" = 'c8520000-0000-4000-8000-000000000008';
select is(
  (public.redeem_sale_unlock_credit('c8520000-1000-4000-8000-000000000005') ->> 'consumed')::boolean,
  true,
  'that credit opens another sale'
);
set local "request.jwt.claim.sub" = 'c8520000-0000-4000-8000-000000000001';
reset role;

-- 24 mois --------------------------------------------------------------------------------------------------
insert into public.sale_unlock_purchases (
  id, user_id, sale_id, payment_intent_id, amount_cents, currency, state, outcome, paid_at
) values (
  'c8520000-3000-4000-8000-000000000007', 'c8520000-0000-4000-8000-000000000007',
  'c8520000-1000-4000-8000-000000000004', 'pi_852_7', 1900, 'eur', 'paid', 'unlocked',
  now() - interval '25 months'
);
insert into public.user_sale_unlocks (user_id, sale_id, unlocked_at, source, purchase_id)
values (
  'c8520000-0000-4000-8000-000000000007', 'c8520000-1000-4000-8000-000000000004',
  now() - interval '25 months', 'purchase', 'c8520000-3000-4000-8000-000000000007'
);
select app_private.purge_sale_unlocks(now());

select ok(
  (select count(*) from public.user_sale_unlocks where user_id = 'c8520000-0000-4000-8000-000000000007') = 0
  and (select count(*) from public.sale_unlock_purchases where user_id = 'c8520000-0000-4000-8000-000000000007') = 1,
  'the 24-month purge removes the bought unlock and keeps the purchase'
);
select is(
  app_private.sale_unlock_credits_available('c8520000-0000-4000-8000-000000000007'),
  0,
  'a bought unlock over 24 months old does not become a credit'
);

-- Rôles du navigateur ----------------------------------------------------------------------------------------
set local role authenticated;
select throws_ok(
  $$select * from public.sale_unlock_purchases$$,
  '42501',
  null,
  'an account cannot read sale_unlock_purchases directly'
);
select throws_ok(
  $$insert into public.sale_unlock_purchases (user_id, amount_cents, currency)
    values ('c8520000-0000-4000-8000-000000000001', 1, 'eur')$$,
  '42501',
  null,
  'an account cannot write sale_unlock_purchases'
);
select throws_ok(
  $$select * from public.grant_purchased_sale_unlock(
    gen_random_uuid(), 'c8520000-0000-4000-8000-000000000001', 'c8520000-1000-4000-8000-000000000004',
    'cs_852_9', 'pi_852_9', 1900, 'eur', 'evt_852_9', now())$$,
  '42501',
  null,
  'an account cannot grant itself a bought unlock'
);
select ok(
  public.get_sale_unlock_status() ?& array['credits', 'source', 'period_start', 'period_end', 'limit', 'used', 'remaining'],
  'the status keeps its keys and adds credits and source'
);
reset role;

-- Preuve d'acceptation ---------------------------------------------------------------------------------------
select lives_ok(
  $$insert into public.commercial_acceptances (
      user_id, purpose, terms_version, terms_sha256, privacy_version, privacy_sha256, offer_code,
      amount_cents, currency, terms_accepted, payment_obligation_acknowledged,
      immediate_performance_requested, withdrawal_information_acknowledged
    ) values (
      'c8520000-0000-4000-8000-000000000001', 'sale_unlock_purchase', 'test', repeat('a', 64), 'test',
      repeat('b', 64), 'sale_unlock_unit', 1900, 'eur', true, true, true, true
    )$$,
  'a commercial acceptance can record a unit purchase'
);

select * from finish();
rollback;
