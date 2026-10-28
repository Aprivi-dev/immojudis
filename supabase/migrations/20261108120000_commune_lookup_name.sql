begin;

set local lock_timeout = '5s';

-- Nom de commune pour la RECHERCHE (jamais stocké) : ce que le libellé d'une vente ajoute au nom de la commune est
-- retiré avant la comparaison. « Paris 8ème », « Marseille 8e », « Lyon 3e arrondissement », « Lyon Cedex 03 » et
-- « Saint-Denis La Réunion » désignent des communes que reference_communes connaît sous « paris », « marseille »,
-- « lyon » et « saint denis » ; le repli par nom (migration 20261106100100, étapes 2 et 3, et pipeline) ne les
-- retrouvait pas (compte-rendu du 27/10/2026, proposition n° 47).
--
-- La colonne stockée reference_communes.name_normalized ne change pas : elle reste celle de
-- app_private.normalize_commune_name. Cette fonction en est le jumeau de recherche de
-- services/data-pipeline/src/reference_data/names.commune_lookup_name, qui suit les mêmes règles :
--   1. normalize_commune_name (sans « (33) » final, accents et ponctuation retirés, st/ste développés) ;
--   2. « cedex » et son numéro, un numéro d'arrondissement suivi de er/ere/e/eme, les mots « arrondissement » et
--      « arr » sont retirés ; un nom qui n'était fait que de cela reste tel quel ;
--   3. une région d'outre-mer finale (la reunion, reunion, guadeloupe, martinique, guyane, mayotte) est retirée,
--      sauf si ce qui reste est un article seul ;
--   4. « paris 15 », « lyon xvi » (chiffre ou chiffres romains après Paris, Lyon ou Marseille) donnent la ville.

create or replace function app_private.commune_lookup_name(p_name text)
returns text
language plpgsql
stable
security invoker
set search_path = ''
as $function$
declare
  v_name text;
  v_stripped text;
  v_without_region text;
begin
  v_name := app_private.normalize_commune_name(p_name);
  v_stripped := pg_catalog.regexp_replace(v_name, '\ycedex( [0-9]+)?\y', ' ', 'g');
  v_stripped := pg_catalog.regexp_replace(v_stripped, '\y[0-9]{1,2} ?(er|ere|e|eme)\y', ' ', 'g');
  v_stripped := pg_catalog.regexp_replace(v_stripped, '\y(arrondissement|arr)\y', ' ', 'g');
  v_stripped := pg_catalog.btrim(pg_catalog.regexp_replace(v_stripped, '\s+', ' ', 'g'));
  if v_stripped = '' then
    return v_name;
  end if;
  -- Le motif non glouton retire la PREMIÈRE région finale trouvée, comme le motif Python.
  v_without_region := pg_catalog.regexp_replace(
    v_stripped,
    '^(.*?\S) (la reunion|reunion|guadeloupe|martinique|guyane|mayotte)$',
    '\1'
  );
  if v_without_region not in ('la', 'le', 'les') then
    v_stripped := v_without_region;
  end if;
  return pg_catalog.regexp_replace(
    v_stripped,
    '^(paris|lyon|marseille) ([0-9]{1,2}|[ivx]{1,5}(er|ere|e|eme)?)$',
    '\1'
  );
end;
$function$;

revoke all on function app_private.commune_lookup_name(text) from public, anon, authenticated;
grant execute on function app_private.commune_lookup_name(text) to service_role;

comment on function app_private.commune_lookup_name(text) is
  'Nom de commune pour la recherche (jamais stocké) : comme normalize_commune_name, sans arrondissement, Cedex ni région d''outre-mer finale (« Paris 8ème » donne paris). Jumeau de src/reference_data/names.commune_lookup_name du pipeline.';

notify pgrst, 'reload schema';

commit;
