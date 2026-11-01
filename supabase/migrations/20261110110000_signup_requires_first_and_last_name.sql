-- Inscription : le prénom et le nom sont obligatoires, garantis côté base.
--
-- Le formulaire (src/app/login/login-page.tsx, src/lib/signup-name.ts) les exige, mais il appelle
-- supabase.auth.signUp directement depuis le navigateur : un appel direct à l'API d'authentification
-- crée un compte sans nom. Le déclencheur de création de profil sur auth.users
-- (app_private.handle_new_user_profile, 20260612100158) refuse donc l'inscription publique par email
-- dont raw_user_meta_data.first_name ou .last_name est vide une fois les espaces retirés.
--
-- Périmètre du contrôle : l'inscription publique par email et mot de passe, et elle seule.
--   * raw_app_meta_data.provider = 'email' (valeur posée par l'API d'inscription ; absente des
--     comptes créés par les tests et scripts SQL, qui passent '{}') ;
--   * invited_at est nul : une invitation (inviteUserByEmail) n'a pas de métadonnées saisies par la
--     personne invitée ;
--   * email_confirmed_at est nul à l'INSERT : une inscription publique n'est jamais confirmée à la
--     création (« Confirm email » actif, supabase/config.toml), alors qu'un compte créé par un
--     administrateur (tableau de bord, auth.admin.createUser avec email_confirm) l'est d'emblée.
--     Le public ne peut pas poser cette date.
-- Aucun autre chemin de création de compte n'existe dans le dépôt (pas d'OAuth, pas de lien magique,
-- pas d'invitation ni de createUser dans le code, les scripts ou les tests e2e, qui simulent
-- /auth/v1/signup). Les comptes existants ne sont pas touchés : le déclencheur ne se lance qu'à l'INSERT.
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
    and new.invited_at is null
    and new.email_confirmed_at is null
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
