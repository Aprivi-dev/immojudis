begin;

set local lock_timeout = '5s';

-- Administration des pépites : lectures moins coûteuses (chantier W2a, n° 33). Aucune règle de pépite n'est touchée.
--
-- 1. `admin_list_sale_pepites` : le filtre de statut de la vente passe AVANT l'appel à
--    `app_private.auction_sale_is_publicly_visible`. Même résultat qu'avant (la fonction teste la même condition en
--    premier), mais la fonction, appelée une fois par évaluation stockée et qui relit la vente et décompresse son
--    `raw_payload`, ne l'est plus pour les évaluations de ventes terminées ou retirées. Le corps est celui de
--    20261104100000, sans autre changement.
-- 2. `admin_pepite_independence_sales` : le contrôle d'indépendance (src/lib/admin-pepites.ts) lisait les évaluations
--    par pages de 1 000, puis les ventes par tranches de 200 identifiants (une requête par tranche). Une seule
--    fonction rend désormais les deux effectifs et, pour les seules ventes qui ont un avocat poursuivant, les champs
--    du rapprochement. Le rapprochement, volontairement strict, reste en TypeScript (`matchProsecutedSales`).
--
-- DÉPLOIEMENT : le code fonctionne avant cette migration (fonction d'indépendance absente : la page affiche « non
-- mesuré » comme lorsque le contrôle dépasse son délai).
-- RETOUR ARRIÈRE : drop function public.admin_pepite_independence_sales(); puis rejouer la définition de
-- admin_list_sale_pepites de 20261104100000.

create or replace function public.admin_list_sale_pepites(
  p_now timestamptz default statement_timestamp(),
  p_limit integer default 300
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  with candidates as materialized (
    -- Filtre bon marché AVANT la fonction de visibilité : c'est la première condition d'auction_sale_is_publicly_visible
    -- (statut à venir, inconnu ou reporté). Les évaluations de ventes terminées, retirées ou passées s'accumulent dans
    -- la table ; la fonction (security definer, non « inlinable », qui relit la vente et son raw_payload) n'est plus
    -- appelée pour elles. `materialized` fixe l'ordre : filtre d'abord, fonction ensuite. Résultat identique.
    select
      p.sale_id,
      p.status,
      p.is_pepite,
      p.reason_codes,
      s.sale_venue_type
    from public.auction_sale_pepites p
    join public.auction_sales s on s.id = p.sale_id
    where coalesce(s.status, 'unknown') in ('upcoming', 'unknown', 'postponed')
  ),
  evaluated as (
    -- Sans la colonne « details » (un JSON par ligne) : elle n'est lue que pour les lignes retenues plus bas.
    select
      c.sale_id,
      c.status,
      c.is_pepite,
      c.reason_codes,
      -- Type de vente d'après la colonne de la vente, jamais d'après le détail privé de l'évaluation.
      case c.sale_venue_type
        when 'tribunal' then 'tribunal'
        when 'notary' then 'notary'
        else 'other'
      end as venue,
      (
        select pg_catalog.count(*)
        from pg_catalog.unnest(c.reason_codes) as code
        where code like 'fail:%'
      ) as missed_count
    from candidates c
    where app_private.auction_sale_is_publicly_visible(c.sale_id)
  ),
  venues as (
    select venue from (values ('tribunal'), ('notary'), ('other')) as v(venue)
  ),
  counters as (
    select
      venues.venue,
      pg_catalog.count(e.sale_id) as evaluated,
      pg_catalog.count(e.sale_id) filter (where e.is_pepite) as pepites,
      pg_catalog.count(e.sale_id) filter (where e.status = 'pepite' and not e.is_pepite) as pending,
      pg_catalog.count(e.sale_id) filter (where e.status = 'not_pepite' and not e.is_pepite) as not_pepite,
      pg_catalog.count(e.sale_id) filter (where e.status = 'not_applicable') as not_applicable,
      pg_catalog.count(e.sale_id) filter (where e.status = 'insufficient') as insufficient,
      pg_catalog.count(e.sale_id) filter (
        where e.status in ('pepite', 'not_pepite') or e.is_pepite
      ) as evaluable,
      pg_catalog.count(e.sale_id) filter (
        where e.status = 'not_pepite' and e.missed_count = 1 and 'fail:gap_significant' = any (e.reason_codes)
      ) as only_gap_guard
    from venues
    left join evaluated e on e.venue = venues.venue
    group by venues.venue
  ),
  retained as (
    select e.sale_id, e.venue
    from evaluated e
    where e.is_pepite
      or e.status = 'pepite'
      or (e.status = 'not_pepite' and e.missed_count = 1)
  ),
  listed as (
    select
      p.sale_id,
      p.status,
      p.is_pepite,
      p.favorable_streak,
      p.frozen_at,
      p.reason_codes,
      p.details,
      p.evaluated_at,
      p.first_pepite_at,
      r.venue,
      s.title,
      s.city,
      s.tribunal,
      s.sale_venue_type,
      s.starting_price_eur,
      s.sale_date
    from retained r
    join public.auction_sale_pepites p on p.sale_id = r.sale_id
    join public.auction_sales s on s.id = r.sale_id
    order by
      p.is_pepite desc,
      (p.status = 'pepite') desc,
      case when pg_catalog.jsonb_typeof(p.details -> 'costRatio') = 'number'
        then (p.details ->> 'costRatio')::numeric
      end asc nulls last,
      p.sale_id
    limit greatest(1, least(coalesce(p_limit, 300), 1000))
  )
  select pg_catalog.jsonb_build_object(
    'generated_at', p_now,
    'mode', app_private.sale_pepite_mode(),
    'counters', coalesce(
      (
        select pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_object(
            'venue', c.venue,
            'evaluated', c.evaluated,
            'pepites', c.pepites,
            'pending', c.pending,
            'not_pepite', c.not_pepite,
            'not_applicable', c.not_applicable,
            'insufficient', c.insufficient,
            'evaluable', c.evaluable,
            'only_gap_guard', c.only_gap_guard
          )
          order by case c.venue when 'tribunal' then 1 when 'notary' then 2 else 3 end
        )
        from counters c
      ),
      '[]'::jsonb
    ),
    'rows', coalesce(
      (
        select pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_object(
            'sale_id', l.sale_id,
            'status', l.status,
            'is_pepite', l.is_pepite,
            'favorable_streak', l.favorable_streak,
            'frozen_at', l.frozen_at,
            'reason_codes', l.reason_codes,
            'details', l.details,
            'evaluated_at', l.evaluated_at,
            'first_pepite_at', l.first_pepite_at,
            'venue', l.venue,
            'title', l.title,
            'city', l.city,
            'tribunal', l.tribunal,
            'sale_venue_type', l.sale_venue_type,
            'starting_price_eur', l.starting_price_eur,
            'sale_date', l.sale_date
          )
          order by
            l.is_pepite desc,
            (l.status = 'pepite') desc,
            case when pg_catalog.jsonb_typeof(l.details -> 'costRatio') = 'number'
              then (l.details ->> 'costRatio')::numeric
            end asc nulls last,
            l.sale_id
        )
        from listed l
      ),
      '[]'::jsonb
    )
  );
$function$;

revoke all on function public.admin_list_sale_pepites(timestamptz, integer)
  from public, anon, authenticated;
grant execute on function public.admin_list_sale_pepites(timestamptz, integer) to service_role;

comment on function public.admin_list_sale_pepites(timestamptz, integer) is
  'Page d''administration des pépites (service_role seul) : mode, compteurs par type de vente, pépites, pépites à confirmer et presque pépites avec leurs détails privés. Ventes publiquement visibles seulement.';

create or replace function public.admin_pepite_independence_sales()
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $function$
  with evaluable as (
    select
      p.sale_id,
      p.is_pepite,
      (p.status = 'pepite' and not p.is_pepite) as pending
    from public.auction_sale_pepites p
    where p.status in ('pepite', 'not_pepite')
  )
  select pg_catalog.jsonb_build_object(
    'evaluable', (select pg_catalog.count(*) from evaluable),
    'pepites', (select pg_catalog.count(*) from evaluable e where e.is_pepite or e.pending),
    -- Seules les ventes dont l'avocat poursuivant est nommé peuvent être rapprochées d'un avocat référencé.
    'sales', coalesce(
      (
        select pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_object(
            'id', s.id,
            'lawyer_name', s.lawyer_name,
            'tribunal', s.tribunal,
            'sale_date', s.sale_date,
            'is_pepite', e.is_pepite,
            'pending', e.pending
          )
          order by s.id
        )
        from evaluable e
        join public.auction_sales s on s.id = e.sale_id
        where s.lawyer_name is not null
      ),
      '[]'::jsonb
    )
  );
$function$;

revoke all on function public.admin_pepite_independence_sales() from public, anon, authenticated;
grant execute on function public.admin_pepite_independence_sales() to service_role;

comment on function public.admin_pepite_independence_sales() is
  'Contrôle d''indépendance des pépites (service_role seul) : effectif des ventes évaluables et des pépites (publiées ou à confirmer), et champs de rapprochement des seules ventes ayant un avocat poursuivant nommé.';

notify pgrst, 'reload schema';

commit;
