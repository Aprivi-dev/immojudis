-- Essai gratuit de 7 jours à l'inscription, à la place de l'offre de lancement sans durée.
--
-- Décision du propriétaire du 25/10/2026 : une personne qui s'inscrit gratuitement bénéficie de
-- l'offre Analyse pendant 7 jours, sans carte bancaire ; ensuite son compte revient à Découverte,
-- sauf abonnement. Les comptes déjà inscrits suivent la même règle (fin immédiate pour un compte
-- confirmé depuis plus de 7 jours).
--
-- Le mécanisme de l'offre de lancement est repris tel quel, avec ses garde-fous : l'interrupteur
-- app_private.launch_offer (désormais « l'essai à l'inscription est ouvert »), l'éligibilité par
-- compte (profil, email confirmé, domaine non jetable, plus ancien compte confirmé de son adresse
-- canonique : une fois par personne), les plafonds globaux séparés et l'absence de prix d'adjudication
-- dans les instantanés. Seule change l'éligibilité : elle dure 7 jours à compter de la confirmation
-- de l'adresse email.
--
-- - app_private.signup_trial_ends_at(uuid) : fin de l'essai du compte (confirmation + 7 jours), ou
--   null si le compte n'y a pas droit (règles de 20261029110000). Seule définition de la durée.
-- - app_private.launch_offer_account_eligible(uuid) : vraie tant que cette fin n'est pas passée. Les
--   deux fonctions d'accès Analyse (20261028170000) l'appellent déjà avec launch_offer_active() :
--   elles ne sont pas redéfinies ici.
-- - public.get_signup_trial_end(uuid) : lecture serveur (service_role) de la fin, même passée, pour
--   que l'application affiche « jusqu'au … » puis « votre essai est terminé ».
-- Aucune écriture dans les comptes ni les abonnements.
begin;

set local lock_timeout = '5s';

create or replace function app_private.signup_trial_ends_at(p_user_id uuid)
returns timestamptz
language sql
stable
security definer
set search_path to ''
as $function$
  -- Fermée par défaut : sans utilisateur, sans profil, sans email confirmé, avec une adresse jetable,
  -- ou si un compte plus ancien a déjà confirmé la même adresse canonique, null. Ne dit rien de
  -- l'interrupteur : les fonctions d'accès le consultent elles-mêmes.
  select account.email_confirmed_at + interval '7 days'
  from auth.users account
  where p_user_id is not null
    and account.id = p_user_id
    and account.email_confirmed_at is not null
    and exists (
      select 1
      from public.user_profiles profile
      where profile.user_id = p_user_id
    )
    and not app_private.is_disposable_email_domain(account.email)
    and not exists (
      select 1
      from app_private.account_email_identity older
      where older.canonical_email = app_private.canonical_email(account.email)
        and older.user_id <> account.id
        and older.email_confirmed_at is not null
        and (older.email_confirmed_at, older.user_id) < (account.email_confirmed_at, account.id)
    );
$function$;

revoke all on function app_private.signup_trial_ends_at(uuid) from public, anon, authenticated;
grant execute on function app_private.signup_trial_ends_at(uuid) to service_role;

comment on function app_private.signup_trial_ends_at(uuid) is
  'Fin de l''essai gratuit de 7 jours de l''offre Analyse : confirmation de l''adresse email + 7 jours, si le compte a un profil, une adresse non jetable et s''il est le plus ancien compte confirmé de son adresse canonique (une fois par personne) ; null sinon. Seule définition de la durée.';

create or replace function app_private.launch_offer_account_eligible(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path to ''
as $function$
  -- Essai en cours : la fin de l'essai du compte n'est pas passée. Ne dit rien de l'interrupteur.
  select coalesce(app_private.signup_trial_ends_at(p_user_id) > now(), false);
$function$;

revoke all on function app_private.launch_offer_account_eligible(uuid) from public, anon, authenticated;
grant execute on function app_private.launch_offer_account_eligible(uuid) to service_role;

comment on function app_private.launch_offer_account_eligible(uuid) is
  'Vrai pendant l''essai gratuit de 7 jours du compte (app_private.signup_trial_ends_at). Lue par les fonctions d''accès Analyse avec launch_offer_active() ; jamais ouverte à anon.';

create or replace function public.get_signup_trial_end(p_user_id uuid)
returns timestamptz
language sql
stable
security definer
set search_path to ''
as $function$
  select app_private.signup_trial_ends_at(p_user_id);
$function$;

revoke all on function public.get_signup_trial_end(uuid) from public, anon, authenticated;
grant execute on function public.get_signup_trial_end(uuid) to service_role;

comment on function public.get_signup_trial_end(uuid) is
  'Lecture serveur seule (service_role) de app_private.signup_trial_ends_at : fin de l''essai gratuit du compte, même passée, ou null si le compte n''y a pas droit.';

notify pgrst, 'reload schema';

commit;
