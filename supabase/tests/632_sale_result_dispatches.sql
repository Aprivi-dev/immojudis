-- 20261030120200 : journal des alertes de résultat ou de remise en vente. Un email (compte, vente, type)
-- n'est jamais réservé deux fois ; une ligne 'failed' ou 'pending' orpheline peut être reprise trois fois
-- au plus ; le journal est fermé au navigateur, survit à la suppression de la vente (pas de clé étrangère
-- vers auction_sales) et disparaît avec le compte ; la purge garde la fenêtre de conservation.
begin;

select plan(29);

-- Structure et droits -------------------------------------------------------------------------

select has_table('public', 'sale_result_dispatches', 'le journal des alertes de résultat existe');

select ok(
  (select relrowsecurity from pg_class where oid = 'public.sale_result_dispatches'::regclass),
  'la sécurité par ligne est activée sur le journal'
);

select ok(
  not has_table_privilege('anon', 'public.sale_result_dispatches', 'select')
  and not has_table_privilege('authenticated', 'public.sale_result_dispatches', 'select')
  and not has_table_privilege('authenticated', 'public.sale_result_dispatches', 'insert')
  and not has_table_privilege('authenticated', 'public.sale_result_dispatches', 'update')
  and not has_table_privilege('authenticated', 'public.sale_result_dispatches', 'delete')
  and has_table_privilege('service_role', 'public.sale_result_dispatches', 'select')
  and has_table_privilege('service_role', 'public.sale_result_dispatches', 'insert'),
  'le journal est fermé au navigateur et ouvert au seul service_role'
);

select ok(
  not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'sale_result_dispatches'),
  'aucune politique : aucun accès par ligne depuis le navigateur'
);

select ok(
  not exists (
    select 1
    from pg_constraint constraint_row
    where constraint_row.conrelid = 'public.sale_result_dispatches'::regclass
      and constraint_row.contype = 'f'
      and constraint_row.confrelid = 'public.auction_sales'::regclass
  ),
  'aucune clé étrangère vers auction_sales : le journal survit à la purge de la vente'
);

select ok(
  (
    select procedure_row.proconfig @> array['search_path=""']::text[]
      and not procedure_row.prosecdef
      and has_function_privilege('service_role', procedure_row.oid, 'execute')
      and not has_function_privilege('anon', procedure_row.oid, 'execute')
      and not has_function_privilege('authenticated', procedure_row.oid, 'execute')
    from pg_proc procedure_row
    where procedure_row.oid = 'public.claim_sale_result(uuid, uuid, text, text, jsonb)'::regprocedure
  ),
  'claim_sale_result est en security invoker, search_path vide, réservée au service_role'
);

select ok(
  (
    select procedure_row.proconfig @> array['search_path=""']::text[]
      and not procedure_row.prosecdef
      and has_function_privilege('service_role', procedure_row.oid, 'execute')
      and not has_function_privilege('anon', procedure_row.oid, 'execute')
      and not has_function_privilege('authenticated', procedure_row.oid, 'execute')
    from pg_proc procedure_row
    where procedure_row.oid = 'public.purge_sale_result_dispatches(interval)'::regprocedure
  ),
  'purge_sale_result_dispatches est en security invoker, search_path vide, réservée au service_role'
);

-- Données --------------------------------------------------------------------------------------

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data
) values
  ('63200000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'result-a@example.test', '', now(), now(), now(),
   '{}'::jsonb, '{}'::jsonb),
  ('63200000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'result-b@example.test', '', now(), now(), now(),
   '{}'::jsonb, '{}'::jsonb);

-- 1. Réserver une alerte ---------------------------------------------------------------------------

set local role service_role;

select isnt(
  public.claim_sale_result(
    '63200000-0000-4000-8000-000000000001', '63200000-1000-4000-8000-000000000001',
    'result_known', 'on', '{"origin":"snapshot"}'::jsonb
  ),
  null,
  'la première réservation donne la main pour envoyer'
);

select is(
  public.claim_sale_result(
    '63200000-0000-4000-8000-000000000001', '63200000-1000-4000-8000-000000000001',
    'result_known', 'on'
  ),
  null,
  'la même alerte ne peut pas être réservée une seconde fois (ligne pending)'
);

select isnt(
  public.claim_sale_result(
    '63200000-0000-4000-8000-000000000001', '63200000-1000-4000-8000-000000000001',
    'relisted', 'on'
  ),
  null,
  'un autre type pour la même vente a sa propre alerte'
);

select isnt(
  public.claim_sale_result(
    '63200000-0000-4000-8000-000000000002', '63200000-1000-4000-8000-000000000001',
    'result_known', 'internal'
  ),
  null,
  'une autre personne a sa propre alerte pour la même vente'
);

select isnt(
  public.claim_sale_result(
    '63200000-0000-4000-8000-000000000001', '63200000-1000-4000-8000-000000000002',
    'result_known', 'on'
  ),
  null,
  'une autre vente a sa propre alerte'
);

-- 2. Envoyé : jamais réservé de nouveau ; échoué : réessayé trois fois au plus -----------------------

update public.sale_result_dispatches
set status = 'sent', sent_at = now(), message_id = 'msg_pgtap_632'
where user_id = '63200000-0000-4000-8000-000000000001'
  and sale_id = '63200000-1000-4000-8000-000000000001'
  and result_kind = 'result_known';

select is(
  public.claim_sale_result(
    '63200000-0000-4000-8000-000000000001', '63200000-1000-4000-8000-000000000001',
    'result_known', 'on'
  ),
  null,
  'une alerte envoyée n''est jamais réservée de nouveau'
);

update public.sale_result_dispatches
set status = 'failed', error = 'send_failed'
where user_id = '63200000-0000-4000-8000-000000000001'
  and sale_id = '63200000-1000-4000-8000-000000000001'
  and result_kind = 'relisted';

select isnt(
  public.claim_sale_result(
    '63200000-0000-4000-8000-000000000001', '63200000-1000-4000-8000-000000000001',
    'relisted', 'on'
  ),
  null,
  'une alerte échouée peut être réessayée'
);

select is(
  (
    select attempts::text || ':' || status || ':' || coalesce(error, 'null')
    from public.sale_result_dispatches
    where user_id = '63200000-0000-4000-8000-000000000001'
      and sale_id = '63200000-1000-4000-8000-000000000001'
      and result_kind = 'relisted'
  ),
  '2:pending:null',
  'le nouvel essai compte une tentative, repasse en pending et efface le code d''erreur'
);

update public.sale_result_dispatches
set status = 'failed', error = 'send_failed'
where result_kind = 'relisted' and user_id = '63200000-0000-4000-8000-000000000001';
select lives_ok(
  $$select public.claim_sale_result(
    '63200000-0000-4000-8000-000000000001', '63200000-1000-4000-8000-000000000001', 'relisted', 'on')$$,
  'le troisième essai est encore accordé'
);
update public.sale_result_dispatches
set status = 'failed', error = 'send_failed'
where result_kind = 'relisted' and user_id = '63200000-0000-4000-8000-000000000001';

select is(
  public.claim_sale_result(
    '63200000-0000-4000-8000-000000000001', '63200000-1000-4000-8000-000000000001',
    'relisted', 'on'
  ),
  null,
  'après trois essais échoués, l''alerte n''est plus réessayée'
);

-- 3. Réservation orpheline : une ligne pending de plus d'une heure est reprise ------------------------

select is(
  public.claim_sale_result(
    '63200000-0000-4000-8000-000000000001', '63200000-1000-4000-8000-000000000002',
    'result_known', 'on'
  ),
  null,
  'une ligne pending récente (passage en cours) n''est pas reprise'
);

update public.sale_result_dispatches
set updated_at = now() - interval '2 hours'
where user_id = '63200000-0000-4000-8000-000000000001'
  and sale_id = '63200000-1000-4000-8000-000000000002';

select isnt(
  public.claim_sale_result(
    '63200000-0000-4000-8000-000000000001', '63200000-1000-4000-8000-000000000002',
    'result_known', 'on'
  ),
  null,
  'une ligne pending orpheline de plus d''une heure est reprise'
);

reset role;

-- 4. Contraintes ----------------------------------------------------------------------------------

select throws_ok(
  $$insert into public.sale_result_dispatches (user_id, sale_id, result_kind, mode)
    values ('63200000-0000-4000-8000-000000000001', '63200000-1000-4000-8000-000000000001',
            'result_known', 'on')$$,
  '23505', null, 'un doublon (compte, vente, type) est refusé par la base'
);

select throws_ok(
  $$insert into public.sale_result_dispatches (user_id, sale_id, result_kind, mode)
    values ('63200000-0000-4000-8000-000000000002', '63200000-1000-4000-8000-000000000002',
            'not_adjudicated', 'on')$$,
  '23514', null, 'un type inconnu est refusé : aucun type « non adjugée », aucune source ne le prouve'
);

select throws_ok(
  $$insert into public.sale_result_dispatches (user_id, sale_id, result_kind, mode)
    values ('63200000-0000-4000-8000-000000000002', '63200000-1000-4000-8000-000000000002',
            'withdrawn', 'off')$$,
  '23514', null, 'le mode "off" n''est jamais journalisé (rien n''est envoyé)'
);

select throws_ok(
  $$insert into public.sale_result_dispatches (user_id, sale_id, result_kind, mode, status, error)
    values ('63200000-0000-4000-8000-000000000002', '63200000-1000-4000-8000-000000000002',
            'withdrawn', 'on', 'failed', 'Resend a refusé l''envoi : adresse x@y.z')$$,
  '23514', null, 'une erreur en texte libre est refusée : seul un code de la liste fermée est accepté'
);

select lives_ok(
  $$insert into public.sale_result_dispatches (user_id, sale_id, result_kind, mode, status, error)
    values ('63200000-0000-4000-8000-000000000002', '63200000-1000-4000-8000-000000000002',
            'withdrawn', 'on', 'failed', 'email_unavailable')$$,
  'un code de la liste fermée est accepté'
);

-- 5. Purge --------------------------------------------------------------------------------------------

insert into public.sale_result_dispatches (user_id, sale_id, result_kind, mode, status, created_at)
values (
  '63200000-0000-4000-8000-000000000002', '63200000-1000-4000-8000-000000000003',
  'result_unknown', 'on', 'sent', now() - interval '200 days'
);

select throws_ok(
  $$select public.purge_sale_result_dispatches(interval '10 days')$$,
  'P0001', null, 'la conservation du journal ne peut pas descendre sous 30 jours'
);

select cmp_ok(
  public.purge_sale_result_dispatches(), '>=', 1,
  'la purge supprime les lignes de plus de 180 jours'
);

select is(
  (select count(*)::integer from public.sale_result_dispatches
    where sale_id = '63200000-1000-4000-8000-000000000003'),
  0,
  'la ligne ancienne a disparu'
);

select ok(
  (select count(*) from public.sale_result_dispatches
    where sale_id = '63200000-1000-4000-8000-000000000001') >= 1,
  'les lignes récentes sont conservées'
);

-- 6. Suppression du compte ------------------------------------------------------------------------

delete from auth.users where id = '63200000-0000-4000-8000-000000000002';

select is(
  (select count(*)::integer from public.sale_result_dispatches
    where user_id = '63200000-0000-4000-8000-000000000002'),
  0,
  'supprimer le compte supprime son journal'
);

select * from finish();

rollback;
