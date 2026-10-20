-- 20261029130000 : preuve du consentement aux rappels d'audience posée par un déclencheur.
-- Le navigateur (rôle authenticated, qui a insert et update sur sa ligne) ne peut ni choisir la date de
-- son consentement, ni celle de son retrait, ni réécrire la version du texte consenti en cours de route.
begin;

select plan(24);

select has_column('public', 'user_notification_preferences', 'sale_reminders_consent_text_version', 'la version du texte consenti est conservée');

select ok(
  exists (
    select 1
    from pg_trigger trigger_row
    where trigger_row.tgrelid = 'public.user_notification_preferences'::regclass
      and trigger_row.tgname = 'immojudis_user_notification_preferences_reminder_consent'
      and not trigger_row.tgisinternal
      and (trigger_row.tgtype & 1) = 1 -- par ligne
      and (trigger_row.tgtype & 2) = 2 -- avant
      and (trigger_row.tgtype & 4) = 4 -- insert
      and (trigger_row.tgtype & 16) = 16 -- update
  ),
  'un déclencheur par ligne, avant insert et update, pose la preuve du consentement'
);

select ok(
  (
    select procedure_row.proconfig @> array['search_path=""']::text[]
      and not has_function_privilege('anon', procedure_row.oid, 'execute')
      and not has_function_privilege('authenticated', procedure_row.oid, 'execute')
    from pg_proc procedure_row
    where procedure_row.oid = 'app_private.enforce_sale_reminder_consent_proof()'::regprocedure
  ),
  'la fonction du déclencheur a un search_path vide et n''est exécutable ni par anon ni par authenticated'
);

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data
) values
  ('55000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'proof-a@example.test', '', now(), now(), now(),
   '{}'::jsonb, '{}'::jsonb),
  ('55000000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'proof-b@example.test', '', now(), now(), now(),
   '{}'::jsonb, '{}'::jsonb),
  ('55000000-0000-4000-8000-000000000003', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'proof-c@example.test', '', now(), now(), now(),
   '{}'::jsonb, '{}'::jsonb);

-- 1. Insertion avec rappels actifs et des dates forgées : la date du consentement est celle de
-- l'instruction, pas celle envoyée ; aucune date de retrait.
insert into public.user_notification_preferences (
  user_id, sale_reminders_enabled, sale_reminders_consented_at, sale_reminders_revoked_at,
  sale_reminders_consent_text_version
) values (
  '55000000-0000-4000-8000-000000000001', true, '2000-01-01 00:00:00+00', '1999-01-01 00:00:00+00',
  '2026-10-20'
);

select ok(
  (
    select sale_reminders_consented_at > now() - interval '1 minute'
      and sale_reminders_consented_at <= clock_timestamp()
      and sale_reminders_revoked_at is null
    from public.user_notification_preferences
    where user_id = '55000000-0000-4000-8000-000000000001'
  ),
  'à l''insertion, la date de consentement est posée par la base et la date de retrait est ignorée'
);

select is(
  (
    select sale_reminders_consent_text_version
    from public.user_notification_preferences
    where user_id = '55000000-0000-4000-8000-000000000001'
  ),
  '2026-10-20',
  'à l''insertion avec consentement, la version du texte envoyée par la route est gardée'
);

-- 2. Insertion avec rappels inactifs et des preuves forgées : rien n'est gardé.
insert into public.user_notification_preferences (
  user_id, sale_reminders_enabled, sale_reminders_consented_at, sale_reminders_revoked_at,
  sale_reminders_consent_text_version
) values (
  '55000000-0000-4000-8000-000000000002', false, '2000-01-01 00:00:00+00', '1999-01-01 00:00:00+00',
  'forgee'
);

select is(
  (
    select coalesce(sale_reminders_consented_at::text, 'null') || ':'
      || coalesce(sale_reminders_revoked_at::text, 'null') || ':'
      || coalesce(sale_reminders_consent_text_version, 'null')
    from public.user_notification_preferences
    where user_id = '55000000-0000-4000-8000-000000000002'
  ),
  'null:null:null',
  'à l''insertion sans consentement, aucune preuve forgée n''est gardée'
);

-- 3. Retrait (true -> false) avec une date de retrait forgée : la date du retrait est celle de
-- l'instruction, la preuve du consentement est gardée, ainsi que la version du texte.
create temporary table w550_first_consent as
select sale_reminders_consented_at as consented_at
from public.user_notification_preferences
where user_id = '55000000-0000-4000-8000-000000000001';

select pg_sleep(0.05);

update public.user_notification_preferences
set sale_reminders_enabled = false,
    sale_reminders_revoked_at = '2000-01-01 00:00:00+00',
    sale_reminders_consented_at = '2001-01-01 00:00:00+00',
    sale_reminders_consent_text_version = 'forgee'
where user_id = '55000000-0000-4000-8000-000000000001';

select ok(
  (
    select preference.sale_reminders_revoked_at > now() - interval '1 minute'
      and preference.sale_reminders_revoked_at <= clock_timestamp()
    from public.user_notification_preferences preference
    where preference.user_id = '55000000-0000-4000-8000-000000000001'
  ),
  'au retrait, la date de retrait est posée par la base'
);

select ok(
  (
    select preference.sale_reminders_consented_at = first_consent.consented_at
      and preference.sale_reminders_consent_text_version = '2026-10-20'
    from public.user_notification_preferences preference
    cross join w550_first_consent first_consent
    where preference.user_id = '55000000-0000-4000-8000-000000000001'
  ),
  'au retrait, la date du consentement donné et la version du texte sont gardées'
);

-- 4. Une mise à jour sans bascule ne change aucune preuve, même forgée.
create temporary table w550_revoked as
select sale_reminders_consented_at as consented_at, sale_reminders_revoked_at as revoked_at
from public.user_notification_preferences
where user_id = '55000000-0000-4000-8000-000000000001';

update public.user_notification_preferences
set sale_reminders_enabled = false,
    sale_reminders_consented_at = '1990-01-01 00:00:00+00',
    sale_reminders_revoked_at = '1990-01-01 00:00:00+00',
    sale_reminders_consent_text_version = 'forgee'
where user_id = '55000000-0000-4000-8000-000000000001';

select ok(
  (
    select preference.sale_reminders_consented_at = revoked.consented_at
      and preference.sale_reminders_revoked_at = revoked.revoked_at
      and preference.sale_reminders_consent_text_version = '2026-10-20'
    from public.user_notification_preferences preference
    cross join w550_revoked revoked
    where preference.user_id = '55000000-0000-4000-8000-000000000001'
  ),
  'sans bascule, ni les dates ni la version du texte ne peuvent être réécrites'
);

-- 5. Nouveau consentement (false -> true) : nouvelle date posée par la base, retrait effacé, version
-- de la route gardée.
select pg_sleep(0.05);

update public.user_notification_preferences
set sale_reminders_enabled = true,
    sale_reminders_consented_at = '2000-01-01 00:00:00+00',
    sale_reminders_revoked_at = '1999-01-01 00:00:00+00',
    sale_reminders_consent_text_version = '2026-10-21'
where user_id = '55000000-0000-4000-8000-000000000001';

select ok(
  (
    select preference.sale_reminders_consented_at > first_consent.consented_at
      and preference.sale_reminders_consented_at <= clock_timestamp()
      and preference.sale_reminders_revoked_at is null
    from public.user_notification_preferences preference
    cross join w550_first_consent first_consent
    where preference.user_id = '55000000-0000-4000-8000-000000000001'
  ),
  'un nouveau consentement est daté à nouveau par la base et efface la date du retrait'
);

select is(
  (
    select sale_reminders_consent_text_version
    from public.user_notification_preferences
    where user_id = '55000000-0000-4000-8000-000000000001'
  ),
  '2026-10-21',
  'au nouveau consentement, la version du texte présentée est celle envoyée par la route'
);

-- 6. Rappels actifs : réécrire « actif » avec d'autres dates ou une autre version ne change rien.
create temporary table w550_active as
select sale_reminders_consented_at as consented_at
from public.user_notification_preferences
where user_id = '55000000-0000-4000-8000-000000000001';

update public.user_notification_preferences
set sale_reminders_enabled = true,
    sale_reminders_consented_at = '1980-01-01 00:00:00+00',
    sale_reminders_consent_text_version = 'forgee'
where user_id = '55000000-0000-4000-8000-000000000001';

select ok(
  (
    select preference.sale_reminders_consented_at = active.consented_at
      and preference.sale_reminders_consent_text_version = '2026-10-21'
    from public.user_notification_preferences preference
    cross join w550_active active
    where preference.user_id = '55000000-0000-4000-8000-000000000001'
  ),
  'réécrire « actif » garde la date d''origine et la version du texte consenti'
);

-- 7. Le chemin « insert ... on conflict do update » de l'application (upsert), avec des dates
-- forgées, donne les mêmes résultats : consentement déjà actif -> rien ne bouge.
insert into public.user_notification_preferences (
  user_id, sale_reminders_enabled, sale_reminders_consented_at, sale_reminders_revoked_at,
  sale_reminders_consent_text_version
) values (
  '55000000-0000-4000-8000-000000000001', true, '1970-01-01 00:00:00+00', null, 'forgee'
)
on conflict (user_id) do update
set sale_reminders_enabled = excluded.sale_reminders_enabled,
    sale_reminders_consented_at = excluded.sale_reminders_consented_at,
    sale_reminders_revoked_at = excluded.sale_reminders_revoked_at,
    sale_reminders_consent_text_version = excluded.sale_reminders_consent_text_version;

select ok(
  (
    select preference.sale_reminders_consented_at = active.consented_at
      and preference.sale_reminders_consent_text_version = '2026-10-21'
    from public.user_notification_preferences preference
    cross join w550_active active
    where preference.user_id = '55000000-0000-4000-8000-000000000001'
  ),
  'un upsert « actif » sur un consentement déjà actif ne change ni la date ni la version'
);

-- Upsert de retrait (comme revokeSaleReminderConsent, qui n'envoie que l'état et la date du retrait).
insert into public.user_notification_preferences (
  user_id, sale_reminders_enabled, sale_reminders_revoked_at
) values (
  '55000000-0000-4000-8000-000000000001', false, '1999-01-01 00:00:00+00'
)
on conflict (user_id) do update
set sale_reminders_enabled = excluded.sale_reminders_enabled,
    sale_reminders_revoked_at = excluded.sale_reminders_revoked_at;

select ok(
  (
    select not preference.sale_reminders_enabled
      and preference.sale_reminders_revoked_at > now() - interval '1 minute'
      and preference.sale_reminders_consented_at = active.consented_at
      and preference.sale_reminders_consent_text_version = '2026-10-21'
    from public.user_notification_preferences preference
    cross join w550_active active
    where preference.user_id = '55000000-0000-4000-8000-000000000001'
  ),
  'un upsert de retrait pose la date du retrait par la base et garde la preuve du consentement'
);

-- Upsert de consentement sur une ligne existante inactive.
insert into public.user_notification_preferences (
  user_id, sale_reminders_enabled, sale_reminders_consented_at, sale_reminders_consent_text_version
) values (
  '55000000-0000-4000-8000-000000000001', true, '1970-01-01 00:00:00+00', '2026-10-22'
)
on conflict (user_id) do update
set sale_reminders_enabled = excluded.sale_reminders_enabled,
    sale_reminders_consented_at = excluded.sale_reminders_consented_at,
    sale_reminders_revoked_at = null,
    sale_reminders_consent_text_version = excluded.sale_reminders_consent_text_version;

select ok(
  (
    select preference.sale_reminders_enabled
      and preference.sale_reminders_consented_at > now() - interval '1 minute'
      and preference.sale_reminders_revoked_at is null
      and preference.sale_reminders_consent_text_version = '2026-10-22'
    from public.user_notification_preferences preference
    where preference.user_id = '55000000-0000-4000-8000-000000000001'
  ),
  'un upsert de consentement sur une ligne inactive pose une date récente et garde la version de la route'
);

-- 8. Le consentement aux alertes par email, indépendant, ne touche pas aux preuves des rappels.
create temporary table w550_before_alerts as
select sale_reminders_consented_at as consented_at, sale_reminders_revoked_at as revoked_at,
       sale_reminders_consent_text_version as version
from public.user_notification_preferences
where user_id = '55000000-0000-4000-8000-000000000001';

update public.user_notification_preferences
set alert_email_enabled = true, alert_email_consented_at = now()
where user_id = '55000000-0000-4000-8000-000000000001';

select ok(
  (
    select preference.sale_reminders_consented_at = before_alerts.consented_at
      and preference.sale_reminders_revoked_at is not distinct from before_alerts.revoked_at
      and preference.sale_reminders_consent_text_version = before_alerts.version
      and preference.alert_email_enabled
    from public.user_notification_preferences preference
    cross join w550_before_alerts before_alerts
    where preference.user_id = '55000000-0000-4000-8000-000000000001'
  ),
  'modifier le consentement aux alertes ne touche pas aux preuves des rappels'
);

-- 9. La contrainte historique tient toujours : actif implique une date de consentement.
select ok(
  not exists (
    select 1
    from public.user_notification_preferences
    where sale_reminders_enabled and sale_reminders_consented_at is null
  ),
  'aucune ligne n''a de rappels actifs sans date de consentement'
);

-- 10. La version du texte est bornée.
select throws_ok(
  $$update public.user_notification_preferences
    set sale_reminders_enabled = true, sale_reminders_consent_text_version = repeat('x', 81)
    where user_id = '55000000-0000-4000-8000-000000000002'$$,
  '23514',
  null,
  'la version du texte de consentement ne dépasse pas 80 caractères'
);

-- 11. Depuis le navigateur (rôle authenticated), les dates écrites sont ignorées aussi.
insert into public.user_notification_preferences (user_id)
values ('55000000-0000-4000-8000-000000000003');

set local "request.jwt.claim.role" = 'authenticated';
set local "request.jwt.claim.sub" = '55000000-0000-4000-8000-000000000003';
set local role authenticated;

select lives_ok(
  $$update public.user_notification_preferences
    set sale_reminders_enabled = true,
        sale_reminders_consented_at = '1990-01-01 00:00:00+00',
        sale_reminders_revoked_at = '1990-01-01 00:00:00+00'
    where user_id = '55000000-0000-4000-8000-000000000003'$$,
  'une personne connectée peut donner son consentement à sa propre ligne'
);

select ok(
  (
    select sale_reminders_consented_at > now() - interval '1 minute'
      and sale_reminders_revoked_at is null
    from public.user_notification_preferences
    where user_id = '55000000-0000-4000-8000-000000000003'
  ),
  'les dates envoyées par le navigateur sont ignorées : la base pose la date du consentement'
);

select lives_ok(
  $$update public.user_notification_preferences
    set sale_reminders_consented_at = '1990-01-01 00:00:00+00'
    where user_id = '55000000-0000-4000-8000-000000000003'$$,
  'elle peut tenter de réécrire la date de son consentement'
);

select ok(
  (
    select sale_reminders_consented_at > now() - interval '1 minute'
    from public.user_notification_preferences
    where user_id = '55000000-0000-4000-8000-000000000003'
  ),
  'mais la date du consentement ne change pas'
);

select lives_ok(
  $$update public.user_notification_preferences
    set sale_reminders_enabled = false, sale_reminders_revoked_at = '1990-01-01 00:00:00+00'
    where user_id = '55000000-0000-4000-8000-000000000003'$$,
  'elle peut retirer son consentement'
);

select ok(
  (
    select sale_reminders_revoked_at > now() - interval '1 minute'
      and sale_reminders_consented_at is not null
    from public.user_notification_preferences
    where user_id = '55000000-0000-4000-8000-000000000003'
  ),
  'la date du retrait est posée par la base et la preuve du consentement est gardée'
);

reset role;

select * from finish();

rollback;
