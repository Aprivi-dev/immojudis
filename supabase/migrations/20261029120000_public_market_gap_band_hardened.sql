begin;

set local lock_timeout = '5s';

-- Bande publique d'écart au marché : porte durcie, raisons d'insuffisance séparées, bien occupé.
-- Remplace app_private.get_public_sale_market_gap_band (migration 20261028200000) ; la règle des trois
-- bandes (app_private.public_market_gap_band, garde-fous +70 / -50) ne change pas.
--
-- Mesure en production le 20/10/2026 sur 1 547 ventes : 65 % « insufficient », 16 % sans bande, 13 %
-- « under » (mise à prix médiane à 45 % du P50 côté tribunal), 6,5 % « near », 0,3 % « above ». 26 % des
-- bandes exploitables reposaient sur 4 ou 5 comparables, 8 % sur un rayon de plus d'un kilomètre ; 86 %
-- des biens occupés étaient en « under », contre 44 % des biens libres.
--
-- Porte publique (seuils recopiés dans src/lib/market-gap-band.ts, que market-gap-band.test.ts compare
-- à ce fichier) :
--   * au moins 6 ventes comparables quand l'intervalle vient de la méthode jackknife locale
--     (predictionInterval.method = 'local_jackknife', qui exige au moins 6 résidus dans
--     conformalPredictionInterval de src/lib/market-estimation-engine.ts), au moins 8 sinon
--     (marge fixe du type de bien, ou intervalle du modèle LightGBM) ;
--   * échantillon effectif d'au moins 5 (le moteur se contente de 3) ;
--   * largeur (P90 - P10) / P50 d'au plus 60 % (110 % avant : la borne de promotion d'un modèle) ;
--   * rayon de recherche (estimate->>'radiusM') d'au plus 1 000 m pour un appartement urbain, 2 000 m
--     pour tout autre bien. Les rayons du moteur (radiiFor, src/lib/market.server.ts) vont jusqu'à
--     2 000 m (appartement urbain), 3 000 m (maison urbaine) ou 5 000 m et plus : on exclut le plus
--     large, et assessEngineQuality retire déjà 8 points au-delà de 1 000 m. Un rayon absent de
--     l'estimation, ou un type de bien absent, ne passe pas : on prend alors le seuil le plus strict.
--   Les autres conditions de la porte (estimation « actionable », intervalle cohérent, modèle actif,
--   statut 'ready') sont inchangées.
--
-- Sortie (text) : 'under', 'near', 'above' comme avant, plus
--   'occupied'              la bande aurait été 'under' mais le bien est occupé, loué ou occupé par son
--                           propriétaire (occupancy_status, comme normalizeOccupationStatus de
--                           src/lib/tribunal-listing-statistics.ts) : comparer à des ventes de biens
--                           libres n'est pas pertinent, la fiche le dit au lieu de « sous » ;
--   'insufficient_surface'  l'estimation a échoué faute de surface (last_error_code MISSING_SURFACE) ;
--   'insufficient_type'     type de bien non pris en charge (UNSUPPORTED_SEGMENT) ;
--   'insufficient'          tout le reste : pas assez de ventes comparables fiables (la porte ci-dessus
--                           ou NO_COMPARABLES), ou position introuvable ;
--   null                    rien à dire (inchangé).

-- Occupation : miroir exact de normalizeOccupationStatus (TypeScript), vrai pour occupé, loué, occupé
-- par le propriétaire ou squatté ; faux pour libre et pour inconnu.
create or replace function app_private.is_occupied_occupancy_status(p_value text)
returns boolean
language sql
immutable
parallel safe
set search_path = ''
as $function$
  select case
    when x.v is null or x.v = '' or x.v = 'unknown' then false
    when x.v = 'vacant' or x.v ~ 'inoccup|libre' then false
    when x.v = 'rented' or x.v = 'tenant_occupied' or x.v ~ 'lou[eé]' then true
    when x.v in ('occupied', 'owner_occupied', 'squatted')
      or x.v ~ 'occup|proprietaire|propriétaire|squat' then true
    else false
  end
  from (select lower(pg_catalog.btrim(p_value)) as v) x;
$function$;

revoke all on function app_private.is_occupied_occupancy_status(text)
  from public, anon, authenticated;
grant execute on function app_private.is_occupied_occupancy_status(text) to service_role;

-- Rayon maximal de la porte publique, selon le type de bien et la zone de l'estimation.
create or replace function app_private.public_market_gap_band_max_radius_m(
  p_segment text,
  p_area_kind text
)
returns integer
language sql
immutable
parallel safe
set search_path = ''
as $function$
  select case
    when p_segment in ('house', 'building', 'commercial', 'land') then 2000
    when p_segment = 'apartment' and p_area_kind = 'rural' then 2000
    else 1000
  end;
$function$;

revoke all on function app_private.public_market_gap_band_max_radius_m(text, text)
  from public, anon, authenticated;
grant execute on function app_private.public_market_gap_band_max_radius_m(text, text)
  to service_role;

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
        when b.band = 'under' and app_private.is_occupied_occupancy_status(g.occupancy_status)
          then 'occupied'
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
