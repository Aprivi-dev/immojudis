-- REPARATION MANUELLE DE DONNEES, PAS UNE MIGRATION DE SCHEMA.
-- Ne pas placer ce fichier dans supabase/migrations : le workflow « Apply Supabase Migrations »
-- applique tout ce qui s'y trouve, sans essai. Procedure complete : supabase/repairs/README.md.
--
-- Chantier F, point 11 : departement et coordonnees absents alors que la preuve est deja stockee.
--
-- NON APPLIQUEE : a relire, puis a lancer par le proprietaire du projet avec psql (psql 13 ou plus) :
--
--   psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/repairs/20261020130001_repair_sale_department_and_coordinates.sql
--       -> mode COMPTAGE SEULEMENT (defaut) : aucune ecriture, la transaction est annulee (rollback).
--   psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -v apply=1 -f supabase/repairs/20261020130001_repair_sale_department_and_coordinates.sql
--       -> mode APPLICATION : ecrit, dans une seule transaction.
--
-- Idempotente : une seconde execution ne trouve plus rien a reparer.
--
-- Ce que la reparation fait, sur public.auction_sales uniquement et sur les ventes
-- active / upcoming / unknown (meme perimetre que la requete de controle) :
--   1. departement absent -> deduit, dans cet ordre, du code postal puis du code INSEE (citycode)
--      d'un geocodage BAN accepte (raw_payload->'geocode'). La source de la deduction est ecrite
--      dans raw_payload->'department_inference'. Le tribunal n'est JAMAIS une source : un tribunal
--      peut couvrir une commune d'un departement voisin ; sans code postal ni geocodage accepte,
--      le departement reste absent.
--   2. coordonnees absentes -> recopiees depuis un geocodage BAN accepte (centre de commune
--      compris) ; raw_payload->>'geo_precision' recoit municipality, street ou address. La recopie
--      n'a lieu que si le departement de la vente est coherent avec le code INSEE du geocodage (et
--      avec le code postal quand il existe) : un point accepte pour une autre commune que celle de
--      la vente n'est jamais recopie. Un point hors du rectangle connu du departement (24, 33, 40,
--      47, 64) est ecarte en plus, tout comme le point d'une adresse ecartee
--      (invalid_address_evidence) quand il est de niveau adresse.
--   3. drapeau missing_gps perime -> retire des lignes qui ont des coordonnees.
-- Elle ne touche ni aux departements ni aux coordonnees deja renseignes, et ne fait aucun appel reseau.
-- Une copie des valeurs d'origine est gardee dans app_private.location_repair_backup_20261020.
--
-- A verifier avant et apres (lecture seule) :
--   select count(*) filter (where department is null or department = '') as sans_departement,
--          count(*) filter (where latitude is null or longitude is null) as sans_coordonnees,
--          count(*) filter (where quality_flags ? 'missing_gps' and latitude is not null
--                             and longitude is not null) as drapeau_perime
--     from public.auction_sales
--    where status in ('active', 'upcoming', 'unknown');
--
-- Retour arriere : voir la fin du fichier.

\set ON_ERROR_STOP on
\if :{?apply}
\else
  \set apply off
\endif

\if :apply
  \echo === MODE APPLICATION : les ventes seront modifiees ===
\else
  \echo === MODE COMPTAGE SEULEMENT : aucune ecriture. Relancer avec -v apply=1 pour appliquer. ===
\endif

begin;
set local lock_timeout = '5s';

-- Plan de reparation : table temporaire, calculee dans les deux modes.
create temporary table location_repair_plan on commit drop as
with accepted as (
  select s.source_url,
         s.department,
         s.latitude,
         s.longitude,
         s.postal_code,
         s.raw_payload,
         case
           when s.raw_payload #>> '{geocode,provider}' = 'ban_geoplateforme'
            and s.raw_payload #>> '{geocode,accepted}' = 'true'
           then s.raw_payload -> 'geocode'
         end as geocode
    from public.auction_sales s
   where s.status in ('active', 'upcoming', 'unknown')
     and (nullif(btrim(s.department), '') is null
          or s.latitude is null
          or s.longitude is null)
),
parsed as (
  select a.*,
         upper(btrim(a.geocode ->> 'citycode')) as citycode,
         case when (a.geocode ->> 'latitude') ~ '^-?[0-9]+(\.[0-9]+)?$'
              then (a.geocode ->> 'latitude')::numeric end as geo_latitude,
         case when (a.geocode ->> 'longitude') ~ '^-?[0-9]+(\.[0-9]+)?$'
              then (a.geocode ->> 'longitude')::numeric end as geo_longitude,
         case a.geocode ->> 'type'
           when 'municipality' then 'municipality'
           when 'housenumber' then 'address'
           when 'street' then 'street'
           when 'locality' then 'street'
         end as geo_precision
    from accepted a
),
departments as (
  select p.*,
         case
           when p.postal_code ~ '^20[0-9]{3}$' then case when p.postal_code::int < 20200 then '2A' else '2B' end
           when p.postal_code ~ '^9[78][0-9]{3}$' then left(p.postal_code, 3)
           when p.postal_code ~ '^[0-9]{5}$' then left(p.postal_code, 2)
         end as dept_postal,
         case
           when p.citycode ~ '^2[AB][0-9]{3}$' then left(p.citycode, 2)
           when p.citycode ~ '^9[78][0-9]{3}$' then left(p.citycode, 3)
           when p.citycode ~ '^[0-9]{5}$' then left(p.citycode, 2)
         end as dept_citycode
    from parsed p
),
chosen as (
  select d.*,
         case
           when nullif(btrim(d.department), '') is not null then null
           when d.dept_postal is not null then 'postal_code'
           when d.dept_citycode is not null then 'geocode_citycode'
         end as department_source,
         coalesce(nullif(btrim(d.department), ''), d.dept_postal, d.dept_citycode) as final_department
    from departments d
),
bounds(department, min_lat, max_lat, min_lon, max_lon) as (
  -- Rectangles connus (memes valeurs que DEPARTMENT_BOUNDS dans geocode.py). Pas de table de
  -- reference des bornes par departement : ailleurs, la coherence avec le code INSEE (ci-dessous)
  -- est la garantie.
  values ('24', 44.55, 45.75, -0.1, 1.5),
         ('33', 44.15, 45.65, -1.35, 0.05),
         ('40', 43.45, 44.55, -1.55, 0.15),
         ('47', 43.95, 44.85, -0.15, 1.15),
         ('64', 42.75, 43.65, -1.95, 0.15)
),
located as (
  select c.*,
         (
           (c.latitude is null or c.longitude is null)
           and c.geo_latitude between -90 and 90
           and c.geo_longitude between -180 and 180
           and c.geo_precision is not null
           and not (c.geo_precision <> 'municipality' and c.raw_payload ? 'invalid_address_evidence')
           -- Departement coherent avec le geocodage accepte et avec le code postal.
           and c.dept_citycode is not null
           and c.final_department = c.dept_citycode
           and (c.dept_postal is null or c.dept_postal = c.dept_citycode)
           and not exists (
             select 1 from bounds b
              where b.department = c.final_department
                and not (c.geo_latitude between b.min_lat and b.max_lat
                     and c.geo_longitude between b.min_lon and b.max_lon)
           )
         ) as copy_coordinates
    from chosen c
)
select l.source_url,
       case when l.department_source is not null then l.final_department end as new_department,
       l.department_source,
       case when l.copy_coordinates then l.geo_latitude end as new_latitude,
       case when l.copy_coordinates then l.geo_longitude end as new_longitude,
       l.geo_precision
  from located l
 where l.department_source is not null
    or l.copy_coordinates;

-- Mode comptage : le plan est calcule, la transaction devient en lecture seule (rien ne s'ecrit
-- dans les tables) puis se termine par un rollback.
\if :apply
\else
  set transaction read only;
\endif

-- Comptage (les deux modes) : ce que l'application modifierait.
select count(*) as ventes_touchees,
       count(*) filter (where new_department is not null) as departements_a_renseigner,
       count(*) filter (where department_source = 'postal_code') as dont_par_code_postal,
       count(*) filter (where department_source = 'geocode_citycode') as dont_par_code_insee,
       count(*) filter (where new_latitude is not null) as coordonnees_a_recopier
  from location_repair_plan;

select count(*) as drapeaux_missing_gps_perimes_deja_presents
  from public.auction_sales s
 where s.status in ('active', 'upcoming', 'unknown')
   and s.latitude is not null
   and s.longitude is not null
   and coalesce(s.quality_flags, '[]'::jsonb) ? 'missing_gps';

\if :apply
  create table if not exists app_private.location_repair_backup_20261020 (
    source_url text primary key,
    department text,
    latitude numeric,
    longitude numeric,
    quality_flags jsonb,
    geo_precision text,
    department_inference jsonb,
    backed_up_at timestamptz not null default now()
  );
  revoke all on app_private.location_repair_backup_20261020 from public, anon, authenticated;

  insert into app_private.location_repair_backup_20261020
    (source_url, department, latitude, longitude, quality_flags, geo_precision, department_inference)
  select s.source_url, s.department, s.latitude, s.longitude, s.quality_flags,
         s.raw_payload ->> 'geo_precision', s.raw_payload -> 'department_inference'
    from public.auction_sales s
    join location_repair_plan p using (source_url)
  on conflict (source_url) do nothing;

  update public.auction_sales s
     set department = coalesce(p.new_department, s.department),
         latitude = case when p.new_latitude is not null then p.new_latitude else s.latitude end,
         longitude = case when p.new_latitude is not null then p.new_longitude else s.longitude end,
         quality_flags = case
           when p.new_latitude is not null then coalesce(s.quality_flags, '[]'::jsonb) - 'missing_gps'
           else coalesce(s.quality_flags, '[]'::jsonb)
         end,
         raw_payload = coalesce(s.raw_payload, '{}'::jsonb)
           || case
                when p.new_latitude is not null and p.geo_precision is not null
                then jsonb_build_object('geo_precision', p.geo_precision)
                else '{}'::jsonb
              end
           || case
                when p.new_department is not null
                then jsonb_build_object(
                       'department_inference',
                       jsonb_build_object('source', p.department_source, 'value', p.new_department))
                else '{}'::jsonb
              end
    from location_repair_plan p
   where s.source_url = p.source_url
     and s.status in ('active', 'upcoming', 'unknown');

  -- Drapeau missing_gps perime : la vente a des coordonnees.
  insert into app_private.location_repair_backup_20261020
    (source_url, department, latitude, longitude, quality_flags, geo_precision, department_inference)
  select s.source_url, s.department, s.latitude, s.longitude, s.quality_flags,
         s.raw_payload ->> 'geo_precision', s.raw_payload -> 'department_inference'
    from public.auction_sales s
   where s.status in ('active', 'upcoming', 'unknown')
     and s.latitude is not null
     and s.longitude is not null
     and coalesce(s.quality_flags, '[]'::jsonb) ? 'missing_gps'
  on conflict (source_url) do nothing;

  update public.auction_sales s
     set quality_flags = s.quality_flags - 'missing_gps'
   where s.status in ('active', 'upcoming', 'unknown')
     and s.latitude is not null
     and s.longitude is not null
     and coalesce(s.quality_flags, '[]'::jsonb) ? 'missing_gps';

  \echo === Application terminee : verifier avec la requete de controle de l en-tete. ===
\endif

\if :apply
  commit;
\else
  rollback;
\endif

-- Retour arriere (a executer a la main, hors de ce fichier), pour les lignes sauvegardees :
--   update public.auction_sales s
--      set department = b.department,
--          latitude = b.latitude,
--          longitude = b.longitude,
--          quality_flags = b.quality_flags,
--          raw_payload = case when b.geo_precision is null then s.raw_payload - 'geo_precision'
--                             else s.raw_payload || jsonb_build_object('geo_precision', b.geo_precision) end
--                        - 'department_inference'
--     from app_private.location_repair_backup_20261020 b
--    where s.source_url = b.source_url;
