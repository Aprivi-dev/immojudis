begin;

set local lock_timeout = '5s';

-- Consentement distinct aux emails de nouveautés et d'offres d'Immojudis (décision du propriétaire du
-- 26/11/2026, après avis juridique). La prospection commerciale par email exige un consentement
-- préalable, explicite et distinct (article L. 34-5 du code des postes et des communications
-- électroniques) : celui des alertes, des rappels d'audience, de « Ma semaine » ou de l'alerte de
-- résultat ne vaut pas pour elle. Aucun email commercial n'est écrit dans ce lot : seulement le recueil,
-- la preuve et le retrait.
--
-- Même schéma que les trois consentements existants (20261029130000, 20261030120000, 20261031100400) :
--   * marketing_emails_enabled              : la case, fausse par défaut (jamais pré-cochée) ;
--   * marketing_emails_consented_at         : date du consentement en cours, posée par le déclencheur ;
--   * marketing_emails_revoked_at           : date du retrait, posée par le déclencheur ;
--   * marketing_emails_consent_text_version : version du texte présenté, posée par la route serveur
--                                             (src/lib/notification-preferences.ts) à la bascule
--                                             false -> true, et gardée seulement d'un écrivain
--                                             service_role.
--
-- Rien n'est recueilli tant que l'interrupteur MARKETING_EMAILS_MODE vaut « off » (défaut) : la case
-- n'est pas proposée et la route refuse le consentement. Le retrait reste toujours possible.
--
-- Déclencheur before insert or update, même règle que app_private.enforce_email_feature_consent_proof :
--   * insertion  : case cochée -> consented_at = maintenant, revoked_at = null, version gardée du seul
--                  service_role ; case décochée -> consented_at, revoked_at et version = null ;
--   * bascule false -> true : consented_at = maintenant, revoked_at = null, version du seul service_role ;
--   * bascule true -> false : revoked_at = maintenant, consented_at et version conservés (preuve du
--                  consentement retiré) ;
--   * toute autre mise à jour : consented_at, revoked_at et version reprennent leur valeur précédente.
-- Une fonction à part plutôt qu'un ajout aux fonctions existantes : chaque consentement garde sa propre
-- preuve, et les fonctions déjà en service ne sont pas réécrites.
--
-- Droits : aucun grant n'est ajouté. Depuis 20261031100400, le rôle authenticated n'écrit que la liste
-- de colonnes qui lui est accordée ; les nouvelles colonnes n'en font pas partie : seul service_role
-- (la route serveur, le lien de désinscription) les écrit.

alter table public.user_notification_preferences
  add column if not exists marketing_emails_enabled boolean not null default false,
  add column if not exists marketing_emails_consented_at timestamptz,
  add column if not exists marketing_emails_revoked_at timestamptz,
  add column if not exists marketing_emails_consent_text_version text;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.user_notification_preferences'::regclass
      and conname = 'user_notification_preferences_marketing_text_version_check'
  ) then
    alter table public.user_notification_preferences
      add constraint user_notification_preferences_marketing_text_version_check
      check (
        marketing_emails_consent_text_version is null
        or char_length(marketing_emails_consent_text_version) between 1 and 80
      );
  end if;
end $$;

comment on column public.user_notification_preferences.marketing_emails_enabled is
  'Consentement distinct aux emails de nouveautés et d''offres d''Immojudis (jamais pré-coché).';
comment on column public.user_notification_preferences.marketing_emails_consented_at is
  'Horodatage du consentement en cours aux emails de nouveautés et d''offres. Posé par le déclencheur immojudis_user_notification_preferences_marketing_consent, jamais par le client.';
comment on column public.user_notification_preferences.marketing_emails_revoked_at is
  'Horodatage du retrait du consentement aux emails de nouveautés et d''offres (réglages ou lien de désinscription). Posé par le déclencheur, jamais par le client.';
comment on column public.user_notification_preferences.marketing_emails_consent_text_version is
  'Version du texte de consentement aux emails de nouveautés et d''offres présenté à la personne (posée par la route serveur, rôle service_role, à la bascule false -> true).';

create or replace function app_private.enforce_marketing_email_consent_proof()
returns trigger
language plpgsql
set search_path = ''
as $function$
declare
  -- Seule la route serveur (rôle de service) peut poser la version du texte consenti.
  v_trusted boolean := current_user = 'service_role';
begin
  if tg_op = 'INSERT' then
    if new.marketing_emails_enabled then
      new.marketing_emails_consented_at := pg_catalog.statement_timestamp();
      new.marketing_emails_revoked_at := null;
      if not v_trusted then
        new.marketing_emails_consent_text_version := null;
      end if;
    else
      new.marketing_emails_consented_at := null;
      new.marketing_emails_revoked_at := null;
      new.marketing_emails_consent_text_version := null;
    end if;
    return new;
  end if;

  if new.marketing_emails_enabled and not old.marketing_emails_enabled then
    -- Nouveau consentement : la date est celle de cette instruction, la version vient de la route.
    new.marketing_emails_consented_at := pg_catalog.statement_timestamp();
    new.marketing_emails_revoked_at := null;
    if not v_trusted then
      new.marketing_emails_consent_text_version := old.marketing_emails_consent_text_version;
    end if;
  elsif old.marketing_emails_enabled and not new.marketing_emails_enabled then
    -- Retrait : la preuve du consentement donné est gardée, la date du retrait est celle d'ici.
    new.marketing_emails_consented_at := old.marketing_emails_consented_at;
    new.marketing_emails_revoked_at := pg_catalog.statement_timestamp();
    new.marketing_emails_consent_text_version := old.marketing_emails_consent_text_version;
  else
    new.marketing_emails_consented_at := old.marketing_emails_consented_at;
    new.marketing_emails_revoked_at := old.marketing_emails_revoked_at;
    new.marketing_emails_consent_text_version := old.marketing_emails_consent_text_version;
  end if;
  return new;
end;
$function$;

revoke all on function app_private.enforce_marketing_email_consent_proof()
  from public, anon, authenticated;

comment on function app_private.enforce_marketing_email_consent_proof() is
  'Déclencheur de user_notification_preferences : pose les dates de consentement et de retrait des emails de nouveautés et d''offres, en ignorant les valeurs envoyées par le client ; la version du texte consenti n''est prise que d''un écrivain au rôle service_role (la route serveur), jamais d''un autre rôle.';

do $$
begin
  if not exists (
    select 1
    from pg_trigger
    where tgrelid = 'public.user_notification_preferences'::regclass
      and tgname = 'immojudis_user_notification_preferences_marketing_consent'
      and not tgisinternal
  ) then
    create trigger immojudis_user_notification_preferences_marketing_consent
      before insert or update on public.user_notification_preferences
      for each row
      execute function app_private.enforce_marketing_email_consent_proof();
  end if;
end $$;

comment on table public.user_notification_preferences is
  'Préférences de notification et preuves de consentement. Le navigateur ne peut écrire que le consentement aux alertes par email et le jour du récapitulatif : les consentements aux rappels d''audience, à « Ma semaine », à l''alerte de résultat et aux emails de nouveautés et d''offres (état, dates, version du texte) ne s''écrivent que par la route serveur (service_role).';

notify pgrst, 'reload schema';

commit;
