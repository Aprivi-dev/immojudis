-- Couper l'interrupteur de l'essai ne ferme que les NOUVEAUX essais.
--
-- Les fonctions d'accès Analyse (20261028170000) exigeaient l'interrupteur
-- app_private.launch_offer_active() pour tout compte en essai : couper l'interrupteur ramenait donc
-- à Découverte, sans préavis, les comptes dont les 7 jours couraient encore. L'article 13 des CGU
-- ne prévoit l'arrêt que pour les nouveaux comptes (le retrait anticipé se limite à l'abus ou à
-- l'impératif technique ou juridique).
--
-- Nouvelle règle : un compte dont l'adresse a été confirmée AVANT la coupure garde ses 7 jours
-- (app_private.signup_trial_ends_at, inchangée). Seuls les comptes qui confirment après la coupure
-- n'ont pas d'essai.
--   * app_private.launch_offer.closed_at : instant de la dernière coupure (null tant que l'interrupteur
--     est actif). Tenue par un déclencheur, que la coupure passe par set_launch_offer ou par un
--     update direct. Une coupure antérieure à cette migration (ligne inactive) prend updated_at.
--   * app_private.launch_offer_confirmed_before_close(uuid) : l'interrupteur est coupé et le compte a
--     confirmé son adresse avant closed_at.
--   * current_user_has_premium_access et has_active_analysis_access : corps de 20261028170000, avec
--     « interrupteur actif OU confirmé avant la coupure » à la place de l'interrupteur seul. Elles
--     continuent d'appeler launch_offer_active() et launch_offer_account_eligible().
--   * public.get_signup_trial(uuid) : fin de l'essai et « l'essai est ouvert pour ce compte », lus
--     par le serveur d'application (service_role) pour que les écrans et les droits TypeScript
--     répondent comme la base.
-- Rétablir l'interrupteur remet closed_at à null. Aucune écriture dans les comptes ni les abonnements.
begin;

set local lock_timeout = '5s';

alter table app_private.launch_offer add column if not exists closed_at timestamptz;

comment on column app_private.launch_offer.closed_at is
  'Instant de la dernière coupure de l''essai (null tant qu''il est actif). Les comptes dont l''adresse a été confirmée avant cet instant gardent leurs 7 jours.';

update app_private.launch_offer
set closed_at = updated_at
where not active
  and closed_at is null;

create or replace function app_private.launch_offer_track_closing()
returns trigger
language plpgsql
set search_path to ''
as $function$
begin
  if new.active then
    new.closed_at := null;
  elsif tg_op = 'INSERT' or old.active then
    new.closed_at := pg_catalog.now();
  end if;
  return new;
end;
$function$;

revoke all on function app_private.launch_offer_track_closing() from public, anon, authenticated;

drop trigger if exists launch_offer_track_closing on app_private.launch_offer;
create trigger launch_offer_track_closing
  before insert or update on app_private.launch_offer
  for each row
  execute function app_private.launch_offer_track_closing();

create or replace function app_private.launch_offer_confirmed_before_close(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path to ''
as $function$
  -- Fermée par défaut : interrupteur actif (rien à rattraper), sans date de coupure, sans compte ou
  -- sans email confirmé, faux.
  select coalesce(
    (
      select not offer.active
        and offer.closed_at is not null
        and account.email_confirmed_at is not null
        and account.email_confirmed_at < offer.closed_at
      from app_private.launch_offer offer
      join auth.users account on account.id = p_user_id
      where offer.singleton
    ),
    false
  );
$function$;

revoke all on function app_private.launch_offer_confirmed_before_close(uuid)
  from public, anon, authenticated;
grant execute on function app_private.launch_offer_confirmed_before_close(uuid) to service_role;

comment on function app_private.launch_offer_confirmed_before_close(uuid) is
  'Vrai si l''essai est coupé et que le compte a confirmé son adresse avant la coupure : il garde ses 7 jours. Jamais ouverte à anon.';

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
    -- Essai : compte connecté avec profil ET email confirmé (jamais anon : sans JWT, auth.uid() est
    -- nul), tant que l'interrupteur est actif, ou si le compte a confirmé avant la coupure.
    or (
      app_private.launch_offer_account_eligible((select auth.uid()))
      and (
        app_private.launch_offer_active()
        or app_private.launch_offer_confirmed_before_close((select auth.uid()))
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
  -- Essai : compte avec profil ET email confirmé, tant que l'interrupteur est actif, ou si le
  -- compte a confirmé avant la coupure.
  or (
    app_private.launch_offer_account_eligible(p_user_id)
    and (
      app_private.launch_offer_active()
      or app_private.launch_offer_confirmed_before_close(p_user_id)
    )
  );
$function$;

revoke all on function app_private.has_active_analysis_access(uuid)
  from public, anon, authenticated;
grant execute on function app_private.has_active_analysis_access(uuid) to service_role;

create or replace function public.get_signup_trial(p_user_id uuid)
returns table (ends_at timestamptz, gate_open boolean)
language sql
stable
security definer
set search_path to ''
as $function$
  select
    app_private.signup_trial_ends_at(p_user_id),
    (
      app_private.launch_offer_active()
      or app_private.launch_offer_confirmed_before_close(p_user_id)
    );
$function$;

revoke all on function public.get_signup_trial(uuid) from public, anon, authenticated;
grant execute on function public.get_signup_trial(uuid) to service_role;

comment on function public.get_signup_trial(uuid) is
  'Lecture serveur seule (service_role) : fin de l''essai du compte (app_private.signup_trial_ends_at, même passée) et gate_open (l''essai est ouvert pour ce compte : interrupteur actif, ou adresse confirmée avant la coupure).';

notify pgrst, 'reload schema';

commit;
