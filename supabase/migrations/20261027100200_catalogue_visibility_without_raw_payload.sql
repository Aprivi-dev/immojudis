begin;

set local lock_timeout = '5s';

-- 3/3 : à appliquer après 20261027100000 (colonnes) et 20261027100100 (fonctions, déclencheurs,
-- rattrapage). À APPLIQUER HORS COLLECTE. Cette migration ne relit aucune ligne : elle réécrit des
-- vues, des fonctions et une politique, et prend brièvement leurs verrous (ACCESS EXCLUSIVE sur chaque
-- vue et chaque fonction réécrite, ALTER POLICY sur auction_sales). lock_timeout (5 s) la fait
-- échouer, sans effet, si un verrou n'est pas obtenu ; relancer hors collecte. Retour arrière :
-- docs/runbooks/catalogue-visibility-projection.md.
--
-- La visibilité publique d'une annonce relisait raw_payload (85 Ko compressés en moyenne, jusqu'à
-- 2,7 Mo) pour chaque ligne examinée :
--   * v_auction_sales_app et v_auction_sales_discovery lisaient raw_payload->>'publication_quarantine'
--     et passaient raw_payload à sale_catalogue_entry_is_live_materialized (count(*) de la carte :
--     5,4 s et 4,7 s en production) ;
--   * la recherche publique (search_auction_sales_preview_v3 et _v4) retombait, pour les annonces dont
--     la date limite matérialisée est nulle (193 en production), sur sale_catalogue_entry_is_live, qui
--     relit raw_payload et le concatène à un objet : 1 315 ms de filtre, contre 16 ms sans ce repli.
-- Ici, tout ce qui décide de la visibilité ne lit plus que des colonnes ordinaires :
--   1. la quarantaine lit catalogue_quarantined (colonne matérialisée par
--      zzzz_auction_sales_catalogue_projection_*, 20261009180000, et recalculée à chaque écriture par
--      zzzzz_auction_sales_catalogue_visibility_*, 20261027100100) ;
--   2. le repli « sans date limite » lit trois colonnes matérialisées à l'écriture (20261027100000
--      et 20261027100100), voir ci-dessous.
--
-- Cas « sans date limite » (catalogue_expiry_materialized et catalogue_expiry_deadline nul).
-- sale_catalogue_entry_is_live(sale_date, raw_payload || sale_procedure) décide alors ainsi :
--   * sale_date nulle : app_private.state_listing_is_live(raw_payload), c'est-à-dire la fiche « cessions
--     de l'État » observée active depuis moins de 14 jours (et au plus un jour dans le futur), avec une
--     fin de publication estimée non dépassée ;
--   * sale_date renseignée (vente reportée, conflit de dates, calendrier en ligne illisible) :
--     sale_catalogue_expiry(sale_date, raw_payload || sale_procedure) > maintenant.
-- Le résultat dépend de l'heure courante, il ne peut donc pas être figé en booléen : on matérialise
-- les seules valeurs que cette décision compare à l'heure, et la comparaison reste faite à la lecture,
-- avec les mêmes expressions que state_listing_is_live (14 jours, un jour, minuit à Paris) :
--   * catalogue_expiry_fallback : sale_catalogue_expiry(...) de la ligne, utile seulement quand
--     catalogue_expiry_deadline est nul et sale_date renseignée ;
--   * catalogue_state_observed_at et catalogue_state_end_estimate : le seul état de la fiche de l'État
--     (state_listing.observed_at et state_listing.listing_end_estimate), non nuls seulement quand la
--     fiche passe les contrôles statiques de state_listing_is_live (source cessions_etat, active,
--     formats valides) et que sale_date est nulle.
-- Ces trois colonnes restent nulles pour toute ligne dont la date limite est matérialisée. Elles sont
-- recalculées par un déclencheur dédié, sous le déclencheur de date limite, à chaque changement de
-- sale_date, raw_payload, sale_procedure ou de la date limite. La stratégie d'expiration par défaut
-- (réglage app.date_only_catalogue_policy) est donc figée à l'écriture, comme la date limite.
--
-- Une ligne dont catalogue_expiry_materialized est faux n'est visible nulle part : le déclencheur de
-- date limite la matérialise à chaque écriture et la migration 20261003130000 a refusé d'aboutir tant
-- qu'il en restait. Les anciens prédicats l'évaluaient en relisant raw_payload ; le nouveau échoue
-- fermé (jamais d'annonce masquée rendue visible).

-- v_auction_sales_app est une vue security_invoker : le rôle authenticated lit ces colonnes
-- directement (le grant de colonnes de 20261010003000 ne contenait pas catalogue_quarantined, jamais
-- lue par une vue jusqu'ici). Les vues « découverte » sont security definer et n'en ont pas besoin.
-- Aucune de ces colonnes ne contient de donnée de la fiche : ce sont des dates et un booléen.
grant select (
  catalogue_quarantined,
  catalogue_expiry_fallback,
  catalogue_state_observed_at,
  catalogue_state_end_estimate
) on table public.auction_sales to authenticated;

-- Politique de lecture des comptes connectés : elle relisait raw_payload à chaque ligne examinée pour
-- tout compte non administrateur. Mêmes conditions, la quarantaine lue sur la colonne matérialisée.
alter policy auction_sales_authenticated_read on public.auction_sales
using (
  public.is_admin()
  or (
    public.has_analysis_access()
    and public.catalogue_readiness_allows_premium(
      premium_readiness_status,
      premium_readiness_override,
      premium_readiness_override_expires_at
    )
    and coalesce(status, 'unknown') <> 'quarantined'
    and not catalogue_quarantined
  )
);

-- Les définitions actuelles sont relues et réécrites plutôt que recopiées (méthode de
-- 20261003170000) : projections, droits et options des vues, signatures et corps des fonctions restent
-- intacts. Seuls changent le prédicat de date et le prédicat de quarantaine. Trois motifs, tolérants à
-- la mise en forme de pg_get_viewdef / pg_get_functiondef et à l'alias de la table :
--   1. l'appel avec les colonnes de la ligne (vues, fonctions à une ligne) ;
--   2. l'appel de repli « (false, null, ...) » de la branche sinon des recherches ;
--   3. la quarantaine lue dans raw_payload, remplacée par « (NOT <alias>.catalogue_quarantined) » :
--      entre parenthèses, pour rester un seul terme quel que soit le AND / OR qui l'entoure.
-- Si une définition garde un de ces motifs ou n'en reçoit aucun, la migration échoue. Pour chaque
-- fonction réécrite, elle échoue aussi si l'option SECURITY DEFINER, les réglages (search_path) ou les
-- droits d'exécution ne sont pas strictement ceux d'avant la réécriture.
do $rewrite$
declare
  v_live_call constant text := $re$app_private\.sale_catalogue_entry_is_live_materialized\(\s*((?:\w+\.)?)catalogue_expiry_materialized\s*,\s*(?:\w+\.)?catalogue_expiry_deadline\s*,\s*(?:\w+\.)?sale_date\s*,\s*(?:\w+\.)?raw_payload\s*,\s*(?:\w+\.)?sale_procedure\s*\)$re$;
  v_live_fallback constant text := $re$app_private\.sale_catalogue_entry_is_live_materialized\(\s*false\s*,\s*null\s*,\s*((?:\w+\.)?)sale_date\s*,\s*(?:\w+\.)?raw_payload\s*,\s*(?:\w+\.)?sale_procedure\s*\)$re$;
  v_live_new constant text := $new$app_private.sale_catalogue_projection_is_live(\1catalogue_expiry_materialized, \1catalogue_expiry_deadline, \1sale_date, \1catalogue_expiry_fallback, \1catalogue_state_observed_at, \1catalogue_state_end_estimate)$new$;
  v_quarantine constant text := $re$coalesce\(\s*\(?\s*((?:\w+\.)?)raw_payload\s*->>\s*'publication_quarantine'(?:::text)?\s*\)?\s*,\s*''(?:::text)?\s*\)\s*=\s*''(?:::text)?$re$;
  v_quarantine_new constant text := $new$(NOT \1catalogue_quarantined)$new$;
  -- Le commentaire laissé par 20261009180000 dans les corps des recherches décrit l'ancien repli.
  v_comment constant text := $re$--[^\n]*sale_catalogue_entry_is_live_materialized, but(?:\n[ \t]*--[^\n]*)*$re$;
  v_comment_new constant text := $new$-- Même règle que app_private.sale_catalogue_projection_is_live, en colonnes seules : ni raw_payload ni détoastage.$new$;
  -- app_private.set_catalogue_raw_columns_hidden (20261010003000, jamais exécutée) recolle l'ancien
  -- prédicat de quarantaine dans un texte SQL : la même quarantaine, lue sur la colonne.
  v_hidden_old constant text := $lit$COALESCE(s.raw_payload ->> ''publication_quarantine''::text, ''''::text) = ''''::text$lit$;
  v_hidden_new constant text := $lit$(NOT s.catalogue_quarantined)$lit$;
  v_function_names constant text[] := array[
    'auction_sale_is_publicly_visible',
    'search_auction_sales_preview',
    'search_auction_sales_preview_v2',
    'search_auction_sales_preview_v3',
    'search_auction_sales_preview_v4',
    'list_public_sale_sitemap_entries',
    'get_public_sale_summary',
    'get_public_sale_details',
    'get_public_tribunal_activity',
    'get_public_sale_indexability',
    'get_public_sale_calendar_event',
    'sale_photo_mirrors'
  ];
  v_function_name text;
  v_function regprocedure;
  v_before text;
  v_after text;
  v_found integer;
  v_secdef_before boolean;
  v_config_before text;
  v_acl_before text;
  v_secdef_after boolean;
  v_config_after text;
  v_acl_after text;
  v_view_name text;
  v_view_options text;
  v_views integer := 0;
begin
  foreach v_function_name in array v_function_names loop
    v_found := 0;
    for v_function in
      select procedure_row.oid::regprocedure
      from pg_catalog.pg_proc procedure_row
      join pg_catalog.pg_namespace schema_row on schema_row.oid = procedure_row.pronamespace
      where schema_row.nspname = 'app_private'
        and procedure_row.proname = v_function_name
      order by procedure_row.oid::regprocedure::text
    loop
      v_found := v_found + 1;
      v_before := pg_catalog.pg_get_functiondef(v_function);
      v_after := regexp_replace(v_before, v_live_call, v_live_new, 'gi');
      v_after := regexp_replace(v_after, v_live_fallback, v_live_new, 'gi');
      v_after := regexp_replace(v_after, v_quarantine, v_quarantine_new, 'gi');
      v_after := regexp_replace(v_after, v_comment, v_comment_new, 'g');

      if v_after ~* 'sale_catalogue_entry_is_live_materialized\('
         or v_after ~* 'publication_quarantine'
         or v_after !~ 'sale_catalogue_projection_is_live\('
         or v_after !~ 'catalogue_quarantined' then
        raise exception using
          errcode = 'P0001',
          message = format(
            'Unexpected definition of %s; catalogue visibility without raw_payload was not installed.',
            v_function
          );
      end if;
      if v_after <> v_before then
        select procedure_row.prosecdef,
               coalesce(procedure_row.proconfig::text, ''),
               coalesce(procedure_row.proacl::text, '')
          into v_secdef_before, v_config_before, v_acl_before
          from pg_catalog.pg_proc procedure_row
          where procedure_row.oid = v_function::oid;

        execute v_after;

        select procedure_row.prosecdef,
               coalesce(procedure_row.proconfig::text, ''),
               coalesce(procedure_row.proacl::text, '')
          into v_secdef_after, v_config_after, v_acl_after
          from pg_catalog.pg_proc procedure_row
          where procedure_row.oid = v_function::oid;

        if v_secdef_after is distinct from v_secdef_before
           or v_config_after is distinct from v_config_before
           or v_acl_after is distinct from v_acl_before then
          raise exception using
            errcode = 'P0001',
            message = format(
              'Rewriting %s changed SECURITY DEFINER (%s -> %s), settings (%s -> %s) or privileges; catalogue visibility without raw_payload was not installed.',
              v_function, v_secdef_before, v_secdef_after, v_config_before, v_config_after
            );
        end if;
      end if;
    end loop;

    -- Les versions 1 et 2 de la recherche sont des anciennes versions : absentes, elles ne bloquent pas.
    if v_found = 0 and v_function_name not in ('search_auction_sales_preview', 'search_auction_sales_preview_v2') then
      raise exception using
        errcode = '42883',
        message = format('Missing app_private.%s.', v_function_name);
    end if;
  end loop;

  -- Fonction dormante : un simple remplacement de texte, vérifié (une occurrence exactement).
  v_function := pg_catalog.to_regprocedure('app_private.set_catalogue_raw_columns_hidden(boolean)');
  if v_function is null then
    raise exception using
      errcode = '42883',
      message = 'Missing app_private.set_catalogue_raw_columns_hidden(boolean).';
  end if;
  v_before := pg_catalog.pg_get_functiondef(v_function);
  v_found := (length(v_before) - length(replace(v_before, v_hidden_old, ''))) / length(v_hidden_old);
  if v_found = 1 then
    v_after := replace(v_before, v_hidden_old, v_hidden_new);
  elsif v_found = 0 and v_before ~ 's\.catalogue_quarantined' then
    v_after := v_before;
  else
    v_after := null;
  end if;
  if v_after is null or v_after ~* 'publication_quarantine' then
    raise exception using
      errcode = 'P0001',
      message = 'Unexpected definition of app_private.set_catalogue_raw_columns_hidden; catalogue visibility without raw_payload was not installed.';
  end if;
  if v_after <> v_before then
    select procedure_row.prosecdef,
           coalesce(procedure_row.proconfig::text, ''),
           coalesce(procedure_row.proacl::text, '')
      into v_secdef_before, v_config_before, v_acl_before
      from pg_catalog.pg_proc procedure_row
      where procedure_row.oid = v_function::oid;

    execute v_after;

    select procedure_row.prosecdef,
           coalesce(procedure_row.proconfig::text, ''),
           coalesce(procedure_row.proacl::text, '')
      into v_secdef_after, v_config_after, v_acl_after
      from pg_catalog.pg_proc procedure_row
      where procedure_row.oid = v_function::oid;

    if v_secdef_after is distinct from v_secdef_before
       or v_config_after is distinct from v_config_before
       or v_acl_after is distinct from v_acl_before then
      raise exception using
        errcode = 'P0001',
        message = 'Rewriting app_private.set_catalogue_raw_columns_hidden changed SECURITY DEFINER, settings or privileges.';
    end if;
  end if;

  for v_view_name, v_before, v_view_options in
    select
      view_row.relname,
      pg_catalog.pg_get_viewdef(view_row.oid, true),
      pg_catalog.array_to_string(view_row.reloptions, ', ')
    from pg_catalog.pg_class view_row
    join pg_catalog.pg_namespace schema_row on schema_row.oid = view_row.relnamespace
    where schema_row.nspname = 'public'
      and view_row.relkind = 'v'
      and view_row.relname in ('v_auction_sales_app', 'v_auction_sales_discovery')
    order by view_row.relname
  loop
    v_views := v_views + 1;
    v_after := regexp_replace(v_before, v_live_call, v_live_new, 'gi');
    v_after := regexp_replace(v_after, v_live_fallback, v_live_new, 'gi');
    v_after := regexp_replace(v_after, v_quarantine, v_quarantine_new, 'gi');

    if v_after ~* 'sale_catalogue_entry_is_live_materialized\('
       or v_after ~* 'publication_quarantine'
       or v_after !~ 'sale_catalogue_projection_is_live\('
       or v_after !~ 'catalogue_quarantined' then
      raise exception using
        errcode = 'P0001',
        message = format(
          'Unexpected definition of public.%s; catalogue visibility without raw_payload was not installed.',
          v_view_name
        );
    end if;
    -- Les options (security_invoker, security_barrier) sont celles de la vue actuelle.
    if v_after <> v_before then
      execute 'create or replace view public.' || quote_ident(v_view_name)
        || case when coalesce(v_view_options, '') <> '' then ' with (' || v_view_options || ')' else '' end
        || ' as ' || rtrim(v_after, E';\n ');
    end if;
  end loop;

  if v_views <> 2 then
    raise exception using
      errcode = '42P01',
      message = 'Missing public.v_auction_sales_app or public.v_auction_sales_discovery.';
  end if;
end;
$rewrite$;

notify pgrst, 'reload schema';

commit;
