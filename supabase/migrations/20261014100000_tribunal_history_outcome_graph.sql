-- Tribunal statistics: national label resolution and history read from the
-- Outcome Graph.
--
-- Why: catalogue retention purges past sales from auction_sales, so the
-- "observed history" of /tribunaux and of the listing statistics block was
-- empty. Every sale is bridged into the Outcome Graph before deletion, but
-- most bridges stayed on 'legacy:unmapped' because the pipeline only coded the
-- ten legacy Aquitaine courts when the verified INSEE competence was missing.
--
-- What:
--   1. app_private.normalize_tribunal_label / tribunal_label_court_key /
--      resolve_tribunal_code_from_label: an explicit TJ/TGI label resolves to
--      exactly one court of public.tribunals (unique match, otherwise NULL).
--      A bare city never resolves. Mirrors tribunal_label_court_key() in
--      services/data-pipeline/src/court_competence.py.
--   2. Idempotent backfill of auction_sales.tribunal_code for judicial sales
--      whose label resolves uniquely.
--   3. New bridge mapping method 'tribunal_label_exact'. The verified INSEE
--      competence keeps priority; the label is used only without it, and an
--      archived bridge is only ever moved off 'legacy:unmapped'. Every existing
--      dependency guard (feature snapshots, predictions, statistics members,
--      court-dependent source matches, extra events/outcomes, evidence, claim
--      decisions) is unchanged.
--   4. public.tribunal_outcome_graph_past_hearings: read-only, service_role
--      only, past hearings of the graph attached to a real tribunal.
begin;

set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 1. Label normalization and resolution
-- ---------------------------------------------------------------------------

create or replace function app_private.normalize_tribunal_label(p_label text)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$
  -- NFKD + combining marks removed, lower case, every non [a-z0-9] run (hyphen,
  -- apostrophe, punctuation) collapsed to one space.
  select nullif(
    pg_catalog.btrim(
      pg_catalog.regexp_replace(
        pg_catalog.regexp_replace(
          pg_catalog.lower(normalize(coalesce(p_label, ''), NFKD)),
          '[\u0300-\u036f]',
          '',
          'g'
        ),
        '[^a-z0-9]+',
        ' ',
        'g'
      )
    ),
    ''
  );
$$;

create or replace function app_private.tribunal_label_court_key(p_label text)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$
  -- "Tribunal judiciaire d'Évry-Courcouronnes" and "TJ Evry Courcouronnes"
  -- both give "evry courcouronnes". Without an explicit court prefix the key
  -- is NULL: a commune name is never treated as a court.
  select (
    pg_catalog.regexp_match(
      app_private.normalize_tribunal_label(p_label),
      '^(?:tribunal judiciaire|tribunal de grande instance|tgi|tj)(?: (?:de|du|des|d))? (.+)$'
    )
  )[1];
$$;

-- Court keys of one reference row (canonical name and every alias).
create or replace function app_private.tribunal_reference_label_keys(
  p_canonical_name text,
  p_aliases jsonb
)
returns text[]
language sql
immutable
parallel safe
set search_path = ''
as $$
  select coalesce(
    pg_catalog.array_agg(distinct court_key.value order by court_key.value)
      filter (where court_key.value is not null),
    array[]::text[]
  )
  from (
    select app_private.tribunal_label_court_key(p_canonical_name) as value
    union all
    select app_private.tribunal_label_court_key(alias.value)
    from pg_catalog.jsonb_array_elements_text(
      case
        when pg_catalog.jsonb_typeof(p_aliases) = 'array' then p_aliases
        else '[]'::jsonb
      end
    ) as alias(value)
  ) as court_key;
$$;

-- Stored once per reference row so a lookup is an array containment test,
-- not ~500 regular expressions per call. If tribunal_label_court_key() ever
-- changes, rewrite the column (update public.tribunals set canonical_name =
-- canonical_name).
alter table public.tribunals
  add column if not exists label_keys text[]
  generated always as (app_private.tribunal_reference_label_keys(canonical_name, aliases)) stored;

create index if not exists tribunals_label_keys_idx
  on public.tribunals using gin (label_keys);

create or replace function app_private.resolve_tribunal_code_from_label(p_label text)
returns text
language sql
stable
set search_path = ''
as $$
  -- Unique match only: two courts sharing a key resolve to NULL, and a label
  -- without a court key never matches (array[NULL] is contained nowhere).
  select case when pg_catalog.count(*) = 1 then pg_catalog.min(tribunal_row.code) end
  from public.tribunals tribunal_row
  where tribunal_row.label_keys @> array[app_private.tribunal_label_court_key(p_label)];
$$;

-- Sources whose catalogue rows are not judicial real-estate auctions:
-- notarial sales (notaires), State disposals (cessions_etat) and seized-asset
-- sales of the AGRASC agency. They never feed tribunal statistics, even when a
-- label happens to look like a court.
create or replace function app_private.is_non_judicial_catalogue_source(p_source_name text)
returns boolean
language sql
immutable
parallel safe
set search_path = ''
as $$
  select coalesce(pg_catalog.lower(pg_catalog.btrim(p_source_name)), '')
    in ('notaires', 'cessions_etat', 'agrasc');
$$;

revoke all on function app_private.normalize_tribunal_label(text) from public, anon, authenticated;
revoke all on function app_private.tribunal_label_court_key(text) from public, anon, authenticated;
revoke all on function app_private.tribunal_reference_label_keys(text, jsonb) from public, anon, authenticated;
grant execute on function app_private.tribunal_reference_label_keys(text, jsonb) to service_role;
revoke all on function app_private.resolve_tribunal_code_from_label(text) from public, anon, authenticated;
revoke all on function app_private.is_non_judicial_catalogue_source(text) from public, anon, authenticated;
grant execute on function app_private.normalize_tribunal_label(text) to service_role;
grant execute on function app_private.tribunal_label_court_key(text) to service_role;
grant execute on function app_private.resolve_tribunal_code_from_label(text) to service_role;
grant execute on function app_private.is_non_judicial_catalogue_source(text) to service_role;

-- ---------------------------------------------------------------------------
-- 2. Backfill auction_sales.tribunal_code (idempotent: only NULL codes)
-- ---------------------------------------------------------------------------

-- Same audit trail as public.reconcile_catalogue_court_labels (migration
-- 20260824163134), with its own method: that older resolver matches exact or
-- prefix labels against active courts, this one matches the court key.
alter table public.auction_sale_court_label_assignments
  drop constraint auction_sale_court_label_assignments_mapping_method_check;
alter table public.auction_sale_court_label_assignments
  add constraint auction_sale_court_label_assignments_mapping_method_check
  check (
    mapping_method in (
      'source_tribunal_label_exact',
      'source_tribunal_label_unique_prefix',
      'source_tribunal_label_key'
    )
  );

insert into public.outcome_courts(code, name, court_type, active)
select tribunal_row.code, tribunal_row.canonical_name, 'tribunal_judiciaire', true
from public.tribunals tribunal_row
on conflict (code) do nothing;

create temporary table tribunal_label_backfill on commit drop as
select
  sale.id as auction_sale_id,
  sale.source_url,
  sale.tribunal as source_label,
  tribunal_row.code as tribunal_code,
  tribunal_row.canonical_name,
  court_row.id as court_id,
  court_row.name as court_name
from public.auction_sales sale
cross join lateral (
  select app_private.resolve_tribunal_code_from_label(sale.tribunal) as code
) resolved
join public.tribunals tribunal_row on tribunal_row.code = resolved.code
join public.outcome_courts court_row on court_row.code = resolved.code
where sale.sale_venue_type = 'tribunal'
  and sale.tribunal_code is null
  and nullif(pg_catalog.btrim(sale.tribunal), '') is not null
  and not app_private.is_non_judicial_catalogue_source(sale.source_name);

insert into public.auction_sale_court_label_assignments (
  source_key,
  auction_sale_id,
  source_url_snapshot,
  source_label_snapshot,
  normalized_source_label,
  court_id,
  court_code,
  court_name,
  matched_label,
  normalized_matched_label,
  mapping_method,
  candidate_count
)
select
  app_private.auction_sale_catalogue_source_key(backfill.source_url),
  backfill.auction_sale_id,
  backfill.source_url,
  backfill.source_label,
  app_private.normalize_court_label(backfill.source_label),
  backfill.court_id,
  backfill.tribunal_code,
  backfill.court_name,
  backfill.canonical_name,
  app_private.normalize_court_label(backfill.canonical_name),
  'source_tribunal_label_key',
  1
from tribunal_label_backfill backfill
on conflict (source_key, normalized_source_label, court_code, mapping_method) do nothing;

update public.auction_sales sale
set tribunal_code = backfill.tribunal_code
from tribunal_label_backfill backfill
where backfill.auction_sale_id = sale.id
  and sale.tribunal_code is null;

-- ---------------------------------------------------------------------------
-- 3. Outcome Graph: label-based court mapping
-- ---------------------------------------------------------------------------

alter table public.auction_sale_outcome_bridges
  drop constraint auction_sale_outcome_bridges_court_mapping_method_check;
alter table public.auction_sale_outcome_bridges
  add constraint auction_sale_outcome_bridges_court_mapping_method_check
  check (
    court_mapping_method in (
      'tribunal_code_exact',
      'justice_competence_insee_exact',
      'tribunal_label_exact',
      'unmapped'
    )
  );

alter table public.catalogue_court_reconciliation_events
  drop constraint catalogue_court_reconciliation_events_mapping_method_check;
alter table public.catalogue_court_reconciliation_events
  add constraint catalogue_court_reconciliation_events_mapping_method_check
  check (
    mapping_method in ('justice_competence_insee_exact', 'tribunal_label_exact', 'unmapped')
  );

-- The label of a bridge: the live catalogue label while the sale exists,
-- otherwise the label captured in the bridge court input.
create or replace function app_private.catalogue_bridge_tribunal_label(p_bridge_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select nullif(
    pg_catalog.btrim(
      case
        when sale_row.id is not null then sale_row.tribunal
        else bridge.court_mapping_input->>'tribunal_label'
      end
    ),
    ''
  )
  from public.auction_sale_outcome_bridges bridge
  left join public.auction_sales sale_row on sale_row.id = bridge.auction_sale_id
  where bridge.id = p_bridge_id;
$$;

-- Court code named by the bridge label, or NULL. A live sale must be a
-- judicial sale and must not carry a different tribunal_code; a judicial
-- source label is never trusted for notarial/State/AGRASC sources.
create or replace function app_private.catalogue_bridge_label_court_code(p_bridge_id uuid)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  bridge_row public.auction_sale_outcome_bridges%rowtype;
  sale_row public.auction_sales%rowtype;
  label_code text;
begin
  select bridge.* into bridge_row
  from public.auction_sale_outcome_bridges bridge
  where bridge.id = p_bridge_id;
  if bridge_row.id is null
    or app_private.is_non_judicial_catalogue_source(bridge_row.source_name_snapshot) then
    return null;
  end if;

  label_code := app_private.resolve_tribunal_code_from_label(
    app_private.catalogue_bridge_tribunal_label(p_bridge_id)
  );
  if label_code is null or bridge_row.auction_sale_id is null then
    return label_code;
  end if;

  select sale.* into sale_row
  from public.auction_sales sale
  where sale.id = bridge_row.auction_sale_id;
  if sale_row.id is null then
    return label_code;
  end if;
  if sale_row.sale_venue_type is distinct from 'tribunal'
    or (sale_row.tribunal_code is not null and sale_row.tribunal_code <> label_code) then
    return null;
  end if;
  return label_code;
end;
$$;

-- Expected court_mapping_input for a target court, or NULL when that court is
-- not an admissible mapping for the bridge. Admissible courts:
--   * live sale with verified INSEE competence: that court only;
--   * otherwise 'legacy:unmapped' (fail-closed) or the court named by the
--     explicit label.
create or replace function app_private.catalogue_bridge_court_mapping_input(
  p_bridge_id uuid,
  p_court_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  bridge_row public.auction_sale_outcome_bridges%rowtype;
  sale_row public.auction_sales%rowtype;
  court_row public.outcome_courts%rowtype;
  verified_court_code text;
  label_text text;
  label_code text;
begin
  select bridge.* into bridge_row
  from public.auction_sale_outcome_bridges bridge
  where bridge.id = p_bridge_id;
  select court.* into court_row
  from public.outcome_courts court
  where court.id = p_court_id;
  if bridge_row.id is null or court_row.id is null then
    return null;
  end if;

  if bridge_row.auction_sale_id is not null then
    select sale.* into sale_row
    from public.auction_sales sale
    where sale.id = bridge_row.auction_sale_id;
    if sale_row.id is not null then
      verified_court_code := app_private.auction_sale_verified_court_code(sale_row);
    end if;
  end if;

  if verified_court_code is not null then
    if court_row.code <> verified_court_code then
      return null;
    end if;
    -- Unchanged v2 shape, so already reconciled rows stay "already correct".
    return jsonb_build_object(
      'schema_version', 'catalogue_court_mapping_v2',
      'mapping_method', 'justice_competence_insee_exact',
      'insee_code', sale_row.raw_payload->'tribunal_assignment'->>'insee_code',
      'court_code', verified_court_code,
      'court_name', sale_row.raw_payload->'tribunal_assignment'->>'court_name',
      'reference_sha256', sale_row.raw_payload->'tribunal_assignment'->>'reference_sha256',
      'resolved_outcome_court_id', court_row.id
    );
  end if;

  label_text := app_private.catalogue_bridge_tribunal_label(p_bridge_id);
  if court_row.code = 'legacy:unmapped' then
    -- The source label is kept so an archived bridge can still be resolved
    -- once the catalogue row has been purged.
    return jsonb_build_object(
      'schema_version', 'catalogue_court_mapping_v2',
      'mapping_method', 'unmapped',
      'reason', 'no_verified_insee_competence',
      'resolved_outcome_court_id', court_row.id
    ) || case
      when label_text is null then '{}'::jsonb
      else jsonb_build_object('tribunal_label', label_text)
    end;
  end if;

  label_code := app_private.catalogue_bridge_label_court_code(p_bridge_id);
  if label_code is null or court_row.code <> label_code then
    return null;
  end if;
  return jsonb_build_object(
    'schema_version', 'catalogue_court_mapping_v2',
    'mapping_method', 'tribunal_label_exact',
    'tribunal_label', label_text,
    'label_key', app_private.tribunal_label_court_key(label_text),
    'court_code', label_code,
    'resolved_outcome_court_id', court_row.id
  );
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
    left join public.auction_sales sale_row on sale_row.id = bridge.auction_sale_id
    join public.outcome_courts target_court on target_court.id = p_target_court_id
    join public.auction_outcomes unknown_outcome
      on unknown_outcome.id = bridge.unknown_outcome_id
      and unknown_outcome.round_id = bridge.round_id
      and unknown_outcome.outcome_status = 'unknown'
      and not unknown_outcome.training_eligible
    where bridge.id = p_bridge_id
      and app_private.catalogue_bridge_court_mapping_input(bridge.id, target_court.id) is not null
      -- An archived bridge (catalogue row purged) can only move between
      -- 'legacy:unmapped' and its explicit label court; a verified or
      -- bridge-time court mapping is never rewritten without its sale.
      and (
        sale_row.id is not null
        or bridge.court_mapping_method in ('unmapped', 'tribunal_label_exact')
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
        select 1
        from public.source_record_matches match_row
        join public.judicial_source_records record_row
          on record_row.id = match_row.source_record_id
        where (
          match_row.case_id = bridge.case_id
          or match_row.lot_id = bridge.lot_id
          or match_row.round_id = bridge.round_id
          or match_row.outcome_id = bridge.unknown_outcome_id
        ) and (
          match_row.status not in (
            'candidate', 'weak_candidate', 'review_required', 'strong_candidate'
          )
          or match_row.decided_at is not null
          or match_row.reviewer_user_id is not null
          or match_row.decision_notes is not null
          or match_row.supersedes_match_id is not null
          or record_row.training_eligible
          or match_row.match_method in ('court_name_address', 'address_date_court')
          or match_row.match_signals ? 'court'
          or exists (
            select 1
            from public.source_record_matches successor_row
            where successor_row.supersedes_match_id = match_row.id
          )
        )
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

create or replace function app_private.guard_auction_sale_outcome_bridge_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  expected_input jsonb;
  resolved_court_id uuid;
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
    select case_row.court_id into resolved_court_id
    from public.auction_cases case_row
    where case_row.id = new.case_id;

    -- The mapping must describe the court the case already points to, with
    -- the exact provenance computed from the evidence (INSEE competence,
    -- explicit label, or unmapped).
    expected_input := app_private.catalogue_bridge_court_mapping_input(
      new.id,
      resolved_court_id
    );
    if expected_input is not null
      and new.court_mapping_method = expected_input->>'mapping_method'
      and new.court_mapping_input = expected_input
      and app_private.catalogue_bridge_court_is_reconcilable(new.id, resolved_court_id) then
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

-- Move one bridge (case, round, provenance, audit event) to an admissible
-- court. Returns false when a dependency freezes the statistical lineage.
create or replace function app_private.apply_catalogue_bridge_court(
  p_bridge_id uuid,
  p_target_court_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  bridge_row public.auction_sale_outcome_bridges%rowtype;
  desired_input jsonb;
  old_court_id uuid;
begin
  select bridge.* into bridge_row
  from public.auction_sale_outcome_bridges bridge
  where bridge.id = p_bridge_id
  for update;
  desired_input := app_private.catalogue_bridge_court_mapping_input(p_bridge_id, p_target_court_id);
  if bridge_row.id is null
    or desired_input is null
    or not app_private.catalogue_bridge_court_is_reconcilable(p_bridge_id, p_target_court_id) then
    return false;
  end if;

  select round_row.court_id into old_court_id
  from public.auction_rounds round_row
  where round_row.id = bridge_row.round_id;

  update public.auction_cases
  set court_id = p_target_court_id,
      updated_at = now()
  where id = bridge_row.case_id
    and court_id is distinct from p_target_court_id;

  update public.auction_rounds
  set court_id = p_target_court_id,
      updated_at = now()
  where id = bridge_row.round_id
    and court_id is distinct from p_target_court_id;

  update public.auction_sale_outcome_bridges
  set court_mapping_method = desired_input->>'mapping_method',
      court_mapping_input = desired_input
  where id = bridge_row.id
    and (
      court_mapping_method is distinct from desired_input->>'mapping_method'
      or court_mapping_input is distinct from desired_input
    );

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
    bridge_row.auction_sale_id,
    old_court_id,
    p_target_court_id,
    desired_input->>'mapping_method',
    case
      when desired_input->>'mapping_method' = 'justice_competence_insee_exact'
        then pg_catalog.upper(desired_input->>'insee_code')
    end,
    case
      when desired_input->>'mapping_method' = 'justice_competence_insee_exact'
        then desired_input->>'reference_sha256'
    end
  ) on conflict do nothing;
  return true;
end;
$$;

create or replace function public.reconcile_catalogue_competent_courts_batch(p_after_id uuid default null, p_limit integer default 25)
returns table (
  scanned_count bigint,
  corrected_count bigint,
  already_correct_count bigint,
  blocked_count bigint,
  complete boolean,
  next_cursor uuid,
  has_more boolean
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
  label_court_code text;
  target_court public.outcome_courts%rowtype;
  old_court public.outcome_courts%rowtype;
  desired_input jsonb;
  last_id uuid := p_after_id;
  more_rows boolean;
  total_scanned bigint := 0;
  total_corrected bigint := 0;
  total_already_correct bigint := 0;
  total_blocked bigint := 0;
begin
  if p_limit is null or p_limit < 1 or p_limit > 100 then
    raise exception using errcode = '22023', message = 'Batch limit must be between 1 and 100.';
  end if;
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
    where p_after_id is null or bridge.id > p_after_id
    order by bridge.id
    limit p_limit
    for update of bridge
  loop
    select sale.* into strict sale_row
    from public.auction_sales sale
    where sale.id = bridge_row.auction_sale_id
    for update;

    last_id := bridge_row.id;
    total_scanned := total_scanned + 1;
    assignment := sale_row.raw_payload->'tribunal_assignment';
    verified_court_code := app_private.auction_sale_verified_court_code(sale_row);
    -- Priority: verified INSEE competence, then the explicit source label,
    -- then the fail-closed 'legacy:unmapped' court.
    label_court_code := case
      when verified_court_code is null
        then app_private.catalogue_bridge_label_court_code(bridge_row.id)
    end;

    target_court := null;
    select court_row.* into target_court
    from public.outcome_courts court_row
    where court_row.code = coalesce(verified_court_code, label_court_code, 'legacy:unmapped');
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

    old_court := null;
    select court_row.* into old_court
    from public.auction_rounds round_row
    join public.outcome_courts court_row on court_row.id = round_row.court_id
    where round_row.id = bridge_row.round_id;

    desired_input := app_private.catalogue_bridge_court_mapping_input(bridge_row.id, target_court.id);

    if old_court.id = target_court.id
      and bridge_row.court_mapping_method = desired_input->>'mapping_method'
      and bridge_row.court_mapping_input = desired_input then
      total_already_correct := total_already_correct + 1;
      continue;
    end if;

    if not app_private.catalogue_bridge_court_is_reconcilable(bridge_row.id, target_court.id) then
      -- A downstream dependency freezes the lineage. Keeping it is "already
      -- correct" when it already sits on the right court with the right
      -- method (only the provenance text would change), or when an
      -- unverified bridge stays fail-closed on 'legacy:unmapped' instead of
      -- gaining an optional label court. Anything else stays blocked, as
      -- before, so destructive cleanup is disabled.
      if (old_court.id = target_court.id
          and bridge_row.court_mapping_method = desired_input->>'mapping_method')
        or (verified_court_code is null
          and old_court.code = 'legacy:unmapped'
          and bridge_row.court_mapping_method = 'unmapped') then
        total_already_correct := total_already_correct + 1;
      else
        total_blocked := total_blocked + 1;
      end if;
      continue;
    end if;

    perform app_private.apply_catalogue_bridge_court(bridge_row.id, target_court.id);

    if verified_court_code is not null then
      update public.outcome_addresses address_row
      set insee_code = upper(assignment->>'insee_code'),
          updated_at = now()
      from public.auction_lots lot_row
      where lot_row.id = bridge_row.lot_id
        and address_row.id = lot_row.address_id
        and address_row.insee_code is distinct from upper(assignment->>'insee_code');
    end if;

    total_corrected := total_corrected + 1;
  end loop;

  select exists (
    select 1 from public.auction_sale_outcome_bridges b
    join public.auction_sales s on s.id = b.auction_sale_id
    where last_id is null or b.id > last_id
  ) into more_rows;

  return query select
    total_scanned,
    total_corrected,
    total_already_correct,
    total_blocked,
    total_blocked = 0,
    last_id,
    more_rows;
end;
$$;

-- The unbounded entry point now delegates to the batch so both share one
-- mapping policy (its older standalone body would write the previous
-- provenance shape, which the bridge guard rejects).
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
  page record;
  cursor_id uuid;
  iteration integer := 0;
  total_scanned bigint := 0;
  total_corrected bigint := 0;
  total_already_correct bigint := 0;
  total_blocked bigint := 0;
begin
  loop
    iteration := iteration + 1;
    if iteration > 10000 then
      raise exception using errcode = '54000', message = 'Court reconciliation did not converge.';
    end if;
    select * into page from public.reconcile_catalogue_competent_courts_batch(cursor_id, 100);
    total_scanned := total_scanned + page.scanned_count;
    total_corrected := total_corrected + page.corrected_count;
    total_already_correct := total_already_correct + page.already_correct_count;
    total_blocked := total_blocked + page.blocked_count;
    exit when page.scanned_count = 0 or not page.has_more;
    cursor_id := page.next_cursor;
  end loop;
  return query select
    total_scanned,
    total_corrected,
    total_already_correct,
    total_blocked,
    total_blocked = 0;
end;
$$;

-- Archived bridges (catalogue row purged) left on 'legacy:unmapped' whose
-- captured label names exactly one court. Bounded and resumable; a bridge
-- frozen by a downstream dependency is skipped, never forced.
create or replace function public.remap_archived_catalogue_courts_by_label_batch(
  p_after_id uuid default null,
  p_limit integer default 100
)
returns table (
  scanned_count bigint,
  remapped_count bigint,
  skipped_count bigint,
  next_cursor uuid,
  has_more boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  bridge_row public.auction_sale_outcome_bridges%rowtype;
  label_court_code text;
  target_court_id uuid;
  last_id uuid := p_after_id;
  total_scanned bigint := 0;
  total_remapped bigint := 0;
  total_skipped bigint := 0;
begin
  if p_limit is null or p_limit < 1 or p_limit > 500 then
    raise exception using errcode = '22023', message = 'Batch limit must be between 1 and 500.';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('immojudis:competent-court-reconciliation:v1', 0)
  );

  insert into public.outcome_courts(code, name, court_type, active)
  select tribunal_row.code, tribunal_row.canonical_name, 'tribunal_judiciaire', true
  from public.tribunals tribunal_row
  on conflict (code) do nothing;

  for bridge_row in
    select bridge.*
    from public.auction_sale_outcome_bridges bridge
    where bridge.auction_sale_id is null
      and (p_after_id is null or bridge.id > p_after_id)
    order by bridge.id
    limit p_limit
  loop
    last_id := bridge_row.id;
    total_scanned := total_scanned + 1;

    label_court_code := app_private.catalogue_bridge_label_court_code(bridge_row.id);
    target_court_id := null;
    select court_row.id into target_court_id
    from public.outcome_courts court_row
    where court_row.code = label_court_code
      and court_row.court_type = 'tribunal_judiciaire';

    if target_court_id is null
      or bridge_row.court_mapping_method <> 'unmapped'
      or not exists (
        select 1
        from public.auction_rounds round_row
        join public.outcome_courts court_row on court_row.id = round_row.court_id
        where round_row.id = bridge_row.round_id
          and court_row.code = 'legacy:unmapped'
      )
      or not app_private.apply_catalogue_bridge_court(bridge_row.id, target_court_id) then
      total_skipped := total_skipped + 1;
      continue;
    end if;
    total_remapped := total_remapped + 1;
  end loop;

  return query select
    total_scanned,
    total_remapped,
    total_skipped,
    last_id,
    exists (
      select 1 from public.auction_sale_outcome_bridges bridge
      where bridge.auction_sale_id is null
        and (last_id is null or bridge.id > last_id)
    );
end;
$$;

revoke all on function app_private.catalogue_bridge_tribunal_label(uuid) from public, anon, authenticated;
revoke all on function app_private.catalogue_bridge_label_court_code(uuid) from public, anon, authenticated;
revoke all on function app_private.catalogue_bridge_court_mapping_input(uuid, uuid) from public, anon, authenticated;
revoke all on function app_private.catalogue_bridge_court_is_reconcilable(uuid, uuid) from public, anon, authenticated;
revoke all on function app_private.apply_catalogue_bridge_court(uuid, uuid) from public, anon, authenticated;
revoke all on function app_private.guard_auction_sale_outcome_bridge_mutation() from public, anon, authenticated;
revoke all on function public.reconcile_catalogue_competent_courts_batch(uuid, integer) from public, anon, authenticated;
revoke all on function public.reconcile_catalogue_competent_courts() from public, anon, authenticated;
revoke all on function public.remap_archived_catalogue_courts_by_label_batch(uuid, integer) from public, anon, authenticated;
grant execute on function app_private.catalogue_bridge_tribunal_label(uuid) to service_role;
grant execute on function app_private.catalogue_bridge_label_court_code(uuid) to service_role;
grant execute on function app_private.catalogue_bridge_court_mapping_input(uuid, uuid) to service_role;
grant execute on function app_private.catalogue_bridge_court_is_reconcilable(uuid, uuid) to service_role;
grant execute on function app_private.apply_catalogue_bridge_court(uuid, uuid) to service_role;
grant execute on function public.reconcile_catalogue_competent_courts_batch(uuid, integer) to service_role;
grant execute on function public.reconcile_catalogue_competent_courts() to service_role;
grant execute on function public.remap_archived_catalogue_courts_by_label_batch(uuid, integer) to service_role;

-- Apply once: live bridges first (same RPC as the pipeline), then archives.
do $$
declare
  cursor_id uuid;
  page record;
  iteration integer := 0;
begin
  loop
    iteration := iteration + 1;
    if iteration > 1000 then
      raise exception 'Court reconciliation did not converge.';
    end if;
    select * into page from public.reconcile_catalogue_competent_courts_batch(cursor_id, 100);
    exit when page.scanned_count = 0 or not page.has_more;
    cursor_id := page.next_cursor;
  end loop;

  cursor_id := null;
  iteration := 0;
  loop
    iteration := iteration + 1;
    if iteration > 1000 then
      raise exception 'Archived court remapping did not converge.';
    end if;
    select * into page from public.remap_archived_catalogue_courts_by_label_batch(cursor_id, 500);
    exit when page.scanned_count = 0 or not page.has_more;
    cursor_id := page.next_cursor;
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Read-only history RPC
-- ---------------------------------------------------------------------------

-- Past hearings preserved in the Outcome Graph, attached to an active
-- tribunal judiciaire. Exclusions:
--   * 'legacy:unmapped' and any non tribunal_judiciaire court;
--   * catalogue status other than upcoming/past/adjudicated at bridge time
--     (quarantined, cancelled, withdrawn, postponed, unknown);
--   * cancelled/draft/not_requested rounds;
--   * non-judicial sources (see is_non_judicial_catalogue_source).
-- auction_sale_id is set while the sale is still in the catalogue: callers
-- must then use the catalogue row (verification and quarantine filters) and
-- ignore this archive row.
create or replace function public.tribunal_outcome_graph_past_hearings(
  p_history_start timestamptz,
  p_as_of timestamptz,
  p_court_code text default null
)
returns table (
  round_id uuid,
  court_code text,
  scheduled_at timestamptz,
  initial_starting_price_eur numeric,
  property_type text,
  city text,
  publication_first_seen_at timestamptz,
  occupation_status text,
  source_name text,
  auction_sale_id uuid,
  external_id text,
  source_url text,
  lot_label text,
  lawyer_label text,
  legacy_status text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_history_start is null or p_as_of is null or p_as_of <= p_history_start then
    raise exception using errcode = '22023', message = 'A valid history window is required.';
  end if;
  if p_as_of - p_history_start > interval '38 months' then
    raise exception using errcode = '22023', message = 'The history window cannot exceed 38 months.';
  end if;

  return query
  select
    round_row.id,
    court_row.code,
    round_row.scheduled_at,
    coalesce(lot_row.initial_starting_price_eur, round_row.initial_starting_price_eur),
    nullif(nullif(pg_catalog.btrim(lot_row.property_type), ''), 'unknown'),
    nullif(pg_catalog.btrim(address_row.city), ''),
    round_row.publication_first_seen_at,
    lot_row.occupation_status,
    bridge.source_name_snapshot,
    bridge.auction_sale_id,
    bridge.external_id_snapshot,
    bridge.source_url_snapshot,
    lot_row.lot_label,
    case_row.pursuing_law_firm_label,
    bridge.source_snapshot->>'legacy_status'
  from public.auction_sale_outcome_bridges bridge
  join public.auction_rounds round_row on round_row.id = bridge.round_id
  join public.auction_cases case_row
    on case_row.id = bridge.case_id
    and case_row.court_id = round_row.court_id
  join public.auction_lots lot_row
    on lot_row.id = bridge.lot_id
    and lot_row.auction_case_id = bridge.case_id
  join public.outcome_courts court_row on court_row.id = round_row.court_id
  left join public.outcome_addresses address_row on address_row.id = lot_row.address_id
  where court_row.court_type = 'tribunal_judiciaire'
    and court_row.active
    and court_row.code <> 'legacy:unmapped'
    and lot_row.active
    and round_row.scheduled_at >= p_history_start
    and round_row.scheduled_at < least(p_as_of, statement_timestamp())
    and round_row.current_status not in ('cancelled', 'draft', 'not_requested')
    and bridge.source_snapshot->>'legacy_status' in ('upcoming', 'past', 'adjudicated')
    and not app_private.is_non_judicial_catalogue_source(bridge.source_name_snapshot)
    and (
      p_court_code is null
      or court_row.code = pg_catalog.lower(pg_catalog.btrim(p_court_code))
    )
  order by round_row.scheduled_at, round_row.id;
end;
$$;

revoke all on function public.tribunal_outcome_graph_past_hearings(timestamptz, timestamptz, text)
  from public, anon, authenticated;
grant execute on function public.tribunal_outcome_graph_past_hearings(timestamptz, timestamptz, text)
  to service_role;

comment on function public.tribunal_outcome_graph_past_hearings(timestamptz, timestamptz, text) is
  'Past hearings archived in the Outcome Graph and attached to a tribunal judiciaire (service_role only). Rows with auction_sale_id are still in the catalogue and must be read from auction_sales instead.';

notify pgrst, 'reload schema';

commit;
