begin;

set local lock_timeout = '5s';

-- n° 26 : le drapeau probable_duplicate arrive au navigateur.
--
-- Le pipeline (services/data-pipeline/src/probable_duplicates.py) pose probable_duplicate dans quality_flags sur les
-- ventes qui sont probablement la copie d'une autre ligne du catalogue (celles que le balayage des doublons
-- supprimerait, sans fusion ni suppression), et le retire quand la condition disparaît. La fiche refuse la vue
-- aérienne « bâtiment » d'une vente marquée : deux copies peuvent porter des points différents.
--
-- Les vues « découverte » (v_auction_sales_discovery, v_auction_sales_unlocked) n'exposent de quality_flags que la
-- liste blanche d'app_private.public_position_quality_flags (migration 20261101110000, seule définition de la
-- fonction : aucune autre migration ne l'a modifiée depuis). Cette migration la redéfinit en entier avec un drapeau de
-- plus ; tout autre drapeau (qualité du texte, prix, conflits, tribunal...) reste privé. Ni les vues, ni les droits
-- de colonne de auction_sales ne changent : la fonction est lue à chaque requête.
--
-- Droits inchangés : fonction appelée avec les droits de l'appelant, exécutable par authenticated et service_role,
-- jamais par anon.

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
    'missing_address',
    'probable_duplicate'
  ]);
$$;

comment on function app_private.public_position_quality_flags(pg_catalog.jsonb) is
  'The flags of quality_flags that the discovery and unlocked views may show: the position flags (implausible_coordinates, unverified_source_coordinates, geocode_outside_department, missing_address) and probable_duplicate; every other flag stays private.';

revoke all on function app_private.public_position_quality_flags(pg_catalog.jsonb)
  from public, anon, authenticated;
grant execute on function app_private.public_position_quality_flags(pg_catalog.jsonb)
  to authenticated, service_role;

do $grants$
begin
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'lovable_readonly') then
    execute 'grant execute on function app_private.public_position_quality_flags(pg_catalog.jsonb) to lovable_readonly';
  end if;
end;
$grants$;

commit;
