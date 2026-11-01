begin;

set local lock_timeout = '5s';

-- Compte-rendu du 31/10/2026, n° 12 (qualite-donnees A) : contrôle de santé « groupes de doublons inter-sources
-- restants ». Le 31/10/2026, 72 groupes (152 lignes visibles) décrivaient le même bien vendu par deux sources : la
-- fusion du pipeline est coupée par défaut (DEDUPE_RECONCILE_ENABLED=false). Une fois la fusion activée (P9 : lancer
-- dedupe-candidates, relire les paires, activer la variable), ce contrôle dit combien de groupes restent et alerte si
-- leur nombre dérive (fusion de nouveau coupée, nouvelle source mal rapprochée).
--
-- Définition d'un groupe : des ventes VISIBLES au catalogue (app_private.auction_sale_is_publicly_visible, la fonction
-- des pages publiques) qui ont le même jour de vente (heure de Paris), la même mise à prix (à l'euro près) et la même
-- ville normalisée (app_private.normalize_commune_name), et qui viennent d'AU MOINS DEUX sources différentes
-- (source_name). Deux lignes de la même source ne comptent jamais (deux lots d'une même source ne sont pas des
-- doublons). Après une fusion réussie, la vente absorbée n'a plus de ligne : seule survit la ligne principale, avec
-- raw_payload.merged_sources.
-- C'est un SIGNAL, pas un verdict : deux lots distincts de même prix, même jour et même ville vendus par deux sources
-- formeraient un groupe sans être un doublon (le pipeline écarte ces cas, les multi-lots en tête). Le seuil laisse
-- donc une marge ; il est à recaler sur la première mesure après l'activation de la fusion.
--
--   Alerte catalogue.duplicates.cross_source, catégorie `import` :
--     avertissement à partir de 100 groupes, critique à partir de 200 groupes.
--     Pourquoi 100 et 200 : le 31/10/2026, avant l'activation de la fusion, il y avait 72 groupes. Des seuils plus bas
--     (30 et 150) ouvraient l'alerte dès l'application de la migration, sur un état connu et voulu. 100 laisse une marge
--     au-dessus de ces 72 groupes tant que la fusion est coupée (DEDUPE_RECONCILE_ENABLED=false) ; 200 signale une
--     dérive nette. Activer la fusion est une décision du propriétaire (P9 : dedupe-candidates, relecture des paires,
--     variable) : une fois la fusion activée et le nombre de groupes mesuré, abaisser les seuils par une migration de
--     cette seule fonction (voir le runbook docs/runbooks/doublons-inter-sources.md).
--   Les seuils sont dans app_private.cross_source_duplicate_thresholds() : une migration d'une fonction pour les changer.
--   Se ferme d'elle-même deux heures après le retour sous le seuil (app_private.sync_operational_alert).
--   Runbook : docs/runbooks/doublons-inter-sources.md (requête de liste des groupes, causes, que faire).
--
-- Aucune donnée personnelle dans les détails : des nombres. Évaluée par app_private.evaluate_operational_health à chaque
-- passage (toutes les 30 min), sur les seules ventes à statut upcoming / unknown / postponed.
-- Retour arrière : retirer l'appel d'evaluate_operational_health (remplacement inverse), puis
-- drop function app_private.evaluate_catalogue_duplicates_health(timestamptz),
-- app_private.cross_source_duplicate_groups(), app_private.cross_source_duplicate_thresholds().
-- Les alertes ouvertes se referment à la main (update public.operational_alerts set status = 'resolved' ...).

create or replace function app_private.cross_source_duplicate_thresholds()
returns jsonb
language sql
immutable
parallel safe
security invoker
set search_path = ''
as $$
  select pg_catalog.jsonb_build_object('warning_groups', 100, 'critical_groups', 200);
$$;

revoke all on function app_private.cross_source_duplicate_thresholds() from public, anon, authenticated;
grant execute on function app_private.cross_source_duplicate_thresholds() to service_role;

comment on function app_private.cross_source_duplicate_thresholds() is
  'Seuils de l''alerte catalogue.duplicates.cross_source, en nombre de groupes de doublons inter-sources visibles : avertissement 100, critique 200 (72 groupes le 31/10/2026, fusion coupée). À abaisser après l''activation de la fusion, décision du propriétaire.';

create or replace function app_private.cross_source_duplicate_groups()
returns table (
  sale_day date,
  starting_price_eur bigint,
  city_key text,
  line_count integer,
  source_count integer
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    visible.sale_day,
    visible.price,
    visible.city_key,
    count(*)::integer,
    count(distinct visible.source_name)::integer
  from (
    select
      (sale.sale_date at time zone 'Europe/Paris')::date as sale_day,
      pg_catalog.round(sale.starting_price_eur)::bigint as price,
      app_private.normalize_commune_name(sale.city) as city_key,
      sale.source_name
    from public.auction_sales sale
    where coalesce(sale.status, 'unknown') in ('upcoming', 'unknown', 'postponed')
      and sale.sale_date is not null
      and sale.starting_price_eur > 0
      and pg_catalog.btrim(coalesce(sale.city, '')) <> ''
      and app_private.auction_sale_is_publicly_visible(sale.id)
  ) visible
  where visible.city_key <> ''
  group by visible.sale_day, visible.price, visible.city_key
  having count(distinct visible.source_name) >= 2;
$$;

revoke all on function app_private.cross_source_duplicate_groups() from public, anon, authenticated;
grant execute on function app_private.cross_source_duplicate_groups() to service_role;

comment on function app_private.cross_source_duplicate_groups() is
  'Groupes de ventes visibles de même jour (heure de Paris), même mise à prix et même ville normalisée, venant d''au moins deux sources : les doublons inter-sources restants. Un signal, pas un verdict (voir docs/runbooks/doublons-inter-sources.md).';

create or replace function app_private.evaluate_catalogue_duplicates_health(
  p_now timestamptz default statement_timestamp()
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_thresholds jsonb := app_private.cross_source_duplicate_thresholds();
  v_warning integer := (v_thresholds ->> 'warning_groups')::integer;
  v_critical integer := (v_thresholds ->> 'critical_groups')::integer;
  v_groups integer;
  v_lines integer;
begin
  select count(*)::integer, coalesce(sum(duplicate.line_count), 0)::integer
  into v_groups, v_lines
  from app_private.cross_source_duplicate_groups() duplicate;

  perform app_private.sync_operational_alert(
    'catalogue.duplicates.cross_source',
    'import',
    case when v_groups >= v_critical then 'critical' else 'warning' end,
    pg_catalog.jsonb_build_object(
      'groups', v_groups,
      'lines', v_lines,
      'warning_groups', v_warning,
      'critical_groups', v_critical
    ),
    v_groups >= v_warning,
    p_now
  );
end;
$$;

revoke all on function app_private.evaluate_catalogue_duplicates_health(timestamptz)
  from public, anon, authenticated;
grant execute on function app_private.evaluate_catalogue_duplicates_health(timestamptz) to service_role;

comment on function app_private.evaluate_catalogue_duplicates_health(timestamptz) is
  'Alerte catalogue.duplicates.cross_source : nombre de groupes de doublons inter-sources visibles au-dessus du seuil. Appelée par evaluate_operational_health ; ne renvoie rien.';

-- Appel depuis app_private.evaluate_operational_health, juste après l'évaluation des alertes d'inondation, de pépites et
-- de référence (20261108100000). Même méthode que les migrations précédentes : refuser de deviner si le fragment attendu
-- n'y est plus.
do $hook$
declare
  definition text := pg_catalog.pg_get_functiondef(
    'app_private.evaluate_operational_health(timestamptz)'::regprocedure
  );
  anchor constant text := 'perform app_private.evaluate_flood_pepite_reference_health(p_now);';
begin
  if position('evaluate_catalogue_duplicates_health' in definition) = 0 then
    if position(anchor in definition) = 0 then
      raise exception using
        errcode = '55000',
        message = 'Operational health definition changed; review before adding the cross-source duplicates alert (n° 12).';
    end if;
    execute replace(
      definition,
      anchor,
      anchor || E'\n  perform app_private.evaluate_catalogue_duplicates_health(p_now);'
    );
  end if;
end;
$hook$;

notify pgrst, 'reload schema';

commit;
