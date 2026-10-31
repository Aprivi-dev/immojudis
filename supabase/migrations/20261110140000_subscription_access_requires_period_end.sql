-- Un statut d'accès sans fin de période n'ouvre plus l'accès Analyse (revue du 31/10/2026, n° 47).
--
-- Jusqu'ici app_private.subscription_grants_access (20261009181000) ouvrait l'accès à une ligne
-- « trialing » ou « active » dont current_period_end est NULL, pour toujours. Un abonnement Stripe
-- réel porte toujours la fin de sa période ; seuls un repli du webhook (retiré dans le même lot) et
-- une attribution manuelle sans date pouvaient produire une telle ligne. Règle désormais :
--   * trialing / active : accès seulement si current_period_end est connue et future ;
--   * past_due : inchangé (fin de période connue + 7 jours de grâce) ;
--   * tout autre statut : pas d'accès.
-- Miroir TypeScript : isPlanPeriodActive (src/lib/plans.ts).
--
-- reserve_analyse_checkout (corps de 20261108130000, seule la condition « fin NULL » change) : une
-- ligne « active » sans fin ne bloque plus une souscription, puisqu'elle n'ouvre plus d'accès.
--
-- GARDE : des lignes « analyse » trialing/active sans fin de période perdraient leur accès à
-- l'application de cette migration (attributions manuelles sans date, le champ étant facultatif jusqu'ici).
-- La migration s'arrête (raise exception, avec le nombre de lignes) tant qu'il en reste ; contrôle fait en
-- production le 31/10/2026 : 0 ligne. Pour les lister, en lecture seule :
--   select user_id, status, stripe_subscription_id, metadata -> 'manual_grant' ->> 'source' as source
--   from public.user_subscriptions
--   where plan_code = 'analyse' and status in ('trialing', 'active') and current_period_end is null;
-- Chaque ligne listée doit recevoir une date de fin (ou passer en compte premium) AVANT la migration.
-- RETOUR ARRIÈRE : rétablir le corps de 20261009181000 (« p_period_end is null or ... ») et celui de
-- reserve_analyse_checkout de 20261108130000.
begin;

set local lock_timeout = '5s';

do $guard$
declare
  open_ended_count bigint;
begin
  select count(*) into open_ended_count
  from public.user_subscriptions subscription
  where subscription.plan_code = 'analyse'
    and subscription.status in ('trialing', 'active')
    and subscription.current_period_end is null;
  if open_ended_count > 0 then
    raise exception using
      errcode = '23514',
      message = format(
        '%s abonnement(s) analyse trialing/active sans current_period_end perdraient leur accès : donner une date de fin avant cette migration.',
        open_ended_count
      );
  end if;
end;
$guard$;

create or replace function app_private.subscription_grants_access(
  p_status text,
  p_period_end timestamptz
)
returns boolean
language sql
stable
set search_path = ''
as $function$
  select case
    when p_status in ('trialing', 'active')
      then p_period_end is not null and p_period_end > statement_timestamp()
    when p_status = 'past_due'
      then p_period_end is not null
        and p_period_end + interval '7 days' > statement_timestamp()
    else false
  end;
$function$;

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
  -- (aucun abonnement Stripe) ne la bloque pas. Une ligne sans fin de période n'ouvre aucun accès
  -- (app_private.subscription_grants_access) et ne bloque donc plus.
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
        and current_row.current_period_end > statement_timestamp()
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
