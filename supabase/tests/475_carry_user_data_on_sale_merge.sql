-- Fusion de doublons sans perte (20261028110000) : les données des comptes d'une ligne supprimée passent à
-- la fiche conservée sans doublon et sans quota, la correspondance ancien identifiant -> fiche conservée
-- est notée, et la redirection ne mène qu'à une fiche visible au catalogue public.
begin;

select plan(37);

-- Fixtures -------------------------------------------------------------------------------------
insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data
) values
  ('c4750000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'merge-one@example.test', '', now(), now(), now(),
   '{}'::jsonb, '{}'::jsonb),
  ('c4750000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'merge-two@example.test', '', now(), now(), now(),
   '{}'::jsonb, '{}'::jsonb);

insert into public.user_subscriptions (user_id, plan_code, status, current_period_end)
values
  ('c4750000-0000-4000-8000-000000000001', 'decouverte', 'active', null),
  ('c4750000-0000-4000-8000-000000000002', 'decouverte', 'active', null);

-- Ventes : c1 (conservée, visible) liste l'URL de s1 (supprimée) ; c2 (conservée mais en quarantaine, donc
-- masquée) liste l'URL de s2 ; f1 et f2 sont deux autres ventes en ligne sans rapport.
insert into public.auction_sales (id, source_name, source_url, title, status, sale_date, source_urls)
values
  ('c4750000-1000-4000-8000-000000000001', 'merge-carry-test', 'https://example.test/merge-carry/c1',
   'Merge carry c1', 'upcoming', '2099-01-01 12:00:00Z',
   '["https://example.test/merge-carry/c1", "https://example.test/merge-carry/s1"]'::jsonb),
  ('c4750000-1000-4000-8000-000000000002', 'merge-carry-test', 'https://example.test/merge-carry/s1',
   'Merge carry s1', 'upcoming', '2099-01-01 12:00:00Z',
   '["https://example.test/merge-carry/s1"]'::jsonb),
  ('c4750000-1000-4000-8000-000000000003', 'merge-carry-test', 'https://example.test/merge-carry/c2',
   'Merge carry c2', 'upcoming', '2099-01-01 12:00:00Z',
   '["https://example.test/merge-carry/c2", "https://example.test/merge-carry/s2"]'::jsonb),
  ('c4750000-1000-4000-8000-000000000004', 'merge-carry-test', 'https://example.test/merge-carry/s2',
   'Merge carry s2', 'upcoming', '2099-01-01 12:00:00Z',
   '["https://example.test/merge-carry/s2"]'::jsonb),
  ('c4750000-1000-4000-8000-000000000005', 'merge-carry-test', 'https://example.test/merge-carry/f1',
   'Merge carry f1', 'upcoming', '2099-01-01 12:00:00Z', '[]'::jsonb),
  ('c4750000-1000-4000-8000-000000000006', 'merge-carry-test', 'https://example.test/merge-carry/f2',
   'Merge carry f2', 'upcoming', '2099-01-01 12:00:00Z', '[]'::jsonb),
  ('c4750000-1000-4000-8000-000000000007', 'merge-carry-test', 'https://example.test/merge-carry/lone',
   'Merge carry lone', 'upcoming', '2099-01-01 12:00:00Z', '[]'::jsonb);

-- c2 est masquée du catalogue public par la clé de quarantaine de sa fiche (catalogue_quarantined).
update public.auction_sales
   set raw_payload = '{"publication_quarantine": "merge_carry_test"}'::jsonb
 where id = 'c4750000-1000-4000-8000-000000000003';

-- Structure -------------------------------------------------------------------------------------
select has_table('app_private', 'auction_sale_merges', 'the merge correspondence table exists');
select ok(
  (select relrowsecurity from pg_class where oid = 'app_private.auction_sale_merges'::regclass)
  and not has_table_privilege('anon', 'app_private.auction_sale_merges', 'SELECT')
  and not has_table_privilege('authenticated', 'app_private.auction_sale_merges', 'SELECT')
  and has_table_privilege('service_role', 'app_private.auction_sale_merges', 'SELECT')
  and not has_table_privilege('service_role', 'app_private.auction_sale_merges', 'INSERT'),
  'the correspondence is closed to browser roles and read-only for service_role'
);
select has_trigger('public', 'auction_sales', 'auction_sales_carry_sale_user_data', 'the merge trigger exists');
select ok(
  not has_function_privilege('anon', 'app_private.carry_sale_user_data_to_merged_sale()', 'EXECUTE')
  and not has_function_privilege('authenticated', 'app_private.carry_sale_user_data_to_merged_sale()', 'EXECUTE'),
  'the trigger function is not callable by browser roles'
);
select ok(
  (select prosecdef and proconfig @> array['search_path=""']
     from pg_proc where oid = 'app_private.carry_sale_user_data_to_merged_sale()'::regprocedure)
  and (select prosecdef and proconfig @> array['search_path=""']
         from pg_proc where oid = 'app_private.get_merged_sale_target(uuid)'::regprocedure),
  'the trigger and the redirect lookup are SECURITY DEFINER with an empty search_path'
);
select ok(
  has_function_privilege('anon', 'public.get_merged_sale_target(uuid)', 'EXECUTE')
  and has_function_privilege('authenticated', 'public.get_merged_sale_target(uuid)', 'EXECUTE'),
  'the redirect lookup is callable by visitors'
);

-- Données de comptes sur la ligne qui sera supprimée (s1) et sur la fiche conservée (c1) -------------
-- Compte 1 : trois favoris (le quota gratuit), dont s1.
insert into public.user_favorites (id, user_id, sale_id) values
  ('c4750000-2000-4000-8000-000000000001', 'c4750000-0000-4000-8000-000000000001', 'c4750000-1000-4000-8000-000000000002'),
  ('c4750000-2000-4000-8000-000000000002', 'c4750000-0000-4000-8000-000000000001', 'c4750000-1000-4000-8000-000000000005'),
  ('c4750000-2000-4000-8000-000000000003', 'c4750000-0000-4000-8000-000000000001', 'c4750000-1000-4000-8000-000000000006');
-- Compte 2 : favori sur s1 ET sur c1 (doublon à ne pas créer).
insert into public.user_favorites (id, user_id, sale_id) values
  ('c4750000-2000-4000-8000-000000000004', 'c4750000-0000-4000-8000-000000000002', 'c4750000-1000-4000-8000-000000000002'),
  ('c4750000-2000-4000-8000-000000000005', 'c4750000-0000-4000-8000-000000000002', 'c4750000-1000-4000-8000-000000000001');

-- Espaces de travail : compte 1 sur s1 (avec une annotation), compte 2 sur s1 et c1.
insert into public.sale_workspaces (id, user_id, sale_id, private_notes) values
  ('c4750000-3000-4000-8000-000000000001', 'c4750000-0000-4000-8000-000000000001', 'c4750000-1000-4000-8000-000000000002', '{"note": "compte 1"}'::jsonb),
  ('c4750000-3000-4000-8000-000000000002', 'c4750000-0000-4000-8000-000000000002', 'c4750000-1000-4000-8000-000000000002', '{"note": "compte 2, s1"}'::jsonb),
  ('c4750000-3000-4000-8000-000000000003', 'c4750000-0000-4000-8000-000000000002', 'c4750000-1000-4000-8000-000000000001', '{"note": "compte 2, c1"}'::jsonb);
insert into public.sale_workspace_annotations (id, workspace_id, sale_id, author_id, body) values
  ('c4750000-3100-4000-8000-000000000001', 'c4750000-3000-4000-8000-000000000001', 'c4750000-1000-4000-8000-000000000002', 'c4750000-0000-4000-8000-000000000001', 'Question au greffe');

-- Rapport enregistré du compte 1 sur s1 ; le compte 2 en a un de même nature sur s1 et sur c1.
insert into public.saved_property_reports (id, user_id, sale_id, report_kind, title) values
  ('c4750000-4000-4000-8000-000000000001', 'c4750000-0000-4000-8000-000000000001', 'c4750000-1000-4000-8000-000000000002', 'opportunity', 'Rapport 1'),
  ('c4750000-4000-4000-8000-000000000002', 'c4750000-0000-4000-8000-000000000002', 'c4750000-1000-4000-8000-000000000002', 'opportunity', 'Rapport 2 sur s1'),
  ('c4750000-4000-4000-8000-000000000003', 'c4750000-0000-4000-8000-000000000002', 'c4750000-1000-4000-8000-000000000001', 'opportunity', 'Rapport 2 sur c1');

-- Alertes : le compte 1 a une correspondance sur s1 et sur c1 (même alerte : un doublon), le compte 2 une
-- correspondance sur s1 seulement, avec sa notification.
-- Un compte Découverte n'a droit qu'à une alerte hebdomadaire sans critère avancé
-- (app_private.enforce_geographic_alert_quota) : une par compte, en « weekly ».
insert into public.user_alerts (id, user_id, name, alert_frequency) values
  ('c4750000-5000-4000-8000-000000000001', 'c4750000-0000-4000-8000-000000000001', 'Alerte 1', 'weekly'),
  ('c4750000-5000-4000-8000-000000000002', 'c4750000-0000-4000-8000-000000000002', 'Alerte 2', 'weekly');
insert into public.user_alert_matches (id, user_id, alert_id, sale_id) values
  ('c4750000-5100-4000-8000-000000000001', 'c4750000-0000-4000-8000-000000000001', 'c4750000-5000-4000-8000-000000000001', 'c4750000-1000-4000-8000-000000000002'),
  ('c4750000-5100-4000-8000-000000000002', 'c4750000-0000-4000-8000-000000000001', 'c4750000-5000-4000-8000-000000000001', 'c4750000-1000-4000-8000-000000000001'),
  ('c4750000-5100-4000-8000-000000000003', 'c4750000-0000-4000-8000-000000000002', 'c4750000-5000-4000-8000-000000000002', 'c4750000-1000-4000-8000-000000000002');
insert into public.user_alert_notifications (id, user_id, alert_id, match_id, sale_id) values
  ('c4750000-5200-4000-8000-000000000001', 'c4750000-0000-4000-8000-000000000001', 'c4750000-5000-4000-8000-000000000001', 'c4750000-5100-4000-8000-000000000001', 'c4750000-1000-4000-8000-000000000002'),
  ('c4750000-5200-4000-8000-000000000003', 'c4750000-0000-4000-8000-000000000002', 'c4750000-5000-4000-8000-000000000002', 'c4750000-5100-4000-8000-000000000003', 'c4750000-1000-4000-8000-000000000002');

-- Suivis : un instantané et un événement pour le favori du compte 1 sur s1 ; un instantané pour le
-- favori du compte 2 sur s1 (ce favori est en double : il disparaît, son instantané ne doit pas rester seul).
insert into public.user_sale_watch_snapshots (id, user_id, sale_id, watch_kind, watch_id, fingerprint) values
  ('c4750000-6000-4000-8000-000000000001', 'c4750000-0000-4000-8000-000000000001', 'c4750000-1000-4000-8000-000000000002', 'favorite', 'c4750000-2000-4000-8000-000000000001', 'fp-1'),
  ('c4750000-6000-4000-8000-000000000002', 'c4750000-0000-4000-8000-000000000002', 'c4750000-1000-4000-8000-000000000002', 'favorite', 'c4750000-2000-4000-8000-000000000004', 'fp-2');
insert into public.user_sale_change_events (id, user_id, sale_id, watch_kind, watch_id, event_kind, fingerprint, summary_label) values
  ('c4750000-6100-4000-8000-000000000001', 'c4750000-0000-4000-8000-000000000001', 'c4750000-1000-4000-8000-000000000002', 'favorite', 'c4750000-2000-4000-8000-000000000001', 'price_changed', 'ev-1', 'Prix modifié');

-- Ensemble d'analyse du compte 1 avec s1.
insert into public.user_sale_analysis_sets (id, user_id, name) values
  ('c4750000-7000-4000-8000-000000000001', 'c4750000-0000-4000-8000-000000000001', 'Comparaison fusion');
insert into public.user_sale_analysis_items (id, analysis_set_id, user_id, sale_id) values
  ('c4750000-7100-4000-8000-000000000001', 'c4750000-7000-4000-8000-000000000001', 'c4750000-0000-4000-8000-000000000001', 'c4750000-1000-4000-8000-000000000002');

-- Demande d'actualisation du compte 1 sur s1.
insert into public.data_refresh_requests (id, user_id, sale_id, source_url, request_kind) values
  ('c4750000-8000-4000-8000-000000000001', 'c4750000-0000-4000-8000-000000000001', 'c4750000-1000-4000-8000-000000000002', 'https://example.test/merge-carry/s1', 'dpe');

-- Fusion : la base exige le rattachement au graphe des issues avant toute suppression de fiche -----------
select count(*) from public.bridge_auction_sales_to_outcome_graph();

select lives_ok(
  $$delete from public.auction_sales where id = 'c4750000-1000-4000-8000-000000000002'$$,
  'the secondary row is deleted (merge) without error, quota trigger included'
);

-- Transfert -------------------------------------------------------------------------------------
select is(
  (select count(*) from public.user_favorites
    where user_id = 'c4750000-0000-4000-8000-000000000001' and sale_id = 'c4750000-1000-4000-8000-000000000001'),
  1::bigint,
  'a favorite of the deleted row moves to the kept sale'
);
select is(
  (select count(*) from public.user_favorites where user_id = 'c4750000-0000-4000-8000-000000000001'),
  3::bigint,
  'the transfer neither loses nor adds a favorite: the free quota (3) did not block it'
);
select is(
  (select id from public.user_favorites
    where user_id = 'c4750000-0000-4000-8000-000000000001' and sale_id = 'c4750000-1000-4000-8000-000000000001'),
  'c4750000-2000-4000-8000-000000000001'::uuid,
  'the favorite keeps its identifier'
);
select is(
  (select count(*) from public.user_favorites
    where user_id = 'c4750000-0000-4000-8000-000000000002' and sale_id = 'c4750000-1000-4000-8000-000000000001'),
  1::bigint,
  'a favorite already on the kept sale is not duplicated'
);
select is(
  (select count(*) from public.user_favorites where sale_id = 'c4750000-1000-4000-8000-000000000002'),
  0::bigint,
  'no favorite remains on the deleted row'
);

select is(
  (select sale_id from public.sale_workspaces where id = 'c4750000-3000-4000-8000-000000000001'),
  'c4750000-1000-4000-8000-000000000001'::uuid,
  'a workspace (notes) moves to the kept sale'
);
select is(
  (select private_notes ->> 'note' from public.sale_workspaces
    where user_id = 'c4750000-0000-4000-8000-000000000002' and sale_id = 'c4750000-1000-4000-8000-000000000001'),
  'compte 2, c1',
  'a workspace already on the kept sale is left as it was, not overwritten or duplicated'
);
select is(
  (select sale_id from public.sale_workspace_annotations where id = 'c4750000-3100-4000-8000-000000000001'),
  'c4750000-1000-4000-8000-000000000001'::uuid,
  'the annotations follow their workspace'
);

select is(
  (select count(*) from public.saved_property_reports
    where user_id = 'c4750000-0000-4000-8000-000000000001' and sale_id = 'c4750000-1000-4000-8000-000000000001'),
  1::bigint,
  'a saved report moves to the kept sale'
);
select is(
  (select count(*) from public.saved_property_reports
    where user_id = 'c4750000-0000-4000-8000-000000000002' and sale_id = 'c4750000-1000-4000-8000-000000000001'),
  1::bigint,
  'a report of the same kind already on the kept sale is not duplicated'
);

select is(
  (select count(*) from public.user_alert_matches
    where alert_id = 'c4750000-5000-4000-8000-000000000001' and sale_id = 'c4750000-1000-4000-8000-000000000001'),
  1::bigint,
  'an alert match already on the kept sale is not duplicated'
);
select is(
  (select sale_id from public.user_alert_matches where id = 'c4750000-5100-4000-8000-000000000003'),
  'c4750000-1000-4000-8000-000000000001'::uuid,
  'an alert match moves to the kept sale'
);
select is(
  (select sale_id from public.user_alert_notifications where id = 'c4750000-5200-4000-8000-000000000003'),
  'c4750000-1000-4000-8000-000000000001'::uuid,
  'the notification follows its match'
);
select is(
  (select count(*) from public.user_alert_notifications where user_id = 'c4750000-0000-4000-8000-000000000001'),
  0::bigint,
  'the notification of a duplicate match goes with it: no second notification for the same alert'
);

select is(
  (select sale_id from public.user_sale_watch_snapshots where id = 'c4750000-6000-4000-8000-000000000001'),
  'c4750000-1000-4000-8000-000000000001'::uuid,
  'the watch snapshot of a moved favorite moves to the kept sale'
);
select is(
  (select count(*) from public.user_sale_watch_snapshots where id = 'c4750000-6000-4000-8000-000000000002'),
  0::bigint,
  'the snapshot of a duplicate favorite does not stay behind on its own'
);
select is(
  (select sale_id from public.user_sale_change_events where id = 'c4750000-6100-4000-8000-000000000001'),
  'c4750000-1000-4000-8000-000000000001'::uuid,
  'the change events of the account move to the kept sale'
);

select is(
  (select sale_id from public.user_sale_analysis_items where id = 'c4750000-7100-4000-8000-000000000001'),
  'c4750000-1000-4000-8000-000000000001'::uuid,
  'an analysis set item moves to the kept sale'
);

select is(
  (select sale_id::text || ' ' || source_url from public.data_refresh_requests
    where id = 'c4750000-8000-4000-8000-000000000001'),
  'c4750000-1000-4000-8000-000000000001 https://example.test/merge-carry/c1',
  'a refresh request follows the kept sale (identifier and source URL)'
);

-- Correspondance et redirection ------------------------------------------------------------------
select is(
  (select canonical_sale_id from app_private.auction_sale_merges
    where old_sale_id = 'c4750000-1000-4000-8000-000000000002'),
  'c4750000-1000-4000-8000-000000000001'::uuid,
  'the old identifier is mapped to the kept sale'
);

select lives_ok(
  $$delete from public.auction_sales where id = 'c4750000-1000-4000-8000-000000000007'$$,
  'a row without a kept sale is deleted as before (retention)'
);
select is(
  (select count(*) from app_private.auction_sale_merges
    where old_sale_id = 'c4750000-1000-4000-8000-000000000007'),
  0::bigint,
  'and leaves no correspondence'
);

-- s2 est fusionnée dans c2, qui est masquée (quarantaine).
select count(*) from public.bridge_auction_sales_to_outcome_graph();
select lives_ok(
  $$delete from public.auction_sales where id = 'c4750000-1000-4000-8000-000000000004'$$,
  'a second merge, into a sale hidden from the catalogue'
);

set local role anon;
select is(
  public.get_merged_sale_target('c4750000-1000-4000-8000-000000000002'),
  'c4750000-1000-4000-8000-000000000001'::uuid,
  'a merged identifier redirects to the kept sale when it is visible'
);
select is(
  public.get_merged_sale_target('c4750000-1000-4000-8000-000000000004'),
  null::uuid,
  'a merged identifier whose kept sale is hidden redirects nowhere (404, no leak of the hidden sale)'
);
select is(
  public.get_merged_sale_target('c4750000-1000-4000-8000-000000000001'),
  null::uuid,
  'an identifier that was never merged redirects nowhere'
);
select is(
  public.get_merged_sale_target('00000000-0000-0000-0000-000000000000'),
  null::uuid,
  'an unknown identifier redirects nowhere'
);
select throws_ok(
  $$select * from app_private.auction_sale_merges$$,
  '42501',
  null,
  'a visitor cannot read the correspondence table'
);
reset role;

-- Chaîne : c1 est à son tour fusionnée dans c3 ; l'ancien identifiant mène à la dernière fiche conservée.
insert into public.auction_sales (id, source_name, source_url, title, status, sale_date, source_urls)
values
  ('c4750000-1000-4000-8000-000000000008', 'merge-carry-test', 'https://example.test/merge-carry/c3',
   'Merge carry c3', 'upcoming', '2099-01-01 12:00:00Z',
   '["https://example.test/merge-carry/c3", "https://example.test/merge-carry/c1", "https://example.test/merge-carry/s1"]'::jsonb);
select count(*) from public.bridge_auction_sales_to_outcome_graph();
delete from public.auction_sales where id = 'c4750000-1000-4000-8000-000000000001';

select is(
  (select canonical_sale_id from app_private.auction_sale_merges
    where old_sale_id = 'c4750000-1000-4000-8000-000000000002'),
  'c4750000-1000-4000-8000-000000000008'::uuid,
  'a chain of merges: the first old identifier follows the latest kept sale'
);
select is(
  (select count(*) from public.user_favorites
    where user_id = 'c4750000-0000-4000-8000-000000000001' and sale_id = 'c4750000-1000-4000-8000-000000000008'),
  1::bigint,
  'and the account data followed the chain'
);

select * from finish();
rollback;
