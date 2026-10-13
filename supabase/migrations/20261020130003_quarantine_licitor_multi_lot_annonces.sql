begin;

set local lock_timeout = '5s';

-- Chantier F, point 16 : annonces Licitor en plusieurs lots dont la fiche affiche les valeurs du premier lot.
--
-- NON APPLIQUÉE : à relire, puis à lancer par le propriétaire du projet (npm run db:migrate).
-- Idempotente : une ligne déjà en quarantaine pour ce motif n'est pas retouchée.
--
-- Constat : pour une annonce Licitor en plusieurs lots, la fiche ne porte qu'UNE adresse, UNE mise à
-- prix et UN point (ceux du premier lot ; sources/licitor.py, parse_licitor_detail_html). Les lots
-- suivants ne vivent que dans raw_payload->'source_property_features'->'lots'. Pour dc67982d
-- (Échannay 2 000 € lot 1, Montoillot 5 000 € lot 2) la fiche affiche donc Échannay 2 000 €.
-- Corriger le code suppose de choisir un modèle (une ligne par lot, ou un agrégat) : décision de
-- produit non prise. En attendant, les 9 annonces sont retirées de l'affichage au lieu de montrer un
-- prix et une commune qui ne valent que pour un lot.
--
-- Ce que la migration fait, sur les seules lignes source_name = 'licitor' dont l'identifiant
-- d'annonce figure dans la liste ci-dessous :
--   - status -> 'quarantined' (même mécanisme que hold_identity dans publication_identity.py) ;
--   - drapeau property_identity_conflict ajouté et raw_payload->'publication_identity_conflict'
--     renseigné : ces deux marques rendent la quarantaine durable, les collectes suivantes la
--     conservent (merge_revision) au lieu de remettre la vente à l'affichage.
-- L'état d'origine est copié dans app_private.licitor_multi_lot_quarantine_backup_20261020.
--
-- Annonces : 109863, 109968, 110081, 110098, 110145, 110156, 110160, 110164, 110177.
--
-- À vérifier avant et après (lecture seule) :
--   select id, status, city, starting_price_eur, quality_flags ? 'property_identity_conflict' as en_quarantaine
--     from public.auction_sales
--    where source_name = 'licitor'
--      and substring(source_url from '/([0-9]+)\.html') in
--          ('109863','109968','110081','110098','110145','110156','110160','110164','110177');
--   (le nombre de lignes peut être inférieur à 9 : une annonce échue ou retirée a pu quitter la base)
--
-- Retour arrière : voir la fin du fichier.

create table if not exists app_private.licitor_multi_lot_quarantine_backup_20261020 (
  source_url text primary key,
  status text,
  quality_flags jsonb,
  publication_identity_conflict jsonb,
  backed_up_at timestamptz not null default now()
);
revoke all on app_private.licitor_multi_lot_quarantine_backup_20261020 from public, anon, authenticated;

create temporary table licitor_multi_lot_rows on commit drop as
select s.source_url
  from public.auction_sales s
 where s.source_name = 'licitor'
   and substring(s.source_url from '/([0-9]+)\.html') in
       ('109863', '109968', '110081', '110098', '110145', '110156', '110160', '110164', '110177')
   and s.raw_payload #>> '{publication_identity_conflict,reason}' is distinct from 'licitor_multi_lot_first_lot_values';

insert into app_private.licitor_multi_lot_quarantine_backup_20261020
  (source_url, status, quality_flags, publication_identity_conflict)
select s.source_url, s.status, s.quality_flags, s.raw_payload -> 'publication_identity_conflict'
  from public.auction_sales s
  join licitor_multi_lot_rows r using (source_url)
on conflict (source_url) do nothing;

update public.auction_sales s
   set status = 'quarantined',
       quality_flags = case
         when coalesce(s.quality_flags, '[]'::jsonb) ? 'property_identity_conflict' then s.quality_flags
         else coalesce(s.quality_flags, '[]'::jsonb) || '["property_identity_conflict"]'::jsonb
       end,
       raw_payload = coalesce(s.raw_payload, '{}'::jsonb) || jsonb_build_object(
         'publication_identity_conflict',
         jsonb_build_object(
           'source_url', s.source_url,
           'reason', 'licitor_multi_lot_first_lot_values',
           'detail', 'Annonce en plusieurs lots : adresse, prix et point de la fiche ne valent que pour le premier lot.'
         ))
  from licitor_multi_lot_rows r
 where s.source_url = r.source_url;

commit;

-- Retour arrière (à exécuter à la main, hors migration) :
--   update public.auction_sales s
--      set status = b.status,
--          quality_flags = b.quality_flags,
--          raw_payload = case
--            when b.publication_identity_conflict is null then s.raw_payload - 'publication_identity_conflict'
--            else s.raw_payload || jsonb_build_object('publication_identity_conflict', b.publication_identity_conflict)
--          end
--     from app_private.licitor_multi_lot_quarantine_backup_20261020 b
--    where s.source_url = b.source_url;
