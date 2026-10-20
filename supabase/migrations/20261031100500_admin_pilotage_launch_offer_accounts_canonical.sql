begin;

set local lock_timeout = '5s';

-- Chantier R1, point 7 (relecture de code du 20/10/2026) : « launch_offer_accounts » du pilotage.
--
-- Le chiffre « comptes qui n'ont l'accès Analyse que grâce à l'offre de lancement » (snapshot.
-- launch_offer_accounts de public.admin_pilotage_summary, 20261029120200) comptait les comptes dont
-- l'email est confirmé, sans la règle canonique des fonctions d'accès : il surestimait le nombre de
-- comptes réellement servis par l'offre (une seconde adresse « +tag » d'une même boîte, un domaine jetable
-- ou un compte plus récent d'une adresse déjà confirmée n'ont pas l'accès). Il utilise désormais
-- app_private.launch_offer_account_eligible(account.id) (20261029110000), la fonction que lisent
-- app_private.has_active_analysis_access et la politique d'accès Analyse, plus l'exclusion des droits
-- durables (administrateur, premium, abonnement Analyse en cours), comme avant.
--
-- Rien d'autre ne change : même signature, mêmes droits (service_role seul), mêmes clés ; la définition est
-- celle de 20261029120200, mot pour mot, sauf ce bloc. Aucune donnée n'est modifiée.

create or replace function public.admin_pilotage_summary(
  p_now timestamptz default statement_timestamp()
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_started_at timestamptz;
  v_days integer;
  v_start timestamptz;
  v_windows jsonb := '[]'::jsonb;
  v_previous jsonb;
  v_offer_active boolean;
  v_accounts_total bigint;
  v_accounts_confirmed bigint;
  v_offer_accounts bigint;
  v_consents bigint;
  v_dossiers_total bigint;
  v_dossier_accounts_total bigint;
begin
  select measure.started_at into v_started_at
  from app_private.account_product_events_measure measure
  where measure.singleton;

  foreach v_days in array array[7, 30] loop
    v_start := p_now - pg_catalog.make_interval(days => v_days);

    -- La semaine d'avant, disjointe de la semaine courante : (début - 7 jours, début].
    if v_days = 7 then
      v_previous := app_private.admin_pilotage_period(
        v_start - pg_catalog.make_interval(days => 7), v_start, v_started_at
      );
    else
      v_previous := null;
    end if;

    v_windows := v_windows || pg_catalog.jsonb_build_array(
      app_private.admin_pilotage_period(v_start, p_now, v_started_at)
        || pg_catalog.jsonb_build_object('days', v_days, 'previous', v_previous)
    );
  end loop;

  v_offer_active := app_private.launch_offer_active();

  select
    pg_catalog.count(*),
    pg_catalog.count(*) filter (where account.email_confirmed_at is not null)
  into v_accounts_total, v_accounts_confirmed
  from auth.users account
  where not exists (
    select 1 from public.user_profiles profile
    where profile.user_id = account.id and profile.user_role = 'admin'
  );

  -- Comptes qui n'ont l'accès Analyse que grâce à l'offre de lancement : la règle canonique
  -- app_private.launch_offer_account_eligible (profil, email confirmé, domaine non jetable, plus ancien
  -- compte confirmé de son adresse canonique : celle des fonctions d'accès), sans ceux qui ont déjà un
  -- droit durable (administrateur, premium, abonnement Analyse en cours).
  if v_offer_active then
    select pg_catalog.count(*) into v_offer_accounts
    from auth.users account
    join public.user_profiles profile on profile.user_id = account.id
    where app_private.launch_offer_account_eligible(account.id)
      and profile.user_role is distinct from 'admin'
      and profile.account_tier is distinct from 'premium'
      and not exists (
        select 1 from public.user_subscriptions subscription
        where subscription.user_id = account.id
          and subscription.plan_code = 'analyse'
          and app_private.subscription_grants_access(
            subscription.status,
            subscription.current_period_end
          )
      );
  else
    v_offer_accounts := 0;
  end if;

  select pg_catalog.count(*) into v_consents
  from public.user_notification_preferences preference
  where preference.sale_reminders_enabled
    and not exists (
      select 1 from public.user_profiles profile
      where profile.user_id = preference.user_id and profile.user_role = 'admin'
    );

  select pg_catalog.count(*), pg_catalog.count(distinct favorite.user_id)
  into v_dossiers_total, v_dossier_accounts_total
  from public.user_favorites favorite
  where (favorite.personal_status is not null or favorite.bid_ceiling_eur is not null)
    and not exists (
      select 1 from public.user_profiles profile
      where profile.user_id = favorite.user_id and profile.user_role = 'admin'
    );

  return pg_catalog.jsonb_build_object(
    'generated_at', p_now,
    'events_measured_since', v_started_at,
    'waitlist_active', (
      select pg_catalog.count(*)
      from public.offer_opening_notifications request
      where request.notify_enabled and request.notified_at is null
        and not exists (
          select 1 from public.user_profiles profile
          where profile.user_id = request.user_id and profile.user_role = 'admin'
        )
    ),
    'snapshot', pg_catalog.jsonb_build_object(
      'accounts_total', v_accounts_total,
      'accounts_confirmed', v_accounts_confirmed,
      'launch_offer_active', v_offer_active,
      'launch_offer_accounts', v_offer_accounts,
      'reminder_consents_active', v_consents,
      'dossiers_total', v_dossiers_total,
      'dossier_accounts_total', v_dossier_accounts_total
    ),
    'windows', v_windows
  );
end;
$$;

revoke all on function public.admin_pilotage_summary(timestamptz)
  from public, anon, authenticated;
grant execute on function public.admin_pilotage_summary(timestamptz) to service_role;

comment on function public.admin_pilotage_summary(timestamptz) is
  'Agrégats de la page admin Pilotage sur 7 et 30 jours (fenêtres (début, fin]), la semaine précédente, les comptes distincts et l''état à cet instant, hors administrateurs (service_role seul ; le serveur contrôle le rôle administrateur). Nombres seulement, aucune liste de personnes.';

notify pgrst, 'reload schema';

commit;
