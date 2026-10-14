-- Classement de /sales par complétude des annonces (décision du propriétaire, 14/10/2026).
--
-- Le tri par défaut regroupe les annonces en DEUX paliers de complétude (le plus renseigné
-- d'abord), puis date de vente croissante, puis identifiant.  Les ventes géolocalisées passent
-- toujours avant celles qui ne le sont pas (coordinates_rank), comme aujourd'hui.
--
-- Le critère est le score de la fiche (getListingCompleteness, TypeScript), jamais le score
-- interne premium_readiness_* : le calcul reste dans l'application (tâche planifiée
-- /api/cron/listing-completeness), la base ne stocke que le résultat dans une table à part.  Pas de
-- colonne dans auction_sales : ses seize triggers (journal des changements, revue IA, updated_at)
-- feraient du bruit à chaque réévaluation.
--
-- Ce que les rôles du navigateur peuvent lire : le PALIER (0 ou 1), jamais le score numérique,
-- l'empreinte ni la version de la règle.  La table n'est ouverte à personne sauf service_role ; les
-- vues de recherche et les RPC publiques n'exposent que le palier, via une fonction définer.
--
-- Une vente pas encore évaluée est au palier bas : on ne met pas en avant ce qui n'est pas mesuré.
-- Tant que la tâche n'a pas tourné, l'ordre est donc la date de vente, comme avant.
--
-- Déploiement : appliquer cette migration AVANT le code applicatif (il lit completeness_tier).
begin;

set local lock_timeout = '5s';

create table if not exists public.auction_sale_listing_completeness (
  sale_id uuid primary key references public.auction_sales(id) on delete cascade,
  score numeric(4,1) not null check (score >= 0 and score <= 100),
  tier smallint not null check (tier in (0, 1)),
  policy_version text not null check (length(btrim(policy_version)) > 0),
  input_fingerprint text not null,
  evaluated_at timestamptz not null default now()
);

comment on table public.auction_sale_listing_completeness is
  'Complétude de la fiche d''une vente (score 0-100 de getListingCompleteness) et palier de classement de /sales. Écrit par /api/cron/listing-completeness (service_role) ; jamais lisible par anon ni authenticated.';
comment on column public.auction_sale_listing_completeness.score is
  'Score de complétude de la fiche (0-100). Interne : ne sort pas de la base.';
comment on column public.auction_sale_listing_completeness.tier is
  '1 = annonce bien renseignée (classification publiée de la fiche: décision prête ou riche, portes critiques comprises), 0 = autre. Seul champ publié, via completeness_tier.';
comment on column public.auction_sale_listing_completeness.policy_version is
  'Version de la règle de palier (constante LISTING_COMPLETENESS_POLICY de src/lib/listing-completeness-ranking.ts). Un changement de version fait réévaluer toutes les ventes.';
comment on column public.auction_sale_listing_completeness.input_fingerprint is
  'SHA-256 des données de la vente telles qu''évaluées.';

-- La clé primaire sert la jointure des vues et des RPC.  Cet index sert le suivi (répartition par
-- palier) sans balayer la table.
create index if not exists auction_sale_listing_completeness_tier_idx
  on public.auction_sale_listing_completeness (tier, sale_id);

alter table public.auction_sale_listing_completeness enable row level security;

revoke all on table public.auction_sale_listing_completeness
  from public, anon, authenticated;
grant select, insert, update on table public.auction_sale_listing_completeness
  to service_role;

drop policy if exists auction_sale_listing_completeness_service_role
  on public.auction_sale_listing_completeness;
create policy auction_sale_listing_completeness_service_role
  on public.auction_sale_listing_completeness
  for all to service_role
  using (true)
  with check (true);

-- Palier d'une vente, 0 si elle n'est pas évaluée.  Les vues de recherche « app » sont en
-- security_invoker : un compte connecté qui les lit n'a aucun droit sur la table, alors que le
-- palier est public.  La fonction (définer, chemin de recherche fixé) ne rend que ce palier.
create or replace function app_private.sale_completeness_tier(p_sale_id uuid)
returns smallint
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (
      select completeness.tier
      from public.auction_sale_listing_completeness completeness
      where completeness.sale_id = p_sale_id
    ),
    0
  )::smallint;
$$;

revoke all on function app_private.sale_completeness_tier(uuid) from public, anon, authenticated;
grant usage on schema app_private to authenticated, service_role;
grant execute on function app_private.sale_completeness_tier(uuid) to authenticated, service_role;

comment on function app_private.sale_completeness_tier(uuid) is
  'Palier de complétude (0 ou 1) d''une vente ; 0 si elle n''est pas évaluée. Ne rend jamais le score.';

-- Vues de recherche: completeness_tier est ajouté EN FIN de liste, après coordinates_rank.
-- La liste des colonnes est relue sur la vue actuelle (et non « sale_view.* ») : une vue de base
-- a pu gagner des colonnes depuis la création de la vue de recherche, et create or replace view
-- n'accepte que des colonnes ajoutées à la fin.  Options et droits restent identiques.
do $block$
declare
  v_columns text;
begin
  select string_agg(format('sale_view.%I', attribute.attname), ', ' order by attribute.attnum)
    into v_columns
    from pg_catalog.pg_attribute attribute
   where attribute.attrelid = 'public.v_auction_sales_app_search'::regclass
     and attribute.attnum > 0
     and not attribute.attisdropped
     and attribute.attname not in ('coordinates_rank', 'completeness_tier');
  if v_columns is null then
    raise exception 'v_auction_sales_app_search has no column';
  end if;
  execute format(
    $sql$
      create or replace view public.v_auction_sales_app_search
      with (security_invoker = true)
      as
      select
        %s,
        case
          when sale_view.latitude is null or sale_view.longitude is null then 1
          else 0
        end as coordinates_rank,
        app_private.sale_completeness_tier(sale_view.id) as completeness_tier
      from public.v_auction_sales_app sale_view
    $sql$,
    v_columns
  );

  select string_agg(format('sale_view.%I', attribute.attname), ', ' order by attribute.attnum)
    into v_columns
    from pg_catalog.pg_attribute attribute
   where attribute.attrelid = 'public.v_auction_sales_discovery_search'::regclass
     and attribute.attnum > 0
     and not attribute.attisdropped
     and attribute.attname not in ('coordinates_rank', 'completeness_tier');
  if v_columns is null then
    raise exception 'v_auction_sales_discovery_search has no column';
  end if;
  execute format(
    $sql$
      create or replace view public.v_auction_sales_discovery_search
      with (security_invoker = false, security_barrier = true)
      as
      select
        %s,
        case
          when sale_view.latitude is null or sale_view.longitude is null then 1
          else 0
        end as coordinates_rank,
        app_private.sale_completeness_tier(sale_view.id) as completeness_tier
      from public.v_auction_sales_discovery sale_view
    $sql$,
    v_columns
  );
end;
$block$;

revoke all on table public.v_auction_sales_app_search, public.v_auction_sales_discovery_search
  from public, anon;
grant select on table public.v_auction_sales_app_search, public.v_auction_sales_discovery_search
  to authenticated, service_role;

-- Recherche publique (visiteurs): v3 et v4 rendent désormais completeness_tier (dernière colonne)
-- et classent par défaut selon palier décroissant puis date de vente croissante.  Ajouter une
-- colonne à RETURNS TABLE impose de recréer les fonctions (create or replace ne change pas le type
-- de retour) ; droits et options sont ceux des migrations 20260909121626 et 20260911081621.
drop function if exists public.search_auction_sales_preview_v3(
  text[], text, text, text, text[], text[], numeric, numeric, numeric, numeric, integer, integer,
  text, numeric, text[], double precision, double precision, double precision, double precision,
  text, integer, integer, text
);
drop function if exists public.search_auction_sales_preview_v4(
  text[], text, text, text, text[], text[], numeric, numeric, numeric, numeric, integer, integer,
  text, numeric, text[], double precision, double precision, double precision, double precision,
  text, integer, integer, text, date, date
);
drop function if exists app_private.search_auction_sales_preview_v3(
  text[], text, text, text, text[], text[], numeric, numeric, numeric, numeric, integer, integer,
  text, numeric, text[], double precision, double precision, double precision, double precision,
  text, integer, integer, text
);
drop function if exists app_private.search_auction_sales_preview_v4(
  text[], text, text, text, text[], text[], numeric, numeric, numeric, numeric, integer, integer,
  text, numeric, text[], double precision, double precision, double precision, double precision,
  text, integer, integer, text, date, date
);

create function app_private.search_auction_sales_preview_v3(
  p_departments text[] default null::text[],
  p_city text default null::text,
  p_postal_code text default null::text,
  p_tribunal text default null::text,
  p_keywords text[] default null::text[],
  p_property_types text[] default null::text[],
  p_min_price numeric default null::numeric,
  p_max_price numeric default null::numeric,
  p_min_surface numeric default null::numeric,
  p_max_surface numeric default null::numeric,
  p_min_bedrooms integer default null::integer,
  p_min_bathrooms integer default null::integer,
  p_occupancy_status text default null::text,
  p_min_score numeric default null::numeric,
  p_statuses text[] default null::text[],
  p_north double precision default null::double precision,
  p_south double precision default null::double precision,
  p_east double precision default null::double precision,
  p_west double precision default null::double precision,
  p_sort text default 'score_desc'::text,
  p_limit integer default 24,
  p_offset integer default 0,
  p_sale_venue_type text default null::text
)
returns table(
  id uuid,
  starting_price_eur numeric,
  total_count bigint,
  sale_venue_type text,
  sale_verification_status text,
  city text,
  department text,
  property_type text,
  sale_date timestamp with time zone,
  app_surface_m2 numeric,
  app_surface_kind text,
  rooms_count integer,
  bedrooms_count integer,
  bathrooms_count integer,
  latitude double precision,
  longitude double precision,
  thumbnail_url text,
  completeness_tier smallint
)
language plpgsql
stable
security definer
set search_path to ''
as $function$
begin
  if coalesce(cardinality(p_departments), 0) > 220
    or coalesce(cardinality(p_keywords), 0) > 5
    or coalesce(cardinality(p_property_types), 0) > 8
    or coalesce(cardinality(p_statuses), 0) > 4
    or coalesce((select max(length(item.value)) from unnest(p_departments) as item(value)), 0) > 80
    or coalesce((select max(length(item.value)) from unnest(p_keywords) as item(value)), 0) > 80
    or coalesce((select max(length(item.value)) from unnest(p_property_types) as item(value)), 0) > 80
    or coalesce((select max(length(item.value)) from unnest(p_statuses) as item(value)), 0) > 40
    or length(coalesce(p_city, '')) > 120
    or length(coalesce(p_postal_code, '')) > 16
    or length(coalesce(p_tribunal, '')) > 160
    or length(coalesce(p_sort, '')) > 32
    or coalesce(p_limit, 24) < 1
    or coalesce(p_limit, 24) > 100
    or coalesce(p_offset, 0) < 0
    or coalesce(p_offset, 0) > 10000 then
    raise exception using errcode = '22023', message = 'Invalid or oversized preview search parameters.';
  end if;

  if (
    p_occupancy_status is not null
    or p_min_score is not null
    or p_north is not null
    or p_south is not null
    or p_east is not null
    or p_west is not null
  ) then
    raise exception using errcode = '42501', message = 'Protected filters are not available in the public preview.';
  end if;

  if p_sale_venue_type is not null and p_sale_venue_type not in ('tribunal', 'notary', 'state', 'unknown') then
    raise exception using errcode = '22023', message = 'Invalid sale type.';
  end if;

  return query
  with filtered as (
    select
      case
        when s.latitude is null or s.longitude is null then 1
        else 0
      end as coordinates_rank,
      s.id,
      s.starting_price_eur,
      s.sale_date,
      s.app_surface_m2,
      s.sale_venue_type,
      s.sale_verification_status,
      s.city,
      s.department,
      s.property_type,
      s.app_surface_kind,
      s.rooms_count,
      s.bedrooms_count,
      s.bathrooms_count,
      round(s.latitude::numeric, 2)::double precision as latitude,
      round(s.longitude::numeric, 2)::double precision as longitude,
      s.catalogue_thumbnail_url as thumbnail_url,
      -- Pas encore évaluée = palier bas.  Seul le palier est lu, jamais le score.
      coalesce(completeness.tier, 0)::smallint as completeness_tier
    from public.auction_sales s
    left join public.tribunals t on t.code = s.tribunal_code
    left join public.auction_sale_listing_completeness completeness on completeness.sale_id = s.id
    where coalesce(s.status, 'unknown') in ('upcoming', 'unknown', 'postponed')
      -- Same rule as app_private.sale_catalogue_entry_is_live_materialized, but
      -- inlined: that function carries SET search_path, so PostgreSQL cannot
      -- inline it and evaluates its arguments eagerly, which detoasts raw_payload
      -- for every row (about 260 ms).  The function remains the fallback for
      -- rows whose deadline is not materialized.
      and (
        case
          when s.catalogue_expiry_materialized and s.catalogue_expiry_deadline is not null
            then s.catalogue_expiry_deadline > current_timestamp
          else app_private.sale_catalogue_entry_is_live_materialized(
            false,
            null,
            s.sale_date,
            s.raw_payload,
            s.sale_procedure
          )
        end
      )
      and not s.catalogue_quarantined
      and (
        p_sale_venue_type is null
        or s.sale_venue_type = p_sale_venue_type
        or (p_sale_venue_type = 'unknown' and s.sale_venue_type = 'online')
      )
      and (
        p_departments is null
        or extensions.unaccent(lower(coalesce(s.department, ''))) = any (
          select extensions.unaccent(lower(department.value))
          from unnest(p_departments) as department(value)
        )
      )
      and (
        p_city is null
        or extensions.unaccent(lower(coalesce(s.city, '')))
          like '%' || extensions.unaccent(lower(p_city)) || '%'
      )
      and (p_postal_code is null or s.postal_code = p_postal_code)
      and (
        p_tribunal is null
        or extensions.unaccent(lower(concat_ws(
          ' ',
          s.tribunal,
          s.tribunal_code,
          t.canonical_name,
          t.city
        ))) like '%' || extensions.unaccent(lower(p_tribunal)) || '%'
      )
      and (
        p_keywords is null
        or not exists (
          select 1
          from unnest(p_keywords) as keyword(value)
          where position(
            extensions.unaccent(lower(keyword.value))
            in extensions.unaccent(lower(concat_ws(
              ' ',
              s.city,
              s.department,
              s.postal_code,
              s.tribunal,
              s.tribunal_code,
              t.canonical_name,
              t.city
            )))
          ) = 0
        )
      )
      and (p_property_types is null or s.property_type = any (p_property_types))
      and (p_min_price is null or s.starting_price_eur >= p_min_price)
      and (p_max_price is null or s.starting_price_eur <= p_max_price)
      and (p_min_surface is null or s.app_surface_m2 >= p_min_surface)
      and (p_max_surface is null or s.app_surface_m2 <= p_max_surface)
      and (p_min_bedrooms is null or s.bedrooms_count >= p_min_bedrooms)
      and (p_min_bathrooms is null or s.bathrooms_count >= p_min_bathrooms)
      and (p_occupancy_status is null or s.occupancy_status = p_occupancy_status)
      and (p_min_score is null or s.investment_score >= p_min_score)
      and (p_statuses is null or s.status = any (p_statuses))
      and (p_north is null or s.latitude <= p_north)
      and (p_south is null or s.latitude >= p_south)
      and (p_east is null or s.longitude <= p_east)
      and (p_west is null or s.longitude >= p_west)
  ),
  counted as (
    select
      filtered.*,
      count(*) over () as total_count
    from filtered
  )
  select
    counted.id,
    counted.starting_price_eur,
    counted.total_count,
    counted.sale_venue_type,
    counted.sale_verification_status,
    counted.city,
    counted.department,
    counted.property_type,
    counted.sale_date::timestamptz,
    counted.app_surface_m2::numeric,
    counted.app_surface_kind,
    counted.rooms_count,
    counted.bedrooms_count,
    counted.bathrooms_count,
    counted.latitude,
    counted.longitude,
    counted.thumbnail_url,
    counted.completeness_tier
  from counted
  order by
    counted.coordinates_rank,
    -- Tri par défaut (tout p_sort inconnu, dont 'completeness_desc' et 'score_desc') : palier de
    -- complétude décroissant, puis date de vente croissante (ci-dessous), puis identifiant.
    case when p_sort not in ('date_asc', 'date_desc', 'price_asc', 'price_desc', 'surface_desc')
      then counted.completeness_tier end desc nulls last,
    case when p_sort = 'date_asc' then counted.sale_date end asc nulls last,
    case when p_sort = 'date_desc' then counted.sale_date end desc nulls last,
    case when p_sort = 'price_asc' then counted.starting_price_eur end asc nulls last,
    case when p_sort = 'price_desc' then counted.starting_price_eur end desc nulls last,
    case when p_sort = 'surface_desc' then counted.app_surface_m2 end desc nulls last,
    case when p_sort not in ('date_asc', 'date_desc', 'price_asc', 'price_desc', 'surface_desc')
      then counted.sale_date end asc nulls last,
    counted.id
  limit least(greatest(coalesce(p_limit, 24), 1), 100)
  offset greatest(coalesce(p_offset, 0), 0);
end;
$function$;

create function app_private.search_auction_sales_preview_v4(
  p_departments text[] default null::text[],
  p_city text default null::text,
  p_postal_code text default null::text,
  p_tribunal text default null::text,
  p_keywords text[] default null::text[],
  p_property_types text[] default null::text[],
  p_min_price numeric default null::numeric,
  p_max_price numeric default null::numeric,
  p_min_surface numeric default null::numeric,
  p_max_surface numeric default null::numeric,
  p_min_bedrooms integer default null::integer,
  p_min_bathrooms integer default null::integer,
  p_occupancy_status text default null::text,
  p_min_score numeric default null::numeric,
  p_statuses text[] default null::text[],
  p_north double precision default null::double precision,
  p_south double precision default null::double precision,
  p_east double precision default null::double precision,
  p_west double precision default null::double precision,
  p_sort text default 'score_desc'::text,
  p_limit integer default 24,
  p_offset integer default 0,
  p_sale_venue_type text default null::text,
  p_min_sale_date date default null::date,
  p_max_sale_date date default null::date
)
returns table(
  id uuid,
  starting_price_eur numeric,
  total_count bigint,
  sale_venue_type text,
  sale_verification_status text,
  city text,
  department text,
  property_type text,
  sale_date timestamp with time zone,
  app_surface_m2 numeric,
  app_surface_kind text,
  rooms_count integer,
  bedrooms_count integer,
  bathrooms_count integer,
  latitude double precision,
  longitude double precision,
  thumbnail_url text,
  completeness_tier smallint
)
language plpgsql
stable
security definer
set search_path to ''
as $function$
begin
  if coalesce(cardinality(p_departments), 0) > 220
    or coalesce(cardinality(p_keywords), 0) > 5
    or coalesce(cardinality(p_property_types), 0) > 8
    or coalesce(cardinality(p_statuses), 0) > 4
    or coalesce((select max(length(item.value)) from unnest(p_departments) as item(value)), 0) > 80
    or coalesce((select max(length(item.value)) from unnest(p_keywords) as item(value)), 0) > 80
    or coalesce((select max(length(item.value)) from unnest(p_property_types) as item(value)), 0) > 80
    or coalesce((select max(length(item.value)) from unnest(p_statuses) as item(value)), 0) > 40
    or length(coalesce(p_city, '')) > 120
    or length(coalesce(p_postal_code, '')) > 16
    or length(coalesce(p_tribunal, '')) > 160
    or length(coalesce(p_sort, '')) > 32
    or coalesce(p_limit, 24) < 1
    or coalesce(p_limit, 24) > 100
    or coalesce(p_offset, 0) < 0
    or coalesce(p_offset, 0) > 10000 then
    raise exception using errcode = '22023', message = 'Invalid or oversized preview search parameters.';
  end if;

  if (
    p_occupancy_status is not null
    or p_min_score is not null
    or p_north is not null
    or p_south is not null
    or p_east is not null
    or p_west is not null
  ) then
    raise exception using errcode = '42501', message = 'Protected filters are not available in the public preview.';
  end if;

  if p_sale_venue_type is not null and p_sale_venue_type not in ('tribunal', 'notary', 'state', 'unknown') then
    raise exception using errcode = '22023', message = 'Invalid sale type.';
  end if;

  if p_min_sale_date > p_max_sale_date then
    raise exception using errcode = '22023', message = 'Invalid sale date range.';
  end if;

  return query
  with filtered as (
    select
      case
        when s.latitude is null or s.longitude is null then 1
        else 0
      end as coordinates_rank,
      s.id,
      s.starting_price_eur,
      s.sale_date,
      s.app_surface_m2,
      s.sale_venue_type,
      s.sale_verification_status,
      s.city,
      s.department,
      s.property_type,
      s.app_surface_kind,
      s.rooms_count,
      s.bedrooms_count,
      s.bathrooms_count,
      round(s.latitude::numeric, 2)::double precision as latitude,
      round(s.longitude::numeric, 2)::double precision as longitude,
      s.catalogue_thumbnail_url as thumbnail_url,
      -- Pas encore évaluée = palier bas.  Seul le palier est lu, jamais le score.
      coalesce(completeness.tier, 0)::smallint as completeness_tier
    from public.auction_sales s
    left join public.tribunals t on t.code = s.tribunal_code
    left join public.auction_sale_listing_completeness completeness on completeness.sale_id = s.id
    where coalesce(s.status, 'unknown') in ('upcoming', 'unknown', 'postponed')
      -- Same rule as app_private.sale_catalogue_entry_is_live_materialized, but
      -- inlined: that function carries SET search_path, so PostgreSQL cannot
      -- inline it and evaluates its arguments eagerly, which detoasts raw_payload
      -- for every row (about 260 ms).  The function remains the fallback for
      -- rows whose deadline is not materialized.
      and (
        case
          when s.catalogue_expiry_materialized and s.catalogue_expiry_deadline is not null
            then s.catalogue_expiry_deadline > current_timestamp
          else app_private.sale_catalogue_entry_is_live_materialized(
            false,
            null,
            s.sale_date,
            s.raw_payload,
            s.sale_procedure
          )
        end
      )
      and not s.catalogue_quarantined
      and (
        p_sale_venue_type is null
        or s.sale_venue_type = p_sale_venue_type
        or (p_sale_venue_type = 'unknown' and s.sale_venue_type = 'online')
      )
      and (
        p_departments is null
        or extensions.unaccent(lower(coalesce(s.department, ''))) = any (
          select extensions.unaccent(lower(department.value))
          from unnest(p_departments) as department(value)
        )
      )
      and (
        p_city is null
        or extensions.unaccent(lower(coalesce(s.city, '')))
          like '%' || extensions.unaccent(lower(p_city)) || '%'
      )
      and (p_postal_code is null or s.postal_code = p_postal_code)
      and (
        p_tribunal is null
        or extensions.unaccent(lower(concat_ws(
          ' ',
          s.tribunal,
          s.tribunal_code,
          t.canonical_name,
          t.city
        ))) like '%' || extensions.unaccent(lower(p_tribunal)) || '%'
      )
      and (
        p_keywords is null
        or not exists (
          select 1
          from unnest(p_keywords) as keyword(value)
          where position(
            extensions.unaccent(lower(keyword.value))
            in extensions.unaccent(lower(concat_ws(
              ' ',
              s.city,
              s.department,
              s.postal_code,
              s.tribunal,
              s.tribunal_code,
              t.canonical_name,
              t.city
            )))
          ) = 0
        )
      )
      and (p_property_types is null or s.property_type = any (p_property_types))
      and (p_min_sale_date is null or s.sale_date >= (p_min_sale_date::timestamp at time zone 'Europe/Paris'))
      and (p_max_sale_date is null or s.sale_date < ((p_max_sale_date + 1)::timestamp at time zone 'Europe/Paris'))
      and (p_min_price is null or s.starting_price_eur >= p_min_price)
      and (p_max_price is null or s.starting_price_eur <= p_max_price)
      and (p_min_surface is null or s.app_surface_m2 >= p_min_surface)
      and (p_max_surface is null or s.app_surface_m2 <= p_max_surface)
      and (p_min_bedrooms is null or s.bedrooms_count >= p_min_bedrooms)
      and (p_min_bathrooms is null or s.bathrooms_count >= p_min_bathrooms)
      and (p_occupancy_status is null or s.occupancy_status = p_occupancy_status)
      and (p_min_score is null or s.investment_score >= p_min_score)
      and (p_statuses is null or s.status = any (p_statuses))
      and (p_north is null or s.latitude <= p_north)
      and (p_south is null or s.latitude >= p_south)
      and (p_east is null or s.longitude <= p_east)
      and (p_west is null or s.longitude >= p_west)
  ),
  counted as (
    select
      filtered.*,
      count(*) over () as total_count
    from filtered
  )
  select
    counted.id,
    counted.starting_price_eur,
    counted.total_count,
    counted.sale_venue_type,
    counted.sale_verification_status,
    counted.city,
    counted.department,
    counted.property_type,
    counted.sale_date::timestamptz,
    counted.app_surface_m2::numeric,
    counted.app_surface_kind,
    counted.rooms_count,
    counted.bedrooms_count,
    counted.bathrooms_count,
    counted.latitude,
    counted.longitude,
    counted.thumbnail_url,
    counted.completeness_tier
  from counted
  order by
    counted.coordinates_rank,
    -- Tri par défaut (tout p_sort inconnu, dont 'completeness_desc' et 'score_desc') : palier de
    -- complétude décroissant, puis date de vente croissante (ci-dessous), puis identifiant.
    case when p_sort not in ('date_asc', 'date_desc', 'price_asc', 'price_desc', 'surface_desc')
      then counted.completeness_tier end desc nulls last,
    case when p_sort = 'date_asc' then counted.sale_date end asc nulls last,
    case when p_sort = 'date_desc' then counted.sale_date end desc nulls last,
    case when p_sort = 'price_asc' then counted.starting_price_eur end asc nulls last,
    case when p_sort = 'price_desc' then counted.starting_price_eur end desc nulls last,
    case when p_sort = 'surface_desc' then counted.app_surface_m2 end desc nulls last,
    case when p_sort not in ('date_asc', 'date_desc', 'price_asc', 'price_desc', 'surface_desc')
      then counted.sale_date end asc nulls last,
    counted.id
  limit least(greatest(coalesce(p_limit, 24), 1), 100)
  offset greatest(coalesce(p_offset, 0), 0);
end;
$function$;

create function public.search_auction_sales_preview_v3(
  p_departments text[] default null,
  p_city text default null,
  p_postal_code text default null,
  p_tribunal text default null,
  p_keywords text[] default null,
  p_property_types text[] default null,
  p_min_price numeric default null,
  p_max_price numeric default null,
  p_min_surface numeric default null,
  p_max_surface numeric default null,
  p_min_bedrooms integer default null,
  p_min_bathrooms integer default null,
  p_occupancy_status text default null,
  p_min_score numeric default null,
  p_statuses text[] default null,
  p_north double precision default null,
  p_south double precision default null,
  p_east double precision default null,
  p_west double precision default null,
  p_sort text default 'score_desc',
  p_limit integer default 24,
  p_offset integer default 0,
  p_sale_venue_type text default null
)
returns table (
  id uuid,
  starting_price_eur numeric,
  total_count bigint,
  sale_venue_type text,
  sale_verification_status text,
  city text,
  department text,
  property_type text,
  sale_date timestamptz,
  app_surface_m2 numeric,
  app_surface_kind text,
  rooms_count integer,
  bedrooms_count integer,
  bathrooms_count integer,
  latitude double precision,
  longitude double precision,
  thumbnail_url text,
  completeness_tier smallint
)
language sql
stable
security invoker
set search_path = ''
as $$
  select *
  from app_private.search_auction_sales_preview_v3(
    p_departments => p_departments,
    p_city => p_city,
    p_postal_code => p_postal_code,
    p_tribunal => p_tribunal,
    p_keywords => p_keywords,
    p_property_types => p_property_types,
    p_min_price => p_min_price,
    p_max_price => p_max_price,
    p_min_surface => p_min_surface,
    p_max_surface => p_max_surface,
    p_min_bedrooms => p_min_bedrooms,
    p_min_bathrooms => p_min_bathrooms,
    p_occupancy_status => p_occupancy_status,
    p_min_score => p_min_score,
    p_statuses => p_statuses,
    p_north => p_north,
    p_south => p_south,
    p_east => p_east,
    p_west => p_west,
    p_sort => p_sort,
    p_limit => p_limit,
    p_offset => p_offset,
    p_sale_venue_type => p_sale_venue_type
  );
$$;

create function public.search_auction_sales_preview_v4(
  p_departments text[] default null,
  p_city text default null,
  p_postal_code text default null,
  p_tribunal text default null,
  p_keywords text[] default null,
  p_property_types text[] default null,
  p_min_price numeric default null,
  p_max_price numeric default null,
  p_min_surface numeric default null,
  p_max_surface numeric default null,
  p_min_bedrooms integer default null,
  p_min_bathrooms integer default null,
  p_occupancy_status text default null,
  p_min_score numeric default null,
  p_statuses text[] default null,
  p_north double precision default null,
  p_south double precision default null,
  p_east double precision default null,
  p_west double precision default null,
  p_sort text default 'score_desc',
  p_limit integer default 24,
  p_offset integer default 0,
  p_sale_venue_type text default null,
  p_min_sale_date date default null,
  p_max_sale_date date default null
)
returns table (
  id uuid,
  starting_price_eur numeric,
  total_count bigint,
  sale_venue_type text,
  sale_verification_status text,
  city text,
  department text,
  property_type text,
  sale_date timestamptz,
  app_surface_m2 numeric,
  app_surface_kind text,
  rooms_count integer,
  bedrooms_count integer,
  bathrooms_count integer,
  latitude double precision,
  longitude double precision,
  thumbnail_url text,
  completeness_tier smallint
)
language sql
stable
security invoker
set search_path = ''
as $$
  select *
  from app_private.search_auction_sales_preview_v4(
    p_departments => p_departments,
    p_city => p_city,
    p_postal_code => p_postal_code,
    p_tribunal => p_tribunal,
    p_keywords => p_keywords,
    p_property_types => p_property_types,
    p_min_price => p_min_price,
    p_max_price => p_max_price,
    p_min_surface => p_min_surface,
    p_max_surface => p_max_surface,
    p_min_bedrooms => p_min_bedrooms,
    p_min_bathrooms => p_min_bathrooms,
    p_occupancy_status => p_occupancy_status,
    p_min_score => p_min_score,
    p_statuses => p_statuses,
    p_north => p_north,
    p_south => p_south,
    p_east => p_east,
    p_west => p_west,
    p_sort => p_sort,
    p_limit => p_limit,
    p_offset => p_offset,
    p_sale_venue_type => p_sale_venue_type,
    p_min_sale_date => p_min_sale_date,
    p_max_sale_date => p_max_sale_date
  );
$$;

revoke all on function app_private.search_auction_sales_preview_v3(
  text[], text, text, text, text[], text[], numeric, numeric, numeric, numeric, integer, integer,
  text, numeric, text[], double precision, double precision, double precision, double precision,
  text, integer, integer, text
) from public, anon, authenticated;
revoke all on function app_private.search_auction_sales_preview_v4(
  text[], text, text, text, text[], text[], numeric, numeric, numeric, numeric, integer, integer,
  text, numeric, text[], double precision, double precision, double precision, double precision,
  text, integer, integer, text, date, date
) from public, anon, authenticated;
revoke all on function public.search_auction_sales_preview_v3(
  text[], text, text, text, text[], text[], numeric, numeric, numeric, numeric, integer, integer,
  text, numeric, text[], double precision, double precision, double precision, double precision,
  text, integer, integer, text
) from public, anon, authenticated;
revoke all on function public.search_auction_sales_preview_v4(
  text[], text, text, text, text[], text[], numeric, numeric, numeric, numeric, integer, integer,
  text, numeric, text[], double precision, double precision, double precision, double precision,
  text, integer, integer, text, date, date
) from public, anon, authenticated;

grant usage on schema app_private to anon, authenticated, service_role;
grant execute on function app_private.search_auction_sales_preview_v3(
  text[], text, text, text, text[], text[], numeric, numeric, numeric, numeric, integer, integer,
  text, numeric, text[], double precision, double precision, double precision, double precision,
  text, integer, integer, text
) to anon, authenticated, service_role;
grant execute on function app_private.search_auction_sales_preview_v4(
  text[], text, text, text, text[], text[], numeric, numeric, numeric, numeric, integer, integer,
  text, numeric, text[], double precision, double precision, double precision, double precision,
  text, integer, integer, text, date, date
) to anon, authenticated, service_role;
grant execute on function public.search_auction_sales_preview_v3(
  text[], text, text, text, text[], text[], numeric, numeric, numeric, numeric, integer, integer,
  text, numeric, text[], double precision, double precision, double precision, double precision,
  text, integer, integer, text
) to anon, authenticated, service_role;
grant execute on function public.search_auction_sales_preview_v4(
  text[], text, text, text, text[], text[], numeric, numeric, numeric, numeric, integer, integer,
  text, numeric, text[], double precision, double precision, double precision, double precision,
  text, integer, integer, text, date, date
) to anon, authenticated, service_role;

notify pgrst, 'reload schema';

commit;
