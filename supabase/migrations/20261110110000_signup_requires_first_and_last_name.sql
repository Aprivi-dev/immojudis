-- Inscription : le prénom et le nom sont obligatoires, garantis côté base.
--
-- Le formulaire (src/app/login/login-page.tsx, src/lib/signup-name.ts) les exige, mais il appelle
-- supabase.auth.signUp directement depuis le navigateur : un appel direct à l'API d'authentification
-- crée un compte sans nom. Le déclencheur de création de profil sur auth.users
-- (app_private.handle_new_user_profile, 20260612100158) refuse donc l'inscription publique par email
-- dont raw_user_meta_data.first_name ou .last_name est vide une fois les espaces retirés.
--
-- Périmètre du contrôle : tout compte créé avec raw_app_meta_data.provider = 'email' (valeur posée
-- par l'API d'authentification pour l'email et mot de passe ; absente des comptes créés par les tests
-- et scripts SQL, qui passent '{}'). Il n'existe pas de critère plus fin : à l'INSERT, l'inscription
-- publique (/signup), la création par un administrateur (auth.admin.createUser, tableau de bord) et
-- l'invitation (inviteUserByEmail) construisent le même enregistrement (supabase/auth, internal/api :
-- signup.go ToUserModel + signupNewUser, admin.go adminUserCreate, invite.go). email_confirmed_at,
-- invited_at et confirmation_sent_at sont nuls dans les trois cas : GoTrue les pose par un UPDATE
-- ultérieur (Confirm, sendConfirmation, sendInvite). Une exemption fondée sur eux ne distingue donc
-- rien. L'exigence vaut pour tous ces chemins.
--
-- Conséquence pour l'administration : un compte créé par auth.admin.createUser, par le tableau de
-- bord ou par une invitation avec provider 'email' doit fournir first_name et last_name dans
-- user_metadata (data pour l'invitation), faute de quoi la création échoue (« Database error
-- creating new user »). Aucun autre chemin de création n'existe dans le dépôt hors fixtures SQL
-- sans fournisseur (pas d'OAuth ni de lien magique ; les tests e2e simulent /auth/v1/signup).
-- Les comptes existants ne sont pas touchés : le déclencheur ne se lance qu'à l'INSERT.
--
-- Le reste de la fonction est inchangé (reprise exacte de 20260612100158). Le refus lève une
-- exception : l'INSERT dans auth.users est annulé avec le reste de l'inscription. Selon sa version,
-- l'API d'authentification renvoie ce message ou seulement « Database error saving new user » ;
-- le formulaire traduit les deux (src/lib/user-messages.ts).
--
-- Retour arrière : recréer la fonction depuis 20260612100158_user_profiles_b2c_b2b.sql.
begin;

set local lock_timeout = '5s';

create or replace function app_private.handle_new_user_profile()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  requested_account_type text := coalesce(new.raw_user_meta_data ->> 'account_type', 'b2c');
  normalized_account_type text := case
    when requested_account_type in ('b2b', 'pro', 'professional') then 'b2b'
    else 'b2c'
  end;
  requested_role text := new.raw_user_meta_data ->> 'professional_role';
  normalized_role text := case
    when normalized_account_type = 'b2b'
      and requested_role in ('lawyer', 'notary', 'bailiff', 'court', 'other')
      then requested_role
    else null
  end;
  -- Espaces, tabulations, retours à la ligne et espace insécable retirés aux deux bouts.
  trimmed_chars constant text := E' \t\r\n\f\v ';
begin
  if new.raw_app_meta_data ->> 'provider' = 'email'
    and (
      nullif(btrim(coalesce(new.raw_user_meta_data ->> 'first_name', ''), trimmed_chars), '') is null
      or nullif(btrim(coalesce(new.raw_user_meta_data ->> 'last_name', ''), trimmed_chars), '') is null
    )
  then
    raise exception 'Le prénom et le nom sont obligatoires pour créer un compte.'
      using errcode = 'check_violation',
        hint = 'Renseignez first_name et last_name dans les métadonnées de l''inscription.';
  end if;

  insert into public.user_profiles (
    user_id,
    email,
    full_name,
    account_type,
    professional_role,
    organization_name,
    professional_status
  )
  values (
    new.id,
    new.email,
    nullif(btrim(new.raw_user_meta_data ->> 'full_name'), ''),
    normalized_account_type,
    normalized_role,
    case
      when normalized_account_type = 'b2b'
        then nullif(btrim(new.raw_user_meta_data ->> 'organization_name'), '')
      else null
    end,
    case
      when normalized_account_type = 'b2b' then 'pending'
      else 'not_applicable'
    end
  )
  on conflict (user_id) do nothing;

  return new;
end;
$$;

commit;
