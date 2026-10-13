begin;

set local lock_timeout = '5s';

-- Chantier F, point 11 : département et coordonnées absents alors que la preuve est déjà stockée.
--
-- NON APPLIQUÉE : à relire, puis à lancer par le propriétaire du projet (npm run db:migrate).
-- Idempotente : une seconde exécution ne trouve plus rien à réparer.
--
-- Ce que la migration fait, sur public.auction_sales uniquement :
--   1. département absent -> déduit, dans cet ordre, du code postal, du code INSEE (citycode) d'un
--      géocodage BAN accepté (raw_payload->'geocode'), puis du tribunal rattaché (public.tribunals).
--      La source de la déduction est écrite dans raw_payload->'department_inference' ; une déduction
--      par le tribunal ajoute le drapeau department_from_tribunal (indication seulement).
--   2. coordonnées absentes -> recopiées depuis un géocodage BAN accepté (centre de commune
--      compris) ; raw_payload->>'geo_precision' reçoit municipality, street ou address. Un point
--      hors du rectangle connu du département (24, 33, 40, 47, 64) est ignoré, tout comme le point
--      d'une adresse écartée (invalid_address_evidence) quand il est de niveau adresse.
--   3. drapeau missing_gps périmé -> retiré des lignes qui ont des coordonnées.
-- Elle ne touche ni aux départements ni aux coordonnées déjà renseignés, et ne fait aucun appel réseau.
-- Une copie des valeurs d'origine est gardée dans app_private.location_repair_backup_20261020.
--
-- À vérifier avant et après (lecture seule) :
--   select count(*) filter (where department is null or department = '') as sans_departement,
--          count(*) filter (where latitude is null or longitude is null) as sans_coordonnees,
--          count(*) filter (where quality_flags ? 'missing_gps' and latitude is not null
--                             and longitude is not null) as drapeau_perime
--     from public.auction_sales
--    where status in ('active', 'upcoming', 'unknown');
--
-- Retour arrière : voir la fin du fichier.

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

create temporary table location_repair_plan on commit drop as
with accepted as (
  select s.source_url,
         s.department,
         s.latitude,
         s.longitude,
         s.postal_code,
         s.tribunal_code,
         s.raw_payload,
         case
           when s.raw_payload #>> '{geocode,provider}' = 'ban_geoplateforme'
            and s.raw_payload #>> '{geocode,accepted}' = 'true'
           then s.raw_payload -> 'geocode'
         end as geocode
    from public.auction_sales s
   where nullif(btrim(s.department), '') is null
      or s.latitude is null
      or s.longitude is null
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
         end as dept_citycode,
         t.department as dept_tribunal
    from parsed p
    left join public.tribunals t on t.code = p.tribunal_code
),
chosen as (
  select d.*,
         case
           when nullif(btrim(d.department), '') is not null then null
           when d.dept_postal is not null then 'postal_code'
           when d.dept_citycode is not null then 'geocode_citycode'
           when d.dept_tribunal is not null then 'tribunal'
         end as department_source,
         coalesce(nullif(btrim(d.department), ''), d.dept_postal, d.dept_citycode, d.dept_tribunal) as final_department
    from departments d
),
bounds(department, min_lat, max_lat, min_lon, max_lon) as (
  values ('24', 44.55, 45.75, -0.1, 1.5),
         ('33', 44.15, 45.65, -1.35, 0.05),
         ('40', 43.45, 44.55, -1.55, 0.15),
         ('47', 43.95, 44.85, -0.15, 1.15),
         ('64', 42.75, 43.65, -1.95, 0.15)
)
select c.source_url,
       case when c.department_source is not null then c.final_department end as new_department,
       c.department_source,
       case
         when (c.latitude is null or c.longitude is null)
          and c.geo_latitude between -90 and 90
          and c.geo_longitude between -180 and 180
          and c.geo_precision is not null
          and not (c.geo_precision <> 'municipality' and c.raw_payload ? 'invalid_address_evidence')
          and not exists (
            select 1 from bounds b
             where b.department = c.final_department
               and not (c.geo_latitude between b.min_lat and b.max_lat
                    and c.geo_longitude between b.min_lon and b.max_lon)
          )
         then c.geo_latitude
       end as new_latitude,
       case
         when (c.latitude is null or c.longitude is null)
          and c.geo_latitude between -90 and 90
          and c.geo_longitude between -180 and 180
          and c.geo_precision is not null
          and not (c.geo_precision <> 'municipality' and c.raw_payload ? 'invalid_address_evidence')
          and not exists (
            select 1 from bounds b
             where b.department = c.final_department
               and not (c.geo_latitude between b.min_lat and b.max_lat
                    and c.geo_longitude between b.min_lon and b.max_lon)
          )
         then c.geo_longitude
       end as new_longitude,
       c.geo_precision
  from chosen c
 where (c.department_source is not null)
    or (c.latitude is null or c.longitude is null);

delete from location_repair_plan
 where new_department is null and new_latitude is null;

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
       quality_flags = (
         case
           when p.new_latitude is not null then coalesce(s.quality_flags, '[]'::jsonb) - 'missing_gps'
           else coalesce(s.quality_flags, '[]'::jsonb)
         end
       ) || case
              when p.department_source = 'tribunal'
               and not (coalesce(s.quality_flags, '[]'::jsonb) ? 'department_from_tribunal')
              then '["department_from_tribunal"]'::jsonb
              else '[]'::jsonb
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
 where s.source_url = p.source_url;

-- Drapeau missing_gps périmé : la vente a des coordonnées.
insert into app_private.location_repair_backup_20261020
  (source_url, department, latitude, longitude, quality_flags, geo_precision, department_inference)
select s.source_url, s.department, s.latitude, s.longitude, s.quality_flags,
       s.raw_payload ->> 'geo_precision', s.raw_payload -> 'department_inference'
  from public.auction_sales s
 where s.latitude is not null
   and s.longitude is not null
   and coalesce(s.quality_flags, '[]'::jsonb) ? 'missing_gps'
on conflict (source_url) do nothing;

update public.auction_sales s
   set quality_flags = s.quality_flags - 'missing_gps'
 where s.latitude is not null
   and s.longitude is not null
   and coalesce(s.quality_flags, '[]'::jsonb) ? 'missing_gps';

commit;

-- Retour arrière (à exécuter à la main, hors migration), pour les lignes sauvegardées :
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
