begin;

set local lock_timeout = '5s';

-- The sitemap function read raw_payload (about 37 kB of TOAST per sale) for every
-- candidate sale, so one page of 1,000 entries took about 5 s (/sitemap.xml: 12 s).
-- Use the same predicate as search_auction_sales_preview_v4: the materialized
-- expiry deadline and the materialized quarantine flag, and fall back to the
-- full function only for rows whose deadline is not materialized.
create or replace function app_private.list_public_sale_sitemap_entries(
  p_limit integer default 1000,
  p_offset integer default 0
)
returns table (
  id uuid,
  updated_at timestamptz,
  total_count bigint
)
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  if coalesce(p_limit, 1000) < 1
    or coalesce(p_limit, 1000) > 5000
    or coalesce(p_offset, 0) < 0
    or coalesce(p_offset, 0) > 200000 then
    raise exception using errcode = '22023', message = 'Invalid sitemap pagination.';
  end if;

  return query
  with visible as (
    select s.id, s.updated_at
    from public.auction_sales s
    where coalesce(s.status, 'unknown') in ('upcoming', 'unknown', 'postponed')
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
  )
  select visible.id, visible.updated_at::timestamptz, count(*) over () as total_count
  from visible
  order by visible.id
  limit coalesce(p_limit, 1000)
  offset coalesce(p_offset, 0);
end;
$function$;

revoke all on function app_private.list_public_sale_sitemap_entries(integer, integer)
  from public, anon, authenticated;
grant execute on function app_private.list_public_sale_sitemap_entries(integer, integer)
  to anon, authenticated, service_role;

commit;
