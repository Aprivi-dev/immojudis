begin;

set local lock_timeout = '5s';

-- 1/3 de « date de modification fiable des fiches » (point 57 du compte-rendu du 18/10/2026).
--
-- Le sitemap et les données structurées (JSON-LD) des fiches annonçaient jusqu'ici `updated_at` comme
-- date de modification : or cette colonne bouge à chaque passage de la collecte, même sans le moindre
-- changement visible (journal, projections, relecture IA…). Une date de modification fausse apprend aux
-- moteurs à l'ignorer. Cette colonne porte la seule date qui compte : celle du dernier changement d'un
-- champ visible de la fiche (mise à prix, date de vente, statut, adresse, surface, pièces, photo).
--
-- Elle est NULLE au départ, et le reste jusqu'au premier changement visible après la pose de
-- 20261028100200 : « pas de date fiable » se dit par l'absence de date, jamais par une date inventée. Le
-- site n'émet alors ni `lastmod` ni `dateModified`.
--
-- Cette migration ne fait qu'ajouter une colonne nulle, sans valeur par défaut : un changement du
-- catalogue de PostgreSQL, sans réécriture de la table et sans lecture de raw_payload. Elle est séparée
-- des suivantes parce que ALTER TABLE ... ADD COLUMN prend un verrou ACCESS EXCLUSIVE sur auction_sales
-- (lectures du catalogue comprises) jusqu'au COMMIT. À APPLIQUER HORS COLLECTE : lock_timeout (5 s) fait
-- échouer la migration, sans effet, si le verrou n'est pas obtenu ; relancer.
--
-- Aucun droit n'est donné aux rôles du navigateur sur la colonne : seules les fonctions publiques de
-- 20261028100300 la lisent.

alter table public.auction_sales
  add column if not exists content_changed_at timestamptz;

comment on column public.auction_sales.content_changed_at is
  'Date du dernier changement d''un champ visible de la fiche (mise à prix, date de vente, statut, adresse, surface, pièces, photo principale), posée par le déclencheur zzzzzz_auction_sales_content_changed_at. Nulle tant qu''aucun changement n''a été vu : jamais une date inventée. Alimente lastmod du sitemap et dateModified du JSON-LD.';

commit;
