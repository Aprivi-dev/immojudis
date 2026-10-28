-- Prolongation de l'essai par l'administrateur : une ligne d'essai, non un abonnement.
--
-- Depuis #328, « prolonger l'essai » écrit dans user_subscriptions une ligne plan_code 'analyse',
-- statut 'trialing', fin de période choisie, sans abonnement Stripe, avec
-- metadata.manual_grant.source = 'admin_trial_extension'. La base la traitait comme un abonnement :
--   * reserve_analyse_checkout refusait la souscription du compte prolongé (« un abonnement est déjà
--     associé ») ;
--   * has_standing_analysis_access (droit durable) était vraie : le compte prolongé recevait les
--     données que l'essai de 7 jours retient volontairement (prix d'adjudication des instantanés
--     des ventes suivies, via snapshot_price_access) et échappait à la part réduite de l'essai dans
--     les plafonds d'actualisation (enqueue_data_refresh_bounded).
--
-- Cette migration aligne la prolongation sur l'essai qu'elle prolonge :
--   * app_private.is_admin_trial_extension(metadata, stripe_subscription_id) : la ligne vient d'une
--     prolongation d'essai ET ne porte aucun abonnement Stripe. Dès qu'un paiement écrit
--     stripe_subscription_id (webhook), la ligne redevient un abonnement ordinaire.
--   * has_standing_analysis_access exclut ces lignes ; l'accès Analyse lui-même (fonctions d'accès,
--     subscription_grants_access) est inchangé : la prolongation ouvre toujours l'offre jusqu'à sa fin.
--   * reserve_analyse_checkout ne bloque plus la souscription d'un compte en essai prolongé. Le
--     reste du corps est celui de 20261003114434, inchangé. La ligne n'est pas modifiée au-delà des
--     clés de réservation ; le webhook de paiement l'écrase au paiement.
--
-- Aucune écriture dans les comptes ni les abonnements.
begin;

set local lock_timeout = '5s';

create or replace function app_private.is_admin_trial_extension(
  p_metadata jsonb,
  p_stripe_subscription_id text
)
returns boolean
language sql
immutable
set search_path to ''
as $function$
  select p_stripe_subscription_id is null
    and coalesce(p_metadata #>> '{manual_grant,source}', '') = 'admin_trial_extension';
$function$;

revoke all on function app_private.is_admin_trial_extension(jsonb, text)
  from public, anon, authenticated;
grant execute on function app_private.is_admin_trial_extension(jsonb, text) to service_role;

comment on function app_private.is_admin_trial_extension(jsonb, text) is
  'Vrai pour une ligne user_subscriptions écrite par la prolongation d''essai de l''administrateur (metadata.manual_grant.source = admin_trial_extension) qui ne porte aucun abonnement Stripe : un essai, pas un abonnement.';

create or replace function app_private.has_standing_analysis_access(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path to ''
as $function$
  -- Même définition que 20261029110100, sans les lignes de prolongation d'essai : ce que le compte a
  -- par lui-même, qu'une coupure de l'essai ne lui retire pas.
  select
    p_user_id is not null
    and (
      exists (
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
          and not app_private.is_admin_trial_extension(
            subscription.metadata,
            subscription.stripe_subscription_id
          )
      )
    );
$function$;

revoke all on function app_private.has_standing_analysis_access(uuid)
  from public, anon, authenticated;
grant execute on function app_private.has_standing_analysis_access(uuid) to service_role;

comment on function app_private.has_standing_analysis_access(uuid) is
  'Droit Analyse hors essai : abonnement actif, compte premium ou administrateur. Ni l''essai à l''inscription, ni la prolongation d''essai de l''administrateur n''en font partie. Ne lit ni l''interrupteur ni l''email ; jamais ouverte à anon.';

create or replace function public.reserve_analyse_checkout(
  p_user_id uuid,
  p_checkout_token text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_row public.user_subscriptions%rowtype;
  reserved_at timestamptz;
  affected_rows integer;
begin
  if p_user_id is null or p_checkout_token is null or length(p_checkout_token) < 16 then
    raise exception using errcode = '22023', message = 'Invalid checkout reservation.';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('analyse-checkout:' || p_user_id::text, 0)
  );

  select * into current_row
  from public.user_subscriptions
  where user_id = p_user_id
  for update;

  -- Un abonnement en cours bloque une seconde souscription ; un essai prolongé par l'administrateur
  -- (aucun abonnement Stripe) ne la bloque pas.
  if current_row.user_id is not null
    and current_row.plan_code = 'analyse'
    and not app_private.is_admin_trial_extension(
      current_row.metadata,
      current_row.stripe_subscription_id
    )
    and (
      current_row.status in ('past_due', 'paused')
      or (
        current_row.status in ('trialing', 'active')
        and (
          current_row.current_period_end is null
          or current_row.current_period_end > statement_timestamp()
        )
      )
    ) then
    return false;
  end if;

  if current_row.user_id is not null
    and (current_row.metadata->>'analyse_checkout_reservation_token') = p_checkout_token then
    return true;
  end if;

  if current_row.user_id is not null
    and current_row.metadata->>'analyse_checkout_reserved_at' is not null then
    begin
      reserved_at := (current_row.metadata->>'analyse_checkout_reserved_at')::timestamptz;
    exception when others then
      reserved_at := null;
    end;
    if reserved_at is not null and reserved_at > statement_timestamp() - interval '31 minutes' then
      return false;
    end if;
  end if;

  if current_row.user_id is null then
    insert into public.user_subscriptions (user_id, plan_code, status, metadata)
    values (
      p_user_id,
      'decouverte',
      'active',
      jsonb_build_object(
        'analyse_checkout_reservation_token', p_checkout_token,
        'analyse_checkout_reserved_at', statement_timestamp()
      )
    );
  else
    update public.user_subscriptions
    set metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
      'analyse_checkout_reservation_token', p_checkout_token,
      'analyse_checkout_reserved_at', statement_timestamp()
    )
    where user_id = p_user_id;
  end if;
  return true;
end;
$$;

revoke all on function public.reserve_analyse_checkout(uuid, text) from public, anon, authenticated;
grant execute on function public.reserve_analyse_checkout(uuid, text) to service_role;

commit;
