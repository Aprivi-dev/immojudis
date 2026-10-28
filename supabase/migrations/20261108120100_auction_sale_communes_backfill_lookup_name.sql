begin;

set local lock_timeout = '5s';
-- Même borne que le premier remplissage (20261106100100) : une passe de lecture sur les ventes à venir, annulée
-- en bloc si elle dépasse 30 s.
set local statement_timeout = '30s';

-- Deuxième passe du remplissage du code commune, avec le nom de RECHERCHE (app_private.commune_lookup_name,
-- migration 20261108120000) : les ventes dont la ville est « Paris 8ème », « Marseille 8e », « Lyon 3e
-- arrondissement », « Lyon Cedex 03 » ou « Saint-Denis La Réunion » n'avaient trouvé aucune commune aux étapes 2 et 3
-- de la première passe (compte-rendu du 27/10/2026, proposition n° 47).
--
-- Mêmes règles que le pipeline (src/municipality_location.find_commune) :
--   * code postal ET nom de recherche, une seule commune possible ;
--   * à défaut, département ET nom de recherche, seulement sans code postal valide, pour un Cedex ou pour un code
--     postal générique (xx000, comme 13000 ou 69000) : le code postal n'est alors pas l'un de ceux de la commune.
-- Le département manquant se déduit du code postal dans ces deux derniers cas.
--
-- Rejouable et conservatrice comme la première : on conflict do nothing, aucune ligne existante n'est modifiée (un
-- code posé par le pipeline ou par la première passe reste), rien n'est écrit dans auction_sales. L'arrondissement
-- se déduit du code postal (750NN, 75116, 130NN, 6900N) ou, à défaut, du nombre écrit dans la ville (« Marseille 8e »).

create or replace function app_private.commune_arrondissement(
  p_commune text,
  p_postal_code text,
  p_city text
)
returns text
language plpgsql
stable
security invoker
set search_path = ''
as $function$
declare
  v_number integer;
  v_match text[];
  v_name text;
begin
  if p_commune not in ('75056', '13055', '69123') then
    return null;
  end if;
  -- 1. code postal
  if p_commune = '75056' then
    if p_postal_code = '75116' then
      return '75116';
    elsif p_postal_code ~ '^750(0[1-9]|1[0-9]|20)$' then
      return '751' || pg_catalog.substr(p_postal_code, 4, 2);
    end if;
  elsif p_commune = '13055' and p_postal_code ~ '^130(0[1-9]|1[0-6])$' then
    return '132' || pg_catalog.substr(p_postal_code, 4, 2);
  elsif p_commune = '69123' and p_postal_code ~ '^6900[1-9]$' then
    return '6938' || pg_catalog.substr(p_postal_code, 5, 1);
  end if;
  -- 2. nombre écrit dans la ville
  v_name := app_private.normalize_commune_name(p_city);
  v_match := pg_catalog.regexp_match(v_name, '\y([0-9]{1,2}) ?(er|ere|e|eme)\y');
  if v_match is null then
    v_match := pg_catalog.regexp_match(v_name, '^(?:paris|lyon|marseille) ([0-9]{1,2})$');
  end if;
  if v_match is null then
    return null;
  end if;
  v_number := v_match[1]::integer;
  if p_commune = '75056' and v_number between 1 and 20 then
    return '751' || pg_catalog.lpad(v_number::text, 2, '0');
  elsif p_commune = '13055' and v_number between 1 and 16 then
    return '132' || pg_catalog.lpad(v_number::text, 2, '0');
  elsif p_commune = '69123' and v_number between 1 and 9 then
    return '6938' || v_number::text;
  end if;
  return null;
end;
$function$;

revoke all on function app_private.commune_arrondissement(text, text, text) from public, anon, authenticated;
grant execute on function app_private.commune_arrondissement(text, text, text) to service_role;

comment on function app_private.commune_arrondissement(text, text, text) is
  'Arrondissement (751xx, 132xx, 6938x) d''une vente de Paris, Marseille ou Lyon : d''après le code postal (750NN, 75116, 130NN, 6900N), sinon d''après le nombre écrit dans la ville (« Marseille 8e »). Nul ailleurs. Jumeau de src/commune_insee._arrondissement du pipeline, sauf les chiffres romains (« Paris XVIe »), que seul le pipeline lit.';

-- 1. Code postal ET nom de recherche ------------------------------------------------------------------------
insert into public.auction_sale_communes (sale_id, commune_insee, arrondissement_insee, source)
select
  s.id,
  match.code_insee,
  app_private.commune_arrondissement(match.code_insee, s.postal_code, s.city),
  'reference_communes'
from public.auction_sales s
cross join lateral (select app_private.commune_lookup_name(s.city) as name) n
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

-- 2. Département ET nom de recherche (sans code postal valide, Cedex ou code postal générique) -------------------
insert into public.auction_sale_communes (sale_id, commune_insee, arrondissement_insee, source)
select
  s.id,
  match.code_insee,
  app_private.commune_arrondissement(match.code_insee, s.postal_code, s.city),
  'reference_communes'
from public.auction_sales s
cross join lateral (select app_private.commune_lookup_name(s.city) as name) n
cross join lateral (
  select
    coalesce(
      nullif(pg_catalog.upper(pg_catalog.btrim(s.department)), ''),
      case
        when s.postal_code ~ '^97[0-9]{3}$' then pg_catalog.left(s.postal_code, 3)
        when s.postal_code ~ '^[0-9]{5}$' then pg_catalog.left(s.postal_code, 2)
      end
    ) as code
) d
cross join lateral (
  select pg_catalog.min(c.code_insee) as code_insee, pg_catalog.count(*) as matches
  from public.reference_communes c
  where c.department_code = d.code
    and c.name_normalized = n.name
) match
where s.status = 'upcoming'
  and d.code is not null
  and n.name <> ''
  and match.matches = 1
  and (
    s.postal_code is null
    or s.postal_code !~ '^[0-9]{5}$'
    or s.postal_code ~ '000$'
    or pg_catalog.lower(s.city) ~ 'cedex'
  )
  and not exists (
    select 1 from public.auction_sale_communes existing where existing.sale_id = s.id
  )
on conflict (sale_id) do nothing;

notify pgrst, 'reload schema';

commit;
