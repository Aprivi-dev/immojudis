begin;

alter table public.auction_sale_outcome_bridges
  drop constraint if exists auction_sale_outcome_bridges_court_mapping_method_check;

alter table public.auction_sale_outcome_bridges
  add constraint auction_sale_outcome_bridges_court_mapping_method_check check (
    court_mapping_method in (
      'tribunal_code_exact',
      'justice_competence_insee_exact',
      'unmapped'
    )
  );

-- Immutable proof that the trusted pipeline resolved the property's accepted
-- BAN commune code against the semantically validated Ministry reference.
create table public.auction_sale_competent_court_assignments (
  id uuid primary key default gen_random_uuid(),
  source_key text not null,
  auction_sale_id uuid references public.auction_sales(id) on delete set null,
  source_url_snapshot text not null,
  insee_code text not null check (insee_code ~ '^(?:[0-9]{5}|2[AB][0-9]{3})$'),
  commune_name text not null check (nullif(btrim(commune_name), '') is not null),
  court_id uuid not null references public.outcome_courts(id) on delete restrict,
  court_code text not null check (nullif(btrim(court_code), '') is not null),
  court_name text not null check (nullif(btrim(court_name), '') is not null),
  official_court_name text not null check (
    nullif(btrim(official_court_name), '') is not null
  ),
  court_origin_code text not null check (court_origin_code ~ '^[0-9]+$'),
  court_srj_code text not null check (court_srj_code ~ '^[0-9]+$'),
  reference_sha256 text not null check (reference_sha256 ~ '^[0-9a-f]{64}$'),
  mapping_method text not null check (
    mapping_method = 'justice_competence_insee_exact'
  ),
  evidence jsonb not null check (jsonb_typeof(evidence) = 'object'),
  created_at timestamptz not null default now(),
  unique (source_key, reference_sha256),
  constraint auction_sale_competent_court_source_key_check check (
    source_key = app_private.auction_sale_catalogue_source_key(source_url_snapshot)
  )
);

create index auction_sale_competent_court_sale_idx
  on public.auction_sale_competent_court_assignments(auction_sale_id, created_at desc)
  where auction_sale_id is not null;

create table public.catalogue_court_reconciliation_events (
  id uuid primary key default gen_random_uuid(),
  bridge_id uuid not null references public.auction_sale_outcome_bridges(id) on delete restrict,
  auction_sale_id uuid references public.auction_sales(id) on delete set null,
  old_court_id uuid not null references public.outcome_courts(id) on delete restrict,
  new_court_id uuid not null references public.outcome_courts(id) on delete restrict,
  mapping_method text not null check (
    mapping_method in ('justice_competence_insee_exact', 'unmapped')
  ),
  insee_code text check (
    insee_code is null or insee_code ~ '^(?:[0-9]{5}|2[AB][0-9]{3})$'
  ),
  reference_sha256 text check (
    reference_sha256 is null or reference_sha256 ~ '^[0-9a-f]{64}$'
  ),
  created_at timestamptz not null default now(),
  unique (bridge_id, new_court_id, mapping_method, reference_sha256)
);

create or replace function app_private.auction_sale_verified_court_code(
  p_sale public.auction_sales
)
returns text
language sql
stable
security invoker
set search_path = ''
as $$
  select case
    when jsonb_typeof(p_sale.raw_payload->'tribunal_assignment') = 'object'
      and p_sale.raw_payload->'tribunal_assignment'->>'schema_version'
        = 'justice_competent_court_assignment_v1'
      and p_sale.raw_payload->'tribunal_assignment'->>'status' = 'verified'
      and p_sale.raw_payload->'tribunal_assignment'->>'mapping_method'
        = 'justice_competence_insee_exact'
      and p_sale.raw_payload->'tribunal_assignment'->>'source_name'
        = 'justice_open_data'
      and p_sale.raw_payload->'tribunal_assignment'->>'source_url'
        = 'https://www.data.gouv.fr/datasets/liste-des-juridictions-competentes-pour-les-communes-de-france'
      and p_sale.raw_payload->'tribunal_assignment'->>'insee_code'
        ~ '^(?:[0-9]{5}|2[AB][0-9]{3})$'
      and p_sale.raw_payload->'tribunal_assignment'->>'reference_sha256'
        ~ '^[0-9a-f]{64}$'
      and nullif(btrim(p_sale.raw_payload->'tribunal_assignment'->>'commune_name'), '')
        is not null
      and nullif(btrim(p_sale.raw_payload->'tribunal_assignment'->>'court_name'), '')
        is not null
      and nullif(btrim(p_sale.raw_payload->'tribunal_assignment'->>'official_court_name'), '')
        is not null
      and p_sale.raw_payload->'tribunal_assignment'->>'court_origin_code' ~ '^[0-9]+$'
      and p_sale.raw_payload->'tribunal_assignment'->>'court_srj_code' ~ '^[0-9]+$'
      and jsonb_typeof(p_sale.raw_payload->'geocode') = 'object'
      and p_sale.raw_payload->'geocode'->>'provider' = 'ban_geoplateforme'
      and p_sale.raw_payload->'geocode'->'accepted' = 'true'::jsonb
      and upper(p_sale.raw_payload->'geocode'->>'citycode')
        = upper(p_sale.raw_payload->'tribunal_assignment'->>'insee_code')
      and p_sale.tribunal_code
        = p_sale.raw_payload->'tribunal_assignment'->>'court_code'
      and p_sale.tribunal
        = p_sale.raw_payload->'tribunal_assignment'->>'court_name'
      and exists (
        select 1
        from public.tribunals tribunal_row
        where tribunal_row.code = p_sale.tribunal_code
          and tribunal_row.canonical_name = p_sale.tribunal
      )
      then p_sale.tribunal_code
    else null
  end;
$$;

create or replace function app_private.catalogue_bridge_court_is_reconcilable(
  p_bridge_id uuid,
  p_target_court_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.auction_sale_outcome_bridges bridge
    join public.auction_sales sale_row on sale_row.id = bridge.auction_sale_id
    join public.outcome_courts target_court on target_court.id = p_target_court_id
    join public.auction_outcomes unknown_outcome
      on unknown_outcome.id = bridge.unknown_outcome_id
      and unknown_outcome.round_id = bridge.round_id
      and unknown_outcome.outcome_status = 'unknown'
      and not unknown_outcome.training_eligible
    where bridge.id = p_bridge_id
      and target_court.code = coalesce(
        app_private.auction_sale_verified_court_code(sale_row),
        'legacy:unmapped'
      )
      and bridge.catalogue_status = 'announced'
      and bridge.outcome_status = 'unknown'
      and not bridge.training_eligible
      and not exists (
        select 1 from public.auction_feature_snapshots snapshot_row
        where snapshot_row.round_id = bridge.round_id
      )
      and not exists (
        select 1 from public.auction_predictions prediction_row
        where prediction_row.round_id = bridge.round_id
      )
      and not exists (
        select 1 from public.tribunal_statistics_members member_row
        where member_row.round_id = bridge.round_id
      )
      and not exists (
        select 1 from public.source_record_matches match_row
        where match_row.case_id = bridge.case_id
          or match_row.lot_id = bridge.lot_id
          or match_row.round_id = bridge.round_id
          or match_row.outcome_id = bridge.unknown_outcome_id
      )
      and not exists (
        select 1 from public.auction_events event_row
        where event_row.round_id = bridge.round_id
          and event_row.id <> bridge.announcement_event_id
      )
      and not exists (
        select 1 from public.auction_outcomes outcome_row
        where outcome_row.round_id = bridge.round_id
          and outcome_row.id <> bridge.unknown_outcome_id
      )
      and not exists (
        select 1 from public.auction_outcome_evidence evidence_row
        where evidence_row.outcome_id = bridge.unknown_outcome_id
      )
      and not exists (
        select 1 from public.outcome_claim_eligibility_decisions decision_row
        where decision_row.outcome_id = bridge.unknown_outcome_id
      )
  );
$$;

create or replace function app_private.guard_auction_case_statistics_identity()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.court_id is distinct from old.court_id then
    if exists (
      select 1
      from public.auction_sale_outcome_bridges bridge
      where bridge.case_id = old.id
        and app_private.catalogue_bridge_court_is_reconcilable(bridge.id, new.court_id)
    ) and not exists (
      select 1
      from public.auction_sale_outcome_bridges bridge
      where bridge.case_id = old.id
        and not app_private.catalogue_bridge_court_is_reconcilable(bridge.id, new.court_id)
    ) then
      return new;
    end if;
    raise exception using
      errcode = '55000',
      message = 'Auction case statistical identity is immutable; create a new case.';
  end if;
  return new;
end;
$$;

create or replace function app_private.guard_auction_round_statistics_identity()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception using
      errcode = '55000',
      message = 'Auction round statistical identity is immutable; create a new round.';
  end if;
  if new.lot_id is distinct from old.lot_id
    or new.round_kind is distinct from old.round_kind
    or new.sequence_number is distinct from old.sequence_number
    or new.previous_round_id is distinct from old.previous_round_id
    or new.scheduled_at is distinct from old.scheduled_at
    or new.local_timezone is distinct from old.local_timezone
    or new.initial_starting_price_eur is distinct from old.initial_starting_price_eur
    or new.effective_starting_price_eur is distinct from old.effective_starting_price_eur
    or new.created_at is distinct from old.created_at
    or new.recorded_at is distinct from old.recorded_at then
    raise exception using
      errcode = '55000',
      message = 'Auction round statistical identity is immutable; create a new round.';
  end if;
  if new.court_id is distinct from old.court_id then
    if exists (
      select 1
      from public.auction_sale_outcome_bridges bridge
      where bridge.round_id = old.id
        and app_private.catalogue_bridge_court_is_reconcilable(bridge.id, new.court_id)
    ) then
      return new;
    end if;
    raise exception using
      errcode = '55000',
      message = 'Auction round statistical identity is immutable; create a new round.';
  end if;
  return new;
end;
$$;

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

create or replace function app_private.guard_competent_court_audit_mutation()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  raise exception using
    errcode = '55000',
    message = 'Competent-court audit rows are immutable.';
end;
$$;

create trigger guard_competent_court_assignment_before_mutation
before update or delete on public.auction_sale_competent_court_assignments
for each row execute function app_private.guard_competent_court_audit_mutation();

create trigger guard_catalogue_court_event_before_mutation
before update or delete on public.catalogue_court_reconciliation_events
for each row execute function app_private.guard_competent_court_audit_mutation();

create or replace function public.reconcile_catalogue_competent_courts()
returns table (
  scanned_count bigint,
  corrected_count bigint,
  already_correct_count bigint,
  blocked_count bigint,
  complete boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  bridge_row public.auction_sale_outcome_bridges%rowtype;
  sale_row public.auction_sales%rowtype;
  assignment jsonb;
  verified_court_code text;
  target_court public.outcome_courts%rowtype;
  old_court_id uuid;
  desired_method text;
  desired_input jsonb;
  total_scanned bigint := 0;
  total_corrected bigint := 0;
  total_already_correct bigint := 0;
  total_blocked bigint := 0;
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('immojudis:competent-court-reconciliation:v1', 0)
  );

  insert into public.outcome_courts(code, name, court_type, active)
  values ('legacy:unmapped', 'Tribunal non déterminé (pont catalogue)', 'unknown', false)
  on conflict (code) do nothing;

  insert into public.outcome_courts(code, name, court_type, active)
  select tribunal_row.code, tribunal_row.canonical_name, 'tribunal_judiciaire', true
  from public.tribunals tribunal_row
  on conflict (code) do nothing;

  for bridge_row in
    select bridge.*
    from public.auction_sale_outcome_bridges bridge
    join public.auction_sales sale on sale.id = bridge.auction_sale_id
    order by bridge.id
    for update of bridge
  loop
    select sale.* into strict sale_row
    from public.auction_sales sale
    where sale.id = bridge_row.auction_sale_id
    for update;

    total_scanned := total_scanned + 1;
    assignment := sale_row.raw_payload->'tribunal_assignment';
    verified_court_code := app_private.auction_sale_verified_court_code(sale_row);
    desired_method := case
      when verified_court_code is null then 'unmapped'
      else 'justice_competence_insee_exact'
    end;

    select court_row.* into target_court
    from public.outcome_courts court_row
    where court_row.code = coalesce(verified_court_code, 'legacy:unmapped');
    if target_court.id is null then
      total_blocked := total_blocked + 1;
      continue;
    end if;

    if verified_court_code is not null then
      insert into public.auction_sale_competent_court_assignments (
        source_key,
        auction_sale_id,
        source_url_snapshot,
        insee_code,
        commune_name,
        court_id,
        court_code,
        court_name,
        official_court_name,
        court_origin_code,
        court_srj_code,
        reference_sha256,
        mapping_method,
        evidence
      ) values (
        bridge_row.source_key,
        sale_row.id,
        sale_row.source_url,
        upper(assignment->>'insee_code'),
        assignment->>'commune_name',
        target_court.id,
        verified_court_code,
        assignment->>'court_name',
        assignment->>'official_court_name',
        assignment->>'court_origin_code',
        assignment->>'court_srj_code',
        assignment->>'reference_sha256',
        'justice_competence_insee_exact',
        assignment
      ) on conflict (source_key, reference_sha256) do nothing;
    end if;

    select round_row.court_id into old_court_id
    from public.auction_rounds round_row
    where round_row.id = bridge_row.round_id;

    desired_input := case
      when verified_court_code is null then jsonb_build_object(
        'schema_version', 'catalogue_court_mapping_v2',
        'mapping_method', 'unmapped',
        'reason', 'no_verified_insee_competence',
        'resolved_outcome_court_id', target_court.id
      )
      else jsonb_build_object(
        'schema_version', 'catalogue_court_mapping_v2',
        'mapping_method', 'justice_competence_insee_exact',
        'insee_code', assignment->>'insee_code',
        'court_code', verified_court_code,
        'court_name', assignment->>'court_name',
        'reference_sha256', assignment->>'reference_sha256',
        'resolved_outcome_court_id', target_court.id
      )
    end;

    if old_court_id = target_court.id
      and bridge_row.court_mapping_method = desired_method
      and bridge_row.court_mapping_input = desired_input then
      total_already_correct := total_already_correct + 1;
      continue;
    end if;

    if not app_private.catalogue_bridge_court_is_reconcilable(
      bridge_row.id,
      target_court.id
    ) then
      total_blocked := total_blocked + 1;
      continue;
    end if;

    update public.auction_cases
    set court_id = target_court.id,
        updated_at = now()
    where id = bridge_row.case_id
      and court_id is distinct from target_court.id;

    update public.auction_rounds
    set court_id = target_court.id,
        updated_at = now()
    where id = bridge_row.round_id
      and court_id is distinct from target_court.id;

    if verified_court_code is not null then
      update public.outcome_addresses address_row
      set insee_code = upper(assignment->>'insee_code'),
          updated_at = now()
      from public.auction_lots lot_row
      where lot_row.id = bridge_row.lot_id
        and address_row.id = lot_row.address_id
        and address_row.insee_code is distinct from upper(assignment->>'insee_code');
    end if;

    update public.auction_sale_outcome_bridges
    set court_mapping_method = desired_method,
        court_mapping_input = desired_input
    where id = bridge_row.id;

    insert into public.catalogue_court_reconciliation_events (
      bridge_id,
      auction_sale_id,
      old_court_id,
      new_court_id,
      mapping_method,
      insee_code,
      reference_sha256
    ) values (
      bridge_row.id,
      sale_row.id,
      old_court_id,
      target_court.id,
      desired_method,
      case when verified_court_code is null then null else upper(assignment->>'insee_code') end,
      case when verified_court_code is null then null else assignment->>'reference_sha256' end
    ) on conflict do nothing;

    total_corrected := total_corrected + 1;
  end loop;

  return query select
    total_scanned,
    total_corrected,
    total_already_correct,
    total_blocked,
    total_blocked = 0;
end;
$$;

alter table public.auction_sale_competent_court_assignments enable row level security;
alter table public.catalogue_court_reconciliation_events enable row level security;

revoke all on table public.auction_sale_competent_court_assignments
  from anon, authenticated, service_role;
revoke all on table public.catalogue_court_reconciliation_events
  from anon, authenticated, service_role;
grant select, insert on table public.auction_sale_competent_court_assignments
  to service_role;
grant select, insert on table public.catalogue_court_reconciliation_events
  to service_role;

revoke all on function public.reconcile_catalogue_competent_courts()
  from public, anon, authenticated;
grant execute on function public.reconcile_catalogue_competent_courts()
  to service_role;

comment on table public.auction_sale_competent_court_assignments is
  'Immutable exact-INSEE competent-court evidence from the semantically validated Ministry reference.';
comment on function public.reconcile_catalogue_competent_courts() is
  'Reconciles only untouched catalogue-only Outcome lineages; any snapshot, prediction, match, outcome evidence or statistical member blocks mutation.';

notify pgrst, 'reload schema';

commit;
