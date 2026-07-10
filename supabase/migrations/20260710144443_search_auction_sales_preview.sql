begin;

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
  p_min_price numeric default null,
  p_max_price numeric default null,
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
      s.starting_price_eur
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
      and (p_min_price is null or s.starting_price_eur >= p_min_price)
      and (p_max_price is null or s.starting_price_eur <= p_max_price)
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
    case when p_sort = 'price_desc' then counted.starting_price_eur end desc nulls last,
    case when p_sort <> 'price_desc' then counted.starting_price_eur end asc nulls last,
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
  p_min_price numeric default null,
  p_max_price numeric default null,
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
    p_min_price => p_min_price,
    p_max_price => p_max_price,
    p_sort => p_sort,
    p_limit => p_limit,
    p_offset => p_offset
  );
$$;

revoke all on function public.search_auction_sales_preview from public;
grant execute on function public.search_auction_sales_preview to anon, authenticated, service_role;

notify pgrst, 'reload schema';

commit;
