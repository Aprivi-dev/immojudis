begin;

set local lock_timeout = '5s';

-- Retrait explicite de 9 ventes Cessions (État) absentes de la source (alerte catalogue.source_absence.cessions_etat,
-- 05/11/2026 18:35, docs/runbooks/catalogue-source-absence.md).
--
-- La fonction de retrait automatique a refusé de les retirer : 9 sur 53 ventes visibles, soit 17 % (plafond 15 %).
-- Relecture des identifiants avant ce retrait :
--   * l'inventaire Cessions est complet et stable (229 annonces à chaque passage du 05/11), donc il n'est pas tronqué ;
--   * ces 9 ventes sont absentes d'au moins deux inventaires complets ; vues pour la dernière fois entre le 11/10
--     (Maison à Pau) et le 04/11 ;
--   * le site Cessions refuse les requêtes hors du collecteur (403), même pour des ventes en ligne : l'absence ne
--     peut pas être revérifiée page par page d'ici.
--
-- Même écriture que app_private.withdraw_missing_source_sales : statut withdrawn, statut précédent gardé dans
-- raw_payload.source_absence. Ne touche qu'une vente encore absente de Cessions et encore à venir ; une vente revue
-- entre-temps par l'inventaire (absent_inventories = 0) reste en place. Aucune ligne n'est supprimée.

update public.auction_sales sale
   set status = 'withdrawn',
       updated_at = statement_timestamp(),
       raw_payload = (
         case when pg_catalog.jsonb_typeof(sale.raw_payload) = 'object'
           then sale.raw_payload else '{}'::jsonb end
       ) || pg_catalog.jsonb_build_object(
         'source_absence', pg_catalog.jsonb_build_object(
           'source', 'cessions_etat',
           'status_before', sale.status,
           'withdrawn_at', statement_timestamp(),
           'absent_inventories', presence.absent_inventories,
           'decision', 'retrait explicite après relecture, migration 20261111110000'
         )
       )
  from app_private.auction_sale_source_presence presence
 where presence.sale_id = sale.id
   and presence.source_name = 'cessions_etat'
   and presence.absent_inventories >= 2
   and sale.source_name = 'cessions_etat'
   and coalesce(sale.status, 'unknown') in ('upcoming', 'unknown', 'postponed')
   and sale.id in (
     '0e0a261d-8f98-4c8c-b4f0-100ef6732be7',
     '1dbf0fff-1fc1-47e8-a616-7da4fc768d6d',
     '4b586b08-be9d-476b-aa5e-0ea24b9a7d5e',
     '5f3944e5-d71b-4dea-a750-7acc20f9a111',
     '603fb5c2-b969-46e7-a6ec-8421b97770ff',
     '666ce163-454d-4ed5-b6bb-9e6dd763f837',
     'c8dc0f5c-f465-4f9d-86da-b308d56075d8',
     'd1ba30f4-cd5b-4889-b932-0ce94cdf6681',
     'dabe472b-c2fe-45ab-95bb-00788829cda1'
   );

commit;
