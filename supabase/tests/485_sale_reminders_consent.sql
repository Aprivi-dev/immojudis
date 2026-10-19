-- 20261028130000 : consentement distinct aux rappels d'audience et avertissements graves.
-- Case jamais pré-cochée, preuve horodatée obligatoire, indépendance vis-à-vis du consentement aux
-- alertes par email, et lecture limitée à sa propre ligne.
begin;

select plan(14);

select has_column('public', 'user_notification_preferences', 'sale_reminders_enabled', 'le consentement aux rappels a sa colonne');
select has_column('public', 'user_notification_preferences', 'sale_reminders_consented_at', 'la date du consentement est conservée');
select has_column('public', 'user_notification_preferences', 'sale_reminders_revoked_at', 'la date du retrait est conservée');

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data
) values
  ('48500000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'reminders-a@example.test', '', now(), now(), now(),
   '{}'::jsonb, '{}'::jsonb),
  ('48500000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'reminders-b@example.test', '', now(), now(), now(),
   '{}'::jsonb, '{}'::jsonb);

-- 1. Une ligne créée sans rien préciser ne consent à rien (ni aux alertes, ni aux rappels).
insert into public.user_notification_preferences (user_id)
values ('48500000-0000-4000-8000-000000000001');

select is(
  (
    select sale_reminders_enabled::text || ':' || coalesce(sale_reminders_consented_at::text, 'null')
      || ':' || alert_email_enabled::text
    from public.user_notification_preferences
    where user_id = '48500000-0000-4000-8000-000000000001'
  ),
  'false:null:false',
  'par défaut, aucun consentement (case jamais pré-cochée)'
);

-- 2. Activer les rappels sans date de consentement est refusé.
select throws_ok(
  $$update public.user_notification_preferences
    set sale_reminders_enabled = true
    where user_id = '48500000-0000-4000-8000-000000000001'$$,
  '23514',
  null,
  'les rappels ne peuvent pas être activés sans preuve du consentement'
);

-- 3. Avec la date, c'est accepté, et le consentement aux alertes email n'est pas touché.
select lives_ok(
  $$update public.user_notification_preferences
    set sale_reminders_enabled = true, sale_reminders_consented_at = now()
    where user_id = '48500000-0000-4000-8000-000000000001'$$,
  'les rappels s''activent avec la date du consentement'
);

select is(
  (
    select alert_email_enabled::text || ':' || coalesce(alert_email_consented_at::text, 'null')
    from public.user_notification_preferences
    where user_id = '48500000-0000-4000-8000-000000000001'
  ),
  'false:null',
  'activer les rappels n''active pas les alertes par email'
);

-- 4. Le consentement aux alertes email reste indépendant: le retirer laisse les rappels actifs.
update public.user_notification_preferences
set alert_email_enabled = true, alert_email_consented_at = now()
where user_id = '48500000-0000-4000-8000-000000000001';

update public.user_notification_preferences
set alert_email_enabled = false, alert_email_revoked_at = now()
where user_id = '48500000-0000-4000-8000-000000000001';

select is(
  (
    select sale_reminders_enabled::text
    from public.user_notification_preferences
    where user_id = '48500000-0000-4000-8000-000000000001'
  ),
  'true',
  'retirer le consentement aux alertes email laisse les rappels actifs'
);

-- 5. Le retrait des rappels garde la date du consentement et note celle du retrait.
update public.user_notification_preferences
set sale_reminders_enabled = false, sale_reminders_revoked_at = now()
where user_id = '48500000-0000-4000-8000-000000000001';

select ok(
  (
    select not sale_reminders_enabled
      and sale_reminders_consented_at is not null
      and sale_reminders_revoked_at is not null
    from public.user_notification_preferences
    where user_id = '48500000-0000-4000-8000-000000000001'
  ),
  'le retrait des rappels garde la preuve du consentement et la date du retrait'
);

-- 6. L'index partiel du cron existe.
select ok(
  exists (
    select 1
    from pg_indexes
    where schemaname = 'public'
      and tablename = 'user_notification_preferences'
      and indexname = 'user_notification_preferences_reminders_enabled_idx'
      and indexdef ilike '%where sale_reminders_enabled%'
  ),
  'le cron ne parcourt que les personnes qui ont consenti (index partiel)'
);

-- 7. Chaque personne ne voit et ne modifie que sa propre ligne.
insert into public.user_notification_preferences (user_id, sale_reminders_enabled, sale_reminders_consented_at)
values ('48500000-0000-4000-8000-000000000002', true, now());

set local "request.jwt.claim.role" = 'authenticated';
set local "request.jwt.claim.sub" = '48500000-0000-4000-8000-000000000001';
set local role authenticated;

select is(
  (select count(*)::integer from public.user_notification_preferences),
  1,
  'une personne connectée ne lit que sa propre ligne de préférences'
);

-- Un UPDATE ne peut pas vivre dans une sous-requête : la RLS le rend sans effet, et la
-- dernière vérification (« le consentement de l'autre personne est intact ») le prouve.
select lives_ok(
  $$update public.user_notification_preferences
    set sale_reminders_enabled = false, sale_reminders_revoked_at = now()
    where user_id = '48500000-0000-4000-8000-000000000002'$$,
  'elle ne peut pas retirer le consentement d''une autre personne (aucune ligne visible)'
);

select lives_ok(
  $$update public.user_notification_preferences
    set sale_reminders_enabled = true, sale_reminders_consented_at = now()
    where user_id = '48500000-0000-4000-8000-000000000001'$$,
  'elle peut donner son propre consentement aux rappels'
);

reset role;

select is(
  (
    select sale_reminders_enabled::text
    from public.user_notification_preferences
    where user_id = '48500000-0000-4000-8000-000000000002'
  ),
  'true',
  'le consentement de l''autre personne est intact'
);

select * from finish();

rollback;
