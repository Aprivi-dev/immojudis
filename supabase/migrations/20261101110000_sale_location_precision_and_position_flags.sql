begin;

set local lock_timeout = '5s';

-- n° 24 (partie SQL) : la précision de la position et les vrais drapeaux de position arrivent au navigateur.
--
-- Le pipeline range le niveau de précision du point dans raw_payload->>'geo_precision' (address, parcel, street,
-- municipality) ; ni la vue de la fiche ni les deux vues « découverte » ne l'exposaient. La fiche ne pouvait donc
-- pas distinguer une adresse exacte d'un centre de commune. Cette migration ajoute, en DERNIÈRE colonne de
-- v_auction_sales_app, v_auction_sales_discovery et v_auction_sales_unlocked :
--
--   location_precision text  -- 'address' | 'parcel' | 'street' | 'municipality' | null
--
-- (null : précision inconnue, par exemple un point fourni par la source). Le contrat de nom est fixé avec le
-- chantier TypeScript : la colonne s'appelle exactement location_precision.
--
-- Les deux vues « découverte » (v_auction_sales_discovery, v_auction_sales_unlocked) projetaient en outre
-- '[]'::jsonb as quality_flags : la garde de la vue aérienne (qui refuse un point douteux) ne voyait jamais un
-- drapeau pour un compte gratuit. Elles exposent maintenant, de quality_flags, UNIQUEMENT les drapeaux de
-- position de la liste blanche ci-dessous ; tous les autres (qualité du texte, doublons, prix, conflits, tribunal...)
-- restent privés, comme avant. La vue de la fiche (Analyse) expose déjà s.quality_flags en entier.
--
-- Droits : aucune colonne de auction_sales n'est ouverte de plus. Les vues « découverte » sont des vues
-- security definer (elles lisent la table avec les droits de leur propriétaire) ; la vue de la fiche est
-- security invoker et lisait déjà raw_payload et quality_flags (droits de colonne de 20261010003000). Les deux
-- fonctions ci-dessous sont appelées avec les droits de l'appelant : elles sont accordées à authenticated et
-- service_role, comme les autres fonctions de projection de ces vues.
--
-- Les définitions actuelles des vues ont été réécrites sur place par plusieurs migrations (prédicat de
-- visibilité, quarantaine...) : on les relit (pg_get_viewdef) au lieu de les recopier, et on refuse de continuer
-- si leur forme n'est pas celle attendue. Options (security_invoker, security_barrier), droits et commentaires des
-- vues sont conservés par create or replace view. Les vues de recherche (*_search) listent leurs colonnes et ne
-- changent pas ; leur quality_flags suit celui de la vue découverte. Rejouable : une vue déjà à jour est laissée.

create or replace function app_private.sale_location_precision(p_raw_payload pg_catalog.jsonb)
returns text
language sql
immutable
parallel safe
security invoker
set search_path = ''
as $$
  select case pg_catalog.lower(pg_catalog.btrim(p_raw_payload ->> 'geo_precision'))
    when 'address' then 'address'
    when 'parcel' then 'parcel'
    when 'street' then 'street'
    when 'municipality' then 'municipality'
    else null
  end;
$$;

comment on function app_private.sale_location_precision(pg_catalog.jsonb) is
  'Position precision of a sale (raw_payload->>geo_precision) restricted to address, parcel, street, municipality; null when unknown or unrecognised. Exposed as location_precision by the three sale views.';

-- Liste blanche des drapeaux de position visibles par un compte gratuit : les trois du contrôle de position du
-- pipeline (voir services/data-pipeline/src/position_quality.py) et missing_address. Un nouveau drapeau de
-- position se publie en l'ajoutant ici, avec un test.
create or replace function app_private.public_position_quality_flags(p_flags pg_catalog.jsonb)
returns pg_catalog.jsonb
language sql
immutable
parallel safe
security invoker
set search_path = ''
as $$
  select coalesce(
    pg_catalog.jsonb_agg(flag.value order by flag.ordinality),
    '[]'::pg_catalog.jsonb
  )
  from pg_catalog.jsonb_array_elements_text(
    case
      when pg_catalog.jsonb_typeof(p_flags) = 'array' then p_flags
      else '[]'::pg_catalog.jsonb
    end
  ) with ordinality as flag(value, ordinality)
  where flag.value = any (array[
    'implausible_coordinates',
    'unverified_source_coordinates',
    'geocode_outside_department',
    'missing_address'
  ]);
$$;

comment on function app_private.public_position_quality_flags(pg_catalog.jsonb) is
  'The position flags of quality_flags that the discovery and unlocked views may show (implausible_coordinates, unverified_source_coordinates, geocode_outside_department, missing_address); every other flag stays private.';

revoke all on function app_private.sale_location_precision(pg_catalog.jsonb)
  from public, anon, authenticated;
grant execute on function app_private.sale_location_precision(pg_catalog.jsonb)
  to authenticated, service_role;
revoke all on function app_private.public_position_quality_flags(pg_catalog.jsonb)
  from public, anon, authenticated;
grant execute on function app_private.public_position_quality_flags(pg_catalog.jsonb)
  to authenticated, service_role;

do $grants$
begin
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'lovable_readonly') then
    execute 'grant execute on function app_private.sale_location_precision(pg_catalog.jsonb) to lovable_readonly';
    execute 'grant execute on function app_private.public_position_quality_flags(pg_catalog.jsonb) to lovable_readonly';
  end if;
end;
$grants$;

do $rewrite$
declare
  -- Dernière colonne : le seul « FROM » de plus haut niveau de la définition est celui précédé d'exactement trois
  -- espaces en début de ligne (les sous-requêtes des jointures latérales sont plus indentées).
  v_top_level_from constant text := E'\n   FROM ';
  v_flags_literal constant text := $re$'\[\]'::jsonb\s+AS\s+quality_flags\M$re$;
  v_flags_new constant text := 'app_private.public_position_quality_flags(s.quality_flags) AS quality_flags';
  v_precision_new constant text :=
    E',\n    app_private.sale_location_precision(s.raw_payload) AS location_precision';
  v_view_name text;
  v_before text;
  v_after text;
  v_options text;
  v_views integer := 0;
  v_position integer;
begin
  for v_view_name, v_before, v_options in
    select
      view_row.relname,
      pg_catalog.pg_get_viewdef(view_row.oid, true),
      pg_catalog.array_to_string(view_row.reloptions, ', ')
    from pg_catalog.pg_class view_row
    join pg_catalog.pg_namespace schema_row on schema_row.oid = view_row.relnamespace
    where schema_row.nspname = 'public'
      and view_row.relkind = 'v'
      and view_row.relname in (
        'v_auction_sales_app', 'v_auction_sales_discovery', 'v_auction_sales_unlocked'
      )
    order by view_row.relname
  loop
    v_views := v_views + 1;
    v_after := v_before;

    -- Drapeaux de position : seulement dans les deux vues « découverte ».
    if v_view_name in ('v_auction_sales_discovery', 'v_auction_sales_unlocked')
       and v_after !~ 'public_position_quality_flags' then
      if v_after !~* v_flags_literal then
        raise exception using
          errcode = 'P0001',
          message = format(
            'Unexpected definition of public.%s: no empty quality_flags projection to replace.',
            v_view_name
          );
      end if;
      v_after := regexp_replace(v_after, v_flags_literal, v_flags_new, 'gi');
    end if;

    -- Précision de la position : dernière colonne des trois vues.
    if v_after !~ 'AS location_precision' then
      v_position := position(v_top_level_from in v_after);
      if v_position = 0
         or position(v_top_level_from in substr(v_after, v_position + 1)) <> 0 then
        raise exception using
          errcode = 'P0001',
          message = format(
            'Unexpected definition of public.%s: cannot find its single top-level FROM.',
            v_view_name
          );
      end if;
      v_after := substr(v_after, 1, v_position - 1) || v_precision_new || substr(v_after, v_position);
    end if;

    if v_after <> v_before then
      execute 'create or replace view public.' || quote_ident(v_view_name)
        || case when coalesce(v_options, '') <> '' then ' with (' || v_options || ')' else '' end
        || ' as ' || rtrim(v_after, E';\n ');
    end if;
  end loop;

  if v_views <> 3 then
    raise exception using
      errcode = '42P01',
      message = 'Missing public.v_auction_sales_app, v_auction_sales_discovery or v_auction_sales_unlocked.';
  end if;
end;
$rewrite$;

notify pgrst, 'reload schema';

commit;
