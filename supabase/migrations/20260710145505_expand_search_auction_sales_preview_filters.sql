begin;

-- The first production application of 20260710145100 used the smaller
-- preview signature. Remove it explicitly before installing the complete
-- signature so PostgreSQL does not keep ambiguous overloads.
drop function if exists public.search_auction_sales_preview(
  text[], text, text, text, text[], numeric, numeric, text, integer, integer
);
drop function if exists app_private.search_auction_sales_preview(
  text[], text, text, text, text[], numeric, numeric, text, integer, integer
);

create extension if not exists unaccent with schema extensions;

-- Public catalog search deliberately exposes only the teaser fields already
-- available in v_auction_sales_app_preview. The privileged implementation is
-- kept in app_private so protected location columns are never returned.
create or replace function app_private.search_auction_sales_preview(
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
  p_offset integer default 0
)
returns table (
  id uuid,
  starting_price_eur numeric,
  total_count bigint
)
language sql
stable
security definer
set search_path = ''
as $$
  with filtered as (
    select
      s.id,
      s.starting_price_eur,
      s.sale_date,
      s.investment_score,
      s.app_surface_m2
    from public.auction_sales s
    left join public.tribunals t on t.code = s.tribunal_code
    where coalesce(s.status, 'unknown') in ('upcoming', 'unknown')
      and s.latitude is not null
      and s.longitude is not null
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
              s.title,
              s.city,
              s.department,
              s.postal_code,
              s.address,
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
    counted.total_count
  from counted
  order by
    case when p_sort = 'date_asc' then counted.sale_date end asc nulls last,
    case when p_sort = 'date_desc' then counted.sale_date end desc nulls last,
    case when p_sort = 'price_asc' then counted.starting_price_eur end asc nulls last,
    case when p_sort = 'price_desc' then counted.starting_price_eur end desc nulls last,
    case when p_sort = 'surface_desc' then counted.app_surface_m2 end desc nulls last,
    case when p_sort not in ('date_asc', 'date_desc', 'price_asc', 'price_desc', 'surface_desc')
      then counted.investment_score end desc nulls last,
    counted.id
  limit least(greatest(coalesce(p_limit, 24), 1), 1000)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

revoke all on function app_private.search_auction_sales_preview from public, anon, authenticated;
grant usage on schema app_private to anon, authenticated, service_role;
grant execute on function app_private.search_auction_sales_preview
to anon, authenticated, service_role;

create or replace function public.search_auction_sales_preview(
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
  p_offset integer default 0
)
returns table (
  id uuid,
  starting_price_eur numeric,
  total_count bigint
)
language sql
stable
security invoker
set search_path = ''
as $$
  select *
  from app_private.search_auction_sales_preview(
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
    p_offset => p_offset
  );
$$;

revoke all on function public.search_auction_sales_preview from public;
grant execute on function public.search_auction_sales_preview to anon, authenticated, service_role;

notify pgrst, 'reload schema';

commit;

