begin;

set local lock_timeout = '5s';

-- Recopie horaire du code commune du pipeline (chantier W2a, n° 51).
--
-- AVANT : `syncSaleCommunes` (src/lib/sale-communes-sync.server.ts) relisait chaque heure, par pages de 1 000,
-- `raw_payload->commune` de toutes les ventes à venir (une colonne de plusieurs dizaines de ko à plusieurs Mo par
-- vente, entièrement décompressée pour en extraire une clé), comparait en JavaScript, puis écrivait par paquets de
-- 200 lignes, chaque écriture pouvant attendre un verrou de ligne de la publication du pipeline.
--
-- MAINTENANT : une fonction `service_role`, une seule instruction, sur le modèle du remplissage initial
-- (20261106100100). Elle lit `raw_payload->commune` des ventes à venir DANS la base, applique les mêmes règles que
-- `pipelineCommuneOf` (code à 5 caractères, source connue, arrondissement valable pour SA commune, sinon aucun
-- arrondissement), ne retient que les lignes nouvelles ou changées (code commune ou arrondissement), et n'écrit que
-- celles-là. Les ventes dont la ligne est verrouillée en écriture par une autre transaction (suppression, changement
-- d'URL) sont sautées (`for key share skip locked`), sans attente : elles repartent à la passe suivante. Seules les
-- lignes à écrire sont verrouillées, pas les ~2 000 ventes à venir.
--
-- Un déclencheur sur `auction_sales` aurait écrit la table au fil des publications, mais il alourdirait le chemin
-- chaud de la publication du pipeline (et son échec bloquerait la publication) : la fonction horaire est plus sûre.
--
-- Rend : `n_with_code` (ventes à venir avec un code lisible), `n_changed` (lignes nouvelles ou modifiées),
-- `n_written` (lignes écrites ; la différence avec `n_changed` est le nombre de ventes sautées car verrouillées).
--
-- DÉPLOIEMENT : le code fonctionne avant cette migration (fonction absente : la recopie est sautée, la table et son
-- remplissage initial restent lisibles). Ordre de mise en production : code, puis cette migration.
-- RETOUR ARRIÈRE : drop function public.sync_sale_communes();

create or replace function public.sync_sale_communes()
returns table (n_with_code integer, n_changed integer, n_written integer)
language sql
volatile
security invoker
set search_path = ''
set lock_timeout = '3s'
as $function$
  with parsed as (
    select
      s.id,
      pg_catalog.upper(pg_catalog.btrim(x.c ->> 'insee')) as insee,
      case
        when pg_catalog.jsonb_typeof(x.c -> 'arrondissement_insee') = 'string'
          then pg_catalog.upper(pg_catalog.btrim(x.c ->> 'arrondissement_insee'))
        else ''
      end as arrondissement,
      x.c ->> 'source' as source
    from public.auction_sales s
    cross join lateral (select s.raw_payload -> 'commune' as c) x
    where s.status = 'upcoming'
      and pg_catalog.jsonb_typeof(x.c) = 'object'
      and pg_catalog.jsonb_typeof(x.c -> 'insee') = 'string'
      and pg_catalog.jsonb_typeof(x.c -> 'source') = 'string'
      and x.c ->> 'source' in ('geocode', 'reference_communes')
  ),
  resolved as (
    select
      p.id,
      p.insee,
      -- Exactement la contrainte auction_sale_communes_arrondissement_check : sinon, la commune seule.
      case
        when (p.insee = '75056' and p.arrondissement ~ '^751(0[1-9]|1[0-9]|20)$')
          or (p.insee = '13055' and p.arrondissement ~ '^132(0[1-9]|1[0-6])$')
          or (p.insee = '69123' and p.arrondissement ~ '^6938[1-9]$')
        then p.arrondissement
      end as arrondissement,
      p.source
    from parsed p
    where p.insee ~ '^[0-9][0-9AB][0-9]{3}$'
  ),
  changed as (
    select r.id, r.insee, r.arrondissement, r.source
    from resolved r
    left join public.auction_sale_communes e on e.sale_id = r.id
    where e.sale_id is null
      or (e.commune_insee, e.arrondissement_insee) is distinct from (r.insee, r.arrondissement)
  ),
  locked as (
    select a.id
    from public.auction_sales a
    where a.id in (select c.id from changed c)
    for key share skip locked
  ),
  written as (
    insert into public.auction_sale_communes as t
      (sale_id, commune_insee, arrondissement_insee, source, resolved_at)
    select c.id, c.insee, c.arrondissement, c.source, pg_catalog.now()
    from changed c
    join locked l on l.id = c.id
    on conflict (sale_id) do update
      set commune_insee = excluded.commune_insee,
          arrondissement_insee = excluded.arrondissement_insee,
          source = excluded.source,
          resolved_at = excluded.resolved_at
      where (t.commune_insee, t.arrondissement_insee)
        is distinct from (excluded.commune_insee, excluded.arrondissement_insee)
    returning 1
  )
  select
    (select pg_catalog.count(*) from resolved)::integer,
    (select pg_catalog.count(*) from changed)::integer,
    (select pg_catalog.count(*) from written)::integer;
$function$;

revoke all on function public.sync_sale_communes() from public, anon, authenticated;
grant execute on function public.sync_sale_communes() to service_role;

comment on function public.sync_sale_communes() is
  'Recopie le code commune du pipeline (raw_payload.commune) des ventes à venir dans auction_sale_communes, en une instruction, en n''écrivant que les lignes nouvelles ou changées et en sautant sans attente les ventes verrouillées en écriture (service_role seul). Rend (ventes avec code, lignes à écrire, lignes écrites).';

notify pgrst, 'reload schema';

commit;
