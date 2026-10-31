begin;

set local lock_timeout = '5s';

-- Étape 2 de P4-01 (20261010003000), jamais exécutée jusqu'ici : retirer au rôle `authenticated` la lecture
-- de public.auction_sales.raw_payload, .lawyer_contact et .observations (compte-rendu du 31/10/2026, n° 1).
--
-- Pourquoi : tout compte connecté, y compris un essai gratuit de 7 jours, pouvait lire ces trois colonnes en
-- direct par PostgREST (`/rest/v1/auction_sales?select=raw_payload,lawyer_contact,observations`) : le
-- catalogue brut complet (fiches sources, contacts d'avocats, observations de chaque source), sans passer par
-- l'application ni par son plafond de lectures. Seules les projections de v_auction_sales_app (blocs de
-- source, contrôles, médias, ligne d'avocat) doivent rester visibles.
--
-- Ce que fait cette migration, dans l'ordre :
--   1. elle redéfinit app_private.set_catalogue_raw_columns_hidden(boolean) avec un prédicat de garde qui est
--      celui de la politique auction_sales_authenticated_read dans sa dernière forme (20261029170200 : appels
--      de is_admin() et has_analysis_access() encapsulés dans un sous-select, donc évalués une seule fois par
--      requête et non par ligne). L'ancienne fonction appelait ces deux fonctions ligne par ligne ;
--   2. elle l'exécute (`true`) : v_auction_sales_app devient une vue SECURITY DEFINER (security_barrier), dont
--      le WHERE reprend exactement la politique de lecture ; puis elle retire les trois colonnes à
--      `authenticated`. La vue lit alors la table avec les droits de son propriétaire, mais ne rend que les
--      lignes que la politique aurait rendues ; les fonctions qu'elle appelle restent contrôlées pour le
--      compte appelant.
--
-- Ce qui ne change pas : les colonnes, leur ordre, leurs types, les droits de la vue, la politique de lecture
-- de la table (elle reste la règle de référence pour tout accès direct), les autres vues (elles lisent
-- v_auction_sales_app, ou des colonnes qui restent accordées).
--
-- Vérifié avant d'écrire la migration (31/10/2026) : aucune autre vue security_invoker, aucune fonction non
-- SECURITY DEFINER accordée à `authenticated` et aucune politique ne lit ces trois colonnes de la table ; le
-- code de src/ qui lit auction_sales avec la session d'un compte (data-refresh.ts, lawyer-referrals.ts) ne les
-- sélectionne pas ; tous les autres accès passent par service_role.
--
-- À MESURER AVANT D'APPLIQUER EN PRODUCTION. Une vue SECURITY DEFINER avec security_barrier empêche de
-- descendre dans la vue les filtres de la requête qui ne sont pas « leakproof » : la page /sales, la recherche
-- et la fiche lisent cette vue. Sur une copie récente de la base, avec un compte Analyse et un compte
-- administrateur (set local role authenticated + request.jwt.claim.sub), comparer avant et après le plan
-- (explain (analyze, buffers)) et la durée de : (a) la fiche d'une vente par identifiant, (b) une page de
-- /sales triée et filtrée (v_auction_sales_app_search), (c) le compte de la liste. Si une de ces requêtes
-- dépasse nettement sa durée actuelle, ne pas appliquer : repartir de la mesure.
--
-- APPLIQUER HORS COLLECTE (create or replace view prend un verrou ACCESS EXCLUSIVE sur la vue, la révocation
-- un verrou sur la table ; lock_timeout de 5 s : en cas d'échec rien n'est appliqué, relancer). Déployer le code
-- n'est pas nécessaire : il ne lit pas ces colonnes avec la session d'un compte.
--
-- RETOUR ARRIÈRE, sans perte : `select app_private.set_catalogue_raw_columns_hidden(false);` (rend les trois
-- colonnes à authenticated et restaure l'ancienne définition de la vue, sauvegardée dans
-- app_private.catalogue_view_backups). Toute migration ultérieure qui réécrit v_auction_sales_app doit garder
-- `security_invoker = false, security_barrier = true` et le prédicat de garde ; le script
-- check-security-invariants.mjs le vérifie.
create or replace function app_private.set_catalogue_raw_columns_hidden(p_hidden boolean)
returns text
language plpgsql
security invoker
set search_path = ''
as $$
declare
  view_definition text;
  stored_definition text;
  stored_options text[];
  matches integer;
  already_definer boolean;
  -- Même condition que la politique auction_sales_authenticated_read (20261029170200), appels de fonctions en
  -- sous-select (InitPlan), la quarantaine lue sur la colonne matérialisée (20261027100200).
  predicate constant text :=
    '((SELECT public.is_admin()) OR ((SELECT public.has_analysis_access()) '
    || 'AND public.catalogue_readiness_allows_premium(s.premium_readiness_status, '
    || 's.premium_readiness_override, s.premium_readiness_override_expires_at) '
    || 'AND COALESCE(s.status, ''unknown''::text) <> ''quarantined''::text '
    || 'AND (NOT s.catalogue_quarantined))) AND ';
begin
  select coalesce(c.reloptions @> array['security_invoker=false'], false)
    into already_definer
    from pg_catalog.pg_class c
   where c.oid = 'public.v_auction_sales_app'::regclass;

  if p_hidden then
    if not already_definer then
      view_definition := pg_catalog.pg_get_viewdef('public.v_auction_sales_app'::regclass, true);
      select count(*) into matches
        from regexp_matches(view_definition, 'WHERE\s+\(s\.status = ANY', 'g');
      if matches <> 1 then
        raise exception 'v_auction_sales_app changed shape: update this function before hiding raw columns';
      end if;

      insert into app_private.catalogue_view_backups (view_name, definition, reloptions)
      select 'v_auction_sales_app', view_definition, c.reloptions
        from pg_catalog.pg_class c
       where c.oid = 'public.v_auction_sales_app'::regclass
      on conflict (view_name) do update
        set definition = excluded.definition,
            reloptions = excluded.reloptions,
            saved_at = now();

      view_definition := regexp_replace(
        view_definition,
        'WHERE\s+\(s\.status = ANY',
        'WHERE ' || predicate || '(s.status = ANY'
      );
      execute 'create or replace view public.v_auction_sales_app '
        || 'with (security_invoker = false, security_barrier = true) as '
        || rtrim(view_definition, E';\n ');
    end if;
    -- Aussi quand la vue était déjà gardée : la révocation est idempotente.
    revoke select (raw_payload, lawyer_contact, observations)
      on table public.auction_sales from authenticated;
    return case when already_definer then 'already hidden' else 'hidden' end;
  end if;

  grant select (raw_payload, lawyer_contact, observations)
    on table public.auction_sales to authenticated;
  if already_definer then
    select b.definition, b.reloptions into stored_definition, stored_options
      from app_private.catalogue_view_backups b
     where b.view_name = 'v_auction_sales_app';
    if stored_definition is null then
      raise exception 'no stored definition for v_auction_sales_app; restore it manually';
    end if;
    execute 'create or replace view public.v_auction_sales_app '
      || 'with (security_invoker = true) as '
      || rtrim(stored_definition, E';\n ');
  end if;
  return 'visible';
end;
$$;

revoke all on function app_private.set_catalogue_raw_columns_hidden(boolean)
  from public, anon, authenticated, service_role;

comment on function app_private.set_catalogue_raw_columns_hidden(boolean) is
  'Étape 2 de P4-01, exécutée par 20261110120000 (rôle de migration). true : v_auction_sales_app devient une vue definer gardée par le prédicat de la politique de lecture (sous-select, catalogue_quarantined) et raw_payload, lawyer_contact et observations sont retirées à authenticated. false : rend les colonnes et restaure la définition sauvegardée. Mesurer la vue avant de l''appliquer.';

select app_private.set_catalogue_raw_columns_hidden(true);

notify pgrst, 'reload schema';

commit;
