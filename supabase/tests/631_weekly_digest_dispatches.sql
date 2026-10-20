-- 20261030120100 : journal du récapitulatif hebdomadaire « Ma semaine ». Un récapitulatif (compte,
-- semaine ISO) n'est jamais réservé deux fois ; une ligne 'failed' ou 'pending' orpheline peut être
-- reprise trois fois au plus ; le journal est fermé au navigateur ; l'erreur est un code d'une liste
-- fermée ; la purge garde la fenêtre de conservation.
begin;

select plan(27);

-- Structure et droits -------------------------------------------------------------------------

select has_table('public', 'weekly_digest_dispatches', 'le journal du récapitulatif existe');

select ok(
  (select relrowsecurity from pg_class where oid = 'public.weekly_digest_dispatches'::regclass),
  'la sécurité par ligne est activée sur le journal'
);

select ok(
  not has_table_privilege('anon', 'public.weekly_digest_dispatches', 'select')
  and not has_table_privilege('authenticated', 'public.weekly_digest_dispatches', 'select')
  and not has_table_privilege('authenticated', 'public.weekly_digest_dispatches', 'insert')
  and not has_table_privilege('authenticated', 'public.weekly_digest_dispatches', 'update')
  and not has_table_privilege('authenticated', 'public.weekly_digest_dispatches', 'delete')
  and has_table_privilege('service_role', 'public.weekly_digest_dispatches', 'select')
  and has_table_privilege('service_role', 'public.weekly_digest_dispatches', 'insert'),
  'le journal est fermé au navigateur et ouvert au seul service_role'
);

select ok(
  not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'weekly_digest_dispatches'),
  'aucune politique : aucun accès par ligne depuis le navigateur'
);

select ok(
  (
    select procedure_row.proconfig @> array['search_path=""']::text[]
      and not procedure_row.prosecdef
      and has_function_privilege('service_role', procedure_row.oid, 'execute')
      and not has_function_privilege('anon', procedure_row.oid, 'execute')
      and not has_function_privilege('authenticated', procedure_row.oid, 'execute')
    from pg_proc procedure_row
    where procedure_row.oid = 'public.claim_weekly_digest(uuid, text, text, jsonb)'::regprocedure
  ),
  'claim_weekly_digest est en security invoker, search_path vide, réservée au service_role'
);

select ok(
  (
    select procedure_row.proconfig @> array['search_path=""']::text[]
      and not procedure_row.prosecdef
      and has_function_privilege('service_role', procedure_row.oid, 'execute')
      and not has_function_privilege('anon', procedure_row.oid, 'execute')
      and not has_function_privilege('authenticated', procedure_row.oid, 'execute')
    from pg_proc procedure_row
    where procedure_row.oid = 'public.purge_weekly_digest_dispatches(interval)'::regprocedure
  ),
  'purge_weekly_digest_dispatches est en security invoker, search_path vide, réservée au service_role'
);

-- Données --------------------------------------------------------------------------------------

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data
) values
  ('63100000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'weekly-a@example.test', '', now(), now(), now(),
   '{}'::jsonb, '{}'::jsonb),
  ('63100000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'weekly-b@example.test', '', now(), now(), now(),
   '{}'::jsonb, '{}'::jsonb);

-- 1. Réserver un récapitulatif ------------------------------------------------------------------

set local role service_role;

select isnt(
  public.claim_weekly_digest(
    '63100000-0000-4000-8000-000000000001', '2026-W45', 'on', '{"audiences":2,"changes":1,"newSales":3}'::jsonb
  ),
  null,
  'la première réservation de la semaine donne la main pour envoyer'
);

select is(
  public.claim_weekly_digest('63100000-0000-4000-8000-000000000001', '2026-W45', 'on'),
  null,
  'le même récapitulatif ne peut pas être réservé une seconde fois (ligne pending)'
);

select isnt(
  public.claim_weekly_digest('63100000-0000-4000-8000-000000000001', '2026-W46', 'on'),
  null,
  'la semaine suivante a son propre récapitulatif'
);

select isnt(
  public.claim_weekly_digest('63100000-0000-4000-8000-000000000002', '2026-W45', 'internal'),
  null,
  'une autre personne a son propre récapitulatif pour la même semaine'
);

-- 2. Envoyé : jamais réservé de nouveau ; échoué : réessayé trois fois au plus -----------------------

update public.weekly_digest_dispatches
set status = 'sent', sent_at = now(), message_id = 'msg_pgtap_631'
where user_id = '63100000-0000-4000-8000-000000000001' and week_key = '2026-W45';

select is(
  public.claim_weekly_digest('63100000-0000-4000-8000-000000000001', '2026-W45', 'on'),
  null,
  'un récapitulatif envoyé n''est jamais réservé de nouveau'
);

update public.weekly_digest_dispatches
set status = 'failed', error = 'send_failed'
where user_id = '63100000-0000-4000-8000-000000000001' and week_key = '2026-W46';

select isnt(
  public.claim_weekly_digest('63100000-0000-4000-8000-000000000001', '2026-W46', 'on'),
  null,
  'un récapitulatif échoué peut être réessayé'
);

select is(
  (
    select attempts::text || ':' || status || ':' || coalesce(error, 'null')
    from public.weekly_digest_dispatches
    where user_id = '63100000-0000-4000-8000-000000000001' and week_key = '2026-W46'
  ),
  '2:pending:null',
  'le nouvel essai compte une tentative, repasse en pending et efface le code d''erreur'
);

update public.weekly_digest_dispatches
set status = 'failed', error = 'send_failed'
where user_id = '63100000-0000-4000-8000-000000000001' and week_key = '2026-W46';
select lives_ok(
  $$select public.claim_weekly_digest('63100000-0000-4000-8000-000000000001', '2026-W46', 'on')$$,
  'le troisième essai est encore accordé'
);
update public.weekly_digest_dispatches
set status = 'failed', error = 'send_failed'
where user_id = '63100000-0000-4000-8000-000000000001' and week_key = '2026-W46';

select is(
  public.claim_weekly_digest('63100000-0000-4000-8000-000000000001', '2026-W46', 'on'),
  null,
  'après trois essais échoués, le récapitulatif n''est plus réessayé'
);

-- 3. Réservation orpheline : une ligne pending de plus d'une heure est reprise ------------------------

select is(
  public.claim_weekly_digest('63100000-0000-4000-8000-000000000002', '2026-W45', 'internal'),
  null,
  'une ligne pending récente (passage en cours) n''est pas reprise'
);

update public.weekly_digest_dispatches
set updated_at = now() - interval '2 hours'
where user_id = '63100000-0000-4000-8000-000000000002' and week_key = '2026-W45';

select isnt(
  public.claim_weekly_digest('63100000-0000-4000-8000-000000000002', '2026-W45', 'internal'),
  null,
  'une ligne pending orpheline de plus d''une heure est reprise'
);

reset role;

-- 4. Contraintes ----------------------------------------------------------------------------------

select throws_ok(
  $$insert into public.weekly_digest_dispatches (user_id, week_key, mode)
    values ('63100000-0000-4000-8000-000000000001', '2026-W45', 'on')$$,
  '23505', null, 'un doublon (compte, semaine) est refusé par la base'
);

select throws_ok(
  $$insert into public.weekly_digest_dispatches (user_id, week_key, mode)
    values ('63100000-0000-4000-8000-000000000002', '2026-45', 'on')$$,
  '23514', null, 'une clé de semaine qui n''est pas AAAA-Www est refusée'
);

select throws_ok(
  $$insert into public.weekly_digest_dispatches (user_id, week_key, mode)
    values ('63100000-0000-4000-8000-000000000002', '2026-W47', 'off')$$,
  '23514', null, 'le mode "off" n''est jamais journalisé (rien n''est envoyé)'
);

select throws_ok(
  $$insert into public.weekly_digest_dispatches (user_id, week_key, mode, status, error)
    values ('63100000-0000-4000-8000-000000000002', '2026-W47', 'on', 'failed', 'Resend a refusé l''envoi : adresse x@y.z')$$,
  '23514', null, 'une erreur en texte libre est refusée : seul un code de la liste fermée est accepté'
);

select lives_ok(
  $$insert into public.weekly_digest_dispatches (user_id, week_key, mode, status, error)
    values ('63100000-0000-4000-8000-000000000002', '2026-W47', 'on', 'failed', 'email_unavailable')$$,
  'un code de la liste fermée est accepté'
);

-- 5. Purge --------------------------------------------------------------------------------------------

insert into public.weekly_digest_dispatches (user_id, week_key, mode, status, created_at)
values ('63100000-0000-4000-8000-000000000002', '2026-W10', 'on', 'sent', now() - interval '200 days');

select throws_ok(
  $$select public.purge_weekly_digest_dispatches(interval '10 days')$$,
  'P0001', null, 'la conservation du journal ne peut pas descendre sous 30 jours'
);

select cmp_ok(
  public.purge_weekly_digest_dispatches(), '>=', 1,
  'la purge supprime les lignes de plus de 180 jours'
);

select is(
  (select count(*)::integer from public.weekly_digest_dispatches where week_key = '2026-W10'),
  0,
  'la ligne ancienne a disparu'
);

select ok(
  (select count(*) from public.weekly_digest_dispatches where week_key = '2026-W45') >= 1,
  'les lignes récentes sont conservées'
);

-- 6. Suppression du compte ------------------------------------------------------------------------

delete from auth.users where id = '63100000-0000-4000-8000-000000000002';

select is(
  (select count(*)::integer from public.weekly_digest_dispatches
    where user_id = '63100000-0000-4000-8000-000000000002'),
  0,
  'supprimer le compte supprime son journal'
);

select * from finish();

rollback;
