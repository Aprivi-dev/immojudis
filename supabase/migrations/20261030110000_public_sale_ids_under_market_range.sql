begin;

set local lock_timeout = '5s';

-- Filtre de /sales « Mise à prix sous la fourchette des ventes comparables » (point 71 de la session du
-- 20/10/2026, seconde vague).
--
-- Le catalogue est filtré par des vues (PostgREST), qui ne portent pas la bande d'écart au marché : elle
-- se calcule vente par vente (app_private.get_public_sale_market_gap_band, 20261029120000). Plutôt que de
-- modifier les vues du catalogue, cette fonction rend les identifiants des ventes dont la bande publique
-- est 'under' ; la recherche (src/lib/search/search-service.ts) les croise avec les lignes qu'elle lit déjà
-- pour ses autres filtres avancés.
--
-- Même porte que la fiche publique, par construction, puisqu'on appelle la même fonction :
--   * estimation fiable seulement (au moins 6 ventes comparables avec le jackknife local, 8 sinon,
--     échantillon effectif d'au moins 5, largeur d'au plus 60 %, rayon borné) ; une vente dont l'estimation
--     ne passe pas la porte n'est jamais rendue, ce que le texte du filtre dit ;
--   * jamais un bien occupé, loué ou occupé par son propriétaire : pour eux la fonction rend 'occupied', pas
--     'under' ;
--   * ventes du catalogue public seulement (auction_sale_is_publicly_visible, testée par la fonction).
--
-- Ce que la fonction ne dit pas : aucun chiffre (ni prix, ni fourchette, ni écart), seulement des
-- identifiants de ventes déjà publiques, dont la bande l'est aussi, une à une, pour tout visiteur.
--
-- Coût : un appel par recherche filtrée, qui parcourt les ventes à estimation « ready » (environ 1 500 en
-- production le 20/10/2026). Non mesuré sur la base réelle ; le client garde la réponse 5 minutes. Garde-fou
-- de 5 000 identifiants.

create or replace function app_private.list_public_sale_ids_under_market_range()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $function$
  select s.id
  from public.auction_sales s
  where s.sale_venue_type in ('tribunal', 'notary')
    and coalesce(s.starting_price_eur, 0) > 0
    and exists (
      select 1
      from public.auction_sale_market_estimates e
      where e.auction_sale_id = s.id
        and e.status = 'ready'
    )
    and app_private.get_public_sale_market_gap_band(s.id) = 'under'
  order by s.id
  limit 5000;
$function$;

revoke all on function app_private.list_public_sale_ids_under_market_range()
  from public, anon, authenticated;
grant execute on function app_private.list_public_sale_ids_under_market_range()
  to anon, authenticated, service_role;

create or replace function public.list_public_sale_ids_under_market_range()
returns setof uuid
language sql
stable
set search_path = ''
as $function$
  select app_private.list_public_sale_ids_under_market_range();
$function$;

revoke all on function public.list_public_sale_ids_under_market_range() from public;
grant execute on function public.list_public_sale_ids_under_market_range()
  to anon, authenticated, service_role;

comment on function public.list_public_sale_ids_under_market_range() is
  'Identifiants des ventes publiques dont la bande d''écart au marché est « under » (mise à prix sous la fourchette des ventes comparables), hors biens occupés et hors estimation insuffisante. Aucun chiffre.';

notify pgrst, 'reload schema';

commit;
