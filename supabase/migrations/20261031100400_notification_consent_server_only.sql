begin;

set local lock_timeout = '5s';

-- Chantier R1, point 6 (relecture de code du 20/10/2026) : la version du texte de consentement était
-- forgeable par le client.
--
-- Constat. Les déclencheurs de 20261029130000 (rappels d'audience) et 20261030120000 (« Ma semaine » et
-- alerte de résultat) posent les DATES du consentement et du retrait, mais gardaient la version du texte
-- de consentement envoyée par l'écrivain à la bascule false -> true. Or la table
-- user_notification_preferences est ouverte en insert et en update à tout compte connecté
-- (20260706142000) : un compte pouvait appeler PostgREST directement et écrire la version de son choix
-- avec son consentement (« 2026-10-20 » alors que le texte affiché était autre, ou une version qui
-- n'existe pas). La preuve du texte consenti n'en était pas une.
--
-- Deux protections, qui se renforcent :
--   1. LES DÉCLENCHEURS écrasent la version tant que le rôle courant n'est pas service_role : à
--      l'insertion elle vaut null ; à la mise à jour elle garde sa valeur précédente. Seule la route
--      serveur (src/lib/notification-preferences.ts, qui écrit désormais avec le rôle de service après
--      avoir authentifié la personne) pose la version, à l'activation. Les dates restent posées par la
--      base, comme avant, quel que soit le rôle. Rôle lu par current_user (le rôle de la session, non
--      falsifiable par un réglage de requête) ; une opération de maintenance faite en SQL pour poser une
--      version doit donc passer par « set role service_role ».
--   2. LES DROITS : le rôle authenticated perd l'écriture (insert et update) des colonnes des trois
--      consentements (sale_reminders_*, weekly_digest_enabled / _consented_at / _revoked_at /
--      _consent_text_version, sale_results_*). Il garde la lecture de sa ligne, la suppression (droit à
--      l'effacement, politique existante) et l'écriture de ce que les routes écrivaient déjà pour lui :
--      le consentement aux alertes par email (alert_email_*, consent_source) et le jour du
--      récapitulatif (weekly_digest_weekday, qui n'est pas une preuve). Activer ou retirer un de ces
--      trois consentements passe donc par la route serveur seule.
--
-- Ordre migration / déploiement. Avant le déploiement du code, l'ancienne route (qui écrit avec le rôle
-- du compte) ne peut plus cocher ces trois cases : sans conséquence tant que SALE_REMINDERS_MODE,
-- WEEKLY_DIGEST_MODE et SALE_RESULTS_MODE valent « off » (elles ne sont alors pas proposées). La nouvelle
-- route fonctionne avant comme après la migration.

-- 1. Déclencheurs --------------------------------------------------------------------------------------
create or replace function app_private.enforce_sale_reminder_consent_proof()
returns trigger
language plpgsql
set search_path = ''
as $function$
declare
  -- Seule la route serveur (rôle de service) peut poser la version du texte consenti.
  v_trusted boolean := current_user = 'service_role';
begin
  if tg_op = 'INSERT' then
    if new.sale_reminders_enabled then
      new.sale_reminders_consented_at := pg_catalog.statement_timestamp();
      new.sale_reminders_revoked_at := null;
      if not v_trusted then
        new.sale_reminders_consent_text_version := null;
      end if;
    else
      new.sale_reminders_consented_at := null;
      new.sale_reminders_revoked_at := null;
      new.sale_reminders_consent_text_version := null;
    end if;
    return new;
  end if;

  if new.sale_reminders_enabled and not old.sale_reminders_enabled then
    -- Nouveau consentement : la date est celle de cette instruction, la version vient de la route.
    new.sale_reminders_consented_at := pg_catalog.statement_timestamp();
    new.sale_reminders_revoked_at := null;
    if not v_trusted then
      new.sale_reminders_consent_text_version := old.sale_reminders_consent_text_version;
    end if;
  elsif old.sale_reminders_enabled and not new.sale_reminders_enabled then
    -- Retrait : la preuve du consentement donné est gardée, la date du retrait est celle d'ici.
    new.sale_reminders_consented_at := old.sale_reminders_consented_at;
    new.sale_reminders_revoked_at := pg_catalog.statement_timestamp();
    new.sale_reminders_consent_text_version := old.sale_reminders_consent_text_version;
  else
    new.sale_reminders_consented_at := old.sale_reminders_consented_at;
    new.sale_reminders_revoked_at := old.sale_reminders_revoked_at;
    new.sale_reminders_consent_text_version := old.sale_reminders_consent_text_version;
  end if;
  return new;
end;
$function$;

revoke all on function app_private.enforce_sale_reminder_consent_proof()
  from public, anon, authenticated;

comment on function app_private.enforce_sale_reminder_consent_proof() is
  'Déclencheur de user_notification_preferences : pose les dates de consentement et de retrait des rappels d''audience, en ignorant les valeurs envoyées par le client ; la version du texte consenti n''est prise que d''un écrivain au rôle service_role (la route serveur), jamais d''un autre rôle.';

create or replace function app_private.enforce_email_feature_consent_proof()
returns trigger
language plpgsql
set search_path = ''
as $function$
declare
  -- Seule la route serveur (rôle de service) peut poser la version du texte consenti.
  v_trusted boolean := current_user = 'service_role';
begin
  if tg_op = 'INSERT' then
    if new.weekly_digest_enabled then
      new.weekly_digest_consented_at := pg_catalog.statement_timestamp();
      new.weekly_digest_revoked_at := null;
      if not v_trusted then
        new.weekly_digest_consent_text_version := null;
      end if;
    else
      new.weekly_digest_consented_at := null;
      new.weekly_digest_revoked_at := null;
      new.weekly_digest_consent_text_version := null;
    end if;
    if new.sale_results_enabled then
      new.sale_results_consented_at := pg_catalog.statement_timestamp();
      new.sale_results_revoked_at := null;
      if not v_trusted then
        new.sale_results_consent_text_version := null;
      end if;
    else
      new.sale_results_consented_at := null;
      new.sale_results_revoked_at := null;
      new.sale_results_consent_text_version := null;
    end if;
    return new;
  end if;

  -- Récapitulatif hebdomadaire.
  if new.weekly_digest_enabled and not old.weekly_digest_enabled then
    new.weekly_digest_consented_at := pg_catalog.statement_timestamp();
    new.weekly_digest_revoked_at := null;
    if not v_trusted then
      new.weekly_digest_consent_text_version := old.weekly_digest_consent_text_version;
    end if;
  elsif old.weekly_digest_enabled and not new.weekly_digest_enabled then
    new.weekly_digest_consented_at := old.weekly_digest_consented_at;
    new.weekly_digest_revoked_at := pg_catalog.statement_timestamp();
    new.weekly_digest_consent_text_version := old.weekly_digest_consent_text_version;
  else
    new.weekly_digest_consented_at := old.weekly_digest_consented_at;
    new.weekly_digest_revoked_at := old.weekly_digest_revoked_at;
    new.weekly_digest_consent_text_version := old.weekly_digest_consent_text_version;
  end if;

  -- Alerte de résultat ou de remise en vente.
  if new.sale_results_enabled and not old.sale_results_enabled then
    new.sale_results_consented_at := pg_catalog.statement_timestamp();
    new.sale_results_revoked_at := null;
    if not v_trusted then
      new.sale_results_consent_text_version := old.sale_results_consent_text_version;
    end if;
  elsif old.sale_results_enabled and not new.sale_results_enabled then
    new.sale_results_consented_at := old.sale_results_consented_at;
    new.sale_results_revoked_at := pg_catalog.statement_timestamp();
    new.sale_results_consent_text_version := old.sale_results_consent_text_version;
  else
    new.sale_results_consented_at := old.sale_results_consented_at;
    new.sale_results_revoked_at := old.sale_results_revoked_at;
    new.sale_results_consent_text_version := old.sale_results_consent_text_version;
  end if;
  return new;
end;
$function$;

revoke all on function app_private.enforce_email_feature_consent_proof()
  from public, anon, authenticated;

comment on function app_private.enforce_email_feature_consent_proof() is
  'Déclencheur de user_notification_preferences : pose les dates de consentement et de retrait du récapitulatif hebdomadaire et de l''alerte de résultat, en ignorant les valeurs envoyées par le client ; la version du texte consenti n''est prise que d''un écrivain au rôle service_role (la route serveur), jamais d''un autre rôle.';

-- 2. Droits --------------------------------------------------------------------------------------------
-- Le droit d'écriture du rôle authenticated passe de « toute la table » à la liste des colonnes qui ne
-- portent aucune preuve. Retirer le droit de la table retire aussi les droits par colonne : la liste
-- ci-dessous est la seule écriture restante (user_id y figure : l'upsert de PostgREST l'écrit dans sa
-- clause « do update » ; la politique de mise à jour interdit toujours de changer de propriétaire).
-- select et delete ne changent pas ; service_role garde tout.
revoke insert, update on table public.user_notification_preferences from authenticated;

grant insert (
  user_id,
  alert_email_enabled,
  alert_email_consented_at,
  alert_email_revoked_at,
  consent_source,
  weekly_digest_weekday
) on table public.user_notification_preferences to authenticated;

grant update (
  user_id,
  alert_email_enabled,
  alert_email_consented_at,
  alert_email_revoked_at,
  consent_source,
  weekly_digest_weekday
) on table public.user_notification_preferences to authenticated;

comment on table public.user_notification_preferences is
  'Préférences de notification et preuves de consentement. Le navigateur ne peut écrire que le consentement aux alertes par email et le jour du récapitulatif : les consentements aux rappels d''audience, à « Ma semaine » et à l''alerte de résultat (état, dates, version du texte) ne s''écrivent que par la route serveur (service_role).';

notify pgrst, 'reload schema';

commit;
