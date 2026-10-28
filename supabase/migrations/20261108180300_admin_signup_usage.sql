begin;

set local lock_timeout = '5s';

-- Usage par compte pour la vue admin « Inscriptions » (point 88 de la session du 27/10/2026) : combien de
-- déblocages, de plafonds enregistrés, de favoris et de fiches dont la valeur de référence a été servie, par
-- compte. Elle permet de voir qui a essayé sans rien faire (filtre « essai fini sans activité ») et de choisir
-- des personnes à joindre soi-même, avec leur accord (voir docs/operations/mesure-essai-et-pepite.md).
--
-- Lecture serveur seule (service_role) : la vue affiche déjà l'adresse, le nom et la dernière connexion de
-- chaque compte à un administrateur authentifié avec double authentification (assertAdminAuth). Cette fonction
-- n'ajoute que quatre nombres par compte et la fin de son essai (règle unique
-- app_private.signup_trial_ends_at), jamais une vente ni un contenu. Les administrateurs ne
-- sont pas rendus. Un compte sans aucune activité est rendu avec des zéros, pour que « sans activité » se lise
-- sans ambiguïté.
--
--   * unlocks      : ventes débloquées (user_sale_unlocks), tout l'historique ; l'essai n'en consomme aucun ;
--   * ceilings     : plafonds enregistrés dans « Mon dossier » (user_favorites.bid_ceiling_saved_at), c'est le
--                    travail délibéré, à la différence d'une fiche simplement ouverte ;
--   * favorites    : ventes suivies (user_favorites) ;
--   * sheets_served: ventes distinctes dont la valeur de référence a été servie au compte
--                    (account_product_events 'bid_ceiling_calculated', conservés 90 jours : le nombre ne
--                    remonte pas au-delà) ;
--   * trial_ends_at: fin de l'essai gratuit de 7 jours, même passée ; nulle si le compte n'y a pas droit.
create or replace function public.admin_signup_usage()
returns table (
  user_id uuid,
  unlocks integer,
  ceilings integer,
  favorites integer,
  sheets_served integer,
  trial_ends_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $function$
  select
    account.id,
    (select pg_catalog.count(*)::integer from public.user_sale_unlocks unlock
      where unlock.user_id = account.id),
    (select pg_catalog.count(*)::integer from public.user_favorites favorite
      where favorite.user_id = account.id and favorite.bid_ceiling_saved_at is not null),
    (select pg_catalog.count(*)::integer from public.user_favorites favorite
      where favorite.user_id = account.id),
    (select pg_catalog.count(distinct product_event.sale_id)::integer from public.account_product_events product_event
      where product_event.user_id = account.id and product_event.event_type = 'bid_ceiling_calculated'),
    app_private.signup_trial_ends_at(account.id)
  from auth.users account
  where not exists (
    select 1
    from public.user_profiles profile
    where profile.user_id = account.id
      and profile.user_role = 'admin'
  );
$function$;

revoke all on function public.admin_signup_usage() from public, anon, authenticated;
grant execute on function public.admin_signup_usage() to service_role;

comment on function public.admin_signup_usage() is
  'Usage par compte pour la vue admin « Inscriptions » (service_role seul) : déblocages, plafonds enregistrés, favoris, fiches dont la valeur de référence a été servie (90 jours), fin de l''essai. Administrateurs exclus.';

notify pgrst, 'reload schema';

commit;
