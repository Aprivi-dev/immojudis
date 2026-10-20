begin;

set local lock_timeout = '5s';

-- Preuve du consentement aux rappels d'audience posée par la base, pas par le navigateur.
--
-- 20261028130000 a ajouté sale_reminders_enabled / sale_reminders_consented_at /
-- sale_reminders_revoked_at, mais la table user_notification_preferences est ouverte en insert et en
-- update à tout compte connecté (20260706142000) : le navigateur pouvait écrire n'importe quelle
-- date de consentement ou de retrait, donc la « preuve » n'en était pas une.
--
-- Un déclencheur before insert or update force désormais, quelles que soient les valeurs envoyées :
--   * insertion  : rappels actifs -> consented_at = maintenant, revoked_at = null ; rappels inactifs ->
--                  consented_at, revoked_at et version du texte = null ;
--   * bascule false -> true : consented_at = maintenant, revoked_at = null ;
--   * bascule true -> false : revoked_at = maintenant, consented_at conservé (preuve du consentement
--                  retiré) ;
--   * toute autre mise à jour : consented_at, revoked_at et version du texte reprennent leur valeur
--                  précédente (une réécriture « actif » alors que les rappels le sont déjà garde la date
--                  d'origine).
-- Le chemin « insert ... on conflict do update » de l'application (upsert) passe par les deux cas : le
-- déclencheur d'insertion s'exécute d'abord, puis celui de mise à jour recale les valeurs sur la ligne
-- existante.
--
-- La colonne sale_reminders_consent_text_version garde la version du texte de consentement présenté
-- (renseignée par la route serveur, src/lib/notification-preferences.ts, au moment de la bascule). Elle
-- n'est reprise du client qu'à la bascule false -> true ; ensuite elle ne change plus tant que le
-- consentement dure. Une bascule faite en SQL sans préciser la version garde l'ancienne valeur : seule
-- la route serveur la renseigne.
alter table public.user_notification_preferences
  add column if not exists sale_reminders_consent_text_version text;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.user_notification_preferences'::regclass
      and conname = 'user_notification_preferences_reminder_text_version_check'
  ) then
    alter table public.user_notification_preferences
      add constraint user_notification_preferences_reminder_text_version_check
      check (
        sale_reminders_consent_text_version is null
        or char_length(sale_reminders_consent_text_version) between 1 and 80
      );
  end if;
end $$;

comment on column public.user_notification_preferences.sale_reminders_consent_text_version is
  'Version du texte de consentement aux rappels d''audience présenté à la personne au moment où elle l''a donné (posée par la route serveur à la bascule false -> true).';
comment on column public.user_notification_preferences.sale_reminders_consented_at is
  'Horodatage prouvant quand la personne a explicitement activé les rappels d''audience. Posé par le déclencheur immojudis_user_notification_preferences_reminder_consent, jamais par le client.';
comment on column public.user_notification_preferences.sale_reminders_revoked_at is
  'Horodatage du retrait du consentement aux rappels d''audience (réglages ou lien de désinscription). Posé par le déclencheur immojudis_user_notification_preferences_reminder_consent, jamais par le client.';

create or replace function app_private.enforce_sale_reminder_consent_proof()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if tg_op = 'INSERT' then
    if new.sale_reminders_enabled then
      new.sale_reminders_consented_at := pg_catalog.statement_timestamp();
      new.sale_reminders_revoked_at := null;
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
  'Déclencheur de user_notification_preferences : pose les dates de consentement et de retrait des rappels d''audience, en ignorant les valeurs envoyées par le client.';

do $$
begin
  if not exists (
    select 1
    from pg_trigger
    where tgrelid = 'public.user_notification_preferences'::regclass
      and tgname = 'immojudis_user_notification_preferences_reminder_consent'
      and not tgisinternal
  ) then
    create trigger immojudis_user_notification_preferences_reminder_consent
      before insert or update on public.user_notification_preferences
      for each row
      execute function app_private.enforce_sale_reminder_consent_proof();
  end if;
end $$;

notify pgrst, 'reload schema';

commit;
