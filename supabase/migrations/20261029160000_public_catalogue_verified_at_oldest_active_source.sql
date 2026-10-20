begin;

set local lock_timeout = '5s';

-- Point 37 du compte-rendu du 20/10/2026 : la date « Données vérifiées le … » de l'accueil.
--
-- 20261028100500 prenait le MAX de last_publication_complete_at sur toutes les sources : il suffisait
-- qu'UNE source collecte ce matin pour afficher « vérifiées le <aujourd'hui> », même si une autre
-- (Enchères Immobilières, par exemple) était figée depuis des semaines et que ses ventes sont toujours
-- à l'écran. La ligne annonçait donc plus qu'elle ne savait.
--
-- Nouvelle règle : le MIN de last_publication_complete_at sur les sources ACTIVES (enabled) qui ont au
-- moins une vente visible à venir dans le catalogue public. Le libellé reste vrai : « toutes les sources
-- qui alimentent les ventes affichées ont été collectées en entier depuis cette date ». Le MIN n'est pas
-- trompeur dans le mauvais sens : il peut paraître sévère (une source en retard vieillit la date de
-- l'accueil), jamais généreux, et c'est précisément le signal à ne pas masquer. Le libellé « dernière
-- collecte réussie » aurait gardé le défaut du MAX (une date récente qui cache une source figée) ; il est
-- donc écarté.
--
-- « Vente visible à venir » = la définition de v_auction_sales_discovery : statut upcoming / unknown /
-- postponed, échéance du catalogue non dépassée, aucune quarantaine de publication. La source d'une vente
-- est auction_sales.source_name (la source principale ; une vente fusionnée compte pour celle-là).
--
-- Une source active dont la date est NULL (jamais de collecte complète) est ignorée par MIN, comme par
-- tout agrégat : la date rendue est celle des sources qui en ont une. Si aucune n'en a, NULL (l'accueil
-- n'affiche alors pas de date). Même signature, mêmes droits ; seule la date sort de la base.

create or replace function app_private.get_public_catalogue_verified_at()
returns timestamptz
language sql
stable
security definer
set search_path = ''
as $function$
  select case
    when oldest.at is null then null
    else least(oldest.at, pg_catalog.now())
  end
  from (
    select min(state.last_publication_complete_at) as at
    from public.auction_source_state state
    where state.enabled
      and exists (
        select 1
        from public.auction_sales sale
        where sale.source_name = state.source_name
          and sale.status = any (array['upcoming', 'unknown', 'postponed'])
          and app_private.sale_catalogue_entry_is_live_materialized(
            sale.catalogue_expiry_materialized,
            sale.catalogue_expiry_deadline,
            sale.sale_date,
            sale.raw_payload,
            sale.sale_procedure
          )
          and coalesce(sale.raw_payload ->> 'publication_quarantine', '') = ''
      )
  ) oldest;
$function$;

comment on function app_private.get_public_catalogue_verified_at() is
  'Date de la dernière collecte complète de la source ACTIVE la moins récente parmi celles qui ont des ventes visibles à venir (MIN de last_publication_complete_at), ramenée à now() si elle est dans le futur ; NULL si aucune. Seule la date sort de la base.';

revoke all on function app_private.get_public_catalogue_verified_at()
  from public, anon, authenticated;
grant execute on function app_private.get_public_catalogue_verified_at()
  to anon, authenticated, service_role;

commit;
