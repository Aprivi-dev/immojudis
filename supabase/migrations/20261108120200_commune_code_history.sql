begin;

set local lock_timeout = '5s';

-- Table de passage des codes commune (compte-rendu du 27/10/2026, proposition n° 48).
--
-- POURQUOI : la carte des loyers de l'ANIL et le zonage tendu sont publiés dans un millésime du code officiel
-- géographique (COG 2025 aujourd'hui), alors que la BAN et reference_communes (geo.api.gouv.fr) passent aux nouveaux
-- codes dès qu'une commune nouvelle est créée. Les fusions décidées après les municipales de mars 2026 prendront
-- effet au 1er janvier 2027 : un code de vente nouveau n'aura plus de ligne ANIL (et un ancien code n'en aura plus
-- dans le prochain millésime). Cette table dit, pour chaque changement de code, de quel code on vient et vers quel
-- code on va ; la lecture des loyers (src/lib/rent-reference.server.ts) essaie le code d'arrivée puis le code de
-- départ quand le code de la vente n'a pas de ligne.
--
-- ALIMENTATION : python -m src.reference_data commune_history, depuis le fichier des mouvements de communes de
-- l'INSEE (v_mvt_commune_AAAA.csv, une ligne par commune et par événement : MOD 31 à 35 pour les fusions et les
-- créations de communes nouvelles, 41 et 50 pour les changements de code). Le chargeur n'est PAS exécuté par cette
-- migration : la table naît vide, et la lecture des loyers se comporte alors exactement comme avant.
--
-- DROITS : table privée (schéma app_private, hors de l'API de données), RLS activée, aucun droit pour anon ni
-- authenticated. La lecture passe par public.commune_code_aliases, réservée au rôle de service.
--
-- RETOUR ARRIÈRE : drop function public.commune_code_aliases(text[]) puis drop table app_private.commune_code_history
-- (la lecture des loyers traite « fonction absente » comme « aucun passage »).

create table if not exists app_private.commune_code_history (
  old_code text not null check (old_code ~ '^[0-9][0-9AB][0-9]{3}$'),
  new_code text not null check (new_code ~ '^[0-9][0-9AB][0-9]{3}$'),
  effective_on date not null,
  -- MOD de l'INSEE : 31 fusion simple, 32 création de commune nouvelle, 33 fusion avec communes associées,
  -- 34 transformation d'une fusion avec associées en fusion simple, 35 rattachement à une commune nouvelle existante,
  -- 41 changement de département, 50 transfert de chef-lieu.
  modality text not null check (modality in ('31', '32', '33', '34', '35', '41', '50')),
  imported_at timestamptz not null default now(),
  primary key (old_code, new_code, effective_on),
  check (old_code <> new_code)
);

create index if not exists commune_code_history_new_code_idx
  on app_private.commune_code_history (new_code);

comment on table app_private.commune_code_history is
  'Passage d''un code commune à un autre (fusions, changements de code), depuis le fichier des mouvements de communes de l''INSEE. Lu par public.commune_code_aliases pour retrouver une ligne ANIL ou de zonage publiée sous l''autre code.';
comment on column app_private.commune_code_history.modality is
  'MOD de l''INSEE : 31 à 35 fusions et communes nouvelles, 41 changement de département, 50 transfert de chef-lieu.';

alter table app_private.commune_code_history enable row level security;

revoke all on table app_private.commune_code_history from public, anon, authenticated;
grant select, insert, update, delete on table app_private.commune_code_history to service_role;
grant usage on schema app_private to service_role;

drop policy if exists commune_code_history_service_role on app_private.commune_code_history;
create policy commune_code_history_service_role
  on app_private.commune_code_history
  for all to service_role
  using (true)
  with check (true);

-- Codes équivalents d'une liste de codes : les codes d'arrivée (direction « new », en suivant les chaînes jusqu'à
-- 4 étapes) puis les codes de départ (direction « old »). Un code sans passage ne donne aucune ligne.
-- SECURITY INVOKER : le rôle de service lit la table ; aucun autre rôle n'a de droit dessus.
create or replace function public.commune_code_aliases(p_codes text[])
returns table (code text, alias text, direction text, depth integer)
language sql
stable
set search_path = ''
as $function$
  with recursive wanted as (
    select pg_catalog.upper(pg_catalog.btrim(c)) as code
    from pg_catalog.unnest(
      case when pg_catalog.cardinality(p_codes) <= 500 then p_codes else '{}'::text[] end
    ) as c
  ),
  forward as (
    select h.old_code as code, h.new_code as alias, 1 as depth, array[h.old_code, h.new_code] as path
    from app_private.commune_code_history h
    where h.old_code in (select code from wanted)
    union all
    select f.code, h.new_code, f.depth + 1, f.path || h.new_code
    from forward f
    join app_private.commune_code_history h on h.old_code = f.alias
    where f.depth < 4 and not (h.new_code = any (f.path))
  ),
  backward as (
    select h.new_code as code, h.old_code as alias, 1 as depth, array[h.new_code, h.old_code] as path
    from app_private.commune_code_history h
    where h.new_code in (select code from wanted)
    union all
    select b.code, h.old_code, b.depth + 1, b.path || h.old_code
    from backward b
    join app_private.commune_code_history h on h.new_code = b.alias
    where b.depth < 4 and not (h.old_code = any (b.path))
  )
  select distinct on (code, alias, direction) code, alias, direction, depth
  from (
    select code, alias, 'new'::text as direction, depth from forward
    union all
    select code, alias, 'old'::text as direction, depth from backward
  ) all_aliases
  order by code, alias, direction, depth
  limit 5000;
$function$;

revoke all on function public.commune_code_aliases(text[]) from public, anon, authenticated;
grant execute on function public.commune_code_aliases(text[]) to service_role;

comment on function public.commune_code_aliases(text[]) is
  'Codes équivalents des codes demandés (500 au plus) : alias d''arrivée (new) puis de départ (old) d''après app_private.commune_code_history, chaînes suivies sur 4 étapes. Réservée au rôle de service.';

notify pgrst, 'reload schema';

commit;
