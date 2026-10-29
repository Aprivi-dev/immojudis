begin;

set local lock_timeout = '5s';

-- Une copie par URL source dans raw_payload.merged_sources (auction_sales, properties, judicial_sales).
--
-- Jusqu'au correctif de services/data-pipeline/src/dedupe.py (_with_merged_source), chaque run qui rapprochait
-- de nouveau les mêmes annonces ajoutait une copie complète de la charge de la source : le 29/10/2026, 388 ventes
-- portaient 707 copies en trop (47 Mo), dont une seule vente Licitor + Petites Affiches 150 fois (12,8 Mo, recopiés
-- à l'identique dans properties et judicial_sales). Chaque écriture de ces lignes faisait passer les déclencheurs
-- d'auction_sales sur tout le JSON ; les redémarrages de la base pour manque de mémoire coïncident avec les
-- collectes qui les réécrivaient.
--
-- On garde la dernière copie de chaque URL (la plus récente, comme le pipeline désormais), à sa place, et toute
-- entrée sans URL. Seul raw_payload change : ni content_hash, ni les colonnes suivies par l'historique, la date de
-- changement de contenu ou les files d'enrichissement ; aucune alerte ni relecture n'est déclenchée.

create function pg_temp.dedupe_merged_sources(entries jsonb)
returns jsonb
language sql
immutable
as $$
  select coalesce(jsonb_agg(entry.value order by entry.ordinality), '[]'::jsonb)
  from (
    select element.value,
           element.ordinality,
           element.value->>'source_url' as source_url,
           row_number() over (
             partition by element.value->>'source_url'
             order by element.ordinality desc
           ) as copy_rank
    from jsonb_array_elements(entries) with ordinality as element(value, ordinality)
  ) as entry
  where entry.source_url is null or entry.copy_rank = 1
$$;

update public.auction_sales sale
set raw_payload = jsonb_set(sale.raw_payload, '{merged_sources}', deduped.entries)
from (
  select id, pg_temp.dedupe_merged_sources(raw_payload->'merged_sources') as entries
  from public.auction_sales
  where jsonb_typeof(raw_payload->'merged_sources') = 'array'
) as deduped
where deduped.id = sale.id
  and jsonb_array_length(deduped.entries) < jsonb_array_length(sale.raw_payload->'merged_sources');

update public.properties property
set raw_payload = jsonb_set(property.raw_payload, '{merged_sources}', deduped.entries)
from (
  select id, pg_temp.dedupe_merged_sources(raw_payload->'merged_sources') as entries
  from public.properties
  where jsonb_typeof(raw_payload->'merged_sources') = 'array'
) as deduped
where deduped.id = property.id
  and jsonb_array_length(deduped.entries) < jsonb_array_length(property.raw_payload->'merged_sources');

update public.judicial_sales judicial
set raw_payload = jsonb_set(judicial.raw_payload, '{merged_sources}', deduped.entries)
from (
  select id, pg_temp.dedupe_merged_sources(raw_payload->'merged_sources') as entries
  from public.judicial_sales
  where jsonb_typeof(raw_payload->'merged_sources') = 'array'
) as deduped
where deduped.id = judicial.id
  and jsonb_array_length(deduped.entries) < jsonb_array_length(judicial.raw_payload->'merged_sources');

commit;
