-- 20261210100100 : consentement distinct aux emails de nouveautés et d'offres, prouvé par la base comme
-- les trois consentements existants (tests 550, 630 et 654).
--   * structure : quatre colonnes, case fausse par défaut, version bornée ;
--   * droits : le rôle authenticated ne peut écrire aucune de ces colonnes (route serveur seule), anon
--     n'a aucun droit ;
--   * déclencheur : dates posées par la base, version gardée du seul rôle service_role, retrait qui
--     garde la preuve, indépendance avec les autres consentements.
begin;

select plan(17);

-- Structure -------------------------------------------------------------------------------------------
select has_column('public', 'user_notification_preferences', 'marketing_emails_enabled', 'la case existe');
select has_column('public', 'user_notification_preferences', 'marketing_emails_consented_at', 'la date du consentement existe');
select has_column('public', 'user_notification_preferences', 'marketing_emails_revoked_at', 'la date du retrait existe');
select has_column('public', 'user_notification_preferences', 'marketing_emails_consent_text_version', 'la version du texte existe');

select ok(
  (
    select pg_get_expr(default_row.adbin, default_row.adrelid) = 'false' and attribute_row.attnotnull
    from pg_attrdef default_row
    join pg_attribute attribute_row
      on attribute_row.attrelid = default_row.adrelid and attribute_row.attnum = default_row.adnum
    where default_row.adrelid = 'public.user_notification_preferences'::regclass
      and attribute_row.attname = 'marketing_emails_enabled'
  ),
  'la case est fausse par défaut : jamais pré-cochée'
);

select ok(
  exists (
    select 1
    from pg_trigger trigger_row
    where trigger_row.tgrelid = 'public.user_notification_preferences'::regclass
      and trigger_row.tgname = 'immojudis_user_notification_preferences_marketing_consent'
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
      and pg_get_functiondef(procedure_row.oid) ~ 'service_role'
    from pg_proc procedure_row
    where procedure_row.oid = 'app_private.enforce_marketing_email_consent_proof()'::regprocedure
  ),
  'la fonction du déclencheur a un search_path vide, n''est exécutable ni par anon ni par authenticated, et ne garde la version que du rôle de service'
);

-- Droits ---------------------------------------------------------------------------------------------
select ok(
  not exists (
    select 1
    from unnest(array[
      'marketing_emails_enabled', 'marketing_emails_consented_at', 'marketing_emails_revoked_at',
      'marketing_emails_consent_text_version'
    ]) as c(name)
    where has_column_privilege('authenticated', 'public.user_notification_preferences', c.name, 'UPDATE')
       or has_column_privilege('authenticated', 'public.user_notification_preferences', c.name, 'INSERT')
  ),
  'authenticated ne peut écrire aucune colonne du consentement : seule la route serveur l''écrit'
);

select ok(
  not has_table_privilege('anon', 'public.user_notification_preferences', 'SELECT')
  and not has_table_privilege('anon', 'public.user_notification_preferences', 'INSERT')
  and not has_table_privilege('anon', 'public.user_notification_preferences', 'UPDATE'),
  'les visiteurs n''ont aucun accès à la table'
);

-- Données --------------------------------------------------------------------------------------------
insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data
) values
  ('92200000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'marketing-a@example.test', '', now(), now(), now(),
   '{}'::jsonb, '{}'::jsonb),
  ('92200000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'marketing-b@example.test', '', now(), now(), now(),
   '{}'::jsonb, '{}'::jsonb);

-- La route serveur écrit avec le rôle de service.
set local role service_role;

-- 1. Insertion avec consentement et dates forgées : dates posées par la base, version de la route gardée.
insert into public.user_notification_preferences (
  user_id, marketing_emails_enabled, marketing_emails_consented_at, marketing_emails_revoked_at,
  marketing_emails_consent_text_version
) values (
  '92200000-0000-4000-8000-000000000001', true, '2000-01-01 00:00:00+00', '1999-01-01 00:00:00+00',
  '2026-11-26.1'
);

select ok(
  (
    select marketing_emails_consented_at > now() - interval '1 minute'
      and marketing_emails_consented_at <= clock_timestamp()
      and marketing_emails_revoked_at is null
      and marketing_emails_consent_text_version = '2026-11-26.1'
    from public.user_notification_preferences
    where user_id = '92200000-0000-4000-8000-000000000001'
  ),
  'à l''insertion, la date du consentement est posée par la base et la version de la route est gardée'
);

-- 2. Insertion sans consentement et preuves forgées : rien n'est gardé.
insert into public.user_notification_preferences (
  user_id, marketing_emails_enabled, marketing_emails_consented_at, marketing_emails_revoked_at,
  marketing_emails_consent_text_version
) values (
  '92200000-0000-4000-8000-000000000002', false, '2000-01-01 00:00:00+00', '1999-01-01 00:00:00+00',
  'forgee'
);

select is(
  (
    select concat_ws(
      ':',
      coalesce(marketing_emails_consented_at::text, 'null'),
      coalesce(marketing_emails_revoked_at::text, 'null'),
      coalesce(marketing_emails_consent_text_version, 'null')
    )
    from public.user_notification_preferences
    where user_id = '92200000-0000-4000-8000-000000000002'
  ),
  'null:null:null',
  'à l''insertion sans consentement, aucune preuve forgée n''est gardée'
);

-- 3. Retrait par upsert (comme revokeMarketingEmailsConsent) avec une date forgée : la date du retrait
-- vient de la base, la preuve du consentement donné est gardée.
create temporary table w922_first as
select marketing_emails_consented_at as consented_at
from public.user_notification_preferences
where user_id = '92200000-0000-4000-8000-000000000001';

select pg_sleep(0.05);

insert into public.user_notification_preferences (
  user_id, marketing_emails_enabled, marketing_emails_revoked_at
) values (
  '92200000-0000-4000-8000-000000000001', false, '1999-01-01 00:00:00+00'
)
on conflict (user_id) do update
set marketing_emails_enabled = excluded.marketing_emails_enabled,
    marketing_emails_revoked_at = excluded.marketing_emails_revoked_at;

select ok(
  (
    select not preference.marketing_emails_enabled
      and preference.marketing_emails_revoked_at > now() - interval '1 minute'
      and preference.marketing_emails_revoked_at <= clock_timestamp()
      and preference.marketing_emails_consented_at = first_row.consented_at
      and preference.marketing_emails_consent_text_version = '2026-11-26.1'
    from public.user_notification_preferences preference
    cross join w922_first first_row
    where preference.user_id = '92200000-0000-4000-8000-000000000001'
  ),
  'au retrait, la date du retrait est posée par la base et la preuve du consentement est gardée'
);

-- 4. Une mise à jour sans bascule ne change aucune preuve, même forgée.
create temporary table w922_revoked as
select marketing_emails_consented_at as consented_at, marketing_emails_revoked_at as revoked_at
from public.user_notification_preferences
where user_id = '92200000-0000-4000-8000-000000000001';

update public.user_notification_preferences
set marketing_emails_enabled = false,
    marketing_emails_consented_at = '1990-01-01 00:00:00+00',
    marketing_emails_revoked_at = '1990-01-01 00:00:00+00',
    marketing_emails_consent_text_version = 'forgee'
where user_id = '92200000-0000-4000-8000-000000000001';

select ok(
  (
    select preference.marketing_emails_consented_at = revoked.consented_at
      and preference.marketing_emails_revoked_at = revoked.revoked_at
      and preference.marketing_emails_consent_text_version = '2026-11-26.1'
    from public.user_notification_preferences preference
    cross join w922_revoked revoked
    where preference.user_id = '92200000-0000-4000-8000-000000000001'
  ),
  'sans bascule, ni les dates ni la version du texte ne peuvent être réécrites'
);

-- 5. Les autres consentements, indépendants, ne touchent pas à cette preuve, et inversement.
update public.user_notification_preferences
set weekly_digest_enabled = true, sale_results_enabled = true, sale_reminders_enabled = true
where user_id = '92200000-0000-4000-8000-000000000001';

select ok(
  (
    select preference.marketing_emails_consented_at = revoked.consented_at
      and preference.marketing_emails_revoked_at = revoked.revoked_at
      and not preference.marketing_emails_enabled
    from public.user_notification_preferences preference
    cross join w922_revoked revoked
    where preference.user_id = '92200000-0000-4000-8000-000000000001'
  ),
  'activer les autres consentements ne touche pas à la preuve des emails de nouveautés et d''offres'
);

-- 6. La version du texte est bornée.
select throws_ok(
  $$update public.user_notification_preferences
    set marketing_emails_enabled = true, marketing_emails_consent_text_version = repeat('x', 81)
    where user_id = '92200000-0000-4000-8000-000000000002'$$,
  '23514', null, 'la version du texte est bornée à 80 caractères'
);

-- 7. Un écrivain qui n'est pas le rôle de service ne peut pas poser la version du texte consenti.
reset role;

update public.user_notification_preferences
set marketing_emails_enabled = true, marketing_emails_consent_text_version = 'forgee'
where user_id = '92200000-0000-4000-8000-000000000002';

select ok(
  (
    select marketing_emails_enabled
      and marketing_emails_consented_at is not null
      and marketing_emails_consent_text_version is null
    from public.user_notification_preferences
    where user_id = '92200000-0000-4000-8000-000000000002'
  ),
  'à l''activation, la version envoyée par un écrivain qui n''est pas le rôle de service est ignorée'
);

-- 8. Aucune ligne n'a le consentement actif sans date de consentement.
select ok(
  not exists (
    select 1
    from public.user_notification_preferences
    where marketing_emails_enabled and marketing_emails_consented_at is null
  ),
  'aucune ligne n''a le consentement actif sans date de consentement'
);

select * from finish();
rollback;
