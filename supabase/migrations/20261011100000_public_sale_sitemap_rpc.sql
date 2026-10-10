begin;

set local lock_timeout = '5s';

-- The sitemap lists every publicly visible sale with its last-modification date.
-- The anonymous contract only exposed identifiers through the preview view, so
-- this function paginates (stable id order) over exactly the sales that
-- search_auction_sales_preview_v4 can return: status, materialized catalogue
-- expiry and publication quarantine use the same predicate. Only the identifier
-- and the update date leave the database.

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
      and app_private.sale_catalogue_entry_is_live_materialized(
        s.catalogue_expiry_materialized,
        s.catalogue_expiry_deadline,
        s.sale_date,
        s.raw_payload,
        s.sale_procedure
      )
      and coalesce(s.raw_payload->>'publication_quarantine', '') = ''
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

create or replace function public.list_public_sale_sitemap_entries(
  p_limit integer default 1000,
  p_offset integer default 0
)
returns table (
  id uuid,
  updated_at timestamptz,
  total_count bigint
)
language sql
stable
set search_path = ''
as $function$
  select * from app_private.list_public_sale_sitemap_entries(p_limit, p_offset);
$function$;

revoke all on function public.list_public_sale_sitemap_entries(integer, integer) from public;
grant execute on function public.list_public_sale_sitemap_entries(integer, integer)
  to anon, authenticated, service_role;

notify pgrst, 'reload schema';

commit;
