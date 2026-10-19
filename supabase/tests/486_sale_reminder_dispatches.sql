-- 20261028130100 : journal des rappels d'audience.  Un rappel (personne, vente, motif, clé) n'est
-- jamais réservé deux fois; une ligne 'failed' peut être réessayée trois fois au plus; le journal est
-- fermé au navigateur; la purge garde la fenêtre de conservation.
begin;

select plan(29);

-- Structure et droits -------------------------------------------------------------------------

select has_table('public', 'sale_reminder_dispatches', 'le journal des rappels existe');

select ok(
  (select relrowsecurity from pg_class where oid = 'public.sale_reminder_dispatches'::regclass),
  'la sécurité par ligne est activée sur le journal'
);

select ok(
  not has_table_privilege('anon', 'public.sale_reminder_dispatches', 'select')
  and not has_table_privilege('authenticated', 'public.sale_reminder_dispatches', 'select')
  and not has_table_privilege('authenticated', 'public.sale_reminder_dispatches', 'insert')
  and not has_table_privilege('authenticated', 'public.sale_reminder_dispatches', 'update')
  and not has_table_privilege('authenticated', 'public.sale_reminder_dispatches', 'delete')
  and has_table_privilege('service_role', 'public.sale_reminder_dispatches', 'select')
  and has_table_privilege('service_role', 'public.sale_reminder_dispatches', 'insert'),
  'le journal est fermé au navigateur et ouvert au seul service_role'
);

select ok(
  not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'sale_reminder_dispatches'),
  'aucune politique: aucun accès par ligne depuis le navigateur'
);

select ok(
  (
    select procedure_row.proconfig @> array['search_path=""']::text[]
      and not procedure_row.prosecdef
      and has_function_privilege('service_role', procedure_row.oid, 'execute')
      and not has_function_privilege('anon', procedure_row.oid, 'execute')
      and not has_function_privilege('authenticated', procedure_row.oid, 'execute')
    from pg_proc procedure_row
    where procedure_row.oid = 'public.claim_sale_reminder(uuid, uuid, text, text, text, jsonb)'::regprocedure
  ),
  'claim_sale_reminder est en security invoker, search_path vide, réservée au service_role'
);

select ok(
  (
    select procedure_row.proconfig @> array['search_path=""']::text[]
      and not procedure_row.prosecdef
      and has_function_privilege('service_role', procedure_row.oid, 'execute')
      and not has_function_privilege('anon', procedure_row.oid, 'execute')
      and not has_function_privilege('authenticated', procedure_row.oid, 'execute')
    from pg_proc procedure_row
    where procedure_row.oid = 'public.purge_sale_reminder_dispatches(interval)'::regprocedure
  ),
  'purge_sale_reminder_dispatches est en security invoker, search_path vide, réservée au service_role'
);

-- Données --------------------------------------------------------------------------------------

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data
) values
  ('48600000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'dispatch-a@example.test', '', now(), now(), now(),
   '{}'::jsonb, '{}'::jsonb),
  ('48600000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'dispatch-b@example.test', '', now(), now(), now(),
   '{}'::jsonb, '{}'::jsonb);

insert into public.auction_sales (id, source_name, source_url, title, status, sale_date)
values
  ('48600000-1000-4000-8000-000000000001', 'reminder-test', 'https://example.test/reminder/1',
   'Vente rappel 1', 'upcoming', now() + interval '30 days'),
  ('48600000-1000-4000-8000-000000000002', 'reminder-test', 'https://example.test/reminder/2',
   'Vente rappel 2', 'upcoming', now() + interval '30 days');

-- 1. Réserver un rappel -------------------------------------------------------------------------

set local role service_role;

select isnt(
  public.claim_sale_reminder(
    '48600000-0000-4000-8000-000000000001', '48600000-1000-4000-8000-000000000001',
    'audience_j7', '2026-11-10', 'on', '{"title":"Vente rappel 1"}'::jsonb
  ),
  null,
  'la première réservation d''un rappel donne la main pour envoyer'
);

select is(
  public.claim_sale_reminder(
    '48600000-0000-4000-8000-000000000001', '48600000-1000-4000-8000-000000000001',
    'audience_j7', '2026-11-10', 'on'
  ),
  null,
  'le même rappel ne peut pas être réservé une seconde fois (ligne pending)'
);

select isnt(
  public.claim_sale_reminder(
    '48600000-0000-4000-8000-000000000001', '48600000-1000-4000-8000-000000000001',
    'audience_j7', '2026-11-12', 'on'
  ),
  null,
  'une audience déplacée (autre jour) donne un nouveau rappel'
);

select isnt(
  public.claim_sale_reminder(
    '48600000-0000-4000-8000-000000000001', '48600000-1000-4000-8000-000000000001',
    'audience_j1', '2026-11-10', 'on'
  ),
  null,
  'le rappel de la veille est distinct du rappel à sept jours'
);

select isnt(
  public.claim_sale_reminder(
    '48600000-0000-4000-8000-000000000002', '48600000-1000-4000-8000-000000000001',
    'audience_j7', '2026-11-10', 'on'
  ),
  null,
  'une autre personne a son propre rappel pour la même vente'
);

select isnt(
  public.claim_sale_reminder(
    '48600000-0000-4000-8000-000000000001', '48600000-1000-4000-8000-000000000002',
    'audience_j7', '2026-11-10', 'on'
  ),
  null,
  'une autre vente a son propre rappel'
);

-- 2. Envoyé: jamais réservé de nouveau; échoué: réessayé trois fois au plus --------------------------

update public.sale_reminder_dispatches
set status = 'sent', sent_at = now(), message_id = 'msg_pgtap_486'
where user_id = '48600000-0000-4000-8000-000000000001'
  and sale_id = '48600000-1000-4000-8000-000000000001'
  and reminder_kind = 'audience_j7'
  and dedupe_key = '2026-11-10';

select is(
  public.claim_sale_reminder(
    '48600000-0000-4000-8000-000000000001', '48600000-1000-4000-8000-000000000001',
    'audience_j7', '2026-11-10', 'on'
  ),
  null,
  'un rappel envoyé n''est jamais réservé de nouveau'
);

update public.sale_reminder_dispatches
set status = 'failed', error = 'Resend a refusé l''envoi'
where user_id = '48600000-0000-4000-8000-000000000001'
  and sale_id = '48600000-1000-4000-8000-000000000001'
  and reminder_kind = 'audience_j1';

select isnt(
  public.claim_sale_reminder(
    '48600000-0000-4000-8000-000000000001', '48600000-1000-4000-8000-000000000001',
    'audience_j1', '2026-11-10', 'on'
  ),
  null,
  'un rappel échoué peut être réessayé'
);

select is(
  (
    select attempts::text || ':' || status || ':' || coalesce(error, 'null')
    from public.sale_reminder_dispatches
    where user_id = '48600000-0000-4000-8000-000000000001'
      and sale_id = '48600000-1000-4000-8000-000000000001'
      and reminder_kind = 'audience_j1'
  ),
  '2:pending:null',
  'le nouvel essai compte une tentative, repasse en pending et efface l''erreur'
);

update public.sale_reminder_dispatches
set status = 'failed', error = 'encore'
where reminder_kind = 'audience_j1'
  and user_id = '48600000-0000-4000-8000-000000000001';
select lives_ok(
  $$select public.claim_sale_reminder(
    '48600000-0000-4000-8000-000000000001', '48600000-1000-4000-8000-000000000001',
    'audience_j1', '2026-11-10', 'on')$$,
  'le troisième essai est encore accordé'
);
update public.sale_reminder_dispatches
set status = 'failed', error = 'toujours'
where reminder_kind = 'audience_j1'
  and user_id = '48600000-0000-4000-8000-000000000001';

select is(
  public.claim_sale_reminder(
    '48600000-0000-4000-8000-000000000001', '48600000-1000-4000-8000-000000000001',
    'audience_j1', '2026-11-10', 'on'
  ),
  null,
  'après trois essais échoués, le rappel n''est plus réessayé'
);

-- 2 bis. Réservation orpheline (20261028160000): une ligne pending de plus d'une heure est reprise ----

select is(
  public.claim_sale_reminder(
    '48600000-0000-4000-8000-000000000001', '48600000-1000-4000-8000-000000000002',
    'audience_j7', '2026-11-10', 'on'
  ),
  null,
  'une ligne pending récente (passage en cours) n''est pas reprise'
);

update public.sale_reminder_dispatches
set updated_at = now() - interval '2 hours'
where user_id = '48600000-0000-4000-8000-000000000001'
  and sale_id = '48600000-1000-4000-8000-000000000002'
  and reminder_kind = 'audience_j7';

select isnt(
  public.claim_sale_reminder(
    '48600000-0000-4000-8000-000000000001', '48600000-1000-4000-8000-000000000002',
    'audience_j7', '2026-11-10', 'on'
  ),
  null,
  'une ligne pending orpheline de plus d''une heure est reprise (rattrapage)'
);

select is(
  (
    select attempts::text || ':' || status
    from public.sale_reminder_dispatches
    where user_id = '48600000-0000-4000-8000-000000000001'
      and sale_id = '48600000-1000-4000-8000-000000000002'
      and reminder_kind = 'audience_j7'
  ),
  '2:pending',
  'la reprise d''une réservation orpheline compte une tentative'
);

update public.sale_reminder_dispatches
set updated_at = now() - interval '2 hours', attempts = 3
where user_id = '48600000-0000-4000-8000-000000000001'
  and sale_id = '48600000-1000-4000-8000-000000000002'
  and reminder_kind = 'audience_j7';

select is(
  public.claim_sale_reminder(
    '48600000-0000-4000-8000-000000000001', '48600000-1000-4000-8000-000000000002',
    'audience_j7', '2026-11-10', 'on'
  ),
  null,
  'une réservation orpheline qui a épuisé ses trois essais n''est plus reprise'
);

reset role;

-- 3. Contraintes ----------------------------------------------------------------------------------

select throws_ok(
  $$insert into public.sale_reminder_dispatches (user_id, sale_id, reminder_kind, dedupe_key, mode)
    values ('48600000-0000-4000-8000-000000000001', '48600000-1000-4000-8000-000000000001',
            'audience_j7', '2026-11-10', 'on')$$,
  '23505',
  null,
  'un doublon (personne, vente, motif, clé) est refusé par la base'
);

select throws_ok(
  $$insert into public.sale_reminder_dispatches (user_id, sale_id, reminder_kind, dedupe_key, mode)
    values ('48600000-0000-4000-8000-000000000002', '48600000-1000-4000-8000-000000000002',
            'prix_modifie', 'x', 'on')$$,
  '23514',
  null,
  'un motif inconnu est refusé'
);

select throws_ok(
  $$insert into public.sale_reminder_dispatches (user_id, sale_id, reminder_kind, dedupe_key, mode)
    values ('48600000-0000-4000-8000-000000000002', '48600000-1000-4000-8000-000000000002',
            'audience_j1', 'x', 'off')$$,
  '23514',
  null,
  'le mode "off" n''est jamais journalisé (rien n''est envoyé)'
);

-- 4. Purge --------------------------------------------------------------------------------------------

insert into public.sale_reminder_dispatches (
  user_id, sale_id, reminder_kind, dedupe_key, mode, status, created_at
) values (
  '48600000-0000-4000-8000-000000000002', '48600000-1000-4000-8000-000000000002',
  'status_changed', 'ancien', 'on', 'sent', now() - interval '200 days'
);

select throws_ok(
  $$select public.purge_sale_reminder_dispatches(interval '10 days')$$,
  'P0001',
  null,
  'la conservation du journal ne peut pas descendre sous 30 jours'
);

select cmp_ok(
  public.purge_sale_reminder_dispatches(),
  '>=',
  1,
  'la purge supprime les lignes de plus de 180 jours'
);

select is(
  (select count(*)::integer from public.sale_reminder_dispatches where dedupe_key = 'ancien'),
  0,
  'la ligne ancienne a disparu'
);

select ok(
  (select count(*) from public.sale_reminder_dispatches where dedupe_key = '2026-11-10') >= 1,
  'les lignes récentes sont conservées'
);

-- 5. Suppression du compte ------------------------------------------------------------------------

delete from auth.users where id = '48600000-0000-4000-8000-000000000002';

select is(
  (
    select count(*)::integer
    from public.sale_reminder_dispatches
    where user_id = '48600000-0000-4000-8000-000000000002'
  ),
  0,
  'supprimer le compte supprime son journal'
);

select * from finish();

rollback;
