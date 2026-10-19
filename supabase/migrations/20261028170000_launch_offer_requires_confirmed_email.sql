-- Offre de lancement : exiger une adresse email confirmée.
--
-- 20261028120000_launch_offer.sql ouvre les avantages Analyse à « tout compte qui a un profil ». Le
-- profil est créé par le déclencheur app_private.handle_new_user_profile() à l'INSERT dans
-- auth.users, donc AVANT toute confirmation : si le réglage « Confirm email » de Supabase Auth est
-- coupé (ou qu'un chemin d'inscription crée un compte sans confirmer), une personne qui crée 50
-- comptes avec des adresses inventées obtiendrait 50 fois les quotas d'Analyse. La confirmation
-- prouve au moins que l'adresse existe et que la personne la lit : c'est le plus petit frein à la
-- multiplication de comptes, et il ne gêne aucun vrai utilisateur.
--
-- Une seule source de vérité pour le compte : app_private.launch_offer_account_eligible(uuid) = profil
-- ET auth.users.email_confirmed_at non nul. Les deux fonctions d'accès Analyse gardent leur
-- consultation de l'interrupteur (app_private.launch_offer_active(), exigée par
-- scripts/check-security-invariants.mjs) et y ajoutent cette condition ; le reste de leur corps est
-- inchangé (reprise exacte de 20261028120000_launch_offer.sql). Aucune écriture dans les tables des comptes : un compte qui
-- confirme son adresse reçoit l'accès à la lecture suivante, sans nettoyage.
--
-- Côté application, resolvePlanEntitlements applique la même règle (src/lib/launch-offer.server.ts,
-- hasConfirmedEmail) pour que les écrans et la base répondent pareil.
begin;

set local lock_timeout = '5s';

create or replace function app_private.launch_offer_account_eligible(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path to ''
as $function$
  -- Fermée par défaut : sans utilisateur, sans profil ou sans email confirmé, faux. Ne dit rien de
  -- l'interrupteur de l'offre : les fonctions d'accès le consultent elles-mêmes.
  select
    p_user_id is not null
    and exists (
      select 1
      from public.user_profiles profile
      where profile.user_id = p_user_id
    )
    and exists (
      select 1
      from auth.users account
      where account.id = p_user_id
        and account.email_confirmed_at is not null
    );
$function$;

revoke all on function app_private.launch_offer_account_eligible(uuid) from public, anon, authenticated;
grant execute on function app_private.launch_offer_account_eligible(uuid) to service_role;

comment on function app_private.launch_offer_account_eligible(uuid) is
  'Vrai si le compte a un profil et une adresse email confirmée (auth.users.email_confirmed_at). Condition de l''offre de lancement, lue par les fonctions d''accès Analyse avec launch_offer_active() ; jamais ouverte à anon.';

create or replace function app_private.current_user_has_premium_access()
returns boolean
language sql
stable
security definer
set search_path to ''
as $function$
  select
    exists (
      select 1
      from public.user_profiles profile
      where profile.user_id = (select auth.uid())
        and (
          profile.user_role = 'admin'
          or profile.account_tier = 'premium'
        )
    )
    or exists (
      select 1
      from public.user_subscriptions subscription
      where subscription.user_id = (select auth.uid())
        and subscription.plan_code = 'analyse'
        and app_private.subscription_grants_access(
          subscription.status,
          subscription.current_period_end
        )
    )
    -- Offre de lancement : compte connecté avec profil ET email confirmé (jamais anon : sans JWT,
    -- auth.uid() est nul).
    or (
      app_private.launch_offer_active()
      and app_private.launch_offer_account_eligible((select auth.uid()))
    );
$function$;

revoke all on function app_private.current_user_has_premium_access()
  from public, anon, authenticated;
grant execute on function app_private.current_user_has_premium_access()
  to authenticated, service_role;

create or replace function app_private.has_active_analysis_access(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path to ''
as $function$
  select exists (
    select 1
    from public.user_profiles profile
    where profile.user_id = p_user_id
      and (profile.account_tier = 'premium' or profile.user_role = 'admin')
  )
  or exists (
    select 1
    from public.user_subscriptions subscription
    where subscription.user_id = p_user_id
      and subscription.plan_code = 'analyse'
      and app_private.subscription_grants_access(
        subscription.status,
        subscription.current_period_end
      )
  )
  -- Offre de lancement : compte avec profil ET email confirmé.
  or (
    app_private.launch_offer_active()
    and app_private.launch_offer_account_eligible(p_user_id)
  );
$function$;

revoke all on function app_private.has_active_analysis_access(uuid)
  from public, anon, authenticated;
grant execute on function app_private.has_active_analysis_access(uuid) to service_role;

notify pgrst, 'reload schema';

commit;
