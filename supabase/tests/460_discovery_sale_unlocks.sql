-- "3 déblocages par mois": a Découverte account unlocks one sale at a time, three per Paris month.
begin;

select plan(59);

-- Fixtures -------------------------------------------------------------------------------------
insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data
) values
  ('c4600000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'unlock-free@example.test', '', now(), now(), now(),
   '{}'::jsonb, '{}'::jsonb),
  ('c4600000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'unlock-other@example.test', '', now(), now(), now(),
   '{}'::jsonb, '{}'::jsonb),
  ('c4600000-0000-4000-8000-000000000003', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'unlock-analysis@example.test', '', now(), now(), now(),
   '{}'::jsonb, '{}'::jsonb),
  ('c4600000-0000-4000-8000-000000000004', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'unlock-month@example.test', '', now(), now(), now(),
   '{}'::jsonb, '{}'::jsonb);

insert into public.user_subscriptions (user_id, plan_code, status, current_period_end)
values
  ('c4600000-0000-4000-8000-000000000001', 'decouverte', 'active', null),
  ('c4600000-0000-4000-8000-000000000002', 'decouverte', 'active', null),
  ('c4600000-0000-4000-8000-000000000003', 'analyse', 'active', now() + interval '30 days'),
  ('c4600000-0000-4000-8000-000000000004', 'decouverte', 'active', null);

-- Seven online sales (s1..s5, s7, s8) and one sale already past (s6).
insert into public.auction_sales (id, source_name, source_url, title, status, sale_date)
select
  ('c4600000-1000-4000-8000-' || lpad(i::text, 12, '0'))::uuid,
  'sale-unlock-test',
  'https://example.test/sale-unlock/' || i,
  'Protected unlock title ' || i,
  case when i = 6 then 'past' else 'upcoming' end,
  case when i = 6 then now() - interval '30 days' else '2099-01-01 12:00:00Z'::timestamptz end
from generate_series(1, 8) i;

-- Official documents, risks and score factors of s1 and s2.
insert into public.auction_documents (source_url, document_url, label, document_type)
values
  ('https://example.test/sale-unlock/1', 'https://example.test/sale-unlock/1/pv.pdf', 'PV', 'pv'),
  ('https://example.test/sale-unlock/2', 'https://example.test/sale-unlock/2/pv.pdf', 'PV', 'pv');
insert into public.auction_risks (source_url, risk_type, risk_label)
values
  ('https://example.test/sale-unlock/1', 'occupancy', 'Occupation'),
  ('https://example.test/sale-unlock/2', 'occupancy', 'Occupation');
insert into public.auction_risk_occurrences (source_url, risk_type, risk_label, excerpt)
values
  ('https://example.test/sale-unlock/1', 'occupancy', 'Occupation', 'bien occupé'),
  ('https://example.test/sale-unlock/2', 'occupancy', 'Occupation', 'bien occupé');
insert into public.auction_score_factors (source_url, factor_key, label)
values
  ('https://example.test/sale-unlock/1', 'price', 'Prix'),
  ('https://example.test/sale-unlock/2', 'price', 'Prix');

-- Structure and constants ----------------------------------------------------------------------
select has_table('public', 'user_sale_unlocks', 'unlocked sales are stored');
select is(app_private.monthly_sale_unlock_limit(), 3, 'the database quota is three unlocks a month');
select ok(
  not has_table_privilege('authenticated', 'public.user_sale_unlocks', 'INSERT')
  and not has_table_privilege('authenticated', 'public.user_sale_unlocks', 'UPDATE')
  and not has_table_privilege('authenticated', 'public.user_sale_unlocks', 'DELETE')
  and has_table_privilege('authenticated', 'public.user_sale_unlocks', 'SELECT')
  and not has_table_privilege('anon', 'public.user_sale_unlocks', 'SELECT'),
  'clients can read their own unlocks but never write the table'
);
select ok(
  (select relrowsecurity from pg_class where oid = 'public.user_sale_unlocks'::regclass),
  'row level security is enabled on the unlock table'
);
select ok(
  not has_function_privilege('anon', 'public.unlock_sale(uuid)', 'EXECUTE')
  and has_function_privilege('authenticated', 'public.unlock_sale(uuid)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'app_private.unlock_sale_at(uuid, timestamptz)', 'EXECUTE'),
  'only the public wrapper is callable by an account; the clock-injecting function is not'
);

-- Paris month ----------------------------------------------------------------------------------
select is(
  (select period_start from app_private.sale_unlock_period('2026-10-31T23:30:00Z')),
  '2026-10-31T23:00:00Z'::timestamptz,
  '31/10 23:30 UTC is already 1 November 00:30 in Paris: the month of November has started'
);
select is(
  (select period_end from app_private.sale_unlock_period('2026-10-31T23:30:00Z')),
  '2026-11-30T23:00:00Z'::timestamptz,
  'the November period ends at 1 December 00:00 Paris time (UTC+1)'
);
select is(
  (select period_start from app_private.sale_unlock_period('2026-10-31T22:59:59Z')),
  '2026-09-30T22:00:00Z'::timestamptz,
  '31/10 22:59 UTC is still 31 October 23:59 in Paris (UTC+1): October (summer start, UTC+2)'
);
select is(
  (select period_start from app_private.sale_unlock_period('2026-06-30T22:30:00Z')),
  '2026-06-30T22:00:00Z'::timestamptz,
  'in summer time the month starts at 22:00 UTC the evening before'
);

-- A signed-in Découverte account ---------------------------------------------------------------
set local role authenticated;
set local "request.jwt.claim.role" = 'authenticated';
set local "request.jwt.claim.sub" = 'c4600000-0000-4000-8000-000000000001';

select is(
  (select count(*) from public.auction_sales where title like 'Protected unlock title%'),
  0::bigint,
  'before any unlock the account reads no sale'
);
select is(
  (select count(*) from public.auction_documents where source_url like 'https://example.test/sale-unlock/%'),
  0::bigint,
  'before any unlock the account reads no official document'
);
select is(
  (select public.get_sale_unlock_status('c4600000-1000-4000-8000-000000000001') ->> 'remaining')::integer,
  3,
  'three unlocks are available at the start of the month'
);

select is(
  (select public.unlock_sale('c4600000-1000-4000-8000-000000000001') ->> 'remaining')::integer,
  2,
  'the first unlock leaves two'
);
select is(
  (select (public.unlock_sale('c4600000-1000-4000-8000-000000000001') ->> 'consumed')::boolean),
  false,
  'unlocking the same sale again consumes nothing'
);
select is(
  (select public.get_sale_unlock_status() ->> 'used')::integer,
  1,
  'the idempotent call did not use a second unlock'
);

select is(
  (select count(*) from public.auction_sales where id = 'c4600000-1000-4000-8000-000000000001'),
  1::bigint,
  'the unlocked sale is readable'
);
select is(
  (select count(*) from public.auction_sales where id <> 'c4600000-1000-4000-8000-000000000001'
     and title like 'Protected unlock title%'),
  0::bigint,
  'every other sale stays hidden'
);
select is(
  (select count(*) from public.auction_documents where source_url = 'https://example.test/sale-unlock/1'),
  1::bigint,
  'the official documents of the unlocked sale are readable'
);
select is(
  (select count(*) from public.auction_risks where source_url = 'https://example.test/sale-unlock/1')
  + (select count(*) from public.auction_risk_occurrences where source_url = 'https://example.test/sale-unlock/1')
  + (select count(*) from public.auction_score_factors where source_url = 'https://example.test/sale-unlock/1'),
  3::bigint,
  'the risks and the score factors of the unlocked sale are readable'
);
select is(
  (select count(*) from public.auction_documents where source_url = 'https://example.test/sale-unlock/2')
  + (select count(*) from public.auction_risks where source_url = 'https://example.test/sale-unlock/2')
  + (select count(*) from public.auction_risk_occurrences where source_url = 'https://example.test/sale-unlock/2')
  + (select count(*) from public.auction_score_factors where source_url = 'https://example.test/sale-unlock/2'),
  0::bigint,
  'the documents and risks of a sale that was not unlocked stay hidden'
);
select is(
  (select jsonb_array_length(documents_rich) from public.v_auction_sales_app
    where id = 'c4600000-1000-4000-8000-000000000001'),
  1,
  'the catalogue view serves the unlocked sale with its documents'
);
select is(
  (select count(*) from public.v_auction_sales_app where title like 'Protected unlock title%'),
  1::bigint,
  'the catalogue view serves nothing else'
);

select lives_ok(
  $$select public.unlock_sale('c4600000-1000-4000-8000-000000000002')$$,
  'a second sale can be unlocked'
);
select is(
  (select public.unlock_sale('c4600000-1000-4000-8000-000000000003') ->> 'remaining')::integer,
  0,
  'the third unlock leaves none'
);
select throws_ok(
  $$select public.unlock_sale('c4600000-1000-4000-8000-000000000004')$$,
  'P0001',
  'Vous avez utilisé tous vos déblocages de ce mois-ci.',
  'the fourth unlock of the month is refused'
);
select is(
  (select count(*) from public.auction_sales where id = 'c4600000-1000-4000-8000-000000000004'),
  0::bigint,
  'the refused sale stays hidden'
);
select is(
  (select (public.unlock_sale('c4600000-1000-4000-8000-000000000001') ->> 'already_unlocked')::boolean),
  true,
  'an unlocked sale can still be opened once the quota is spent'
);
select throws_ok(
  $$select public.unlock_sale('c4600000-1000-4000-8000-000000000006')$$,
  'P0002',
  'Vente introuvable ou plus en ligne.',
  'a sale that is no longer online cannot be unlocked'
);

-- No direct write -------------------------------------------------------------------------------
select throws_ok(
  $$insert into public.user_sale_unlocks (user_id, sale_id)
    values ('c4600000-0000-4000-8000-000000000001', 'c4600000-1000-4000-8000-000000000005')$$,
  '42501',
  'permission denied for table user_sale_unlocks',
  'an account cannot insert an unlock itself'
);
select throws_ok(
  $$delete from public.user_sale_unlocks$$,
  '42501',
  'permission denied for table user_sale_unlocks',
  'an account cannot delete an unlock to get its credit back'
);

-- Another account ------------------------------------------------------------------------------
set local "request.jwt.claim.sub" = 'c4600000-0000-4000-8000-000000000002';
select is(
  (select count(*) from public.auction_sales where title like 'Protected unlock title%'),
  0::bigint,
  'another account does not see the sales unlocked by someone else'
);
select is(
  (select count(*) from public.user_sale_unlocks),
  0::bigint,
  'another account cannot read the unlock list of someone else'
);
select is(
  (select count(*) from public.auction_documents where source_url like 'https://example.test/sale-unlock/%'),
  0::bigint,
  'another account does not see the documents of a sale unlocked by someone else'
);

-- An Analyse account ---------------------------------------------------------------------------
set local "request.jwt.claim.sub" = 'c4600000-0000-4000-8000-000000000003';
select is(
  (select count(*) from public.v_auction_sales_app where title like 'Protected unlock title%'),
  7::bigint,
  'Analyse reads every online sale through the catalogue view, as before'
);
select is(
  (select (public.unlock_sale('c4600000-1000-4000-8000-000000000001') ->> 'consumed')::boolean),
  false,
  'an Analyse account consumes nothing'
);
select is(
  (select count(*) from public.user_sale_unlocks),
  0::bigint,
  'no unlock row is created for an Analyse account'
);
select is(
  (select public.get_sale_unlock_status() ->> 'limit'),
  null::text,
  'an Analyse account has no quota to display'
);

-- Not signed in ----------------------------------------------------------------------------------
set local "request.jwt.claim.sub" = '';
select throws_ok(
  $$select public.unlock_sale('c4600000-1000-4000-8000-000000000005')$$,
  '42501',
  'Connexion requise.',
  'a request without a signed-in account is refused'
);
reset role;
set local role anon;
select throws_ok(
  $$select public.unlock_sale('c4600000-1000-4000-8000-000000000005')$$,
  '42501',
  'permission denied for function unlock_sale',
  'a visitor cannot call the unlock function'
);
reset role;

-- The unlocked sale leaves the catalogue: the access goes with it, the credit is not given back --
update public.auction_sales set status = 'past', sale_date = now() - interval '1 day'
where id = 'c4600000-1000-4000-8000-000000000001';
set local role authenticated;
set local "request.jwt.claim.sub" = 'c4600000-0000-4000-8000-000000000001';
select is(
  (select count(*) from public.auction_sales where id = 'c4600000-1000-4000-8000-000000000001'),
  0::bigint,
  'a sale that is no longer online is no longer readable, unlocked or not'
);
select is(
  (select public.get_sale_unlock_status() ->> 'used')::integer,
  3,
  'the credit of a sale that left the catalogue is not given back'
);
reset role;

-- Purging a sale does not give the credit back either -----------------------------------------
-- Catalogue retention only deletes rows that already carry their Outcome Graph bridge.
do $$ begin perform public.bridge_auction_sales_to_outcome_graph(); end $$;
delete from public.auction_sales where id = 'c4600000-1000-4000-8000-000000000002';
select is(
  (select count(*) from public.user_sale_unlocks
    where user_id = 'c4600000-0000-4000-8000-000000000001' and sale_id is null),
  1::bigint,
  'the unlock of a purged sale is kept, detached from the sale'
);
set local role authenticated;
set local "request.jwt.claim.sub" = 'c4600000-0000-4000-8000-000000000001';
select is(
  (select public.get_sale_unlock_status() ->> 'remaining')::integer,
  0,
  'a purged sale does not restore a credit'
);
reset role;

-- A duplicate merge keeps the unlock: the secondary row is deleted, the canonical row lists its url -----
insert into public.auction_sales (id, source_name, source_url, title, status, sale_date, source_urls)
values
  ('c4600000-1000-4000-8000-000000000011', 'sale-unlock-test', 'https://example.test/sale-unlock/merge-secondary',
   'Protected unlock title merge secondary', 'upcoming', '2099-01-01 12:00:00Z', '[]'::jsonb),
  ('c4600000-1000-4000-8000-000000000012', 'sale-unlock-test', 'https://example.test/sale-unlock/merge-canonical',
   'Protected unlock title merge canonical', 'upcoming', '2099-01-01 12:00:00Z',
   '["https://example.test/sale-unlock/merge-canonical", "https://example.test/sale-unlock/merge-secondary"]'::jsonb);
set local "request.jwt.claim.sub" = 'c4600000-0000-4000-8000-000000000002';
set local role authenticated;
select lives_ok(
  $$select public.unlock_sale('c4600000-1000-4000-8000-000000000011')$$,
  'an account unlocks the secondary listing of a duplicated sale'
);
reset role;
do $$ begin perform public.bridge_auction_sales_to_outcome_graph(); end $$;
delete from public.auction_sales where id = 'c4600000-1000-4000-8000-000000000011';
select is(
  (select sale_id from public.user_sale_unlocks
    where user_id = 'c4600000-0000-4000-8000-000000000002'),
  'c4600000-1000-4000-8000-000000000012'::uuid,
  'the merge moves the unlock to the canonical sale'
);
set local role authenticated;
select is(
  (select count(*) from public.auction_sales where id = 'c4600000-1000-4000-8000-000000000012'),
  1::bigint,
  'the merged sale stays readable for the account that unlocked it'
);
select is(
  (select (public.get_sale_unlock_status() ->> 'used')::integer),
  1,
  'the merge neither adds nor removes a credit'
);
reset role;

-- An account that unlocked both listings keeps both credits counted, with one access left.
insert into public.auction_sales (id, source_name, source_url, title, status, sale_date, source_urls)
values
  ('c4600000-1000-4000-8000-000000000013', 'sale-unlock-test', 'https://example.test/sale-unlock/merge-secondary-2',
   'Protected unlock title merge secondary 2', 'upcoming', '2099-01-01 12:00:00Z', '[]'::jsonb),
  ('c4600000-1000-4000-8000-000000000014', 'sale-unlock-test', 'https://example.test/sale-unlock/merge-canonical-2',
   'Protected unlock title merge canonical 2', 'upcoming', '2099-01-01 12:00:00Z',
   '["https://example.test/sale-unlock/merge-secondary-2"]'::jsonb);
insert into public.user_sale_unlocks (user_id, sale_id) values
  ('c4600000-0000-4000-8000-000000000003', 'c4600000-1000-4000-8000-000000000013'),
  ('c4600000-0000-4000-8000-000000000003', 'c4600000-1000-4000-8000-000000000014');
do $$ begin perform public.bridge_auction_sales_to_outcome_graph(); end $$;
delete from public.auction_sales where id = 'c4600000-1000-4000-8000-000000000013';
select is(
  (select count(*) from public.user_sale_unlocks where user_id = 'c4600000-0000-4000-8000-000000000003'),
  2::bigint,
  'an account that unlocked both listings keeps both credits counted'
);
select is(
  (select count(*) from public.user_sale_unlocks
    where user_id = 'c4600000-0000-4000-8000-000000000003'
      and sale_id = 'c4600000-1000-4000-8000-000000000014'),
  1::bigint,
  'and still has a single unlock on the canonical sale'
);

select is(
  (select count(*) from public.user_sale_unlocks
    where user_id = 'c4600000-0000-4000-8000-000000000003' and sale_id is null),
  1::bigint,
  'the duplicate unlock is detached, never merged into one credit'
);
delete from public.user_sale_unlocks where user_id = 'c4600000-0000-4000-8000-000000000003';

-- Paris month change, clock injected ---------------------------------------------------------------
set local "request.jwt.claim.sub" = 'c4600000-0000-4000-8000-000000000004';
select lives_ok(
  $$select app_private.unlock_sale_at('c4600000-1000-4000-8000-000000000003', '2026-10-10T10:00:00Z');
    select app_private.unlock_sale_at('c4600000-1000-4000-8000-000000000004', '2026-10-20T10:00:00Z');
    select app_private.unlock_sale_at('c4600000-1000-4000-8000-000000000005', '2026-10-31T22:30:00Z')$$,
  'three unlocks are made during October'
);
select throws_ok(
  $$select app_private.unlock_sale_at('c4600000-1000-4000-8000-000000000007', '2026-10-31T22:59:00Z')$$,
  'P0001',
  'Vous avez utilisé tous vos déblocages de ce mois-ci.',
  '31/10 22:59 UTC (23:59 in Paris) is still October: refused'
);
select lives_ok(
  $$select app_private.unlock_sale_at('c4600000-1000-4000-8000-000000000007', '2026-10-31T23:30:00Z')$$,
  '31/10 23:30 UTC is 1 November 00:30 in Paris: the counter has restarted'
);
reset role;

-- Retention ---------------------------------------------------------------------------------------
-- Dates are fixed so that the run below does not depend on the day the suite is executed.
update public.user_sale_unlocks set unlocked_at = '2026-10-15T10:00:00Z'
where user_id = 'c4600000-0000-4000-8000-000000000001';
select is(
  (select count(*) from public.user_sale_unlocks where user_id = 'c4600000-0000-4000-8000-000000000001'),
  3::bigint,
  'the first account holds its three October unlocks (one detached from its purged sale)'
);
select lives_ok(
  $$select public.run_data_retention('2026-12-01T00:00:00Z'::timestamptz)$$,
  'the scheduled retention run covers the unlock table'
);
select is(
  (select count(*) from public.user_sale_unlocks
    where user_id = 'c4600000-0000-4000-8000-000000000001' and sale_id is null),
  0::bigint,
  'an unlock detached from its sale is removed once its month is over'
);
select is(
  (select count(*) from public.user_sale_unlocks where user_id = 'c4600000-0000-4000-8000-000000000001'),
  2::bigint,
  'the unlocks still attached to an existing sale are kept'
);
select lives_ok(
  $$select app_private.purge_sale_unlocks('2029-12-01T00:00:00Z'::timestamptz)$$,
  'the purge accepts a clock three years later'
);
select is(
  (select count(*) from public.user_sale_unlocks
    where user_id in (
      'c4600000-0000-4000-8000-000000000001', 'c4600000-0000-4000-8000-000000000004'
    )),
  0::bigint,
  'no unlock is kept more than 24 months'
);

select * from finish();
rollback;
