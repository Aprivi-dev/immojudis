-- 20261030120000 : consentements distincts du récapitulatif hebdomadaire « Ma semaine » et de l'alerte
-- de résultat, prouvés par la base. Un écrivain ne peut ni choisir la date de son consentement ou de son
-- retrait, ni réécrire la version du texte consenti ; les deux consentements sont indépendants l'un de
-- l'autre et de ceux des rappels.
-- 20261031100400 : la version du texte n'est prise que d'un écrivain au rôle service_role (la route
-- serveur). Les sections 1 à 10 jouent donc le rôle de la route (service_role) ; la section 11 vérifie
-- qu'un autre rôle ne peut pas poser la version.
begin;

select plan(25);

-- Structure -------------------------------------------------------------------------------------------
select has_column('public', 'user_notification_preferences', 'weekly_digest_enabled', 'la case du récapitulatif existe');
select has_column('public', 'user_notification_preferences', 'weekly_digest_weekday', 'le jour du récapitulatif existe');
select has_column('public', 'user_notification_preferences', 'sale_results_enabled', 'la case de l''alerte de résultat existe');

select ok(
  (
    select count(*) = 2
    from pg_attrdef default_row
    join pg_attribute attribute_row
      on attribute_row.attrelid = default_row.adrelid and attribute_row.attnum = default_row.adnum
    where default_row.adrelid = 'public.user_notification_preferences'::regclass
      and attribute_row.attname in ('weekly_digest_enabled', 'sale_results_enabled')
      and pg_get_expr(default_row.adbin, default_row.adrelid) = 'false'
  ),
  'les deux cases sont fausses par défaut : jamais pré-cochées'
);

select ok(
  (
    select pg_get_expr(default_row.adbin, default_row.adrelid) = '2'
    from pg_attrdef default_row
    join pg_attribute attribute_row
      on attribute_row.attrelid = default_row.adrelid and attribute_row.attnum = default_row.adnum
    where default_row.adrelid = 'public.user_notification_preferences'::regclass
      and attribute_row.attname = 'weekly_digest_weekday'
  ),
  'le récapitulatif part le mardi par défaut (ISO : 2)'
);

select ok(
  exists (
    select 1
    from pg_trigger trigger_row
    where trigger_row.tgrelid = 'public.user_notification_preferences'::regclass
      and trigger_row.tgname = 'immojudis_user_notification_preferences_email_feature_consent'
      and not trigger_row.tgisinternal
      and (trigger_row.tgtype & 1) = 1 -- par ligne
      and (trigger_row.tgtype & 2) = 2 -- avant
      and (trigger_row.tgtype & 4) = 4 -- insert
      and (trigger_row.tgtype & 16) = 16 -- update
  ),
  'un déclencheur par ligne, avant insert et update, pose la preuve des deux consentements'
);

select ok(
  (
    select procedure_row.proconfig @> array['search_path=""']::text[]
      and not has_function_privilege('anon', procedure_row.oid, 'execute')
      and not has_function_privilege('authenticated', procedure_row.oid, 'execute')
    from pg_proc procedure_row
    where procedure_row.oid = 'app_private.enforce_email_feature_consent_proof()'::regprocedure
  ),
  'la fonction du déclencheur a un search_path vide et n''est exécutable ni par anon ni par authenticated'
);

-- Données --------------------------------------------------------------------------------------------
insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data
) values
  ('63000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'feature-a@example.test', '', now(), now(), now(),
   '{}'::jsonb, '{}'::jsonb),
  ('63000000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'feature-b@example.test', '', now(), now(), now(),
   '{}'::jsonb, '{}'::jsonb),
  ('63000000-0000-4000-8000-000000000003', '00000000-0000-0000-0000-000000000000',
   'authenticated', 'authenticated', 'feature-c@example.test', '', now(), now(), now(),
   '{}'::jsonb, '{}'::jsonb);

-- La route serveur écrit avec le rôle de service : c'est le seul écrivain dont la version du texte est gardée.
set local role service_role;

-- 1. Insertion avec les deux fonctions actives et des dates forgées : dates posées par la base.
insert into public.user_notification_preferences (
  user_id,
  weekly_digest_enabled, weekly_digest_consented_at, weekly_digest_revoked_at, weekly_digest_consent_text_version,
  sale_results_enabled, sale_results_consented_at, sale_results_revoked_at, sale_results_consent_text_version
) values (
  '63000000-0000-4000-8000-000000000001',
  true, '2000-01-01 00:00:00+00', '1999-01-01 00:00:00+00', '2026-10-20',
  true, '2000-01-01 00:00:00+00', '1999-01-01 00:00:00+00', '2026-10-21'
);

select ok(
  (
    select weekly_digest_consented_at > now() - interval '1 minute'
      and weekly_digest_consented_at <= clock_timestamp()
      and weekly_digest_revoked_at is null
      and sale_results_consented_at > now() - interval '1 minute'
      and sale_results_consented_at <= clock_timestamp()
      and sale_results_revoked_at is null
    from public.user_notification_preferences
    where user_id = '63000000-0000-4000-8000-000000000001'
  ),
  'à l''insertion, les dates de consentement sont posées par la base et les dates de retrait ignorées'
);

select is(
  (
    select weekly_digest_consent_text_version || ':' || sale_results_consent_text_version
    from public.user_notification_preferences
    where user_id = '63000000-0000-4000-8000-000000000001'
  ),
  '2026-10-20:2026-10-21',
  'à l''insertion avec consentement, la version du texte envoyée par la route est gardée'
);

-- 2. Insertion avec les deux fonctions inactives et des preuves forgées : rien n'est gardé.
insert into public.user_notification_preferences (
  user_id,
  weekly_digest_enabled, weekly_digest_consented_at, weekly_digest_revoked_at, weekly_digest_consent_text_version,
  sale_results_enabled, sale_results_consented_at, sale_results_revoked_at, sale_results_consent_text_version
) values (
  '63000000-0000-4000-8000-000000000002',
  false, '2000-01-01 00:00:00+00', '1999-01-01 00:00:00+00', 'forgee',
  false, '2000-01-01 00:00:00+00', '1999-01-01 00:00:00+00', 'forgee'
);

select is(
  (
    select concat_ws(
      ':',
      coalesce(weekly_digest_consented_at::text, 'null'), coalesce(weekly_digest_revoked_at::text, 'null'),
      coalesce(weekly_digest_consent_text_version, 'null'),
      coalesce(sale_results_consented_at::text, 'null'), coalesce(sale_results_revoked_at::text, 'null'),
      coalesce(sale_results_consent_text_version, 'null')
    )
    from public.user_notification_preferences
    where user_id = '63000000-0000-4000-8000-000000000002'
  ),
  'null:null:null:null:null:null',
  'à l''insertion sans consentement, aucune preuve forgée n''est gardée'
);

-- 3. Retrait du récapitulatif seul, avec des dates forgées : la date du retrait vient de la base, la
-- preuve du consentement donné est gardée, et l'alerte de résultat n'est pas touchée.
create temporary table w630_first as
select weekly_digest_consented_at as weekly_consented_at, sale_results_consented_at as results_consented_at
from public.user_notification_preferences
where user_id = '63000000-0000-4000-8000-000000000001';

select pg_sleep(0.05);

update public.user_notification_preferences
set weekly_digest_enabled = false,
    weekly_digest_revoked_at = '2000-01-01 00:00:00+00',
    weekly_digest_consented_at = '2001-01-01 00:00:00+00',
    weekly_digest_consent_text_version = 'forgee'
where user_id = '63000000-0000-4000-8000-000000000001';

select ok(
  (
    select preference.weekly_digest_revoked_at > now() - interval '1 minute'
      and preference.weekly_digest_revoked_at <= clock_timestamp()
      and preference.weekly_digest_consented_at = first_row.weekly_consented_at
      and preference.weekly_digest_consent_text_version = '2026-10-20'
    from public.user_notification_preferences preference
    cross join w630_first first_row
    where preference.user_id = '63000000-0000-4000-8000-000000000001'
  ),
  'au retrait du récapitulatif, la date du retrait est posée par la base, la preuve du consentement est gardée'
);

select ok(
  (
    select preference.sale_results_enabled
      and preference.sale_results_consented_at = first_row.results_consented_at
      and preference.sale_results_revoked_at is null
      and preference.sale_results_consent_text_version = '2026-10-21'
    from public.user_notification_preferences preference
    cross join w630_first first_row
    where preference.user_id = '63000000-0000-4000-8000-000000000001'
  ),
  'retirer le récapitulatif ne touche pas à l''alerte de résultat'
);

-- 4. Une mise à jour sans bascule ne change aucune preuve, même forgée.
create temporary table w630_revoked as
select weekly_digest_consented_at as consented_at, weekly_digest_revoked_at as revoked_at
from public.user_notification_preferences
where user_id = '63000000-0000-4000-8000-000000000001';

update public.user_notification_preferences
set weekly_digest_enabled = false,
    weekly_digest_consented_at = '1990-01-01 00:00:00+00',
    weekly_digest_revoked_at = '1990-01-01 00:00:00+00',
    weekly_digest_consent_text_version = 'forgee',
    sale_results_enabled = true,
    sale_results_consented_at = '1990-01-01 00:00:00+00',
    sale_results_consent_text_version = 'forgee'
where user_id = '63000000-0000-4000-8000-000000000001';

select ok(
  (
    select preference.weekly_digest_consented_at = revoked.consented_at
      and preference.weekly_digest_revoked_at = revoked.revoked_at
      and preference.weekly_digest_consent_text_version = '2026-10-20'
      and preference.sale_results_consented_at = first_row.results_consented_at
      and preference.sale_results_consent_text_version = '2026-10-21'
    from public.user_notification_preferences preference
    cross join w630_revoked revoked
    cross join w630_first first_row
    where preference.user_id = '63000000-0000-4000-8000-000000000001'
  ),
  'sans bascule, ni les dates ni la version du texte ne peuvent être réécrites (un « actif » sur actif garde la date d''origine)'
);

-- 5. Nouveau consentement au récapitulatif (false -> true) : nouvelle date, retrait effacé, version
-- de la route gardée.
select pg_sleep(0.05);

update public.user_notification_preferences
set weekly_digest_enabled = true,
    weekly_digest_consented_at = '2000-01-01 00:00:00+00',
    weekly_digest_revoked_at = '1999-01-01 00:00:00+00',
    weekly_digest_consent_text_version = '2026-10-25'
where user_id = '63000000-0000-4000-8000-000000000001';

select ok(
  (
    select preference.weekly_digest_consented_at > first_row.weekly_consented_at
      and preference.weekly_digest_consented_at <= clock_timestamp()
      and preference.weekly_digest_revoked_at is null
      and preference.weekly_digest_consent_text_version = '2026-10-25'
    from public.user_notification_preferences preference
    cross join w630_first first_row
    where preference.user_id = '63000000-0000-4000-8000-000000000001'
  ),
  'un nouveau consentement est daté à nouveau par la base, efface le retrait et garde la version de la route'
);

-- 6. Retrait de l'alerte de résultat seule (upsert, comme revokeSaleResultsConsent).
insert into public.user_notification_preferences (
  user_id, sale_results_enabled, sale_results_revoked_at
) values (
  '63000000-0000-4000-8000-000000000001', false, '1999-01-01 00:00:00+00'
)
on conflict (user_id) do update
set sale_results_enabled = excluded.sale_results_enabled,
    sale_results_revoked_at = excluded.sale_results_revoked_at;

select ok(
  (
    select not preference.sale_results_enabled
      and preference.sale_results_revoked_at > now() - interval '1 minute'
      and preference.sale_results_consented_at = first_row.results_consented_at
      and preference.sale_results_consent_text_version = '2026-10-21'
      and preference.weekly_digest_enabled
    from public.user_notification_preferences preference
    cross join w630_first first_row
    where preference.user_id = '63000000-0000-4000-8000-000000000001'
  ),
  'un upsert de retrait pose la date du retrait par la base, garde la preuve et laisse le récapitulatif actif'
);

-- 7. Les consentements aux alertes et aux rappels, indépendants, ne touchent pas à ces preuves.
create temporary table w630_before as
select weekly_digest_consented_at as weekly_consented_at, sale_results_revoked_at as results_revoked_at
from public.user_notification_preferences
where user_id = '63000000-0000-4000-8000-000000000001';

update public.user_notification_preferences
set alert_email_enabled = true, alert_email_consented_at = now(),
    sale_reminders_enabled = true
where user_id = '63000000-0000-4000-8000-000000000001';

select ok(
  (
    select preference.weekly_digest_consented_at = before_row.weekly_consented_at
      and preference.sale_results_revoked_at = before_row.results_revoked_at
      and preference.sale_reminders_consented_at > now() - interval '1 minute'
    from public.user_notification_preferences preference
    cross join w630_before before_row
    where preference.user_id = '63000000-0000-4000-8000-000000000001'
  ),
  'activer les alertes et les rappels ne touche pas aux preuves du récapitulatif et de l''alerte de résultat'
);

-- 8. Le jour du récapitulatif se modifie librement mais reste borné de 1 à 7.
update public.user_notification_preferences
set weekly_digest_weekday = 5
where user_id = '63000000-0000-4000-8000-000000000001';

select is(
  (select weekly_digest_weekday from public.user_notification_preferences
    where user_id = '63000000-0000-4000-8000-000000000001'),
  5::smallint,
  'le jour choisi se modifie'
);

select throws_ok(
  $$update public.user_notification_preferences set weekly_digest_weekday = 0
    where user_id = '63000000-0000-4000-8000-000000000001'$$,
  '23514', null, 'le jour 0 est refusé'
);
select throws_ok(
  $$update public.user_notification_preferences set weekly_digest_weekday = 8
    where user_id = '63000000-0000-4000-8000-000000000001'$$,
  '23514', null, 'le jour 8 est refusé'
);

-- 9. Aucune ligne n'a une fonction active sans date de consentement.
select ok(
  not exists (
    select 1
    from public.user_notification_preferences
    where (weekly_digest_enabled and weekly_digest_consented_at is null)
       or (sale_results_enabled and sale_results_consented_at is null)
  ),
  'aucune ligne n''a le récapitulatif ou l''alerte de résultat actif sans date de consentement'
);

-- 10. La version du texte est bornée.
select throws_ok(
  $$update public.user_notification_preferences
    set weekly_digest_enabled = true, weekly_digest_consent_text_version = repeat('x', 81)
    where user_id = '63000000-0000-4000-8000-000000000002'$$,
  '23514', null, 'la version du texte du récapitulatif est bornée à 80 caractères'
);
select throws_ok(
  $$update public.user_notification_preferences
    set sale_results_enabled = true, sale_results_consent_text_version = repeat('x', 81)
    where user_id = '63000000-0000-4000-8000-000000000002'$$,
  '23514', null, 'la version du texte de l''alerte de résultat est bornée à 80 caractères'
);

-- 11. Un écrivain qui n'est pas le rôle de service (ici le rôle de la session de test, comme une
-- maintenance en SQL) ne peut pas poser la version du texte consenti : elle reste celle d'avant.
reset role;

update public.user_notification_preferences
set weekly_digest_enabled = true, weekly_digest_consent_text_version = 'forgee',
    sale_results_enabled = true, sale_results_consent_text_version = 'forgee'
where user_id = '63000000-0000-4000-8000-000000000002';

select is(
  (
    select concat_ws(
      ':',
      coalesce(weekly_digest_consent_text_version, 'null'),
      coalesce(sale_results_consent_text_version, 'null')
    )
    from public.user_notification_preferences
    where user_id = '63000000-0000-4000-8000-000000000002'
  ),
  'null:null',
  'à l''activation, la version envoyée par un écrivain qui n''est pas le rôle de service est ignorée'
);

insert into public.user_notification_preferences (
  user_id, weekly_digest_enabled, weekly_digest_consent_text_version,
  sale_results_enabled, sale_results_consent_text_version
) values ('63000000-0000-4000-8000-000000000003', true, 'forgee', true, 'forgee');

select is(
  (
    select concat_ws(
      ':',
      coalesce(weekly_digest_consent_text_version, 'null'),
      coalesce(sale_results_consent_text_version, 'null')
    )
    from public.user_notification_preferences
    where user_id = '63000000-0000-4000-8000-000000000003'
  ),
  'null:null',
  'à l''insertion, la version envoyée par un écrivain qui n''est pas le rôle de service est ignorée aussi'
);

-- Le rôle de service, lui, pose la version à l'activation (la route serveur).
set local role service_role;
update public.user_notification_preferences
set weekly_digest_enabled = false, sale_results_enabled = false
where user_id = '63000000-0000-4000-8000-000000000002';
update public.user_notification_preferences
set weekly_digest_enabled = true, weekly_digest_consent_text_version = '2026-10-30',
    sale_results_enabled = true, sale_results_consent_text_version = '2026-10-31'
where user_id = '63000000-0000-4000-8000-000000000002';

select is(
  (
    select concat_ws(':', weekly_digest_consent_text_version, sale_results_consent_text_version)
    from public.user_notification_preferences
    where user_id = '63000000-0000-4000-8000-000000000002'
  ),
  '2026-10-30:2026-10-31',
  'le rôle de service (la route serveur) pose la version du texte à l''activation'
);
reset role;

select * from finish();
rollback;
