begin;

create or replace function app_private.auction_sale_catalogue_source_key(p_source_url text)
returns text
language sql
immutable
strict
security invoker
set search_path = pg_catalog, extensions, public
as $$
  select 'auction_sales:v1:sha256:'
    || encode(digest(convert_to(p_source_url, 'UTF8'), 'sha256'), 'hex');
$$;

-- The listing catalogue is mutable and deliberately pruned.  This registry is
-- the durable, review-neutral link into Outcome Graph.  It snapshots the
-- source identity and the mapping rationale, but never asserts an auction
-- result or makes a row eligible for training.
create table public.auction_sale_outcome_bridges (
  id uuid primary key default gen_random_uuid(),
  source_key text not null unique,
  source_name_snapshot text not null,
  source_url_snapshot text not null,
  external_id_snapshot text,
  auction_sale_id uuid unique references public.auction_sales(id) on delete set null,
  case_id uuid not null unique references public.auction_cases(id),
  lot_id uuid not null unique references public.auction_lots(id),
  round_id uuid not null unique references public.auction_rounds(id),
  announcement_event_id uuid not null unique references public.auction_events(id),
  unknown_outcome_id uuid not null unique,
  catalogue_status text not null default 'announced' check (catalogue_status = 'announced'),
  outcome_status text not null default 'unknown' check (outcome_status = 'unknown'),
  case_mapping_method text not null check (
    case_mapping_method = 'isolated_catalogue_listing'
  ),
  court_mapping_method text not null check (
    court_mapping_method in ('tribunal_code_exact', 'unmapped')
  ),
  address_mapping_method text not null check (
    address_mapping_method in (
      'catalogue_address_snapshot',
      'catalogue_location_snapshot',
      'not_available'
    )
  ),
  court_mapping_input jsonb not null check (jsonb_typeof(court_mapping_input) = 'object'),
  address_mapping_input jsonb not null check (jsonb_typeof(address_mapping_input) = 'object'),
  source_snapshot jsonb not null check (jsonb_typeof(source_snapshot) = 'object'),
  training_eligible boolean not null default false check (not training_eligible),
  created_at timestamptz not null default now(),
  constraint auction_sale_outcome_bridges_no_unverified_result_price check (
    not (source_snapshot ? 'adjudication_price_eur')
    and not (source_snapshot ? 'legacy_adjudication_price_eur')
    and not (source_snapshot ? 'initial_hammer_price_eur')
    and not (source_snapshot ? 'final_hammer_price_eur')
  ),
  constraint auction_sale_outcome_bridges_source_key_check check (
    source_key = app_private.auction_sale_catalogue_source_key(source_url_snapshot)
  ),
  constraint auction_sale_outcome_bridges_lot_case_fk
    foreign key (lot_id, case_id)
    references public.auction_lots(id, auction_case_id),
  constraint auction_sale_outcome_bridges_round_lot_fk
    foreign key (round_id, lot_id)
    references public.auction_rounds(id, lot_id),
  constraint auction_sale_outcome_bridges_outcome_round_fk
    foreign key (unknown_outcome_id, round_id)
    references public.auction_outcomes(id, round_id)
);

create index auction_sale_outcome_bridges_auction_sale_idx
  on public.auction_sale_outcome_bridges(auction_sale_id)
  where auction_sale_id is not null;

create or replace function app_private.guard_auction_sale_outcome_bridge_mutation()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception using
      errcode = '55000',
      message = 'Outcome catalogue bridge rows cannot be deleted.';
  end if;

  if (to_jsonb(new) - 'auction_sale_id') is distinct from
    (to_jsonb(old) - 'auction_sale_id') then
    raise exception using
      errcode = '55000',
      message = 'Outcome catalogue bridge identity and mapping are immutable.';
  end if;

  if new.auction_sale_id is distinct from old.auction_sale_id then
    -- ON DELETE SET NULL is intentional: the immutable source key and graph
    -- identifiers remain after catalogue retention removes the source row.
    if new.auction_sale_id is null then
      return new;
    end if;

    if old.auction_sale_id is not null or not exists (
      select 1
      from public.auction_sales sale_row
      where sale_row.id = new.auction_sale_id
        and sale_row.source_name = new.source_name_snapshot
        and sale_row.source_url = new.source_url_snapshot
        and new.source_key = app_private.auction_sale_catalogue_source_key(sale_row.source_url)
    ) then
      raise exception using
        errcode = '23514',
        message = 'A catalogue bridge can only be reattached to the same immutable source identity.';
    end if;
  end if;

  return new;
end;
$$;

create trigger guard_auction_sale_outcome_bridge_before_mutation
before update or delete on public.auction_sale_outcome_bridges
for each row execute function app_private.guard_auction_sale_outcome_bridge_mutation();

create or replace function app_private.require_outcome_bridge_before_auction_sale_delete()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if not exists (
    select 1
    from public.auction_sale_outcome_bridges bridge
    join public.auction_cases case_row on case_row.id = bridge.case_id
    join public.auction_lots lot_row
      on lot_row.id = bridge.lot_id
      and lot_row.auction_case_id = bridge.case_id
    join public.auction_rounds round_row
      on round_row.id = bridge.round_id
      and round_row.lot_id = bridge.lot_id
    join public.auction_events announcement
      on announcement.id = bridge.announcement_event_id
      and announcement.case_id = bridge.case_id
      and announcement.lot_id = bridge.lot_id
      and announcement.round_id = bridge.round_id
      and announcement.event_type = 'announcement_observed'
    join public.auction_outcomes unknown_outcome
      on unknown_outcome.id = bridge.unknown_outcome_id
      and unknown_outcome.round_id = bridge.round_id
      and unknown_outcome.outcome_status = 'unknown'
      and not unknown_outcome.training_eligible
    where bridge.auction_sale_id = old.id
      and lot_row.auction_sale_id = old.id
      and bridge.source_name_snapshot = old.source_name
      and bridge.source_url_snapshot = old.source_url
      and bridge.source_key = app_private.auction_sale_catalogue_source_key(old.source_url)
      and bridge.catalogue_status = 'announced'
      and bridge.outcome_status = 'unknown'
      and not bridge.training_eligible
  ) then
    raise exception using
      errcode = '55000',
      message = 'auction_sales rows must have a complete Outcome Graph bridge before deletion.';
  end if;

  return old;
end;
$$;

create trigger require_outcome_bridge_before_auction_sale_delete
before delete on public.auction_sales
for each row execute function app_private.require_outcome_bridge_before_auction_sale_delete();

create or replace function public.bridge_auction_sales_to_outcome_graph()
returns table (
  scanned_count bigint,
  created_count bigint,
  reused_count bigint,
  linked_count bigint,
  complete boolean
)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  sale_row public.auction_sales%rowtype;
  existing_bridge public.auction_sale_outcome_bridges%rowtype;
  stable_source_key text;
  resolved_court_id uuid;
  resolved_address_id uuid;
  created_case_id uuid;
  created_lot_id uuid;
  created_round_id uuid;
  created_announcement_event_id uuid;
  created_unknown_outcome_id uuid;
  catalogue_source_id uuid;
  resolved_court_method text;
  resolved_address_method text;
  court_input jsonb;
  address_input jsonb;
  source_input jsonb;
  catalogue_total bigint := 0;
  bridge_created bigint := 0;
  bridge_reused bigint := 0;
  bridge_linked bigint := 0;
begin
  -- One RPC call is one transaction.  The table lock produces a stable scan;
  -- the deletion trigger below remains the final fail-closed guard after this
  -- transaction releases the lock.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('immojudis:outcome_catalogue_bridge:v1', 0)
  );
  lock table public.auction_sales in share mode;

  insert into public.data_sources (
    name,
    publisher,
    official,
    legal_review_status,
    ingestion_policy,
    active
  ) values (
    'immojudis_catalogue_bridge',
    'Immojudis',
    false,
    'pending',
    'disabled',
    false
  )
  on conflict (name) do nothing;

  select source_row.id into catalogue_source_id
  from public.data_sources source_row
  where source_row.name = 'immojudis_catalogue_bridge';

  if catalogue_source_id is null then
    raise exception using
      errcode = '23514',
      message = 'The Outcome catalogue bridge provenance source is missing.';
  end if;

  insert into public.outcome_courts (
    code,
    name,
    court_type,
    judicial_region,
    active
  )
  select
    tribunal_row.code,
    tribunal_row.canonical_name,
    'tribunal_judiciaire',
    null,
    true
  from public.tribunals tribunal_row
  on conflict (code) do nothing;

  insert into public.outcome_courts (code, name, court_type, active)
  values (
    'legacy:unmapped',
    'Tribunal non déterminé (pont catalogue)',
    'unknown',
    false
  )
  on conflict (code) do nothing;

  select count(*) into catalogue_total from public.auction_sales;

  for sale_row in
    select sale.*
    from public.auction_sales sale
    order by sale.id
  loop
    stable_source_key := app_private.auction_sale_catalogue_source_key(sale_row.source_url);

    select bridge.* into existing_bridge
    from public.auction_sale_outcome_bridges bridge
    where bridge.source_key = stable_source_key
    for update;

    if found then
      if existing_bridge.source_name_snapshot <> sale_row.source_name
        or existing_bridge.source_url_snapshot <> sale_row.source_url then
        raise exception using
          errcode = '23514',
          message = 'An existing Outcome bridge conflicts with the catalogue source identity.';
      end if;
      if existing_bridge.auction_sale_id is not null
        and existing_bridge.auction_sale_id <> sale_row.id then
        raise exception using
          errcode = '23514',
          message = 'An existing Outcome bridge is attached to another catalogue row.';
      end if;

      update public.auction_sale_outcome_bridges
      set auction_sale_id = sale_row.id
      where id = existing_bridge.id
        and auction_sale_id is null;

      update public.auction_lots
      set auction_sale_id = sale_row.id,
          updated_at = now()
      where id = existing_bridge.lot_id
        and auction_sale_id is null;

      if not exists (
        select 1
        from public.auction_lots lot_row
        join public.auction_rounds round_row
          on round_row.id = existing_bridge.round_id
          and round_row.lot_id = lot_row.id
        join public.auction_events announcement
          on announcement.id = existing_bridge.announcement_event_id
          and announcement.case_id = existing_bridge.case_id
          and announcement.lot_id = lot_row.id
          and announcement.round_id = round_row.id
          and announcement.event_type = 'announcement_observed'
        join public.auction_outcomes unknown_outcome
          on unknown_outcome.id = existing_bridge.unknown_outcome_id
          and unknown_outcome.round_id = round_row.id
          and unknown_outcome.outcome_status = 'unknown'
          and not unknown_outcome.training_eligible
        where lot_row.id = existing_bridge.lot_id
          and lot_row.auction_case_id = existing_bridge.case_id
          and lot_row.auction_sale_id = sale_row.id
      ) then
        raise exception using
          errcode = '23514',
          message = 'An existing Outcome bridge has an incomplete case/lot/round lineage.';
      end if;

      bridge_reused := bridge_reused + 1;
      continue;
    end if;

    if sale_row.tribunal_code is not null then
      select court_row.id into resolved_court_id
      from public.outcome_courts court_row
      where court_row.code = sale_row.tribunal_code;
      resolved_court_method := 'tribunal_code_exact';
    else
      select court_row.id into resolved_court_id
      from public.outcome_courts court_row
      where court_row.code = 'legacy:unmapped';
      resolved_court_method := 'unmapped';
    end if;

    if resolved_court_id is null then
      raise exception using
        errcode = '23514',
        message = 'The catalogue court mapping could not be resolved.';
    end if;

    court_input := jsonb_strip_nulls(jsonb_build_object(
      'tribunal_code', sale_row.tribunal_code,
      'tribunal_label', sale_row.tribunal,
      'department', sale_row.department,
      'city', sale_row.city,
      'resolved_outcome_court_id', resolved_court_id,
      'mapping_method', resolved_court_method
    ));

    address_input := jsonb_strip_nulls(jsonb_build_object(
      'address', sale_row.address,
      'postal_code', sale_row.postal_code,
      'city', sale_row.city,
      'latitude', sale_row.latitude,
      'longitude', sale_row.longitude
    ));

    resolved_address_id := null;
    if address_input = '{}'::jsonb then
      resolved_address_method := 'not_available';
    else
      if nullif(btrim(sale_row.address), '') is not null then
        resolved_address_method := 'catalogue_address_snapshot';
      else
        resolved_address_method := 'catalogue_location_snapshot';
      end if;

      insert into public.outcome_addresses (
        label,
        street,
        postal_code,
        city,
        latitude,
        longitude,
        geocoding_source,
        geocoding_score
      ) values (
        nullif(
          btrim(concat_ws(' ', sale_row.address, sale_row.postal_code, sale_row.city)),
          ''
        ),
        nullif(btrim(sale_row.address), ''),
        nullif(btrim(sale_row.postal_code), ''),
        nullif(btrim(sale_row.city), ''),
        sale_row.latitude::double precision,
        sale_row.longitude::double precision,
        case
          when sale_row.latitude is not null and sale_row.longitude is not null
            then 'auction_sales_snapshot'
          else null
        end,
        null
      )
      returning id into resolved_address_id;
    end if;

    insert into public.auction_cases (
      court_id,
      court_case_number,
      portalis_number,
      procedure_type,
      case_status,
      pursuing_law_firm_label
    ) values (
      resolved_court_id,
      null,
      null,
      'unknown',
      'announced',
      nullif(btrim(sale_row.lawyer_name), '')
    )
    returning id into created_case_id;

    insert into public.auction_lots (
      auction_case_id,
      auction_sale_id,
      lot_number,
      lot_label,
      property_type,
      address_id,
      occupation_status,
      occupation_confidence,
      living_area_m2,
      carrez_area_m2,
      land_area_m2,
      room_count,
      bedroom_count,
      parking_count,
      initial_starting_price_eur,
      active
    ) values (
      created_case_id,
      sale_row.id,
      null,
      nullif(btrim(sale_row.title), ''),
      coalesce(nullif(btrim(sale_row.property_type), ''), 'unknown'),
      resolved_address_id,
      case sale_row.occupancy_status
        when 'vacant' then 'vacant'
        when 'owner_occupied' then 'owner_occupied'
        when 'rented' then 'tenant_occupied'
        when 'occupied' then 'occupied_other'
        when 'squatted' then 'occupied_other'
        else 'unknown'
      end,
      null,
      coalesce(sale_row.habitable_surface_m2, sale_row.surface_m2),
      sale_row.carrez_surface_m2,
      sale_row.land_surface_m2,
      sale_row.rooms_count,
      sale_row.bedrooms_count,
      sale_row.parking_count,
      sale_row.starting_price_eur,
      true
    )
    returning id into created_lot_id;

    insert into public.auction_rounds (
      lot_id,
      round_kind,
      sequence_number,
      scheduled_at,
      local_timezone,
      court_id,
      initial_starting_price_eur,
      effective_starting_price_eur,
      current_status,
      publication_first_seen_at,
      result_first_seen_at,
      status_confidence
    ) values (
      created_lot_id,
      'initial',
      1,
      sale_row.sale_date,
      'Europe/Paris',
      resolved_court_id,
      sale_row.starting_price_eur,
      sale_row.starting_price_eur,
      case
        when sale_row.sale_date is null then 'draft'
        when sale_row.sale_date > statement_timestamp() then 'scheduled'
        else 'unknown_outcome'
      end,
      coalesce(sale_row.first_seen_at, sale_row.created_at, now()),
      null,
      null
    )
    returning id into created_round_id;

    insert into public.auction_events (
      case_id,
      lot_id,
      round_id,
      event_type,
      event_at,
      observed_at,
      source_id,
      payload,
      confidence_score
    ) values (
      created_case_id,
      created_lot_id,
      created_round_id,
      'announcement_observed',
      coalesce(sale_row.first_seen_at, sale_row.created_at, now()),
      coalesce(sale_row.first_seen_at, sale_row.created_at, now()),
      catalogue_source_id,
      jsonb_build_object(
        'source_key', stable_source_key,
        'catalogue_status', 'announced',
        'outcome_status', 'unknown',
        'mapping_version', 'auction-sales-bridge/v1'
      ),
      null
    )
    returning id into created_announcement_event_id;

    insert into public.auction_outcomes (
      round_id,
      version,
      outcome_status,
      initial_hammer_price_eur,
      final_hammer_price_eur,
      result_observed_at,
      canonical_confidence,
      training_eligible
    ) values (
      created_round_id,
      1,
      'unknown',
      null,
      null,
      null,
      null,
      false
    )
    returning id into created_unknown_outcome_id;

    source_input := jsonb_strip_nulls(jsonb_build_object(
      'auction_sale_id_at_bridge', sale_row.id,
      'source_name', sale_row.source_name,
      'source_url', sale_row.source_url,
      'external_id', sale_row.external_id,
      'title', sale_row.title,
      'legacy_status', sale_row.status,
      'sale_date', sale_row.sale_date,
      'starting_price_eur', sale_row.starting_price_eur,
      'property_type', sale_row.property_type,
      'surface_m2', sale_row.surface_m2,
      'habitable_surface_m2', sale_row.habitable_surface_m2,
      'snapshot_note', 'catalogue_only_not_verified_outcome'
    ));

    insert into public.auction_sale_outcome_bridges (
      source_key,
      source_name_snapshot,
      source_url_snapshot,
      external_id_snapshot,
      auction_sale_id,
      case_id,
      lot_id,
      round_id,
      announcement_event_id,
      unknown_outcome_id,
      catalogue_status,
      outcome_status,
      case_mapping_method,
      court_mapping_method,
      address_mapping_method,
      court_mapping_input,
      address_mapping_input,
      source_snapshot,
      training_eligible
    ) values (
      stable_source_key,
      sale_row.source_name,
      sale_row.source_url,
      sale_row.external_id,
      sale_row.id,
      created_case_id,
      created_lot_id,
      created_round_id,
      created_announcement_event_id,
      created_unknown_outcome_id,
      'announced',
      'unknown',
      'isolated_catalogue_listing',
      resolved_court_method,
      resolved_address_method,
      court_input,
      address_input,
      source_input,
      false
    );

    bridge_created := bridge_created + 1;
  end loop;

  select count(*) into bridge_linked
  from public.auction_sales catalogue_sale
  join public.auction_sale_outcome_bridges bridge
    on bridge.source_key = app_private.auction_sale_catalogue_source_key(catalogue_sale.source_url)
    and bridge.auction_sale_id = catalogue_sale.id
    and bridge.source_name_snapshot = catalogue_sale.source_name
    and bridge.source_url_snapshot = catalogue_sale.source_url
  join public.auction_cases case_row on case_row.id = bridge.case_id
  join public.auction_lots lot_row
    on lot_row.id = bridge.lot_id
    and lot_row.auction_case_id = bridge.case_id
    and lot_row.auction_sale_id = catalogue_sale.id
  join public.auction_rounds round_row
    on round_row.id = bridge.round_id
    and round_row.lot_id = bridge.lot_id
  join public.auction_events announcement
    on announcement.id = bridge.announcement_event_id
    and announcement.case_id = bridge.case_id
    and announcement.lot_id = bridge.lot_id
    and announcement.round_id = bridge.round_id
    and announcement.event_type = 'announcement_observed'
  join public.auction_outcomes unknown_outcome
    on unknown_outcome.id = bridge.unknown_outcome_id
    and unknown_outcome.round_id = bridge.round_id
    and unknown_outcome.outcome_status = 'unknown'
    and not unknown_outcome.training_eligible
  where bridge.catalogue_status = 'announced'
    and bridge.outcome_status = 'unknown'
    and not bridge.training_eligible;

  return query select
    catalogue_total,
    bridge_created,
    bridge_reused,
    bridge_linked,
    catalogue_total = bridge_linked;
end;
$$;

alter table public.auction_sale_outcome_bridges enable row level security;

revoke all on table public.auction_sale_outcome_bridges
from public, anon, authenticated;
grant select, insert, update on table public.auction_sale_outcome_bridges
to service_role;

revoke all on function public.bridge_auction_sales_to_outcome_graph()
from public, anon, authenticated;
grant execute on function public.bridge_auction_sales_to_outcome_graph()
to service_role;

revoke all on function app_private.guard_auction_sale_outcome_bridge_mutation()
from public, anon, authenticated;
revoke all on function app_private.require_outcome_bridge_before_auction_sale_delete()
from public, anon, authenticated;
revoke all on function app_private.auction_sale_catalogue_source_key(text)
from public, anon, authenticated;
grant execute on function app_private.guard_auction_sale_outcome_bridge_mutation()
to service_role;
grant execute on function app_private.require_outcome_bridge_before_auction_sale_delete()
to service_role;
grant execute on function app_private.auction_sale_catalogue_source_key(text)
to service_role;

comment on table public.auction_sale_outcome_bridges is
  'Immutable catalogue-to-Outcome lineage. A bounded SHA-256 key plus the URL snapshot survive catalogue deletion; rows are never training eligible.';
comment on function public.bridge_auction_sales_to_outcome_graph() is
  'Service-role-only, idempotent bridge of every auction_sales row into an announced case/lot/round with an explicitly unknown, never-trainable outcome.';

notify pgrst, 'reload schema';

commit;
