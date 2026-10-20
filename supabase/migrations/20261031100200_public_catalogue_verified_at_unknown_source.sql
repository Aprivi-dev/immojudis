begin;

set local lock_timeout = '5s';

-- Chantier R1, point 3 (relecture de code du 20/10/2026) : la date « Données vérifiées le … » ignorait
-- une source jamais collectée en entier.
--
-- 20261029160000 prend le MIN de last_publication_complete_at sur les sources actives qui ont au moins une
-- vente visible à venir. Un MIN ignore les NULL : une source du périmètre qui n'a JAMAIS de publication
-- complète (NULL) alimente pourtant des ventes affichées, et la date de l'accueil ne la comptait pas : elle
-- annonçait « toutes les sources qui alimentent les ventes affichées ont été collectées en entier depuis
-- cette date » alors que l'une d'elles ne l'a jamais été.
--
-- Nouvelle règle : si UNE source du périmètre (active, avec au moins une vente visible à venir) n'a jamais
-- de publication complète, la date est NULL (l'accueil n'affiche alors pas de date) ; sinon, comme avant,
-- le MIN ramené à now(). Même signature, mêmes droits ; seule la date sort de la base. Aucune donnée n'est
-- modifiée.

create or replace function app_private.get_public_catalogue_verified_at()
returns timestamptz
language sql
stable
security definer
set search_path = ''
as $function$
  select case
    when oldest.has_unknown then null
    when oldest.at is null then null
    else least(oldest.at, pg_catalog.now())
  end
  from (
    select
      min(state.last_publication_complete_at) as at,
      coalesce(pg_catalog.bool_or(state.last_publication_complete_at is null), false) as has_unknown
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
  'Date de la dernière collecte complète de la source ACTIVE la moins récente parmi celles qui ont des ventes visibles à venir (MIN de last_publication_complete_at), ramenée à now() si elle est dans le futur ; NULL si aucune, ou si une de ces sources n''a jamais de collecte complète. Seule la date sort de la base.';

revoke all on function app_private.get_public_catalogue_verified_at()
  from public, anon, authenticated;
grant execute on function app_private.get_public_catalogue_verified_at()
  to anon, authenticated, service_role;

commit;
