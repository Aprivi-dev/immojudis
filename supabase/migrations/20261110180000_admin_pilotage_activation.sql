begin;

set local lock_timeout = '5s';

-- Lot 6, n° 86 et 97 : deux indicateurs de lecture pour la page admin « Pilotage ». Aucune nouvelle
-- donnée, aucune nouvelle colonne, aucune écriture : des requêtes sur les tables existantes.
--
-- 1. public.admin_pilotage_activation(p_now) : l'ACTIVATION, définie sans dépendre du quota de
--    déblocages. Pendant l'essai, aucun déblocage n'est consommé (« premier déblocage » vaut 0) : un
--    compte est donc dit activé quand, depuis sa création, il a fait au moins l'un des trois gestes
--    suivants :
--      * ouvert une fiche en détail : un événement sale_unlocked, bid_ceiling_calculated (l'estimation
--        servie à l'ouverture d'une fiche, essai compris) ou pepite_detail_served ;
--      * posé un premier favori (public.user_favorites) ;
--      * créé une première alerte (public.user_alerts).
--    Sur 7 et 30 jours glissants (p_now - durée, p_now], parmi les comptes créés dans la fenêtre :
--    inscrits, adresse confirmée, activés (et le détail par geste, un compte pouvant en cumuler
--    plusieurs). Les événements par compte sont conservés 90 jours : suffisant pour des comptes de
--    30 jours.
--
-- 2. public.admin_pilotage_unlock_threshold(p_now) : la part des comptes Découverte qui atteignent les
--    3 déblocages du mois (n° 97, « mesurer avant de toucher au prix »). Pour le mois de Paris en cours
--    (depuis le 1er) et le mois précédent : les comptes Découverte (adresse confirmée, ni administrateur
--    ni accès Analyse, essai compris : app_private.has_active_analysis_access), ceux qui ont débloqué au
--    moins une vente dans le mois, et ceux qui en ont débloqué au moins 3 (ventes distinctes, événement
--    sale_unlocked). Le dénominateur est l'état à p_now, pour les deux mois.
--
-- Même contrat que public.admin_pilotage_bid_ceilings (20261101160000) : service_role seul, SECURITY
-- DEFINER à search_path vide, nombres exacts (la page masque ceux de moins de 5), administrateurs exclus,
-- aucune liste de personnes ni de ventes dans la réponse.

create or replace function public.admin_pilotage_activation(
  p_now timestamptz default statement_timestamp()
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  with accounts as (
    select
      account.id as user_id,
      account.created_at,
      account.email_confirmed_at is not null as confirmed
    from auth.users account
    where account.created_at > p_now - interval '30 days'
      and account.created_at <= p_now
      and not exists (
        select 1
        from public.user_profiles profile
        where profile.user_id = account.id
          and profile.user_role = 'admin'
      )
  ),
  gestures as (
    select
      a.user_id,
      a.created_at,
      a.confirmed,
      exists (
        select 1
        from public.account_product_events event_row
        where event_row.user_id = a.user_id
          and event_row.event_type in ('sale_unlocked', 'bid_ceiling_calculated', 'pepite_detail_served')
          and event_row.occurred_at >= a.created_at
          and event_row.occurred_at <= p_now
      ) as opened_detail,
      exists (
        select 1
        from public.user_favorites favorite
        where favorite.user_id = a.user_id
          and favorite.created_at >= a.created_at
          and favorite.created_at <= p_now
      ) as added_favorite,
      exists (
        select 1
        from public.user_alerts alert_row
        where alert_row.user_id = a.user_id
          and alert_row.created_at >= a.created_at
          and alert_row.created_at <= p_now
      ) as created_alert
    from accounts a
  ),
  scored as (
    select g.*, (g.opened_detail or g.added_favorite or g.created_alert) as activated
    from gestures g
  )
  select pg_catalog.jsonb_build_object(
    'generated_at', p_now,
    'windows', pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'days', 7,
        'signups', (select pg_catalog.count(*) from scored s
                     where s.created_at > p_now - interval '7 days'),
        'confirmed', (select pg_catalog.count(*) from scored s
                       where s.created_at > p_now - interval '7 days' and s.confirmed),
        'activated', (select pg_catalog.count(*) from scored s
                       where s.created_at > p_now - interval '7 days' and s.activated),
        'opened_detail', (select pg_catalog.count(*) from scored s
                           where s.created_at > p_now - interval '7 days' and s.opened_detail),
        'added_favorite', (select pg_catalog.count(*) from scored s
                            where s.created_at > p_now - interval '7 days' and s.added_favorite),
        'created_alert', (select pg_catalog.count(*) from scored s
                           where s.created_at > p_now - interval '7 days' and s.created_alert)
      ),
      pg_catalog.jsonb_build_object(
        'days', 30,
        'signups', (select pg_catalog.count(*) from scored s),
        'confirmed', (select pg_catalog.count(*) from scored s where s.confirmed),
        'activated', (select pg_catalog.count(*) from scored s where s.activated),
        'opened_detail', (select pg_catalog.count(*) from scored s where s.opened_detail),
        'added_favorite', (select pg_catalog.count(*) from scored s where s.added_favorite),
        'created_alert', (select pg_catalog.count(*) from scored s where s.created_alert)
      )
    )
  );
$function$;

revoke all on function public.admin_pilotage_activation(timestamptz)
  from public, anon, authenticated;
grant execute on function public.admin_pilotage_activation(timestamptz) to service_role;

comment on function public.admin_pilotage_activation(timestamptz) is
  'Activation sur 7 et 30 jours (service_role seul) : parmi les comptes créés dans la fenêtre, ceux qui ont ouvert une fiche en détail, posé un favori ou créé une alerte, indépendamment du quota de déblocages. Administrateurs exclus. Aucun nom, aucun identifiant.';

create or replace function public.admin_pilotage_unlock_threshold(
  p_now timestamptz default statement_timestamp()
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  with bounds as (
    select
      (pg_catalog.date_trunc('month', p_now at time zone 'Europe/Paris')
        at time zone 'Europe/Paris') as current_start,
      ((pg_catalog.date_trunc('month', p_now at time zone 'Europe/Paris')
        - interval '1 month') at time zone 'Europe/Paris') as previous_start
  ),
  discovery as (
    select account.id as user_id
    from auth.users account
    where account.email_confirmed_at is not null
      and not exists (
        select 1
        from public.user_profiles profile
        where profile.user_id = account.id
          and profile.user_role = 'admin'
      )
      and not app_private.has_active_analysis_access(account.id)
  ),
  unlocks as (
    select
      event_row.user_id,
      case
        when event_row.occurred_at >= (select current_start from bounds) then 'current'
        else 'previous'
      end as month_label,
      pg_catalog.count(distinct event_row.sale_id) as sales
    from public.account_product_events event_row
    where event_row.event_type = 'sale_unlocked'
      and event_row.occurred_at >= (select previous_start from bounds)
      and event_row.occurred_at <= p_now
      and event_row.user_id in (select user_id from discovery)
    group by 1, 2
  )
  select pg_catalog.jsonb_build_object(
    'generated_at', p_now,
    'discovery_accounts', (select pg_catalog.count(*) from discovery),
    'months', pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'month_start', (select current_start from bounds),
        'partial', true,
        'unlocked_one', (select pg_catalog.count(*) from unlocks u
                          where u.month_label = 'current' and u.sales >= 1),
        'reached_three', (select pg_catalog.count(*) from unlocks u
                           where u.month_label = 'current' and u.sales >= 3)
      ),
      pg_catalog.jsonb_build_object(
        'month_start', (select previous_start from bounds),
        'partial', false,
        'unlocked_one', (select pg_catalog.count(*) from unlocks u
                          where u.month_label = 'previous' and u.sales >= 1),
        'reached_three', (select pg_catalog.count(*) from unlocks u
                           where u.month_label = 'previous' and u.sales >= 3)
      )
    )
  );
$function$;

revoke all on function public.admin_pilotage_unlock_threshold(timestamptz)
  from public, anon, authenticated;
grant execute on function public.admin_pilotage_unlock_threshold(timestamptz) to service_role;

comment on function public.admin_pilotage_unlock_threshold(timestamptz) is
  'Part des comptes Découverte qui atteignent les 3 déblocages du mois de Paris (service_role seul) : comptes Découverte à cet instant, comptes ayant débloqué au moins une vente, comptes en ayant débloqué au moins 3, pour le mois en cours et le mois précédent. Administrateurs exclus. Aucun nom, aucun identifiant.';

notify pgrst, 'reload schema';

commit;
