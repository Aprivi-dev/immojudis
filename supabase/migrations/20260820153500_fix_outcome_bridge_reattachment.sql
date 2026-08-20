begin;

-- The competent-court reconciliation migration introduced a PL/pgSQL
-- variable named sale_row.  Reusing that name as a SQL table alias made the
-- reattachment guard ambiguous at runtime, so a previously pruned listing
-- could not be linked again when the same immutable source URL reappeared.
create or replace function app_private.guard_auction_sale_outcome_bridge_mutation()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  expected_method text;
  expected_input jsonb;
  verified_court_code text;
  resolved_court_id uuid;
  sale_row public.auction_sales%rowtype;
begin
  if tg_op = 'DELETE' then
    raise exception using
      errcode = '55000',
      message = 'Outcome catalogue bridge rows cannot be deleted.';
  end if;

  if (to_jsonb(new) - 'court_mapping_method' - 'court_mapping_input') is not distinct from
    (to_jsonb(old) - 'court_mapping_method' - 'court_mapping_input')
    and (new.court_mapping_method is distinct from old.court_mapping_method
      or new.court_mapping_input is distinct from old.court_mapping_input) then
    select sale.* into sale_row
    from public.auction_sales sale
    where sale.id = new.auction_sale_id;

    select case_row.court_id into resolved_court_id
    from public.auction_cases case_row
    where case_row.id = new.case_id;

    verified_court_code := app_private.auction_sale_verified_court_code(sale_row);
    expected_method := case
      when verified_court_code is null then 'unmapped'
      else 'justice_competence_insee_exact'
    end;
    expected_input := case
      when verified_court_code is null then jsonb_build_object(
        'schema_version', 'catalogue_court_mapping_v2',
        'mapping_method', 'unmapped',
        'reason', 'no_verified_insee_competence',
        'resolved_outcome_court_id', resolved_court_id
      )
      else jsonb_build_object(
        'schema_version', 'catalogue_court_mapping_v2',
        'mapping_method', 'justice_competence_insee_exact',
        'insee_code', sale_row.raw_payload->'tribunal_assignment'->>'insee_code',
        'court_code', verified_court_code,
        'court_name', sale_row.raw_payload->'tribunal_assignment'->>'court_name',
        'reference_sha256', sale_row.raw_payload->'tribunal_assignment'->>'reference_sha256',
        'resolved_outcome_court_id', resolved_court_id
      )
    end;

    if expected_method = new.court_mapping_method
      and new.court_mapping_input = expected_input
      and app_private.catalogue_bridge_court_is_reconcilable(
        new.id,
        resolved_court_id
      ) then
      return new;
    end if;
  end if;

  if (to_jsonb(new) - 'auction_sale_id') is distinct from
    (to_jsonb(old) - 'auction_sale_id') then
    raise exception using
      errcode = '55000',
      message = 'Outcome catalogue bridge identity and mapping are immutable.';
  end if;

  if new.auction_sale_id is distinct from old.auction_sale_id then
    if new.auction_sale_id is null then
      return new;
    end if;
    if old.auction_sale_id is not null or not exists (
      select 1
      from public.auction_sales catalogue_sale
      where catalogue_sale.id = new.auction_sale_id
        and catalogue_sale.source_name = new.source_name_snapshot
        and catalogue_sale.source_url = new.source_url_snapshot
        and new.source_key = app_private.auction_sale_catalogue_source_key(catalogue_sale.source_url)
    ) then
      raise exception using
        errcode = '23514',
        message = 'A catalogue bridge can only be reattached to the same immutable source identity.';
    end if;
  end if;
  return new;
end;
$$;

revoke all on function app_private.guard_auction_sale_outcome_bridge_mutation()
from public, anon, authenticated;
grant execute on function app_private.guard_auction_sale_outcome_bridge_mutation()
to service_role;

notify pgrst, 'reload schema';

commit;
