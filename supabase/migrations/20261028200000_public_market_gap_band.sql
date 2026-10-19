begin;

set local lock_timeout = '5s';

-- Fiche publique d'une vente : l'écart entre la mise à prix et le marché local (DVF), en TROIS BANDES
-- seulement, pour un visiteur sans compte. Le chiffre (pourcentage, valeur estimée, fourchette) reste
-- réservé aux comptes ; ici, aucun prix exact ne sort : la fonction publique ne rend qu'un mot.
--
-- Sortie (text) :
--   'under'        la mise à prix est sous toute la fourchette de valeur estimée (nettement sous le
--                  marché) ;
--   'near'         elle est dans la fourchette (proche du marché) ;
--   'above'        elle est au-dessus de toute la fourchette ;
--   'insufficient' une estimation a été tentée pour cette vente, mais elle n'est pas assez fiable pour
--                  situer la mise à prix (pas assez de ventes comparables fiables) ;
--   null           rien à dire : vente hors du catalogue public, mise à prix inconnue ou qui n'est pas
--                  un prix de départ d'enchères, estimation pas encore (re)calculée, écart aberrant.
--
-- Porte de qualité : celle du code existant, recopiée et non réinventée.
--   * l'estimation est « actionable » (src/lib/market-estimation-engine.ts : au moins 4 ventes
--     comparables, échantillon effectif d'au moins 3, dispersion P25-P75 d'au plus 75 % de la
--     médiane, surfaces non élargies ; src/lib/market.server.ts : collecte complète, surface du bien
--     non estimée, position non approximative) ;
--   * l'intervalle est exploitable : P10 <= P50 <= P90 et largeur (P90 - P10) / P50 d'au plus 110 %,
--     la borne de la porte de promotion d'un modèle (src/lib/valuation-admin.ts) ;
--   * porte d'activation du modèle : une estimation issue du modèle LightGBM n'est retenue que si ce
--     modèle est toujours le modèle actif du registre (valuation_model_versions.status = 'active') ;
--   * l'estimation est à jour : seule la ligne au statut 'ready' compte. Tout changement d'une
--     donnée de l'estimation (adresse, surface, type, coordonnées, pièces) la repasse en 'pending'
--     (déclencheur immojudis_queue_auction_sale_market_estimate).
-- Garde-fou d'écart (src/lib/market-gap.ts) : un écart au-delà de 70 % sous la valeur ou de 50 % au-dessus
-- est le signe d'une estimation fausse plus que d'une affaire : aucune bande (null). L'écart se
-- calcule comme dans le code, arrondi à l'unité (Math.round) sur la valeur médiane.
--
-- Seules les ventes dont la « mise à prix » est un prix de départ d'enchères (au tribunal ou chez le
-- notaire) sont concernées ; une cession de l'État affiche un « prix publié », pas une mise à prix.
-- La visibilité est celle de tout le catalogue public (auction_sale_is_publicly_visible).
--
-- Contrat : fonction privée SECURITY DEFINER (la table des estimations n'est lisible que par le
-- service), à search_path vide, enveloppe publique SECURITY INVOKER. Le seuil de 4 ventes, de 3 pour
-- l'échantillon effectif, de 110 %, de 70 % et de -50 % est vérifié contre le code TypeScript par
-- src/lib/market-gap-band.test.ts.

-- La bande d'un prix par rapport à une fourchette, sans accès aux tables : la règle seule.
create or replace function app_private.public_market_gap_band(
  p_starting_price numeric,
  p_value_low numeric,
  p_value numeric,
  p_value_high numeric
)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $function$
  select case
    when p_starting_price is null or p_value_low is null or p_value is null or p_value_high is null
      or p_starting_price <= 0 or p_value <= 0 or p_value_low <= 0
      or p_value_low > p_value or p_value > p_value_high
      then null
    -- Garde-fou : écart (valeur - mise à prix) / valeur, arrondi comme Math.round (demi vers le haut).
    when floor((p_value - p_starting_price) / p_value * 100 + 0.5) > 70 then null
    when floor((p_value - p_starting_price) / p_value * 100 + 0.5) < -50 then null
    when p_starting_price < p_value_low then 'under'
    when p_starting_price > p_value_high then 'above'
    else 'near'
  end;
$function$;

revoke all on function app_private.public_market_gap_band(numeric, numeric, numeric, numeric)
  from public, anon, authenticated;
grant execute on function app_private.public_market_gap_band(numeric, numeric, numeric, numeric)
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
      e.status,
      e.actionable,
      e.comparable_count,
      e.value_p10_eur,
      e.value_p50_eur,
      e.value_p90_eur,
      e.engine_kind,
      e.model_version_id,
      case
        when jsonb_typeof(e.estimate -> 'effectiveSampleSize') = 'number'
          then (e.estimate ->> 'effectiveSampleSize')::numeric
      end as effective_sample_size
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
        and c.comparable_count >= 4
        and coalesce(c.effective_sample_size, 0) >= 3
        and coalesce(c.value_p10_eur, 0) > 0
        and coalesce(c.value_p50_eur, 0) > 0
        and c.value_p10_eur <= c.value_p50_eur
        and c.value_p50_eur <= coalesce(c.value_p90_eur, 0)
        and (c.value_p90_eur - c.value_p10_eur) / nullif(c.value_p50_eur, 0) <= 1.10
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
    when not g.reliable then 'insufficient'
    else app_private.public_market_gap_band(
      g.starting_price,
      g.value_p10_eur,
      g.value_p50_eur,
      g.value_p90_eur
    )
  end
  from gate g;
$function$;

revoke all on function app_private.get_public_sale_market_gap_band(uuid)
  from public, anon, authenticated;
grant execute on function app_private.get_public_sale_market_gap_band(uuid)
  to anon, authenticated, service_role;

create or replace function public.get_public_sale_market_gap_band(p_sale_id uuid)
returns text
language sql
stable
set search_path = ''
as $function$
  select app_private.get_public_sale_market_gap_band(p_sale_id);
$function$;

revoke all on function public.get_public_sale_market_gap_band(uuid) from public;
grant execute on function public.get_public_sale_market_gap_band(uuid)
  to anon, authenticated, service_role;

notify pgrst, 'reload schema';

commit;
