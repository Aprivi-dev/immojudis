-- Rapport enregistré ouvert par le déblocage de sa vente (20261121100000).
--   * un compte gratuit lit son rapport d'une vente qu'il a débloquée, pas celui d'une vente non débloquée ;
--   * il ne lit jamais le rapport d'un autre compte, même sur une vente qu'il a débloquée ;
--   * un abonné Analyse lit les siens, et seulement les siens ;
--   * property_report_exports n'est pas ouverte à un déblocage.
-- État de base laissé par 20261120100000 : l'essai est coupé. Les comptes gratuits n'ont donc pas l'accès
-- Analyse ; l'abonné a une fin de période future (une ligne sans fin n'ouvre rien, test 850).
begin;

select plan(12);

-- 01 et 02 comptes gratuits ; 03 abonné Analyse
insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data
) values
  ('c8110000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'free-a@reports811.example.test', '', now(),
   now(), now(), '{}'::jsonb, '{}'::jsonb),
  ('c8110000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'free-b@reports811.example.test', '', now(),
   now(), now(), '{}'::jsonb, '{}'::jsonb),
  ('c8110000-0000-4000-8000-000000000003', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'analyse@reports811.example.test', '', now(),
   now(), now(), '{}'::jsonb, '{}'::jsonb);

insert into public.user_subscriptions (user_id, plan_code, status, current_period_end)
values
  ('c8110000-0000-4000-8000-000000000001', 'decouverte', 'active', null),
  ('c8110000-0000-4000-8000-000000000002', 'decouverte', 'active', null),
  ('c8110000-0000-4000-8000-000000000003', 'analyse', 'active', now() + interval '30 days');

-- s1 et s2 en ligne
insert into public.auction_sales (id, source_name, source_url, title, status, sale_date)
select
  ('c8110000-1000-4000-8000-' || lpad(i::text, 12, '0'))::uuid,
  'saved-reports-unlock-test',
  'https://example.test/saved-reports-unlock/' || i,
  'Saved report unlock title ' || i,
  'upcoming',
  '2099-01-01 12:00:00Z'::timestamptz
from generate_series(1, 2) i;

-- Les deux comptes gratuits ont débloqué s1 (le déblocage est écrit par unlock_sale en production ;
-- ici directement, le test porte sur la politique des rapports).
insert into public.user_sale_unlocks (user_id, sale_id, unlocked_at)
values
  ('c8110000-0000-4000-8000-000000000001', 'c8110000-1000-4000-8000-000000000001', now()),
  ('c8110000-0000-4000-8000-000000000002', 'c8110000-1000-4000-8000-000000000001', now());

-- Rapports écrits par le serveur : a1 (A, s1), a2 (A, s2), b1 (B, s1), c1 (abonné, s1), c2 (abonné, s2)
insert into public.saved_property_reports (id, user_id, sale_id, title, report_kind)
values
  ('c8110000-2000-4000-8000-0000000000a1', 'c8110000-0000-4000-8000-000000000001',
   'c8110000-1000-4000-8000-000000000001', 'A on s1', 'bid_ceiling'),
  ('c8110000-2000-4000-8000-0000000000a2', 'c8110000-0000-4000-8000-000000000001',
   'c8110000-1000-4000-8000-000000000002', 'A on s2', 'bid_ceiling'),
  ('c8110000-2000-4000-8000-0000000000b1', 'c8110000-0000-4000-8000-000000000002',
   'c8110000-1000-4000-8000-000000000001', 'B on s1', 'bid_ceiling'),
  ('c8110000-2000-4000-8000-0000000000c1', 'c8110000-0000-4000-8000-000000000003',
   'c8110000-1000-4000-8000-000000000001', 'Analyse on s1', 'bid_ceiling'),
  ('c8110000-2000-4000-8000-0000000000c2', 'c8110000-0000-4000-8000-000000000003',
   'c8110000-1000-4000-8000-000000000002', 'Analyse on s2', 'bid_ceiling');

-- Structure -------------------------------------------------------------------------------------------
select is(
  (select permissive from pg_catalog.pg_policies
   where schemaname = 'public' and tablename = 'saved_property_reports'
     and policyname = 'analysis_access_required'),
  'RESTRICTIVE',
  'the saved reports policy stays restrictive'
);
select ok(
  (select qual like '%current_user_unlocked_sale(sale_id)%' and qual like '%has_analysis_access()%'
   from pg_catalog.pg_policies
   where schemaname = 'public' and tablename = 'saved_property_reports'
     and policyname = 'analysis_access_required'),
  'the saved reports policy opens the Analyse access or the unlocked sale'
);
select ok(
  (select qual not like '%current_user_unlocked_sale%'
   from pg_catalog.pg_policies
   where schemaname = 'public' and tablename = 'property_report_exports'
     and policyname = 'analysis_access_required'),
  'the report exports policy is not opened to an unlock'
);

-- Compte gratuit A ------------------------------------------------------------------------------------
set local role authenticated;
set local "request.jwt.claim.role" = 'authenticated';
set local "request.jwt.claim.sub" = 'c8110000-0000-4000-8000-000000000001';

select ok(not public.has_analysis_access(), 'the free account has no Analyse access');
select is(
  (select count(*) from public.saved_property_reports
   where id = 'c8110000-2000-4000-8000-0000000000a1'),
  1::bigint,
  'a free account reads its report of the sale it unlocked'
);
select is(
  (select count(*) from public.saved_property_reports
   where id = 'c8110000-2000-4000-8000-0000000000a2'),
  0::bigint,
  'a free account does not read its report of a sale it did not unlock'
);
select is(
  (select count(*) from public.saved_property_reports
   where id = 'c8110000-2000-4000-8000-0000000000b1'),
  0::bigint,
  'a free account does not read the report of another account on the sale it unlocked'
);
select is(
  (select count(*) from public.saved_property_reports),
  1::bigint,
  'a free account reads one report in all'
);

-- Compte gratuit B ------------------------------------------------------------------------------------
set local "request.jwt.claim.sub" = 'c8110000-0000-4000-8000-000000000002';

select is(
  (select array_agg(id order by id) from public.saved_property_reports),
  array['c8110000-2000-4000-8000-0000000000b1']::uuid[],
  'another free account reads its own report of the same unlocked sale only'
);

-- Abonné Analyse --------------------------------------------------------------------------------------
set local "request.jwt.claim.sub" = 'c8110000-0000-4000-8000-000000000003';

select ok(public.has_analysis_access(), 'the subscriber has the Analyse access');
select is(
  (select array_agg(id order by id) from public.saved_property_reports),
  array[
    'c8110000-2000-4000-8000-0000000000c1',
    'c8110000-2000-4000-8000-0000000000c2'
  ]::uuid[],
  'a subscriber reads its reports, unlocked sale or not'
);
select is(
  (select count(*) from public.saved_property_reports
   where user_id <> 'c8110000-0000-4000-8000-000000000003'),
  0::bigint,
  'a subscriber never reads the report of another account'
);
reset role;

select * from finish();
rollback;
