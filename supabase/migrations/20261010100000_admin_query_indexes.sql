begin;

set local lock_timeout = '5s';

-- P3-11 : index des requêtes les plus sollicitées par /api/admin/*.
--
-- Analyse EXPLAIN (sans ANALYZE) du 10 octobre 2026, détail dans
-- docs/audits/2026-10-10-admin-requetes-lourdes.md. Les tables lues par l'admin sont petites
-- (auction_sales 2 837 lignes, auction_runs environ 1 540, auction_pipeline_observations 21 989) : un seul
-- index est justifié.
--
-- auction_runs : le tableau de bord (section `runs`, relue toutes les 10 s tant qu'un run est
-- actif) et le rapport de qualité lisent les 25 / 20 derniers runs par created_at décroissant.
-- Seul idx_auction_runs_started_at existait : Postgres lisait toute la table (environ 1 540 lignes,
-- 1,2 Mo de heap, 66 Mo avec les JSON summary/errors) et la triait. Avec cet index, le coût
-- planifié passe de 205,9 à 3,2 et la lecture s'arrête après 25 lignes quel que soit
-- le nombre de runs.
-- La table est petite : la construction dans la transaction de migration est immédiate, donc
-- pas de CREATE INDEX CONCURRENTLY (incompatible avec la transaction du lanceur de migrations).
create index if not exists auction_runs_created_at_desc_idx
  on public.auction_runs (created_at desc nulls last);

commit;
