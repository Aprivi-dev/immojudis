begin;

set local lock_timeout = '5s';

-- Consentements distincts du récapitulatif hebdomadaire « Ma semaine » (point 70 de la session du
-- 20/10/2026) et de l'alerte de résultat ou de remise en vente (point 73), avec la même preuve que les
-- rappels d'audience (20261029130000) : les dates sont posées par la base, pas par le navigateur.
--
-- Chaque email a son consentement, jamais pré-coché, séparé de celui des alertes et de celui des rappels
-- d'audience : la personne peut vouloir l'un sans les autres. Pour chacun :
--   * *_enabled              : la case, fausse par défaut ;
--   * *_consented_at         : date du consentement en cours, posée par le déclencheur ;
--   * *_revoked_at           : date du retrait, posée par le déclencheur ;
--   * *_consent_text_version : version du texte présenté, posée par la route serveur
--                              (src/lib/notification-preferences.ts) à la bascule false -> true.
-- Le récapitulatif a en plus le jour de la semaine choisi (weekly_digest_weekday, 1 = lundi ... 7 =
-- dimanche, ISO 8601), le mardi par défaut.
--
-- L'envoi reste fermé tant que les interrupteurs WEEKLY_DIGEST_MODE et SALE_RESULTS_MODE valent « off »
-- (défaut) : ces colonnes ne déclenchent aucun envoi à elles seules.
--
-- Déclencheur before insert or update (même règle que app_private.enforce_sale_reminder_consent_proof) :
--   * insertion  : fonction active -> consented_at = maintenant, revoked_at = null ; inactive ->
--                  consented_at, revoked_at et version = null ;
--   * bascule false -> true : consented_at = maintenant, revoked_at = null (la version vient de la route) ;
--   * bascule true -> false : revoked_at = maintenant, consented_at et version conservés (preuve du
--                  consentement retiré) ;
--   * toute autre mise à jour : consented_at, revoked_at et version reprennent leur valeur précédente.
-- Le jour choisi n'est pas une preuve : il se modifie librement (contrainte 1 à 7).

alter table public.user_notification_preferences
  add column if not exists weekly_digest_enabled boolean not null default false,
  add column if not exists weekly_digest_consented_at timestamptz,
  add column if not exists weekly_digest_revoked_at timestamptz,
  add column if not exists weekly_digest_consent_text_version text,
  add column if not exists weekly_digest_weekday smallint not null default 2,
  add column if not exists sale_results_enabled boolean not null default false,
  add column if not exists sale_results_consented_at timestamptz,
  add column if not exists sale_results_revoked_at timestamptz,
  add column if not exists sale_results_consent_text_version text;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.user_notification_preferences'::regclass
      and conname = 'user_notification_preferences_weekly_weekday_check'
  ) then
    alter table public.user_notification_preferences
      add constraint user_notification_preferences_weekly_weekday_check
      check (weekly_digest_weekday between 1 and 7);
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.user_notification_preferences'::regclass
      and conname = 'user_notification_preferences_weekly_text_version_check'
  ) then
    alter table public.user_notification_preferences
      add constraint user_notification_preferences_weekly_text_version_check
      check (
        weekly_digest_consent_text_version is null
        or char_length(weekly_digest_consent_text_version) between 1 and 80
      );
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.user_notification_preferences'::regclass
      and conname = 'user_notification_preferences_results_text_version_check'
  ) then
    alter table public.user_notification_preferences
      add constraint user_notification_preferences_results_text_version_check
      check (
        sale_results_consent_text_version is null
        or char_length(sale_results_consent_text_version) between 1 and 80
      );
  end if;
end $$;

comment on column public.user_notification_preferences.weekly_digest_enabled is
  'Consentement distinct au récapitulatif hebdomadaire « Ma semaine » (jamais pré-coché).';
comment on column public.user_notification_preferences.weekly_digest_consented_at is
  'Horodatage du consentement en cours au récapitulatif hebdomadaire. Posé par le déclencheur immojudis_user_notification_preferences_email_feature_consent, jamais par le client.';
comment on column public.user_notification_preferences.weekly_digest_revoked_at is
  'Horodatage du retrait du consentement au récapitulatif hebdomadaire (réglages ou lien de désinscription). Posé par le déclencheur, jamais par le client.';
comment on column public.user_notification_preferences.weekly_digest_consent_text_version is
  'Version du texte de consentement au récapitulatif hebdomadaire présenté à la personne (posée par la route serveur à la bascule false -> true).';
comment on column public.user_notification_preferences.weekly_digest_weekday is
  'Jour d''envoi du récapitulatif hebdomadaire, ISO 8601 : 1 = lundi ... 7 = dimanche. Mardi (2) par défaut.';
comment on column public.user_notification_preferences.sale_results_enabled is
  'Consentement distinct à l''alerte de résultat ou de remise en vente d''une vente suivie (jamais pré-coché).';
comment on column public.user_notification_preferences.sale_results_consented_at is
  'Horodatage du consentement en cours à l''alerte de résultat. Posé par le déclencheur immojudis_user_notification_preferences_email_feature_consent, jamais par le client.';
comment on column public.user_notification_preferences.sale_results_revoked_at is
  'Horodatage du retrait du consentement à l''alerte de résultat (réglages ou lien de désinscription). Posé par le déclencheur, jamais par le client.';
comment on column public.user_notification_preferences.sale_results_consent_text_version is
  'Version du texte de consentement à l''alerte de résultat présenté à la personne (posée par la route serveur à la bascule false -> true).';

create or replace function app_private.enforce_email_feature_consent_proof()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if tg_op = 'INSERT' then
    if new.weekly_digest_enabled then
      new.weekly_digest_consented_at := pg_catalog.statement_timestamp();
      new.weekly_digest_revoked_at := null;
    else
      new.weekly_digest_consented_at := null;
      new.weekly_digest_revoked_at := null;
      new.weekly_digest_consent_text_version := null;
    end if;
    if new.sale_results_enabled then
      new.sale_results_consented_at := pg_catalog.statement_timestamp();
      new.sale_results_revoked_at := null;
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
  'Déclencheur de user_notification_preferences : pose les dates de consentement et de retrait du récapitulatif hebdomadaire et de l''alerte de résultat, en ignorant les valeurs envoyées par le client.';

do $$
begin
  if not exists (
    select 1
    from pg_trigger
    where tgrelid = 'public.user_notification_preferences'::regclass
      and tgname = 'immojudis_user_notification_preferences_email_feature_consent'
      and not tgisinternal
  ) then
    create trigger immojudis_user_notification_preferences_email_feature_consent
      before insert or update on public.user_notification_preferences
      for each row
      execute function app_private.enforce_email_feature_consent_proof();
  end if;
end $$;

notify pgrst, 'reload schema';

commit;
