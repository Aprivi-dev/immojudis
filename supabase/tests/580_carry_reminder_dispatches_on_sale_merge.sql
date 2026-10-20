-- Fusion de doublons (20261029150000) : les rappels déjà envoyés (sale_reminder_dispatches) passent à la fiche
-- conservée sans doublon, de sorte que le cron ne renvoie pas un rappel déjà reçu.
begin;

select plan(14);

-- Fixtures -------------------------------------------------------------------------------------
insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data
) values
  ('58000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'dispatch-merge-one@example.test', '', now(), now(), now(),
   '{}'::jsonb, '{}'::jsonb),
  ('58000000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'dispatch-merge-two@example.test', '', now(), now(), now(),
   '{}'::jsonb, '{}'::jsonb);

-- c1 (conservée) liste l'URL de s1 (supprimée) ; l1 est une vente sans rapport (supprimée sans fiche conservée).
insert into public.auction_sales (id, source_name, source_url, title, status, sale_date, source_urls)
values
  ('58000000-1000-4000-8000-000000000001', 'dispatch-merge-test', 'https://example.test/dispatch-merge/c1',
   'Dispatch merge c1', 'upcoming', '2099-01-01 12:00:00Z',
   '["https://example.test/dispatch-merge/c1", "https://example.test/dispatch-merge/s1"]'::jsonb),
  ('58000000-1000-4000-8000-000000000002', 'dispatch-merge-test', 'https://example.test/dispatch-merge/s1',
   'Dispatch merge s1', 'upcoming', '2099-01-01 12:00:00Z',
   '["https://example.test/dispatch-merge/s1"]'::jsonb),
  ('58000000-1000-4000-8000-000000000003', 'dispatch-merge-test', 'https://example.test/dispatch-merge/l1',
   'Dispatch merge l1', 'upcoming', '2099-01-01 12:00:00Z', '[]'::jsonb);

-- Journal des rappels :
--   d1 : compte 1, s1, audience_j7 du 2099-01-01, envoyé : doit suivre la fiche conservée ;
--   d2 : compte 1, s1, audience_j1 du 2098-12-31 ; d4 : même clé déjà sur c1 (envoyé avec un autre message) :
--        d2 disparaît avec s1, d4 reste telle quelle ;
--   d3 : compte 2, s1, date_changed (empreinte « fp-x »), envoyé : suit la fiche conservée ;
--   d5 : compte 2, s1, audience_j1 du 2098-12-31 : la même clé que d2 mais pour un autre compte : suit aussi ;
--   d6 : compte 1, l1 : sans fiche conservée, disparaît avec la ligne comme avant.
insert into public.sale_reminder_dispatches
  (id, user_id, sale_id, reminder_kind, dedupe_key, mode, status, message_id, sent_at)
values
  ('58000000-2000-4000-8000-000000000001', '58000000-0000-4000-8000-000000000001',
   '58000000-1000-4000-8000-000000000002', 'audience_j7', '2099-01-01', 'on', 'sent', 'msg_s1_j7', now()),
  ('58000000-2000-4000-8000-000000000002', '58000000-0000-4000-8000-000000000001',
   '58000000-1000-4000-8000-000000000002', 'audience_j1', '2098-12-31', 'on', 'sent', 'msg_s1_j1', now()),
  ('58000000-2000-4000-8000-000000000003', '58000000-0000-4000-8000-000000000002',
   '58000000-1000-4000-8000-000000000002', 'date_changed', 'fp-x', 'on', 'sent', 'msg_s1_changed', now()),
  ('58000000-2000-4000-8000-000000000004', '58000000-0000-4000-8000-000000000001',
   '58000000-1000-4000-8000-000000000001', 'audience_j1', '2098-12-31', 'on', 'sent', 'msg_c1_j1', now()),
  ('58000000-2000-4000-8000-000000000005', '58000000-0000-4000-8000-000000000002',
   '58000000-1000-4000-8000-000000000002', 'audience_j1', '2098-12-31', 'on', 'sent', 'msg_s1_j1_two', now()),
  ('58000000-2000-4000-8000-000000000006', '58000000-0000-4000-8000-000000000001',
   '58000000-1000-4000-8000-000000000003', 'audience_j7', '2099-01-01', 'on', 'sent', 'msg_l1', now());

-- Structure -------------------------------------------------------------------------------------
select has_trigger('public', 'auction_sales', 'auction_sales_carry_sale_user_data', 'the merge trigger is still in place');
select ok(
  (select prosecdef and proconfig @> array['search_path=""']
     from pg_proc where oid = 'app_private.carry_sale_user_data_to_merged_sale()'::regprocedure),
  'the trigger function stays SECURITY DEFINER with an empty search_path'
);
select ok(
  not has_function_privilege('anon', 'app_private.carry_sale_user_data_to_merged_sale()', 'EXECUTE')
  and not has_function_privilege('authenticated', 'app_private.carry_sale_user_data_to_merged_sale()', 'EXECUTE'),
  'the trigger function is not callable by browser roles'
);
select ok(
  (select pg_get_functiondef('app_private.carry_sale_user_data_to_merged_sale()'::regprocedure)
          like '%sale_reminder_dispatches%'),
  'the trigger function now carries the reminder log'
);

-- Fusion : la base exige le rattachement au graphe des issues avant toute suppression de fiche ----------
select count(*) from public.bridge_auction_sales_to_outcome_graph();

select lives_ok(
  $$delete from public.auction_sales where id = '58000000-1000-4000-8000-000000000002'$$,
  'the secondary row is deleted (merge) without error'
);

-- Transfert -------------------------------------------------------------------------------------
select is(
  (select sale_id from public.sale_reminder_dispatches where id = '58000000-2000-4000-8000-000000000001'),
  '58000000-1000-4000-8000-000000000001'::uuid,
  'a reminder already sent moves to the kept sale (same row, same identifier)'
);
select is(
  (select status || ' ' || message_id from public.sale_reminder_dispatches
    where id = '58000000-2000-4000-8000-000000000001'),
  'sent msg_s1_j7',
  'and keeps its status and message'
);
select is(
  (select sale_id from public.sale_reminder_dispatches where id = '58000000-2000-4000-8000-000000000003'),
  '58000000-1000-4000-8000-000000000001'::uuid,
  'a change-event reminder of another account moves too'
);
select is(
  (select sale_id from public.sale_reminder_dispatches where id = '58000000-2000-4000-8000-000000000005'),
  '58000000-1000-4000-8000-000000000001'::uuid,
  'the same reminder key of another account is not mistaken for a duplicate'
);
select is(
  (select count(*) from public.sale_reminder_dispatches
    where user_id = '58000000-0000-4000-8000-000000000001'
      and sale_id = '58000000-1000-4000-8000-000000000001'
      and reminder_kind = 'audience_j1' and dedupe_key = '2098-12-31'),
  1::bigint,
  'a reminder key already on the kept sale is not duplicated'
);
select is(
  (select message_id from public.sale_reminder_dispatches where id = '58000000-2000-4000-8000-000000000004'),
  'msg_c1_j1',
  'and the kept sale row is left as it was'
);
select is(
  (select count(*) from public.sale_reminder_dispatches where sale_id = '58000000-1000-4000-8000-000000000002'),
  0::bigint,
  'no reminder log row remains on the deleted row'
);

-- Le cron ne renvoie pas un rappel déjà envoyé -------------------------------------------------------
set local role service_role;
select is(
  public.claim_sale_reminder(
    '58000000-0000-4000-8000-000000000001', '58000000-1000-4000-8000-000000000001',
    'audience_j7', '2099-01-01', 'on'
  ),
  null::uuid,
  'the reminder already sent for the merged row is not claimed again for the kept sale'
);
reset role;

-- Sans fiche conservée : comportement inchangé (rétention) --------------------------------------------
select lives_ok(
  $$delete from public.auction_sales where id = '58000000-1000-4000-8000-000000000003'$$,
  'a row without a kept sale is deleted as before, its reminder log with it'
);

select * from finish();
rollback;
