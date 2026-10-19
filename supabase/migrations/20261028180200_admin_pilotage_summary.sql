-- Page admin « Pilotage » (point 65) : agrégats sur 7 et 30 jours glissants, exacts, sans liste de
-- personnes et sans extrapolation.
--
-- Lue par le serveur Next.js (service_role) après le contrôle du rôle administrateur et de la double
-- authentification (route /api/admin/pilotage). SECURITY DEFINER parce qu'elle lit auth.users et la
-- table des événements, fermée à tout autre rôle ; elle ne rend que des nombres.
--
-- Sources, toutes lues telles quelles :
--   * inscriptions       : comptes créés dans la fenêtre (auth.users.created_at), hors comptes supprimés
--                          depuis ;
--   * comptes actifs     : comptes dont la dernière connexion tombe dans la fenêtre
--                          (auth.users.last_sign_in_at) : une session restée ouverte sans nouvelle
--                          connexion n'est pas comptée ;
--   * alertes créées     : user_alerts.created_at, hors alertes supprimées depuis ;
--   * liste d'attente    : demandes « Me prévenir de l'ouverture » de la fenêtre
--                          (offer_opening_notifications.consented_at, retraits non encore purgés
--                          compris) et demandes actives à cet instant ;
--   * événements         : account_product_events (déblocages, quotas atteints, plafonds calculés,
--                          exports agenda, clics d'email), un par compte, détail, vente et jour.
-- Les événements n'existent que depuis le début de la mesure (app_private.account_product_events_measure) :
-- une fenêtre qui commence avant est rendue avec "events_complete": false. Sans ligne de début, les
-- événements valent null (« non mesuré »).
begin;

set local lock_timeout = '5s';

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
  v_events jsonb;
  v_signups bigint;
  v_active bigint;
  v_alerts bigint;
  v_waitlist bigint;
  v_unlocks bigint;
  v_quota_total bigint;
  v_quota_unlocks bigint;
  v_quota_favorites bigint;
  v_quota_daily bigint;
  v_ceilings bigint;
  v_exports bigint;
  v_clicks_total bigint;
  v_clicks_alert bigint;
  v_clicks_reminder bigint;
begin
  select measure.started_at into v_started_at
  from app_private.account_product_events_measure measure
  where measure.singleton;

  foreach v_days in array array[7, 30] loop
    v_start := p_now - pg_catalog.make_interval(days => v_days);

    select pg_catalog.count(*) into v_signups
    from auth.users account
    where account.created_at >= v_start and account.created_at <= p_now;

    select pg_catalog.count(*) into v_active
    from auth.users account
    where account.last_sign_in_at >= v_start and account.last_sign_in_at <= p_now;

    select pg_catalog.count(*) into v_alerts
    from public.user_alerts alert_row
    where alert_row.created_at >= v_start and alert_row.created_at <= p_now;

    select pg_catalog.count(*) into v_waitlist
    from public.offer_opening_notifications request
    where request.consented_at >= v_start and request.consented_at <= p_now;

    if v_started_at is null then
      v_events := null;
    else
      select
        pg_catalog.count(*) filter (where event_row.event_type = 'sale_unlocked'),
        pg_catalog.count(*) filter (where event_row.event_type = 'quota_reached'),
        pg_catalog.count(*) filter (
          where event_row.event_type = 'quota_reached' and event_row.detail = 'unlocks'
        ),
        pg_catalog.count(*) filter (
          where event_row.event_type = 'quota_reached' and event_row.detail = 'favorites'
        ),
        pg_catalog.count(*) filter (
          where event_row.event_type = 'quota_reached' and event_row.detail = 'daily'
        ),
        pg_catalog.count(*) filter (where event_row.event_type = 'bid_ceiling_calculated'),
        pg_catalog.count(*) filter (where event_row.event_type = 'calendar_exported'),
        pg_catalog.count(*) filter (where event_row.event_type = 'email_clicked'),
        pg_catalog.count(*) filter (
          where event_row.event_type = 'email_clicked' and event_row.detail = 'alert'
        ),
        pg_catalog.count(*) filter (
          where event_row.event_type = 'email_clicked' and event_row.detail = 'reminder'
        )
      into
        v_unlocks, v_quota_total, v_quota_unlocks, v_quota_favorites, v_quota_daily,
        v_ceilings, v_exports, v_clicks_total, v_clicks_alert, v_clicks_reminder
      from public.account_product_events event_row
      where event_row.occurred_at >= v_start and event_row.occurred_at <= p_now;

      v_events := pg_catalog.jsonb_build_object(
        'unlocks', v_unlocks,
        'quota_reached', pg_catalog.jsonb_build_object(
          'total', v_quota_total,
          'unlocks', v_quota_unlocks,
          'favorites', v_quota_favorites,
          'daily', v_quota_daily
        ),
        'bid_ceilings', v_ceilings,
        'calendar_exports', v_exports,
        'email_clicks', pg_catalog.jsonb_build_object(
          'total', v_clicks_total,
          'alert', v_clicks_alert,
          'reminder', v_clicks_reminder
        )
      );
    end if;

    v_windows := v_windows || pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'days', v_days,
        'since', v_start,
        'signups', v_signups,
        'active_accounts', v_active,
        'alerts_created', v_alerts,
        'waitlist_requests', v_waitlist,
        'events_complete', v_started_at is not null and v_started_at <= v_start,
        'events', v_events
      )
    );
  end loop;

  return pg_catalog.jsonb_build_object(
    'generated_at', p_now,
    'events_measured_since', v_started_at,
    'waitlist_active', (
      select pg_catalog.count(*)
      from public.offer_opening_notifications request
      where request.notify_enabled and request.notified_at is null
    ),
    'windows', v_windows
  );
end;
$$;

revoke all on function public.admin_pilotage_summary(timestamptz)
  from public, anon, authenticated;
grant execute on function public.admin_pilotage_summary(timestamptz) to service_role;

comment on function public.admin_pilotage_summary(timestamptz) is
  'Agrégats de la page admin Pilotage sur 7 et 30 jours glissants (service_role seul ; le serveur contrôle le rôle administrateur). Nombres seulement, aucune liste de personnes.';

notify pgrst, 'reload schema';

commit;
