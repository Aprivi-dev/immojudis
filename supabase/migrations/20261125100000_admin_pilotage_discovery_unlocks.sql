-- Page admin « Pilotage » : la carte « Comptes Découverte à 3 déblocages » est remplacée par « Comptes
-- Découverte : déblocage gratuit et achats à l'unité » (changement validé par le propriétaire le 16/11/2026).
--
-- Depuis 20261120100000, un compte Découverte débloque UNE vente en tout ; depuis 20261122100000, il peut en
-- acheter d'autres à l'unité. « Au moins 3 ventes débloquées dans le mois » ne peut plus être atteint
-- gratuitement : public.admin_pilotage_unlock_threshold (20261110180000) n'a plus de sens et est supprimée.
--
-- public.admin_pilotage_discovery_unlocks(p_now) : pour le mois de Paris en cours (depuis le 1er, jusqu'à
-- p_now) et le mois précédent, parmi les comptes Découverte (même définition que la fonction supprimée :
-- adresse confirmée, ni administrateur ni accès Analyse, app_private.has_active_analysis_access, lu à
-- l'instant du calcul ; le dénominateur est le même pour les deux mois) :
--   * unlocked_free : comptes dont le déblocage gratuit a été pris dans le mois ;
--   * purchased_one : comptes ayant au moins un achat à l'unité payé dans le mois ;
--   * purchases     : nombre de ces achats.
-- Plus discovery_accounts (comptes Découverte à l'instant du calcul) et generated_at.
--
-- Même contrat que la fonction remplacée : service_role seul, SECURITY DEFINER à search_path vide, nombres
-- exacts (la page masque ceux de moins de 5), administrateurs exclus, aucun identifiant dans la réponse.
--
-- Déploiement : le site est déployé avant cette migration. Pendant l'intervalle, l'appel à la nouvelle
-- fonction échoue, la route de pilotage répond « non mesuré » pour l'activation et cette carte
-- (src/app/api/admin/pilotage/route.ts), sans faire tomber la page.
--
-- Aucune écriture de données. Verrous : création et suppression d'une fonction.
begin;

set local lock_timeout = '5s';

create or replace function public.admin_pilotage_discovery_unlocks(
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
  -- Déblocage gratuit : les lignes de public.user_sale_unlocks de source 'free', datées par unlocked_at.
  -- C'est la seule donnée qui distingue le déblocage gratuit : l'événement sale_unlocked
  -- (account_product_events) est aussi écrit quand un crédit débloque une vente, sans dire sa source.
  -- Une ligne supprimée n'est plus comptée : déblocage rendu par l'opérateur
  -- (app_private.release_sale_unlock) ou vente retirée puis supprimée
  -- (app_private.release_unlocks_of_withdrawn_sale). Dans ces deux cas le déblocage est rendu au compte,
  -- qui peut en reprendre un : ce nouveau déblocage est compté dans son mois. Avant 20261120100000, la purge
  -- supprimait aussi à la fin du mois les lignes détachées d'une vente purgée.
  free_unlocks as (
    select distinct
      unlock_row.user_id,
      case
        when unlock_row.unlocked_at >= (select current_start from bounds) then 'current'
        else 'previous'
      end as month_label
    from public.user_sale_unlocks unlock_row
    where unlock_row.source = 'free'
      and unlock_row.unlocked_at >= (select previous_start from bounds)
      and unlock_row.unlocked_at <= p_now
      and unlock_row.user_id in (select user_id from discovery)
  ),
  -- Achats à l'unité payés : paid_at dans le mois et état 'paid' à l'instant du calcul. Un achat en attente
  -- ou expiré n'a pas de paid_at ; un achat remboursé ('refunded'), contesté ('disputed') ou au litige perdu
  -- ('dispute_lost') n'est pas compté (un litige gagné le remet à 'paid'). Un achat payé devenu crédit, ou
  -- déduit d'un abonnement, reste un achat payé et est compté.
  purchases as (
    select
      purchase.user_id,
      case
        when purchase.paid_at >= (select current_start from bounds) then 'current'
        else 'previous'
      end as month_label
    from public.sale_unlock_purchases purchase
    where purchase.state = 'paid'
      and purchase.paid_at >= (select previous_start from bounds)
      and purchase.paid_at <= p_now
      and purchase.user_id in (select user_id from discovery)
  )
  select pg_catalog.jsonb_build_object(
    'generated_at', p_now,
    'discovery_accounts', (select pg_catalog.count(*) from discovery),
    'months', pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'month_start', (select current_start from bounds),
        'partial', true,
        'unlocked_free', (select pg_catalog.count(*) from free_unlocks f
                           where f.month_label = 'current'),
        'purchased_one', (select pg_catalog.count(distinct p.user_id) from purchases p
                           where p.month_label = 'current'),
        'purchases', (select pg_catalog.count(*) from purchases p
                       where p.month_label = 'current')
      ),
      pg_catalog.jsonb_build_object(
        'month_start', (select previous_start from bounds),
        'partial', false,
        'unlocked_free', (select pg_catalog.count(*) from free_unlocks f
                           where f.month_label = 'previous'),
        'purchased_one', (select pg_catalog.count(distinct p.user_id) from purchases p
                           where p.month_label = 'previous'),
        'purchases', (select pg_catalog.count(*) from purchases p
                       where p.month_label = 'previous')
      )
    )
  );
$function$;

revoke all on function public.admin_pilotage_discovery_unlocks(timestamptz)
  from public, anon, authenticated;
grant execute on function public.admin_pilotage_discovery_unlocks(timestamptz) to service_role;

comment on function public.admin_pilotage_discovery_unlocks(timestamptz) is
  'Comptes Découverte (service_role seul), pour le mois de Paris en cours et le précédent : comptes ayant pris leur déblocage gratuit dans le mois, comptes ayant payé au moins un achat à l''unité dans le mois, nombre de ces achats (état paid), et comptes Découverte à cet instant. Administrateurs et comptes Analyse exclus. Aucun nom, aucun identifiant.';

drop function if exists public.admin_pilotage_unlock_threshold(timestamptz);

notify pgrst, 'reload schema';

commit;
