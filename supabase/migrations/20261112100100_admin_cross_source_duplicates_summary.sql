begin;

set local lock_timeout = '5s';

-- D12, partie affichage seulement (état des lieux du 08/11/2026, validé par le propriétaire le 08/11/2026) : le
-- panneau « Contrôles qualité » de /admin/quality affiche le nombre de groupes de doublons entre sources, le nombre
-- de lignes concernées et les premiers groupes à trois sources ou plus.
--
-- Lecture seule. Même définition que l'alerte catalogue.duplicates.cross_source : la fonction ne fait que relire
-- app_private.cross_source_duplicate_groups() et app_private.cross_source_duplicate_thresholds()
-- (20261110120400), sans les modifier. Les seuils de l'alerte (100 / 200) ne changent pas. La fusion du pipeline
-- (DEDUPE_RECONCILE_ENABLED) reste coupée : décision du propriétaire.
--
-- Service_role seul, comme public.admin_list_sale_pepites : la route /api/admin/catalogue-quality vérifie le jeton,
-- le rôle administrateur et la double authentification avant l'appel. Aucune donnée personnelle : des nombres, des
-- jours, des mises à prix et des noms de ville normalisés.
--
-- Déploiement : le code applicatif fonctionne avant cette migration (il lit alors le dernier passage de l'alerte,
-- quand elle s'est déjà ouverte).
-- Retour arrière : drop function public.admin_cross_source_duplicates_summary(integer);

create or replace function public.admin_cross_source_duplicates_summary(p_limit integer default 10)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $function$
  with duplicate_groups as (
    select * from app_private.cross_source_duplicate_groups()
  ),
  three_sources as (
    select g.sale_day, g.starting_price_eur, g.city_key, g.line_count, g.source_count
    from duplicate_groups g
    where g.source_count >= 3
    order by g.source_count desc, g.sale_day, g.city_key, g.starting_price_eur
    limit greatest(1, least(coalesce(p_limit, 10), 100))
  )
  select pg_catalog.jsonb_build_object(
    'groups', (select pg_catalog.count(*) from duplicate_groups),
    'lines', (select coalesce(pg_catalog.sum(g.line_count), 0) from duplicate_groups g),
    'thresholds', app_private.cross_source_duplicate_thresholds(),
    'three_source_groups',
      (select pg_catalog.count(*) from duplicate_groups g where g.source_count >= 3),
    'three_source_examples', coalesce(
      (
        select pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_object(
            'sale_day', t.sale_day,
            'starting_price_eur', t.starting_price_eur,
            'city_key', t.city_key,
            'line_count', t.line_count,
            'source_count', t.source_count
          )
          order by t.source_count desc, t.sale_day, t.city_key, t.starting_price_eur
        )
        from three_sources t
      ),
      '[]'::jsonb
    )
  );
$function$;

revoke all on function public.admin_cross_source_duplicates_summary(integer)
  from public, anon, authenticated;
grant execute on function public.admin_cross_source_duplicates_summary(integer) to service_role;

comment on function public.admin_cross_source_duplicates_summary(integer) is
  'Panneau « Contrôles qualité » (service_role seul) : nombre de groupes de doublons inter-sources visibles, lignes concernées, seuils de l''alerte et premiers groupes à trois sources ou plus. Même définition que app_private.cross_source_duplicate_groups ; lecture seule.';

notify pgrst, 'reload schema';

commit;
