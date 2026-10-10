begin;

set local lock_timeout = '5s';

-- The anonymous catalogue search was reading `raw_payload` twice per sale
-- (publication quarantine and thumbnail).  That JSONB averages 37 kB and
-- lives in TOAST, so every search detoasted roughly 100 MB and took more than
-- two seconds, beyond the 3 s statement timeout of the `anon` role under load.
-- Materialize the two values the preview needs as ordinary columns, keep them
-- in sync with a trigger, and make the preview functions read only columns.
alter table public.auction_sales
  add column if not exists catalogue_quarantined boolean not null default false,
  add column if not exists catalogue_thumbnail_url text;

comment on column public.auction_sales.catalogue_quarantined is
  'Materialized from raw_payload->>publication_quarantine; true hides the sale from the public catalogue.';
comment on column public.auction_sales.catalogue_thumbnail_url is
  'Materialized from raw_payload->>raw_image_url when it is an http(s) URL of at most 2048 characters.';

create or replace function app_private.sync_auction_sale_catalogue_projection()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  new.catalogue_quarantined :=
    coalesce(new.raw_payload ->> 'publication_quarantine', '') <> '';
  new.catalogue_thumbnail_url :=
    case
      when new.raw_payload ->> 'raw_image_url' ~* '^https?://'
        and length(new.raw_payload ->> 'raw_image_url') <= 2048
        then new.raw_payload ->> 'raw_image_url'
    end;
  return new;
end;
$function$;

revoke all on function app_private.sync_auction_sale_catalogue_projection()
  from public, anon, authenticated;

-- Backfill without firing the sale change log, AI review refresh or source
-- check triggers: this is a projection of existing data, not a sale change.
-- The table lock taken here is held until commit, so no writer can run while
-- the triggers are disabled.  All sixteen user triggers are enabled today.
alter table public.auction_sales disable trigger user;

update public.auction_sales as sale
set catalogue_quarantined = coalesce(sale.raw_payload ->> 'publication_quarantine', '') <> '',
    catalogue_thumbnail_url = case
      when sale.raw_payload ->> 'raw_image_url' ~* '^https?://'
        and length(sale.raw_payload ->> 'raw_image_url') <= 2048
        then sale.raw_payload ->> 'raw_image_url'
    end
where sale.catalogue_quarantined is distinct from
        (coalesce(sale.raw_payload ->> 'publication_quarantine', '') <> '')
   or sale.catalogue_thumbnail_url is distinct from
        case
          when sale.raw_payload ->> 'raw_image_url' ~* '^https?://'
            and length(sale.raw_payload ->> 'raw_image_url') <= 2048
            then sale.raw_payload ->> 'raw_image_url'
        end;

alter table public.auction_sales enable trigger user;

-- Run after the guards that may rewrite raw_payload (they sort before "zzzz").
drop trigger if exists zzzz_auction_sales_catalogue_projection_insert on public.auction_sales;
create trigger zzzz_auction_sales_catalogue_projection_insert
  before insert on public.auction_sales
  for each row execute function app_private.sync_auction_sale_catalogue_projection();

-- WHEN is evaluated after the earlier BEFORE triggers, so a payload rewritten
-- by a guard is projected too, even when the UPDATE did not name raw_payload.
drop trigger if exists zzzz_auction_sales_catalogue_projection_update on public.auction_sales;
create trigger zzzz_auction_sales_catalogue_projection_update
  before update on public.auction_sales
  for each row
  when (old.raw_payload is distinct from new.raw_payload)
  execute function app_private.sync_auction_sale_catalogue_projection();

create or replace function app_private.search_auction_sales_preview_v3(
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
  thumbnail_url text
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
      s.catalogue_thumbnail_url as thumbnail_url
    from public.auction_sales s
    left join public.tribunals t on t.code = s.tribunal_code
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
    counted.thumbnail_url
  from counted
  order by
    counted.coordinates_rank,
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

create or replace function app_private.search_auction_sales_preview_v4(
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
  thumbnail_url text
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
      s.catalogue_thumbnail_url as thumbnail_url
    from public.auction_sales s
    left join public.tribunals t on t.code = s.tribunal_code
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
    counted.thumbnail_url
  from counted
  order by
    counted.coordinates_rank,
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

commit;
