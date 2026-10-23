-- REPARATION MANUELLE DE DONNEES, PAS UNE MIGRATION DE SCHEMA.
-- Ne pas placer ce fichier dans supabase/migrations : le workflow « Apply Supabase Migrations »
-- applique tout ce qui s'y trouve, sans essai (supabase/README.md, regle 2). Procedure : supabase/repairs/README.md.
--
-- Chantier W2, point 65 : points situes hors de leur departement (vente 85bf9c86..., Avoventes, Grasse :
-- point (54.27, -0.40), dans le Yorkshire, pour le departement 06).
--
-- NON APPLIQUEE : a relire, puis a lancer par le proprietaire du projet avec psql (psql 13 ou plus) :
--
--   psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/repairs/20261101110100_clear_points_outside_their_department.sql
--       -> mode COMPTAGE SEULEMENT (defaut) : liste les ventes visees, aucune ecriture (rollback).
--   psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -v apply=1 -f supabase/repairs/20261101110100_clear_points_outside_their_department.sql
--       -> mode APPLICATION : ecrit, dans une seule transaction.
--
-- Combien de lignes ? Le rapport du 23/10/2026 n'en connait qu'une (85bf9c86..., Grasse). Ce fichier n'a pas
-- ete lance : le nombre exact de lignes touchees se lit en mode comptage (ventes_hors_departement) AVANT
-- l'application. Le fichier est cible par la condition (point hors de la boite de son departement), pas par
-- l'identifiant : toute autre vente dans ce cas est reparee de la meme facon, et le comptage les liste.
--
-- Idempotente : une seconde execution ne trouve plus aucune ligne (les coordonnees sont deja nulles).
--
-- Regle : la meme que le pipeline (services/data-pipeline/src/department_bounds.py, src/geocode.py
-- verify_source_coordinates). Les boites sont celles de ce module : tracés IGN Admin Express (COG), republies
-- par https://github.com/gregoiredavid/france-geojson (Licence Ouverte), elargis de 0,1 degre. Un departement sans
-- boite (collectivites d'outre-mer) n'est jamais vise. La condition ne lit que latitude, longitude et departement.
--
-- Ce que la reparation fait, sur les seules ventes dont le point est hors de la boite de leur departement :
--   - latitude et longitude -> NULL ; drapeaux implausible_coordinates et missing_gps ajoutes ;
--   - dans raw_payload : latitude, longitude, geo_precision retires (precision inconnue), la preuve de
--     geocodage (raw_payload->'geocode') retiree quand elle porte ce meme point, et la trace
--     raw_payload->'rejected_source_coordinates' ecrite (ancien point, motif, departement) ;
--   - parcelles cadastrales trouvees sous ce point (public.auction_cadastre_parcels, match_kind =
--     'point_intersection') supprimees apres copie dans app_private.
-- Elle ne geocode rien : le nouveau point vient du prochain passage du pipeline, qui controle desormais les
-- coordonnees de la source (voir le correctif du pipeline) et pose au besoin le centre de la commune.
--
-- Apres l'application, relancer le workflow « Recompute Existing Sales » (source concernee) pour retrouver un point.
--
-- A verifier avant et apres (lecture seule) : les requetes du mode comptage ci-dessous.
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

-- Boites englobantes (latitude min, latitude max, longitude min, longitude max) : copie de department_bounds.py.
create temporary table department_bounds_w2 (
  department text primary key,
  min_lat double precision not null,
  max_lat double precision not null,
  min_lon double precision not null,
  max_lon double precision not null
) on commit drop;
insert into department_bounds_w2 (department, min_lat, max_lat, min_lon, max_lon) values
    ('01', 45.51, 46.62, 4.62, 6.27), ('02', 48.73, 50.17, 2.85, 4.36), ('03', 45.83, 46.91, 2.18, 4.1), ('04', 43.56, 44.76, 5.39, 7.07),
    ('05', 44.08, 45.23, 5.31, 7.18), ('06', 43.38, 44.47, 6.53, 7.82), ('07', 44.16, 45.47, 3.76, 4.99), ('08', 49.13, 50.27, 3.93, 5.5),
    ('09', 42.47, 43.42, 0.72, 2.28), ('10', 47.82, 48.82, 3.28, 4.97), ('11', 42.55, 43.56, 1.58, 3.35), ('12', 43.59, 45.04, 1.73, 3.55),
    ('13', 43.06, 44.03, 4.13, 5.91), ('14', 48.65, 49.53, -1.26, 0.55), ('15', 44.51, 45.58, 1.96, 3.47), ('16', 45.09, 46.24, -0.57, 1.05),
    ('17', 44.98, 46.47, -1.67, 0.11), ('18', 46.32, 47.73, 1.67, 3.18), ('19', 44.82, 45.86, 1.12, 2.63), ('21', 46.8, 48.14, 3.96, 5.62),
    ('22', 47.93, 48.97, -3.76, -1.81), ('23', 45.56, 46.56, 1.27, 2.72), ('24', 44.47, 45.82, -0.15, 1.55), ('25', 46.45, 47.67, 5.59, 7.17),
    ('26', 44.01, 45.45, 4.54, 5.93), ('27', 48.56, 49.59, 0.19, 1.91), ('28', 47.85, 49.05, 0.66, 2.1), ('29', 47.66, 48.83, -5.21, -3.28),
    ('2A', 41.26, 42.49, 8.45, 9.51), ('2B', 41.73, 43.11, 8.47, 9.66), ('30', 43.36, 44.56, 3.16, 4.95), ('31', 42.58, 44.03, 0.34, 2.15),
    ('32', 43.21, 44.18, -0.39, 1.31), ('33', 44.09, 45.67, -1.37, 0.42), ('34', 43.11, 44.08, 2.44, 4.3), ('35', 47.53, 48.8, -2.39, -0.91),
    ('36', 46.24, 47.38, 0.76, 2.31), ('37', 46.63, 47.81, -0.05, 1.47), ('38', 44.59, 45.99, 4.64, 6.46), ('39', 46.16, 47.41, 5.15, 6.31),
    ('40', 43.39, 44.64, -1.63, 0.24), ('41', 47.08, 48.24, 0.48, 2.35), ('42', 45.13, 46.38, 3.59, 4.86), ('43', 44.64, 45.53, 2.99, 4.59),
    ('44', 46.76, 47.94, -2.66, -0.85), ('45', 47.38, 48.45, 1.41, 3.23), ('46', 44.1, 45.15, 0.88, 2.31), ('47', 43.87, 44.87, -0.25, 1.18),
    ('48', 44.01, 45.08, 2.88, 4.1), ('49', 46.87, 47.91, -1.45, 0.34), ('50', 48.35, 49.83, -2.05, -0.63), ('51', 48.41, 49.51, 3.29, 5.14),
    ('52', 47.47, 48.79, 4.53, 6.0), ('53', 47.63, 48.67, -1.34, 0.05), ('54', 48.25, 49.67, 5.36, 7.23), ('55', 48.31, 49.72, 4.78, 5.96),
    ('56', 47.18, 48.31, -3.84, -1.93), ('57', 48.42, 49.62, 5.79, 7.75), ('58', 46.55, 47.69, 2.74, 4.34), ('59', 49.86, 51.19, 1.96, 4.33),
    ('60', 48.96, 49.86, 1.58, 3.27), ('61', 48.08, 49.08, -0.97, 1.07), ('62', 49.93, 51.11, 1.45, 3.29), ('63', 45.18, 46.36, 2.28, 4.09),
    ('64', 42.67, 43.7, -1.89, 0.13), ('65', 42.57, 43.71, -0.43, 0.75), ('66', 42.23, 43.02, 1.62, 3.28), ('67', 48.02, 49.18, 6.85, 8.34),
    ('68', 47.32, 48.42, 6.74, 7.73), ('69', 45.35, 46.41, 4.14, 5.26), ('70', 47.15, 48.13, 5.27, 6.93), ('71', 46.05, 47.26, 3.52, 5.57),
    ('72', 47.46, 48.59, -0.55, 1.02), ('73', 44.95, 46.04, 5.52, 7.29), ('74', 45.58, 46.51, 5.7, 7.15), ('75', 48.71, 49.01, 2.12, 2.57),
    ('76', 49.15, 50.18, -0.04, 1.9), ('77', 48.02, 49.22, 2.3, 3.66), ('78', 48.33, 49.19, 1.34, 2.33), ('79', 45.86, 47.21, -1.0, 0.33),
    ('80', 49.47, 50.47, 1.28, 3.28), ('81', 43.28, 44.31, 1.43, 3.04), ('82', 43.67, 44.5, 0.63, 2.1), ('83', 42.88, 43.91, 5.55, 7.04),
    ('84', 43.55, 44.53, 4.54, 5.86), ('85', 46.16, 47.19, -2.5, -0.43), ('86', 45.94, 47.28, -0.21, 1.32), ('87', 45.34, 46.51, 0.52, 2.01),
    ('88', 47.71, 48.62, 5.3, 7.3), ('89', 47.21, 48.5, 2.74, 4.45), ('90', 47.33, 47.93, 6.65, 7.24), ('91', 48.18, 48.88, 1.81, 2.69),
    ('92', 48.63, 49.06, 2.04, 2.44), ('93', 48.7, 49.11, 2.19, 2.7), ('94', 48.58, 48.97, 2.2, 2.71), ('95', 48.8, 49.34, 1.5, 2.7),
    ('971', 15.73, 16.62, -61.91, -60.9), ('972', 14.28, 14.98, -61.33, -60.7), ('973', 2.01, 5.85, -54.71, -51.51), ('974', -21.49, -20.77, 55.11, 55.94),
    ('976', -13.11, -12.53, 44.91, 45.4);

-- Ventes visees, calculees dans les deux modes.
create temporary table points_outside_department_rows on commit drop as
select s.source_url,
       s.id,
       s.city,
       upper(btrim(s.department)) as department,
       s.latitude,
       s.longitude,
       coalesce(
         case when s.raw_payload #>> '{geocode,latitude}' ~ '^-?[0-9]+(\.[0-9]+)?$'
              then abs((s.raw_payload #>> '{geocode,latitude}')::numeric - s.latitude) <= 0.000001 end
         and
         case when s.raw_payload #>> '{geocode,longitude}' ~ '^-?[0-9]+(\.[0-9]+)?$'
              then abs((s.raw_payload #>> '{geocode,longitude}')::numeric - s.longitude) <= 0.000001 end,
         false) as geocode_at_point
  from public.auction_sales s
  join department_bounds_w2 b on b.department = upper(btrim(s.department))
 where s.latitude is not null
   and s.longitude is not null
   and not (s.latitude::double precision between b.min_lat and b.max_lat
            and s.longitude::double precision between b.min_lon and b.max_lon);

-- Mode comptage : la transaction devient en lecture seule (rien ne s'ecrit) puis se termine par un rollback.
\if :apply
\else
  set transaction read only;
\endif

-- Comptage (les deux modes).
select count(*) as ventes_hors_departement,
       count(*) filter (where geocode_at_point) as dont_preuve_de_geocodage_a_retirer
  from points_outside_department_rows;

-- Liste a relire avant l'application (les deux modes).
select id, department, city, latitude, longitude
  from points_outside_department_rows
 order by department, city, id;

select count(*) as parcelles_a_supprimer
  from public.auction_cadastre_parcels p
  join points_outside_department_rows r on r.source_url = p.source_url
 where p.match_kind = 'point_intersection';

\if :apply
  create table if not exists app_private.points_outside_department_backup_20261101 (
    source_url text primary key,
    latitude numeric,
    longitude numeric,
    quality_flags jsonb,
    raw_payload_point jsonb,
    backed_up_at timestamptz not null default now()
  );
  revoke all on app_private.points_outside_department_backup_20261101 from public, anon, authenticated;

  create table if not exists app_private.points_outside_department_parcels_backup_20261101
    (like public.auction_cadastre_parcels);
  revoke all on app_private.points_outside_department_parcels_backup_20261101 from public, anon, authenticated;

  insert into app_private.points_outside_department_backup_20261101
    (source_url, latitude, longitude, quality_flags, raw_payload_point)
  select s.source_url, s.latitude, s.longitude, s.quality_flags,
         jsonb_strip_nulls(jsonb_build_object(
           'latitude', s.raw_payload -> 'latitude',
           'longitude', s.raw_payload -> 'longitude',
           'geo_precision', s.raw_payload -> 'geo_precision',
           'geocode', case when r.geocode_at_point then s.raw_payload -> 'geocode' end))
    from public.auction_sales s
    join points_outside_department_rows r using (source_url)
  on conflict (source_url) do nothing;

  insert into app_private.points_outside_department_parcels_backup_20261101
  select p.*
    from public.auction_cadastre_parcels p
    join points_outside_department_rows r on r.source_url = p.source_url
   where p.match_kind = 'point_intersection'
     and not exists (
       select 1 from app_private.points_outside_department_parcels_backup_20261101 b where b.id = p.id
     );

  delete from public.auction_cadastre_parcels p
   using points_outside_department_rows r
   where p.source_url = r.source_url
     and p.match_kind = 'point_intersection';

  update public.auction_sales s
     set latitude = null,
         longitude = null,
         quality_flags = (
           select coalesce(jsonb_agg(flag.value order by flag.ordinality), '[]'::jsonb)
                  || '["implausible_coordinates", "missing_gps"]'::jsonb
             from jsonb_array_elements(
                    case when jsonb_typeof(s.quality_flags) = 'array' then s.quality_flags else '[]'::jsonb end
                  ) with ordinality as flag(value, ordinality)
            where flag.value not in ('"implausible_coordinates"'::jsonb, '"missing_gps"'::jsonb)
         ),
         raw_payload = ((coalesce(s.raw_payload, '{}'::jsonb) - 'latitude' - 'longitude' - 'geo_precision')
           - case when r.geocode_at_point then 'geocode' else '' end)
           || jsonb_build_object(
                'rejected_source_coordinates',
                jsonb_build_object(
                  'latitude', r.latitude,
                  'longitude', r.longitude,
                  'reason', 'outside_department',
                  'department', r.department
                )
              )
    from points_outside_department_rows r
   where s.source_url = r.source_url;

  \echo === Application terminee : relancer le comptage (0 ligne attendue). ===
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
--          raw_payload = (s.raw_payload - 'rejected_source_coordinates') || coalesce(b.raw_payload_point, '{}'::jsonb)
--     from app_private.points_outside_department_backup_20261101 b
--    where s.source_url = b.source_url;
--   insert into public.auction_cadastre_parcels
--   select * from app_private.points_outside_department_parcels_backup_20261101
--   on conflict do nothing;
