-- Offre de lancement : tant qu'elle est active, tout compte connecté qui a un profil bénéficie des
-- avantages de l'offre Analyse. Demande du propriétaire (19/10/2026) : la société n'est pas créée,
-- Stripe n'est pas configuré, le paiement reste fermé.
--
-- Une seule source de vérité, un seul geste pour la couper :
--   * app_private.launch_offer : table singleton (une ligne, active à l'application de cette
--     migration) ;
--   * app_private.launch_offer_active() : la lit (stable, search_path vide, fermée si la ligne manque) ;
--   * les trois fonctions qui décident de l'accès Analyse la consultent :
--       app_private.current_user_has_premium_access()  (RLS, déblocages, vues de découverte),
--       app_private.has_active_analysis_access(uuid)    (quotas, favoris, alertes, actualisations),
--       public.has_analysis_access()                    (appelle la première : rien à changer).
--
-- AUCUNE écriture dans user_profiles.account_tier ni dans user_subscriptions : couper l'offre
-- (update app_private.launch_offer set active = false, ou le bouton de /admin/clients) ramène tout
-- à l'état normal sans nettoyage. Les données créées pendant l'offre (alertes avancées, rapports,
-- favoris au-delà du quota gratuit) sont conservées ; seul l'accès normal s'applique de nouveau.
--
-- Jamais d'accès pour anon : sans JWT, auth.uid() est nul et aucun profil ne correspond ; les
-- fonctions ci-dessous restent fermées à anon et public. Les corps des deux fonctions d'accès
-- reprennent exactement ceux de 20261009181000_stripe_subscription_ordering_and_grace.sql (délai de
-- grâce des paiements échoués compris), avec une branche de plus.
begin;

set local lock_timeout = '5s';

create table if not exists app_private.launch_offer (
  singleton boolean primary key default true check (singleton),
  active boolean not null default true,
  updated_at timestamptz not null default statement_timestamp(),
  updated_by uuid references auth.users (id) on delete set null
);

comment on table app_private.launch_offer is
  'Offre de lancement (une seule ligne). active = true : tout compte connecté ayant un profil a les avantages Analyse, sans écriture dans user_profiles ni user_subscriptions. Se coupe avec set_launch_offer(false) ou update ... set active = false.';

-- Active dès l'application de la migration (voulu par le propriétaire). Rejouer la migration ne
-- rallume jamais une offre qu'il a coupée.
insert into app_private.launch_offer (singleton, active)
values (true, true)
on conflict (singleton) do nothing;

alter table app_private.launch_offer enable row level security;
revoke all on table app_private.launch_offer from public, anon, authenticated;

create or replace function app_private.launch_offer_active()
returns boolean
language sql
stable
security definer
set search_path to ''
as $function$
  -- Fermée par défaut : sans ligne, l'offre n'existe pas.
  select coalesce(
    (select offer.active from app_private.launch_offer offer where offer.singleton),
    false
  );
$function$;

revoke all on function app_private.launch_offer_active() from public, anon, authenticated;
grant execute on function app_private.launch_offer_active() to service_role;

comment on function app_private.launch_offer_active() is
  'True tant que l''offre de lancement est active (table app_private.launch_offer). Lue par les fonctions d''accès Analyse ; jamais ouverte à anon.';

-- Lecture de l'état pour l'application (serveur Next.js, rôle service_role) : les pages et les
-- droits de l'API affichent le surclassement d'après cette lecture, jamais d'après une variable
-- d'environnement qui pourrait diverger de la base.
create or replace function public.get_launch_offer_status()
returns boolean
language sql
stable
security invoker
set search_path to ''
as $function$
  select app_private.launch_offer_active();
$function$;

revoke all on function public.get_launch_offer_status() from public, anon, authenticated;
grant execute on function public.get_launch_offer_status() to service_role;

-- Interrupteur du propriétaire : réservé aux administrateurs (même garde que
-- set_catalogue_readiness_enforcement, qui tient compte de la double authentification). Rend l'état
-- après le changement. Fonction SECURITY DEFINER de `public` exécutable par `authenticated` : elle
-- figure sur la liste blanche de supabase/tests/441_function_privileges.sql, qui exige que cette liste
-- soit étendue ici, avec sa justification.
create or replace function public.set_launch_offer(p_active boolean)
returns boolean
language plpgsql
security definer
set search_path to ''
as $function$
begin
  if not public.is_admin() then
    raise exception using errcode = '42501', message = 'Admin access required.';
  end if;
  if p_active is null then
    raise exception using errcode = '22023', message = 'The launch offer state is required.';
  end if;

  update app_private.launch_offer offer
  set active = p_active,
      updated_by = (select auth.uid()),
      updated_at = statement_timestamp()
  where offer.singleton;
  if not found then
    insert into app_private.launch_offer (singleton, active, updated_by)
    values (true, p_active, (select auth.uid()));
  end if;

  return app_private.launch_offer_active();
end;
$function$;

revoke all on function public.set_launch_offer(boolean) from public, anon;
grant execute on function public.set_launch_offer(boolean) to authenticated, service_role;

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
    -- Offre de lancement : tout compte connecté qui a un profil (jamais anon : sans JWT,
    -- auth.uid() est nul).
    or (
      app_private.launch_offer_active()
      and exists (
        select 1
        from public.user_profiles profile
        where profile.user_id = (select auth.uid())
      )
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
  -- Offre de lancement : tout compte qui a un profil.
  or (
    app_private.launch_offer_active()
    and exists (
      select 1
      from public.user_profiles profile
      where profile.user_id = p_user_id
    )
  );
$function$;

revoke all on function app_private.has_active_analysis_access(uuid)
  from public, anon, authenticated;
grant execute on function app_private.has_active_analysis_access(uuid) to service_role;

notify pgrst, 'reload schema';

commit;
