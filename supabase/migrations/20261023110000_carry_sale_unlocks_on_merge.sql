-- "3 déblocages par mois": keep an unlock when the collection merges duplicate sales.
--
-- The duplicate sweep of the data pipeline (reconcile_duplicate_sales_in_supabase) upserts the
-- canonical row, whose source_urls then lists the secondary listings, and deletes the secondary
-- rows. The sale stays online under the canonical id. Without this trigger the unlock of a
-- secondary row would be detached (sale_id set null, credit kept) and the account would lose the
-- access to a sale that is still online.
--
-- Before a sale row is deleted, its unlocks move to the sale that now lists its source_url. An
-- account that already unlocked that sale keeps both credits counted: its older row is simply
-- detached when the sale is deleted (ON DELETE SET NULL), never merged or refunded. A sale
-- deleted for another reason (retention) has no such sale and behaves as before.
begin;

set local lock_timeout = '5s';

create or replace function app_private.carry_sale_unlocks_to_merged_sale()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_target uuid;
begin
  if not exists (
    select 1 from public.user_sale_unlocks unlock_row where unlock_row.sale_id = old.id
  ) then
    return old;
  end if;

  select merged.id into v_target
  from public.auction_sales merged
  where merged.id <> old.id
    and jsonb_typeof(merged.source_urls) = 'array'
    and merged.source_urls ? old.source_url
  order by merged.updated_at desc nulls last, merged.id
  limit 1;

  if v_target is not null then
    update public.user_sale_unlocks unlock_row
       set sale_id = v_target
     where unlock_row.sale_id = old.id
       and not exists (
         select 1
         from public.user_sale_unlocks existing
         where existing.user_id = unlock_row.user_id and existing.sale_id = v_target
       );
  end if;
  return old;
end;
$$;

revoke all on function app_private.carry_sale_unlocks_to_merged_sale()
  from public, anon, authenticated;

drop trigger if exists auction_sales_carry_sale_unlocks on public.auction_sales;
create trigger auction_sales_carry_sale_unlocks
before delete on public.auction_sales
for each row execute function app_private.carry_sale_unlocks_to_merged_sale();

comment on function app_private.carry_sale_unlocks_to_merged_sale() is
  'Moves the sale unlocks of a deleted duplicate sale to the sale that now lists its source_url (duplicate merge), so an unlocked sale that stays online keeps its access.';

commit;
