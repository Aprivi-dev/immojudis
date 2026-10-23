begin;

set local lock_timeout = '5s';

-- Indicateur « plafonds calculés » de la page admin « Pilotage » (chantier W7, point 63).
--
-- Pourquoi : l'indicateur « 3 déblocages » vaut 0 pendant l'offre de lancement (tous les comptes ont alors
-- l'accès Analyse, aucun déblocage n'est consommé : les événements sale_unlocked n'existent pas). Le
-- plafond d'enchère calculé (événement bid_ceiling_calculated, enregistré à chaque fois que la valeur de
-- référence est servie pour une vente) mesure l'usage réel de la fonction payante, offre ou non.
--
-- Contenu : sur 7 et 30 jours glissants (p_now - durée, p_now], le nombre de comptes ayant calculé au moins
-- un plafond, le nombre de ventes distinctes concernées et le nombre d'occurrences (un même compte compte
-- une fois par vente et par jour UTC : l'index unique de la table). Sources existantes seulement
-- (public.account_product_events, 90 jours de conservation) : aucune nouvelle donnée, aucune nouvelle
-- colonne, aucune liste de personnes ni de ventes dans la réponse.
--
-- Même contrat que public.admin_sale_signal_feedback_summary (20261030110300) : fonction séparée de
-- admin_pilotage_summary (qu'on ne redéfinit pas ici), service_role seul, SECURITY DEFINER à search_path
-- vide, nombres exacts (la page masque ceux de moins de 5), administrateurs exclus.
create or replace function public.admin_pilotage_bid_ceilings(
  p_now timestamptz default statement_timestamp()
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  with calculated as (
    select event_row.user_id, event_row.sale_id, event_row.occurred_at
    from public.account_product_events event_row
    where event_row.event_type = 'bid_ceiling_calculated'
      and event_row.occurred_at > p_now - interval '30 days'
      and event_row.occurred_at <= p_now
      and not exists (
        select 1
        from public.user_profiles profile
        where profile.user_id = event_row.user_id
          and profile.user_role = 'admin'
      )
  )
  select pg_catalog.jsonb_build_object(
    'generated_at', p_now,
    'windows', pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'days', 7,
        'accounts', (select pg_catalog.count(distinct c.user_id) from calculated c
                      where c.occurred_at > p_now - interval '7 days'),
        'sales', (select pg_catalog.count(distinct c.sale_id) from calculated c
                   where c.occurred_at > p_now - interval '7 days'),
        'occurrences', (select pg_catalog.count(*) from calculated c
                         where c.occurred_at > p_now - interval '7 days')
      ),
      pg_catalog.jsonb_build_object(
        'days', 30,
        'accounts', (select pg_catalog.count(distinct c.user_id) from calculated c),
        'sales', (select pg_catalog.count(distinct c.sale_id) from calculated c),
        'occurrences', (select pg_catalog.count(*) from calculated c)
      )
    )
  );
$function$;

revoke all on function public.admin_pilotage_bid_ceilings(timestamptz)
  from public, anon, authenticated;
grant execute on function public.admin_pilotage_bid_ceilings(timestamptz) to service_role;

comment on function public.admin_pilotage_bid_ceilings(timestamptz) is
  'Plafonds d''enchère calculés sur 7 et 30 jours (service_role seul) : comptes distincts, ventes distinctes, occurrences. Administrateurs exclus. Aucun nom, aucun identifiant de vente.';

notify pgrst, 'reload schema';

commit;
