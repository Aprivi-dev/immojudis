-- REPARATION MANUELLE DE DONNEES, PAS UNE MIGRATION DE SCHEMA.
-- Ne pas placer ce fichier dans supabase/migrations : le workflow « Apply Supabase Migrations »
-- applique tout ce qui s'y trouve, sans essai. Procedure complete : supabase/repairs/README.md.
--
-- Chantier F, point 16 : annonces Licitor en plusieurs lots dont la fiche affiche les valeurs du premier lot.
--
-- NON APPLIQUEE : a relire, puis a lancer par le proprietaire du projet avec psql (psql 13 ou plus) :
--
--   psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/repairs/20261020130003_quarantine_licitor_multi_lot_annonces.sql
--       -> mode COMPTAGE SEULEMENT (defaut) : aucune ecriture, la transaction est annulee (rollback).
--   psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -v apply=1 -f supabase/repairs/20261020130003_quarantine_licitor_multi_lot_annonces.sql
--       -> mode APPLICATION : ecrit, dans une seule transaction.
--
-- Idempotente : une ligne deja en quarantaine pour ce motif n'est pas retouchee.
--
-- Constat : pour une annonce Licitor en plusieurs lots, la fiche ne porte qu'UNE adresse, UNE mise a
-- prix et UN point (ceux du premier lot ; sources/licitor.py, parse_licitor_detail_html). Les lots
-- suivants ne vivent que dans raw_payload->'source_property_features'->'lots'. Pour dc67982d
-- (Echannay 2 000 EUR lot 1, Montoillot 5 000 EUR lot 2) la fiche affiche donc Echannay 2 000 EUR.
-- Corriger le code suppose de choisir un modele (une ligne par lot, ou un agregat) : decision de
-- produit non prise. En attendant, les 9 annonces sont retirees de l'affichage au lieu de montrer un
-- prix et une commune qui ne valent que pour un lot.
--
-- Ce que la reparation fait, sur les seules lignes source_name = 'licitor' dont l'identifiant
-- d'annonce figure dans la liste ci-dessous :
--   - status -> 'quarantined' (meme mecanisme que hold_identity dans publication_identity.py) ;
--   - drapeau property_identity_conflict ajoute et raw_payload->'publication_identity_conflict'
--     renseigne : ces deux marques rendent la quarantaine durable, les collectes suivantes la
--     conservent (merge_revision) au lieu de remettre la vente a l'affichage.
-- L'etat d'origine est copie dans app_private.licitor_multi_lot_quarantine_backup_20261020.
--
-- Annonces : 109863, 109968, 110081, 110098, 110145, 110156, 110160, 110164, 110177.
--
-- A verifier avant et apres (lecture seule) :
--   select id, status, city, starting_price_eur, quality_flags ? 'property_identity_conflict' as en_quarantaine
--     from public.auction_sales
--    where source_name = 'licitor'
--      and substring(source_url from '/([0-9]+)\.html') in
--          ('109863','109968','110081','110098','110145','110156','110160','110164','110177');
--   (le nombre de lignes peut etre inferieur a 9 : une annonce echue ou retiree a pu quitter la base)
--
-- Retour arriere : voir la fin du fichier.

\set ON_ERROR_STOP on
\if :{?apply}
\else
  \set apply off
\endif

\if :apply
  \echo === MODE APPLICATION : les annonces seront mises en quarantaine ===
\else
  \echo === MODE COMPTAGE SEULEMENT : aucune ecriture. Relancer avec -v apply=1 pour appliquer. ===
\endif

begin;
set local lock_timeout = '5s';

-- Annonces concernees, calculees dans les deux modes.
create temporary table licitor_multi_lot_rows on commit drop as
select s.source_url
  from public.auction_sales s
 where s.source_name = 'licitor'
   and substring(s.source_url from '/([0-9]+)\.html') in
       ('109863', '109968', '110081', '110098', '110145', '110156', '110160', '110164', '110177')
   and s.raw_payload #>> '{publication_identity_conflict,reason}' is distinct from 'licitor_multi_lot_first_lot_values';

-- Mode comptage : le plan est calcule, la transaction devient en lecture seule (rien ne s'ecrit
-- dans les tables) puis se termine par un rollback.
\if :apply
\else
  set transaction read only;
\endif

-- Comptage (les deux modes) : ce que l'application modifierait (9 annonces au plus).
select count(*) as annonces_a_mettre_en_quarantaine from licitor_multi_lot_rows;

select left(s.id::text, 8) as id, s.status, s.city, s.starting_price_eur
  from public.auction_sales s
  join licitor_multi_lot_rows r using (source_url)
 order by s.source_url;

\if :apply
  create table if not exists app_private.licitor_multi_lot_quarantine_backup_20261020 (
    source_url text primary key,
    status text,
    quality_flags jsonb,
    publication_identity_conflict jsonb,
    backed_up_at timestamptz not null default now()
  );
  revoke all on app_private.licitor_multi_lot_quarantine_backup_20261020 from public, anon, authenticated;

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

  \echo === Application terminee : relancer la requete de controle de l en-tete. ===
\endif

\if :apply
  commit;
\else
  rollback;
\endif

-- Retour arriere (a executer a la main, hors de ce fichier) :
--   update public.auction_sales s
--      set status = b.status,
--          quality_flags = b.quality_flags,
--          raw_payload = case
--            when b.publication_identity_conflict is null then s.raw_payload - 'publication_identity_conflict'
--            else s.raw_payload || jsonb_build_object('publication_identity_conflict', b.publication_identity_conflict)
--          end
--     from app_private.licitor_multi_lot_quarantine_backup_20261020 b
--    where s.source_url = b.source_url;
