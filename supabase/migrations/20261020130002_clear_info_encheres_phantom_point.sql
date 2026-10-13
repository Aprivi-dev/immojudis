begin;

set local lock_timeout = '5s';

-- Chantier F, point 15 : point fantôme d'Info-Enchères (44.40655, 6.061187).
--
-- NON APPLIQUÉE : à relire, puis à lancer par le propriétaire du projet (npm run db:migrate).
-- Idempotente : une seconde exécution ne trouve plus aucune ligne au point fantôme.
--
-- Le site publie ce point quand son propre géocodage échoue (Alpes-de-Haute-Provence), quel que
-- soit le département du bien. Le collecteur l'écarte déjà (sources/info_encheres.py,
-- _SITE_FALLBACK_COORDINATES) ; cette migration nettoie les lignes collectées avant le filtre
-- (constatées le 2026-10-13 : 5ed06bd5, 8ff95700 et 3 ventes en quarantaine).
--
-- Ce que la migration fait, sur les seules lignes source_name = 'info_encheres' situées au point :
--   - latitude et longitude -> NULL, drapeau missing_gps ajouté ;
--   - dans raw_payload : latitude, longitude, geo_precision retirés, et la preuve de géocodage
--     (raw_payload->'geocode') retirée quand elle porte elle-même ce point ;
--   - parcelles cadastrales trouvées sous ce point (public.auction_cadastre_parcels,
--     match_kind = 'point_intersection') supprimées après copie dans app_private.
-- Elle ne géocode rien : le nouveau géocodage vient ensuite du recalcul (voir ci-dessous).
--
-- Après la migration, lancer le workflow « Recompute Existing Sales » avec confirm_target=production,
-- source=info_encheres, dry_run=false (étape « Publish recomputed sales », qui géocode les ventes
-- sans coordonnées). Les ventes sans adresse exploitable restent sans point, ce qui est voulu.
--
-- À vérifier avant et après (lecture seule) :
--   select id, status, latitude, longitude
--     from public.auction_sales
--    where source_name = 'info_encheres'
--      and abs(latitude - 44.40655) < 0.000005 and abs(longitude - 6.061187) < 0.0000005;
--   (avant : 5 lignes environ ; après la migration : 0 ligne ; après le recalcul : 0 ligne)
--
-- Retour arrière : voir la fin du fichier.

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

create temporary table info_encheres_phantom_rows on commit drop as
select s.source_url
  from public.auction_sales s
 where s.source_name = 'info_encheres'
   and abs(s.latitude - 44.40655) < 0.000005
   and abs(s.longitude - 6.061187) < 0.0000005;

insert into app_private.info_encheres_phantom_point_backup_20261020
  (source_url, latitude, longitude, quality_flags, raw_payload_point)
select s.source_url, s.latitude, s.longitude, s.quality_flags,
       jsonb_strip_nulls(jsonb_build_object(
         'latitude', s.raw_payload -> 'latitude',
         'longitude', s.raw_payload -> 'longitude',
         'geo_precision', s.raw_payload -> 'geo_precision',
         'geocode', case
           when abs(coalesce((s.raw_payload #>> '{geocode,latitude}')::numeric, 0) - 44.40655) < 0.000005
            and abs(coalesce((s.raw_payload #>> '{geocode,longitude}')::numeric, 0) - 6.061187) < 0.0000005
           then s.raw_payload -> 'geocode'
         end))
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
         - case
             when abs(coalesce((s.raw_payload #>> '{geocode,latitude}')::numeric, 0) - 44.40655) < 0.000005
              and abs(coalesce((s.raw_payload #>> '{geocode,longitude}')::numeric, 0) - 6.061187) < 0.0000005
             then 'geocode'
             else ''
           end
  from info_encheres_phantom_rows r
 where s.source_url = r.source_url;

commit;

-- Retour arrière (à exécuter à la main, hors migration) :
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
