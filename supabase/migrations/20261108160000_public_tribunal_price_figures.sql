begin;

set local lock_timeout = '5s';

-- Chiffres de mise à prix d'un tribunal, avec les seuils de publication des autres statistiques de
-- tribunal (src/lib/tribunal-publication-thresholds.ts) :
--   * moins de 5 ventes chiffrées : aucun chiffre (la page dit « — » et « n ventes ») ;
--   * de 5 à 9 : la fourchette observée, minimum et maximum, jamais un point ;
--   * à partir de 10 : la médiane.
-- get_public_tribunal_activity() renvoyait la médiane de n'importe quel effectif (une vente suffisait)
-- et ne disait pas combien de ventes la fondaient. Elle n'est pas modifiée (sa définition en
-- production a été réécrite par 20261027100200) : cette fonction à part rend le « n » des ventes à
-- prix connu, les bornes de la fourchette et la médiane, par tribunal, pour les mêmes ventes (tribunal,
-- à venir, visibles au catalogue, hors quarantaine). L'application les lit toutes les deux et reprend
-- les seuils elle-même pour l'affichage ; les nombres 5 et 10 sont recopiés ici et dans le module
-- TypeScript : les changer demande de changer les deux.
--
-- Aucun résultat d'adjudication : seulement les mises à prix déjà publiées au catalogue.

create or replace function app_private.get_public_tribunal_price_figures()
returns table (
  tribunal_code text,
  priced_count integer,
  min_starting_price_eur numeric,
  max_starting_price_eur numeric,
  median_starting_price_eur numeric
)
language sql
stable
security definer
set search_path = ''
as $function$
  select
    s.tribunal_code,
    count(*)::integer,
    case when count(*) >= 5 and count(*) < 10 then min(s.starting_price_eur)::numeric end,
    case when count(*) >= 5 and count(*) < 10 then max(s.starting_price_eur)::numeric end,
    case
      when count(*) >= 10
        then (percentile_cont(0.5) within group (order by s.starting_price_eur))::numeric
    end
  from public.auction_sales s
  join public.tribunals t on t.code = s.tribunal_code
  where s.sale_venue_type = 'tribunal'
    and coalesce(s.status, 'unknown') in ('upcoming', 'unknown', 'postponed')
    and app_private.sale_catalogue_projection_is_live(
      s.catalogue_expiry_materialized,
      s.catalogue_expiry_deadline,
      s.sale_date,
      s.catalogue_expiry_fallback,
      s.catalogue_state_observed_at,
      s.catalogue_state_end_estimate
    )
    and not s.catalogue_quarantined
    and s.starting_price_eur > 0
  group by s.tribunal_code;
$function$;

revoke all on function app_private.get_public_tribunal_price_figures()
  from public, anon, authenticated;
grant execute on function app_private.get_public_tribunal_price_figures()
  to anon, authenticated, service_role;

create or replace function public.get_public_tribunal_price_figures()
returns table (
  tribunal_code text,
  priced_count integer,
  min_starting_price_eur numeric,
  max_starting_price_eur numeric,
  median_starting_price_eur numeric
)
language sql
stable
set search_path = ''
as $function$
  select * from app_private.get_public_tribunal_price_figures();
$function$;

revoke all on function public.get_public_tribunal_price_figures() from public;
grant execute on function public.get_public_tribunal_price_figures()
  to anon, authenticated, service_role;

notify pgrst, 'reload schema';

commit;
