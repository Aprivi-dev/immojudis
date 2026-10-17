begin;

set local lock_timeout = '5s';

-- 1/3 de « visibilité du catalogue sans relire raw_payload » (contexte dans 20261027100200).
--
-- Cette migration ne fait qu'ajouter trois colonnes nulles : sans valeur par défaut, c'est un
-- changement du catalogue de PostgreSQL, sans réécriture de la table et sans lecture de raw_payload.
-- Elle est séparée des suivantes parce que ALTER TABLE ... ADD COLUMN prend un verrou ACCESS EXCLUSIVE
-- sur auction_sales (lectures du catalogue comprises) qu'il garde jusqu'au COMMIT : tout ce qui est
-- long (le rattrapage qui relit raw_payload, la réécriture des vues) se fait dans une autre
-- transaction, après que ce verrou a été relâché.
--
-- À APPLIQUER HORS COLLECTE, comme les deux suivantes : le verrou attend la fin des transactions en
-- cours sur la table, et lock_timeout (5 s) fait échouer la migration plutôt que de laisser le
-- catalogue s'empiler derrière elle. Un échec est sans effet : relancer la migration. Les trois
-- colonnes restent nulles et inutilisées tant que 20261027100100 n'a pas posé les déclencheurs.

alter table public.auction_sales
  add column if not exists catalogue_expiry_fallback timestamptz,
  add column if not exists catalogue_state_observed_at timestamptz,
  add column if not exists catalogue_state_end_estimate date;

comment on column public.auction_sales.catalogue_expiry_fallback is
  'Matérialisé : app_private.sale_catalogue_expiry(sale_date, raw_payload || sale_procedure). Renseigné seulement quand catalogue_expiry_deadline est nul et sale_date renseignée ; la visibilité compare cette valeur à l''heure courante sans relire raw_payload.';
comment on column public.auction_sales.catalogue_state_observed_at is
  'Matérialisé : raw_payload.state_listing.observed_at d''une fiche cessions_etat active, quand sale_date et catalogue_expiry_deadline sont nuls. Nul sinon.';
comment on column public.auction_sales.catalogue_state_end_estimate is
  'Matérialisé : raw_payload.state_listing.listing_end_estimate (fin de publication estimée) de cette même fiche. Nul sinon, ou quand aucune fin n''est annoncée.';

commit;
