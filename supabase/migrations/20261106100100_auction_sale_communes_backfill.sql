begin;

set local lock_timeout = '5s';
-- Une seule passe de lecture sur les ventes à venir, bornée à 30 s : si elle dépassait, la migration échouerait sans effet
-- (la transaction est annulée) plutôt que de tenir la base. Aucune requête par ligne sans index : les jointures
-- sur reference_communes passent par son index GIN (postal_codes) ou par son index (department_code,
-- name_normalized).
set local statement_timeout = '30s';

-- Remplissage initial du code commune des ventes à venir (table 20261106100000), en SQL pur, sans appel externe :
--   1. le code commune du résultat de géocodage accepté (raw_payload.geocode.citycode) ;
--   2. à défaut, la commune de reference_communes retrouvée par code postal ET nom (la même règle que le pipeline,
--      src/municipality_location.find_commune : une commune sans ambiguïté, jamais une supposition) ;
--   3. à défaut de code postal, par département ET nom.
-- Les arrondissements (751xx, 132xx, 693xx) sont ramenés à la commune (75056, 13055, 69123) pour GASPAR ; le code de
-- l'arrondissement est gardé à part.
--
-- Cette migration n'écrit QUE dans la nouvelle table : aucune ligne de auction_sales n'est modifiée (aucun
-- déclencheur de la vente ne part, aucune date de mise à jour ne bouge). Elle est rejouable (on conflict do
-- nothing) : une ligne déjà posée, par le pipeline ou par une passe précédente, n'est jamais écrasée. Les ventes qui
-- passent « à venir » ensuite reçoivent leur code du pipeline (raw_payload.commune, recopié par le traitement
-- planifié).
--
-- NOTE DE REVUE : supabase/README.md (règle 2) range les réparations de données dans supabase/repairs/. Ce
-- remplissage n'en est pas une (il n'abîme ni ne corrige aucune ligne existante : il peuple une table neuve) ; il
-- est demandé en migration par le compte-rendu (proposition n° 2). S'il fallait suivre la règle à la lettre, ce
-- fichier se déplace tel quel dans supabase/repairs/.

-- Le nom de commune normalisé comme src/reference_data/names.normalize_commune_name (Python), qui a rempli
-- reference_communes.name_normalized : minuscules, sans accent ni ponctuation, « st »/« ste » développés ; sans la
-- mention finale « (33) ». Une ligature (œ, æ) n'a pas de décomposition en Python (NFKD) : elle y devient un
-- séparateur (« Cœuvres » donne « c uvres »), alors que unaccent la transcrit (« coeuvres »). Pour rester identique
-- à la colonne stockée, la fonction ci-dessous remplace d'abord œ et æ par une espace, comme le fait Python.
create extension if not exists unaccent with schema extensions;

create or replace function app_private.normalize_commune_name(p_name text)
returns text
language plpgsql
stable
security invoker
set search_path = ''
as $function$
declare
  v_name text;
begin
  v_name := pg_catalog.regexp_replace(
    coalesce(p_name, ''),
    '\s*\((?:\d{2}|2[AB]|97\d)\)\s*$',
    '',
    'i'
  );
  v_name := pg_catalog.translate(v_name, 'œŒæÆ', '    ');
  v_name := pg_catalog.lower(extensions.unaccent(v_name));
  v_name := pg_catalog.btrim(pg_catalog.regexp_replace(v_name, '[^a-z0-9]+', ' ', 'g'));
  if v_name like 'st %' then
    v_name := 'saint ' || pg_catalog.substr(v_name, 4);
  end if;
  v_name := pg_catalog.replace(v_name, ' st ', ' saint ');
  if v_name like 'ste %' then
    v_name := 'sainte ' || pg_catalog.substr(v_name, 5);
  end if;
  v_name := pg_catalog.replace(v_name, ' ste ', ' sainte ');
  return v_name;
end;
$function$;

revoke all on function app_private.normalize_commune_name(text) from public, anon, authenticated;
grant execute on function app_private.normalize_commune_name(text) to service_role;

comment on function app_private.normalize_commune_name(text) is
  'Nom de commune normalisé comme src/reference_data/names.normalize_commune_name du pipeline (minuscules, sans accent ni ponctuation, st/ste développés, sans « (33) » final, ligatures œ et æ traitées comme un séparateur) : sert au repli par code postal et nom.';

-- 1. Code commune du géocodage accepté ---------------------------------------------------------------------
insert into public.auction_sale_communes (sale_id, commune_insee, arrondissement_insee, source)
select
  s.id,
  case
    when g.code ~ '^751(0[1-9]|1[0-9]|20)$' then '75056'
    when g.code ~ '^132(0[1-9]|1[0-6])$' then '13055'
    when g.code ~ '^6938[1-9]$' then '69123'
    else g.code
  end,
  case
    when g.code ~ '^(751(0[1-9]|1[0-9]|20)|132(0[1-9]|1[0-6])|6938[1-9])$' then g.code
  end,
  case when g.provider = 'reference_communes' then 'reference_communes' else 'geocode' end
from public.auction_sales s
cross join lateral (
  select
    pg_catalog.upper(pg_catalog.btrim(s.raw_payload #>> '{geocode,citycode}')) as code,
    s.raw_payload #>> '{geocode,provider}' as provider
) g
where s.status = 'upcoming'
  and s.raw_payload #>> '{geocode,accepted}' = 'true'
  and g.code ~ '^[0-9][0-9AB][0-9]{3}$'
on conflict (sale_id) do nothing;

-- 2. Repli : code postal ET nom de commune, une seule commune possible -------------------------------------
insert into public.auction_sale_communes (sale_id, commune_insee, arrondissement_insee, source)
select s.id, match.code_insee, null, 'reference_communes'
from public.auction_sales s
cross join lateral (select app_private.normalize_commune_name(s.city) as name) n
cross join lateral (
  select pg_catalog.min(c.code_insee) as code_insee, pg_catalog.count(*) as matches
  from public.reference_communes c
  where c.postal_codes @> array[s.postal_code]
    and c.name_normalized = n.name
) match
where s.status = 'upcoming'
  and s.postal_code ~ '^[0-9]{5}$'
  and n.name <> ''
  and match.matches = 1
  and not exists (
    select 1 from public.auction_sale_communes existing where existing.sale_id = s.id
  )
on conflict (sale_id) do nothing;

-- 3. Repli sans code postal : département ET nom de commune, une seule commune possible ----------------------
insert into public.auction_sale_communes (sale_id, commune_insee, arrondissement_insee, source)
select s.id, match.code_insee, null, 'reference_communes'
from public.auction_sales s
cross join lateral (select app_private.normalize_commune_name(s.city) as name) n
cross join lateral (
  select pg_catalog.min(c.code_insee) as code_insee, pg_catalog.count(*) as matches
  from public.reference_communes c
  where c.department_code = pg_catalog.upper(pg_catalog.btrim(s.department))
    and c.name_normalized = n.name
) match
where s.status = 'upcoming'
  and (s.postal_code is null or s.postal_code !~ '^[0-9]{5}$')
  and s.department is not null
  and n.name <> ''
  and match.matches = 1
  and not exists (
    select 1 from public.auction_sale_communes existing where existing.sale_id = s.id
  )
on conflict (sale_id) do nothing;

notify pgrst, 'reload schema';

commit;
