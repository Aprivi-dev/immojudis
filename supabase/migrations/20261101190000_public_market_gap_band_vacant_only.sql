begin;

set local lock_timeout = '5s';

-- Bande publique d'écart au marché : plus de bande pour un bien dont l'occupation n'est pas connue
-- comme « libre ». Remplace app_private.get_public_sale_market_gap_band (migration 20261029120000).
--
-- Constat (revue du 23/10/2026) : l'occupation est inconnue pour 56 % des ventes (59,6 % le 23/10). La
-- fiche les classait « sous » la fourchette alors que les ventes comparables sont des biens libres :
-- un bien occupé ou loué se vend nettement moins cher, et rien ne dit que celui-ci est libre. La
-- migration 20261029120000 ne neutralisait que « under » pour un bien dont l'occupation est connue et
-- occupée ; « near » et « above » passaient pour un bien occupé.
--
-- Nouvelle règle (la même partout : fiche, filtre « sous la fourchette », compteurs des comptes et des
-- alertes, voir src/lib/market-gap-band.ts) : une bande n'est dite que pour un bien libre.
--   * bien occupé, loué, occupé par son propriétaire ou squatté : 'occupied', quelle que soit la bande
--     (avant : seulement quand elle aurait été 'under') ;
--   * occupation inconnue, non renseignée ou illisible : 'occupancy_unknown' (nouveau mot), quelle que
--     soit la bande ;
--   * bien libre (vacant, libre, inoccupé) : 'under', 'near' ou 'above' comme avant.
-- La porte de qualité de l'estimation, les raisons d'insuffisance et le garde-fou d'écart (+70 / -50)
-- ne changent pas. Une bande absente (écart aberrant) reste absente. La fonction
-- app_private.list_public_sale_ids_under_market_range (20261030110000) appelle celle-ci et ne rend
-- donc plus que des biens libres, sans modification.
--
-- Effet attendu : moins de fiches avec une bande (environ 77 sur 1 521 le 23/10, dont une part avec
-- une occupation inconnue). C'est voulu : mieux vaut aucune bande qu'une bande sans réserve.

-- Libre : miroir de normalizeOccupationStatus (src/lib/tribunal-listing-statistics.ts) pour 'vacant'.
-- Vrai pour libre, vacant ou inoccupé ; faux pour occupé, loué, inconnu ou illisible.
create or replace function app_private.is_vacant_occupancy_status(p_value text)
returns boolean
language sql
immutable
parallel safe
set search_path = ''
as $function$
  select coalesce(x.v = 'vacant' or x.v ~ 'inoccup|libre', false)
  from (select lower(pg_catalog.btrim(p_value)) as v) x;
$function$;

revoke all on function app_private.is_vacant_occupancy_status(text)
  from public, anon, authenticated;
grant execute on function app_private.is_vacant_occupancy_status(text) to service_role;

create or replace function app_private.get_public_sale_market_gap_band(p_sale_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $function$
  with candidate as (
    select
      s.starting_price_eur::numeric as starting_price,
      s.occupancy_status,
      e.status,
      e.actionable,
      e.comparable_count,
      e.value_p10_eur,
      e.value_p50_eur,
      e.value_p90_eur,
      e.engine_kind,
      e.model_version_id,
      e.last_error_code,
      coalesce(e.segment, e.estimate ->> 'segment') as segment,
      case
        when jsonb_typeof(e.estimate -> 'effectiveSampleSize') = 'number'
          then (e.estimate ->> 'effectiveSampleSize')::numeric
      end as effective_sample_size,
      case
        when jsonb_typeof(e.estimate -> 'radiusM') = 'number'
          then (e.estimate ->> 'radiusM')::numeric
      end as radius_m,
      case
        when jsonb_typeof(e.estimate -> 'areaKind') = 'string'
          then e.estimate ->> 'areaKind'
      end as area_kind,
      case
        when jsonb_typeof(e.estimate -> 'predictionInterval' -> 'method') = 'string'
          then e.estimate -> 'predictionInterval' ->> 'method'
      end as interval_method
    from public.auction_sales s
    join public.auction_sale_market_estimates e on e.auction_sale_id = s.id
    where s.id = p_sale_id
      and s.sale_venue_type in ('tribunal', 'notary')
      and coalesce(s.starting_price_eur, 0) > 0
      and e.status in ('ready', 'insufficient_data')
      and app_private.auction_sale_is_publicly_visible(s.id)
  ),
  gate as (
    select
      c.*,
      coalesce(
        c.status = 'ready'
        and c.actionable
        and c.comparable_count >= case
          when c.interval_method = 'local_jackknife' then 6
          else 8
        end
        and coalesce(c.effective_sample_size, 0) >= 5
        and coalesce(c.value_p10_eur, 0) > 0
        and coalesce(c.value_p50_eur, 0) > 0
        and c.value_p10_eur <= c.value_p50_eur
        and c.value_p50_eur <= coalesce(c.value_p90_eur, 0)
        and (c.value_p90_eur - c.value_p10_eur) / nullif(c.value_p50_eur, 0) <= 0.60
        and c.radius_m is not null
        and c.radius_m <= app_private.public_market_gap_band_max_radius_m(c.segment, c.area_kind)
        and (
          coalesce(c.engine_kind, 'comparable_ensemble') <> 'hybrid_lightgbm'
          or exists (
            select 1
            from public.valuation_model_versions m
            where m.id = c.model_version_id
              and m.status = 'active'
          )
        ),
        false
      ) as reliable
    from candidate c
  )
  select case
    when not g.reliable then
      case
        when g.status = 'insufficient_data' and g.last_error_code = 'MISSING_SURFACE'
          then 'insufficient_surface'
        when g.status = 'insufficient_data' and g.last_error_code = 'UNSUPPORTED_SEGMENT'
          then 'insufficient_type'
        else 'insufficient'
      end
    else
      case
        when b.band is null then null
        when app_private.is_occupied_occupancy_status(g.occupancy_status) then 'occupied'
        when not app_private.is_vacant_occupancy_status(g.occupancy_status)
          then 'occupancy_unknown'
        else b.band
      end
  end
  from gate g
  cross join lateral (
    select app_private.public_market_gap_band(
      g.starting_price,
      g.value_p10_eur,
      g.value_p50_eur,
      g.value_p90_eur
    ) as band
  ) b;
$function$;

revoke all on function app_private.get_public_sale_market_gap_band(uuid)
  from public, anon, authenticated;
grant execute on function app_private.get_public_sale_market_gap_band(uuid)
  to anon, authenticated, service_role;

notify pgrst, 'reload schema';

commit;
