-- REPARATION MANUELLE DE DONNEES, PAS UNE MIGRATION DE SCHEMA.
-- Ne pas placer ce fichier dans supabase/migrations : le workflow « Apply Supabase Migrations »
-- applique tout ce qui s'y trouve, sans essai. Procedure complete : supabase/repairs/README.md.
--
-- Chantier F, point 15 : point fantome d'Info-Encheres (44.40655, 6.061187).
--
-- NON APPLIQUEE : a relire, puis a lancer par le proprietaire du projet avec psql (psql 13 ou plus) :
--
--   psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/repairs/20261020130002_clear_info_encheres_phantom_point.sql
--       -> mode COMPTAGE SEULEMENT (defaut) : aucune ecriture, la transaction est annulee (rollback).
--   psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -v apply=1 -f supabase/repairs/20261020130002_clear_info_encheres_phantom_point.sql
--       -> mode APPLICATION : ecrit, dans une seule transaction.
--
-- Idempotente : une seconde execution ne trouve plus aucune ligne au point fantome.
--
-- Le site publie ce point quand son propre geocodage echoue (Alpes-de-Haute-Provence), quel que
-- soit le departement du bien. Le collecteur l'ecarte deja (sources/info_encheres.py,
-- _SITE_FALLBACK_COORDINATES) ; cette reparation nettoie les lignes collectees avant le filtre
-- (constatees le 2026-10-13 : 5ed06bd5, 8ff95700 et 3 ventes en quarantaine).
--
-- Ce que la reparation fait, sur les seules lignes source_name = 'info_encheres' situees au point :
--   - latitude et longitude -> NULL, drapeau missing_gps ajoute ;
--   - dans raw_payload : latitude, longitude, geo_precision retires, et la preuve de geocodage
--     (raw_payload->'geocode') retiree quand elle porte elle-meme ce point (une latitude ou une
--     longitude non numerique dans cette preuve est ignoree : la preuve est alors conservee) ;
--   - parcelles cadastrales trouvees sous ce point (public.auction_cadastre_parcels,
--     match_kind = 'point_intersection') supprimees apres copie dans app_private.
-- Elle ne geocode rien : le nouveau geocodage vient ensuite du recalcul (voir ci-dessous).
--
-- Apres l'application, lancer le workflow « Recompute Existing Sales » avec confirm_target=production,
-- source=info_encheres, dry_run=false (etape « Publish recomputed sales », qui geocode les ventes
-- sans coordonnees). Les ventes sans adresse exploitable restent sans point, ce qui est voulu.
--
-- A verifier avant et apres (lecture seule) :
--   select id, status, latitude, longitude
--     from public.auction_sales
--    where source_name = 'info_encheres'
--      and abs(latitude - 44.40655) < 0.000005 and abs(longitude - 6.061187) < 0.0000005;
--   (avant : 5 lignes environ ; apres l'application : 0 ligne ; apres le recalcul : 0 ligne)
--
-- Retour arriere : voir la fin du fichier.

\set ON_ERROR_STOP on
\if :{?apply}
\else
  \set apply off
\endif

\if :apply
  \echo === MODE APPLICATION : les ventes et parcelles seront modifiees ===
\else
  \echo === MODE COMPTAGE SEULEMENT : aucune ecriture. Relancer avec -v apply=1 pour appliquer. ===
\endif

begin;
set local lock_timeout = '5s';

-- Lignes au point fantome, calculees dans les deux modes. Les casts ne portent que sur des textes
-- numeriques : une valeur non numerique dans raw_payload->geocode n'est jamais lue comme un nombre.
create temporary table info_encheres_phantom_rows on commit drop as
select s.source_url,
       coalesce(
         case when s.raw_payload #>> '{geocode,latitude}' ~ '^-?[0-9]+(\.[0-9]+)?$'
              then abs((s.raw_payload #>> '{geocode,latitude}')::numeric - 44.40655) < 0.000005 end
         and
         case when s.raw_payload #>> '{geocode,longitude}' ~ '^-?[0-9]+(\.[0-9]+)?$'
              then abs((s.raw_payload #>> '{geocode,longitude}')::numeric - 6.061187) < 0.0000005 end,
         false) as geocode_at_point
  from public.auction_sales s
 where s.source_name = 'info_encheres'
   and abs(s.latitude - 44.40655) < 0.000005
   and abs(s.longitude - 6.061187) < 0.0000005;

-- Mode comptage : le plan est calcule, la transaction devient en lecture seule (rien ne s'ecrit
-- dans les tables) puis se termine par un rollback.
\if :apply
\else
  set transaction read only;
\endif

-- Comptage (les deux modes) : ce que l'application modifierait.
select count(*) as ventes_au_point_fantome,
       count(*) filter (where geocode_at_point) as dont_preuve_de_geocodage_a_retirer
  from info_encheres_phantom_rows;

select count(*) as parcelles_a_supprimer
  from public.auction_cadastre_parcels p
  join info_encheres_phantom_rows r on r.source_url = p.source_url
 where p.match_kind = 'point_intersection';

\if :apply
  create table if not exists app_private.info_encheres_phantom_point_backup_20261020 (
    source_url text primary key,
    latitude numeric,
    longitude numeric,
    quality_flags jsonb,
    raw_payload_point jsonb,
    backed_up_at timestamptz not null default now()
  );
  revoke all on app_private.info_encheres_phantom_point_backup_20261020 from public, anon, authenticated;

  create table if not exists app_private.info_encheres_phantom_parcels_backup_20261020
    (like public.auction_cadastre_parcels);
  revoke all on app_private.info_encheres_phantom_parcels_backup_20261020 from public, anon, authenticated;

  insert into app_private.info_encheres_phantom_point_backup_20261020
    (source_url, latitude, longitude, quality_flags, raw_payload_point)
  select s.source_url, s.latitude, s.longitude, s.quality_flags,
         jsonb_strip_nulls(jsonb_build_object(
           'latitude', s.raw_payload -> 'latitude',
           'longitude', s.raw_payload -> 'longitude',
           'geo_precision', s.raw_payload -> 'geo_precision',
           'geocode', case when r.geocode_at_point then s.raw_payload -> 'geocode' end))
    from public.auction_sales s
    join info_encheres_phantom_rows r using (source_url)
  on conflict (source_url) do nothing;

  insert into app_private.info_encheres_phantom_parcels_backup_20261020
  select p.*
    from public.auction_cadastre_parcels p
    join info_encheres_phantom_rows r on r.source_url = p.source_url
   where p.match_kind = 'point_intersection'
     and not exists (
       select 1 from app_private.info_encheres_phantom_parcels_backup_20261020 b where b.id = p.id
     );

  delete from public.auction_cadastre_parcels p
   using info_encheres_phantom_rows r
   where p.source_url = r.source_url
     and p.match_kind = 'point_intersection';

  update public.auction_sales s
     set latitude = null,
         longitude = null,
         quality_flags = case
           when coalesce(s.quality_flags, '[]'::jsonb) ? 'missing_gps' then coalesce(s.quality_flags, '[]'::jsonb)
           else coalesce(s.quality_flags, '[]'::jsonb) || '["missing_gps"]'::jsonb
         end,
         raw_payload = (coalesce(s.raw_payload, '{}'::jsonb) - 'latitude' - 'longitude' - 'geo_precision')
           - case when r.geocode_at_point then 'geocode' else '' end
    from info_encheres_phantom_rows r
   where s.source_url = r.source_url;

  \echo === Application terminee : relancer la requete de controle de l en-tete (0 ligne attendue). ===
\endif

\if :apply
  commit;
\else
  rollback;
\endif

-- Retour arriere (a executer a la main, hors de ce fichier) :
--   update public.auction_sales s
--      set latitude = b.latitude,
--          longitude = b.longitude,
--          quality_flags = b.quality_flags,
--          raw_payload = s.raw_payload || coalesce(b.raw_payload_point, '{}'::jsonb)
--     from app_private.info_encheres_phantom_point_backup_20261020 b
--    where s.source_url = b.source_url;
--   insert into public.auction_cadastre_parcels
--   select * from app_private.info_encheres_phantom_parcels_backup_20261020
--   on conflict do nothing;
