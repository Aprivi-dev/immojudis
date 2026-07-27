begin;

create or replace function app_private.prevent_auction_sale_source_reassignment()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if new.source_name is distinct from old.source_name then
    raise exception using
      errcode = '23514',
      message = 'auction_sales.source_name is immutable for an existing source_url';
  end if;
  return new;
end;
$$;

revoke all on function app_private.prevent_auction_sale_source_reassignment() from public;
grant execute on function app_private.prevent_auction_sale_source_reassignment() to service_role;

drop trigger if exists immojudis_auction_sales_source_identity
on public.auction_sales;
create trigger immojudis_auction_sales_source_identity
before update of source_name on public.auction_sales
for each row
execute function app_private.prevent_auction_sale_source_reassignment();

commit;
