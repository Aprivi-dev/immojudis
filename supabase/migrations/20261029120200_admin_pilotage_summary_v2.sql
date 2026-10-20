-- Page admin « Pilotage » : des chiffres qui permettent de lire une tendance sans se tromper.
--
-- Remplace public.admin_pilotage_summary (migration 20261028180200), même signature, même accès
-- (service_role seul, SECURITY DEFINER, aucun nom ni liste de personnes). Les clés d'avant restent, avec
-- les changements de définition suivants ; les ajouts sont de nouvelles clés.
--
-- Changements de définition (voulus, session du 20/10/2026, point 20) :
--   * les administrateurs (user_profiles.user_role = 'admin') ne sont comptés nulle part : ni comptes,
--     ni alertes, ni liste d'attente, ni événements. Un administrateur qui teste son propre site n'est
--     pas un utilisateur ;
--   * les fenêtres sont (début, fin] : un instant pile au bord de la fenêtre appartient à la précédente.
--     Elles ne se chevauchent donc jamais. Avant : [début, fin].
--
-- Ajouts, pour chaque fenêtre (7 et 30 jours) :
--   * signups_confirmed          : parmi les inscriptions, celles dont l'adresse email est confirmée
--                                  (signups garde tous les comptes créés) ;
--   * active_new / active_returning : parmi les comptes actifs (active_accounts, inchangé : dernière
--                                  connexion dans la fenêtre), ceux créés dans la fenêtre et ceux qui
--                                  existaient avant (« revenus ») ;
--   * dossiers, dossier_accounts : dossiers enregistrés dans la fenêtre (un statut personnel ou une
--                                  enchère plafond posés sur un favori, user_favorites) et comptes
--                                  distincts concernés ;
--   * reminders_sent, reminder_accounts : rappels d'audience et avertissements envoyés (journal
--                                  sale_reminder_dispatches, statut 'sent') et comptes distincts ;
--   * events.accounts            : pour chaque événement, le nombre de COMPTES DISTINCTS
--                                  (count(distinct user_id)), à côté des occurrences (un compte qui
--                                  atteint le plafond sur dix ventes pèse une fois ici, dix là) ;
--   * events.quota_reached.daily_account / daily_shared : le plafond quotidien d'un compte, et celui
--                                  d'une adresse ou du site entier (détails ajoutés par la migration
--                                  20261029120100). daily reste le total des trois détails (« daily »
--                                  d'avant, daily_account, daily_shared) ;
--   * until                      : fin de la fenêtre ;
--   * previous                   : pour la fenêtre de 7 jours seulement, les mêmes chiffres sur les 7 jours
--                                  d'avant (fenêtre disjointe), pour comparer la semaine à la précédente ;
--                                  null pour celle de 30 jours.
--
-- Ajout de haut niveau, « snapshot » (état à cet instant, sans fenêtre) :
--   * accounts_total, accounts_confirmed : comptes hors administrateurs, et parmi eux les confirmés ;
--   * launch_offer_active, launch_offer_accounts : l'interrupteur de l'offre de lancement, et le nombre de
--     comptes qui n'ont l'accès Analyse que grâce à elle (profil, email confirmé, ni administrateur, ni
--     premium, ni abonnement Analyse en cours : mêmes règles que les fonctions d'accès) ; 0 si coupée ;
--   * reminder_consents_active   : comptes qui ont consenti aux rappels d'audience, consentement actif ;
--   * dossiers_total, dossier_accounts_total : dossiers enregistrés en tout, et comptes concernés.
--
-- La valeur « moins de 5 » et la mention « sous environ 30 comptes » sont des règles d'affichage : la
-- fonction rend les nombres exacts, la page les masque (src/app/admin/pilotage).
begin;

set local lock_timeout = '5s';

-- Chiffres d'une fenêtre (p_from, p_to], hors administrateurs. Fonction privée, appelée par la fonction
-- publique ci-dessous ; jamais ouverte aux rôles du navigateur.
create or replace function app_private.admin_pilotage_period(
  p_from timestamptz,
  p_to timestamptz,
  p_events_started_at timestamptz
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_signups bigint;
  v_signups_confirmed bigint;
  v_active bigint;
  v_active_new bigint;
  v_alerts bigint;
  v_waitlist bigint;
  v_dossiers bigint;
  v_dossier_accounts bigint;
  v_reminders bigint;
  v_reminder_accounts bigint;
  v_events jsonb;
begin
  select
    pg_catalog.count(*) filter (
      where account.created_at > p_from and account.created_at <= p_to
    ),
    pg_catalog.count(*) filter (
      where account.created_at > p_from and account.created_at <= p_to
        and account.email_confirmed_at is not null
    ),
    pg_catalog.count(*) filter (
      where account.last_sign_in_at > p_from and account.last_sign_in_at <= p_to
    ),
    pg_catalog.count(*) filter (
      where account.last_sign_in_at > p_from and account.last_sign_in_at <= p_to
        and account.created_at > p_from and account.created_at <= p_to
    )
  into v_signups, v_signups_confirmed, v_active, v_active_new
  from auth.users account
  where not exists (
    select 1 from public.user_profiles profile
    where profile.user_id = account.id and profile.user_role = 'admin'
  );

  select pg_catalog.count(*) into v_alerts
  from public.user_alerts alert_row
  where alert_row.created_at > p_from and alert_row.created_at <= p_to
    and not exists (
      select 1 from public.user_profiles profile
      where profile.user_id = alert_row.user_id and profile.user_role = 'admin'
    );

  select pg_catalog.count(*) into v_waitlist
  from public.offer_opening_notifications request
  where request.consented_at > p_from and request.consented_at <= p_to
    and not exists (
      select 1 from public.user_profiles profile
      where profile.user_id = request.user_id and profile.user_role = 'admin'
    );

  -- Un dossier est un favori sur lequel le compte a posé un statut personnel ou une enchère plafond ;
  -- il compte dans la fenêtre où il a été posé.
  select pg_catalog.count(*), pg_catalog.count(distinct favorite.user_id)
  into v_dossiers, v_dossier_accounts
  from public.user_favorites favorite
  where (
      (favorite.personal_status is not null
        and favorite.personal_status_updated_at > p_from
        and favorite.personal_status_updated_at <= p_to)
      or (favorite.bid_ceiling_eur is not null
        and favorite.bid_ceiling_saved_at > p_from
        and favorite.bid_ceiling_saved_at <= p_to)
    )
    and not exists (
      select 1 from public.user_profiles profile
      where profile.user_id = favorite.user_id and profile.user_role = 'admin'
    );

  select pg_catalog.count(*), pg_catalog.count(distinct dispatch.user_id)
  into v_reminders, v_reminder_accounts
  from public.sale_reminder_dispatches dispatch
  where dispatch.status = 'sent'
    and dispatch.sent_at > p_from and dispatch.sent_at <= p_to
    and not exists (
      select 1 from public.user_profiles profile
      where profile.user_id = dispatch.user_id and profile.user_role = 'admin'
    );

  if p_events_started_at is null then
    v_events := null;
  else
    select pg_catalog.jsonb_build_object(
      'unlocks', pg_catalog.count(*) filter (where event_row.event_type = 'sale_unlocked'),
      'quota_reached', pg_catalog.jsonb_build_object(
        'total', pg_catalog.count(*) filter (where event_row.event_type = 'quota_reached'),
        'unlocks', pg_catalog.count(*) filter (
          where event_row.event_type = 'quota_reached' and event_row.detail = 'unlocks'
        ),
        'favorites', pg_catalog.count(*) filter (
          where event_row.event_type = 'quota_reached' and event_row.detail = 'favorites'
        ),
        'daily', pg_catalog.count(*) filter (
          where event_row.event_type = 'quota_reached'
            and event_row.detail in ('daily', 'daily_account', 'daily_shared')
        ),
        'daily_account', pg_catalog.count(*) filter (
          where event_row.event_type = 'quota_reached' and event_row.detail = 'daily_account'
        ),
        'daily_shared', pg_catalog.count(*) filter (
          where event_row.event_type = 'quota_reached' and event_row.detail = 'daily_shared'
        )
      ),
      'bid_ceilings', pg_catalog.count(*) filter (
        where event_row.event_type = 'bid_ceiling_calculated'
      ),
      'calendar_exports', pg_catalog.count(*) filter (
        where event_row.event_type = 'calendar_exported'
      ),
      'email_clicks', pg_catalog.jsonb_build_object(
        'total', pg_catalog.count(*) filter (where event_row.event_type = 'email_clicked'),
        'alert', pg_catalog.count(*) filter (
          where event_row.event_type = 'email_clicked' and event_row.detail = 'alert'
        ),
        'reminder', pg_catalog.count(*) filter (
          where event_row.event_type = 'email_clicked' and event_row.detail = 'reminder'
        )
      ),
      -- Comptes distincts : un compte compte une fois par événement, quel que soit le nombre de ventes.
      'accounts', pg_catalog.jsonb_build_object(
        'unlocks', pg_catalog.count(distinct event_row.user_id) filter (
          where event_row.event_type = 'sale_unlocked'
        ),
        'quota_reached', pg_catalog.jsonb_build_object(
          'total', pg_catalog.count(distinct event_row.user_id) filter (
            where event_row.event_type = 'quota_reached'
          ),
          'unlocks', pg_catalog.count(distinct event_row.user_id) filter (
            where event_row.event_type = 'quota_reached' and event_row.detail = 'unlocks'
          ),
          'favorites', pg_catalog.count(distinct event_row.user_id) filter (
            where event_row.event_type = 'quota_reached' and event_row.detail = 'favorites'
          ),
          'daily', pg_catalog.count(distinct event_row.user_id) filter (
            where event_row.event_type = 'quota_reached'
              and event_row.detail in ('daily', 'daily_account', 'daily_shared')
          ),
          'daily_account', pg_catalog.count(distinct event_row.user_id) filter (
            where event_row.event_type = 'quota_reached' and event_row.detail = 'daily_account'
          ),
          'daily_shared', pg_catalog.count(distinct event_row.user_id) filter (
            where event_row.event_type = 'quota_reached' and event_row.detail = 'daily_shared'
          )
        ),
        'bid_ceilings', pg_catalog.count(distinct event_row.user_id) filter (
          where event_row.event_type = 'bid_ceiling_calculated'
        ),
        'calendar_exports', pg_catalog.count(distinct event_row.user_id) filter (
          where event_row.event_type = 'calendar_exported'
        ),
        'email_clicks', pg_catalog.jsonb_build_object(
          'total', pg_catalog.count(distinct event_row.user_id) filter (
            where event_row.event_type = 'email_clicked'
          ),
          'alert', pg_catalog.count(distinct event_row.user_id) filter (
            where event_row.event_type = 'email_clicked' and event_row.detail = 'alert'
          ),
          'reminder', pg_catalog.count(distinct event_row.user_id) filter (
            where event_row.event_type = 'email_clicked' and event_row.detail = 'reminder'
          )
        )
      )
    )
    into v_events
    from public.account_product_events event_row
    where event_row.occurred_at > p_from and event_row.occurred_at <= p_to
      and not exists (
        select 1 from public.user_profiles profile
        where profile.user_id = event_row.user_id and profile.user_role = 'admin'
      );
  end if;

  return pg_catalog.jsonb_build_object(
    'since', p_from,
    'until', p_to,
    'signups', v_signups,
    'signups_confirmed', v_signups_confirmed,
    'active_accounts', v_active,
    'active_new', v_active_new,
    'active_returning', v_active - v_active_new,
    'alerts_created', v_alerts,
    'waitlist_requests', v_waitlist,
    'dossiers', v_dossiers,
    'dossier_accounts', v_dossier_accounts,
    'reminders_sent', v_reminders,
    'reminder_accounts', v_reminder_accounts,
    'events_complete', p_events_started_at is not null and p_events_started_at <= p_from,
    'events', v_events
  );
end;
$$;

revoke all on function app_private.admin_pilotage_period(timestamptz, timestamptz, timestamptz)
  from public, anon, authenticated;
grant execute on function app_private.admin_pilotage_period(timestamptz, timestamptz, timestamptz)
  to service_role;

comment on function app_private.admin_pilotage_period(timestamptz, timestamptz, timestamptz) is
  'Chiffres de la page Pilotage sur la fenêtre (p_from, p_to], hors administrateurs. Appelée par admin_pilotage_summary ; jamais ouverte aux rôles du navigateur.';

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

  -- Comptes qui n'ont l'accès Analyse que grâce à l'offre de lancement : mêmes règles que
  -- app_private.has_active_analysis_access (profil, email confirmé), sans ceux qui l'ont déjà.
  if v_offer_active then
    select pg_catalog.count(*) into v_offer_accounts
    from auth.users account
    join public.user_profiles profile on profile.user_id = account.id
    where account.email_confirmed_at is not null
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
