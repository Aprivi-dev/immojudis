-- Judilibre decisions are grade-C review candidates. They may never cross the
-- generic auto-match path, and every terminal review decision must be
-- attributable to a reviewer. Keep the rule source-scoped so DVF and other
-- connectors retain their existing reviewed matching contracts.

begin;

-- Close the audit-to-trigger race while preserving concurrent reads. The
-- order is fixed from reviewer registry to source identity, source history,
-- and finally match history.
lock table public.user_profiles in share mode;
lock table public.data_sources in share mode;
lock table public.judicial_source_records in share mode;
lock table public.source_record_matches in share row exclusive mode;

create or replace function app_private.judilibre_match_signals_are_safe(
  p_signals jsonb,
  p_expected_source_content_hash text
)
returns boolean
language sql
immutable
security invoker
set search_path = ''
as $$
  select pg_catalog.jsonb_typeof(p_signals) = 'object'
    and p_signals ?& array[
      'schema_version', 'match_rule_version', 'court',
      'court_resolution_method', 'court_resolution_reference_sha256',
      'hearing_date', 'hearing_date_exact', 'hearing_date_delta_days',
      'case_number', 'portalis_number', 'claim_types',
      'claims_manifest_sha256', 'case_reference_manifest_sha256',
      'source_projection_sha256', 'target_context_sha256',
      'source_record_version_current_at_scan', 'source_training_eligible',
      'selection_requires_human_review', 'automatic_link_allowed',
      'outcome_creation_allowed', 'training_eligible',
      'claim_value_used_for_matching', 'price_used_for_matching',
      'text_used_for_matching', 'address_used_for_matching',
      'personal_identity_used_for_matching', 'source_record_sha256'
    ]::text[]
    and p_signals - array[
      'schema_version', 'match_rule_version', 'court',
      'court_resolution_method', 'court_resolution_reference_sha256',
      'hearing_date', 'hearing_date_exact', 'hearing_date_delta_days',
      'case_number', 'portalis_number', 'claim_types',
      'claims_manifest_sha256', 'case_reference_manifest_sha256',
      'source_projection_sha256', 'target_context_sha256',
      'source_record_version_current_at_scan', 'source_training_eligible',
      'selection_requires_human_review', 'automatic_link_allowed',
      'outcome_creation_allowed', 'training_eligible',
      'claim_value_used_for_matching', 'price_used_for_matching',
      'text_used_for_matching', 'address_used_for_matching',
      'personal_identity_used_for_matching', 'source_record_sha256'
    ]::text[] = '{}'::jsonb
    and p_signals ->> 'schema_version' = 'judilibre_match_signals_v1'
    and p_signals ->> 'match_rule_version' = 'judilibre-review-match-v1'
    and p_signals ->> 'court_resolution_method' in (
      'outcome_court_code_exact',
      'justice_structure_insee_exact_name'
    )
    and pg_catalog.jsonb_typeof(p_signals -> 'claim_types') = 'array'
    and pg_catalog.jsonb_array_length(p_signals -> 'claim_types') between 1 and 3
    and not exists (
      select 1
      from pg_catalog.jsonb_array_elements(p_signals -> 'claim_types') claim(value)
      where pg_catalog.jsonb_typeof(claim.value) <> 'string'
        or claim.value #>> '{}' not in (
          'starting_price_eur', 'hammer_price_eur', 'procedural_event'
        )
    )
    and pg_catalog.jsonb_array_length(p_signals -> 'claim_types') = (
      select count(distinct claim.value #>> '{}')
      from pg_catalog.jsonb_array_elements(p_signals -> 'claim_types') claim(value)
    )
    and pg_catalog.jsonb_typeof(p_signals -> 'hearing_date_exact') = 'boolean'
    and pg_catalog.jsonb_typeof(p_signals -> 'case_number') = 'boolean'
    and pg_catalog.jsonb_typeof(p_signals -> 'portalis_number') = 'boolean'
    and pg_catalog.jsonb_typeof(p_signals -> 'hearing_date_delta_days') = 'number'
    and coalesce(p_signals ->> 'hearing_date_delta_days', '') ~ '^[0-9]+$'
    and (p_signals ->> 'hearing_date_delta_days')::integer between 0 and 30
    and p_signals @> '{
      "court": true,
      "hearing_date": true,
      "source_record_version_current_at_scan": true,
      "source_training_eligible": false,
      "selection_requires_human_review": true,
      "automatic_link_allowed": false,
      "outcome_creation_allowed": false,
      "training_eligible": false,
      "claim_value_used_for_matching": false,
      "price_used_for_matching": false,
      "text_used_for_matching": false,
      "address_used_for_matching": false,
      "personal_identity_used_for_matching": false
    }'::jsonb
    and coalesce(p_signals ->> 'court_resolution_reference_sha256', '') ~ '^[0-9a-f]{64}$'
    and coalesce(p_signals ->> 'claims_manifest_sha256', '') ~ '^[0-9a-f]{64}$'
    and coalesce(p_signals ->> 'case_reference_manifest_sha256', '') ~ '^[0-9a-f]{64}$'
    and coalesce(p_signals ->> 'source_projection_sha256', '') ~ '^[0-9a-f]{64}$'
    and coalesce(p_expected_source_content_hash, '') ~ '^[0-9a-f]{64}$'
    and p_signals ->> 'source_projection_sha256' = p_expected_source_content_hash
    and coalesce(p_signals ->> 'target_context_sha256', '') ~ '^[0-9a-f]{64}$'
    and coalesce(p_signals ->> 'source_record_sha256', '') ~ '^[0-9a-f]{64}$';
$$;

do $$
begin
  if exists (
    select 1
    from public.source_record_matches match_row
    join public.judicial_source_records record
      on record.id = match_row.source_record_id
    join public.data_sources source on source.id = record.source_id
    where source.name = 'judilibre'
      and case
        when match_row.status = 'candidate' then
          match_row.reviewer_user_id is not null
          or match_row.decided_at is not null
          or match_row.supersedes_match_id is not null
          or not app_private.judilibre_match_signals_are_safe(
            match_row.match_signals,
            record.content_hash
          )
          or match_row.match_method not in (
            'exact_case_number', 'exact_portalis_number', 'composite'
          )
          or match_row.match_score is distinct from (case match_row.match_method
            when 'exact_portalis_number' then case
              when (match_row.match_signals ->> 'hearing_date_exact')::boolean
                then 0.9800 else 0.9400 end
            when 'exact_case_number' then case
              when (match_row.match_signals ->> 'hearing_date_exact')::boolean
                then 0.9500 else 0.9000 end
            else 0.7500
          end)
          or (
            match_row.match_method = 'exact_case_number'
            and (
              not (match_row.match_signals ->> 'case_number')::boolean
              or (match_row.match_signals ->> 'portalis_number')::boolean
            )
          )
          or (
            match_row.match_method = 'exact_portalis_number'
            and not (match_row.match_signals ->> 'portalis_number')::boolean
          )
          or (
            match_row.match_method = 'composite'
            and not (
              (match_row.match_signals ->> 'hearing_date_exact')::boolean
              and not (match_row.match_signals ->> 'case_number')::boolean
              and not (match_row.match_signals ->> 'portalis_number')::boolean
            )
          )
        when match_row.status in ('confirmed', 'rejected', 'superseded') then
          match_row.reviewer_user_id is null
          or match_row.decided_at is distinct from match_row.created_at
          or nullif(pg_catalog.btrim(match_row.decision_notes), '') is null
          or not exists (
            select 1
            from public.user_profiles profile
            where profile.user_id = match_row.reviewer_user_id
              and profile.user_role = 'admin'
          )
          or not exists (
            select 1
            from public.source_record_matches prior_match
            where prior_match.id = match_row.supersedes_match_id
              and prior_match.status = 'candidate'
              and prior_match.decided_at is null
              and prior_match.supersedes_match_id is null
              and prior_match.created_at <= match_row.created_at
              and prior_match.source_record_id = match_row.source_record_id
              and prior_match.case_id is not distinct from match_row.case_id
              and prior_match.lot_id is not distinct from match_row.lot_id
              and prior_match.round_id is not distinct from match_row.round_id
              and prior_match.outcome_id is not distinct from match_row.outcome_id
              and prior_match.match_score is not distinct from match_row.match_score
              and prior_match.match_method is not distinct from match_row.match_method
              and prior_match.match_signals is not distinct from match_row.match_signals
          )
        else true
      end
  ) or exists (
    select 1
    from public.source_record_matches match_row
    join public.judicial_source_records record
      on record.id = match_row.source_record_id
    join public.data_sources source on source.id = record.source_id
    where source.name = 'judilibre'
      and match_row.status = 'confirmed'
    group by match_row.source_record_id
    having count(*) > 1
  ) or exists (
    select 1
    from public.source_record_matches match_row
    join public.judicial_source_records record
      on record.id = match_row.source_record_id
    join public.data_sources source on source.id = record.source_id
    where source.name = 'judilibre'
      and match_row.status in ('confirmed', 'rejected', 'superseded')
    group by
      match_row.source_record_id,
      match_row.case_id,
      match_row.lot_id,
      match_row.round_id,
      match_row.outcome_id
    having count(*) > 1
  ) then
    raise exception using
      errcode = '23514',
      message = 'Existing Judilibre match history violates the closed v1 review workflow.';
  end if;
end;
$$;

create or replace function app_private.guard_judilibre_source_record_match_insert()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  source_name text;
  source_content_hash text;
  prior_match public.source_record_matches%rowtype;
  rpc_owner name;
begin
  select source.name, record.content_hash
  into source_name, source_content_hash
  from public.judicial_source_records record
  join public.data_sources source on source.id = record.source_id
  where record.id = new.source_record_id;

  if source_name is distinct from 'judilibre' then
    return new;
  end if;

  new.created_at := clock_timestamp();

  if new.status in (
    'candidate', 'weak_candidate', 'review_required', 'strong_candidate'
  ) then
    if new.status <> 'candidate'
      or new.reviewer_user_id is not null
      or new.decided_at is not null
      or new.supersedes_match_id is not null then
      raise exception using
        errcode = '23514',
        message = 'Judilibre ingestion may append only a root candidate without reviewer attribution.';
    end if;
    if new.match_method not in ('exact_case_number', 'exact_portalis_number', 'composite')
      or not app_private.judilibre_match_signals_are_safe(
        new.match_signals,
        source_content_hash
      )
      or (
        new.match_method = 'exact_case_number'
        and (
          not coalesce((new.match_signals ->> 'case_number')::boolean, false)
          or coalesce((new.match_signals ->> 'portalis_number')::boolean, false)
        )
      )
      or (
        new.match_method = 'exact_portalis_number'
        and not coalesce((new.match_signals ->> 'portalis_number')::boolean, false)
      )
      or (
        new.match_method = 'composite'
        and not (
          coalesce((new.match_signals ->> 'hearing_date_exact')::boolean, false)
          and not coalesce((new.match_signals ->> 'case_number')::boolean, false)
          and not coalesce((new.match_signals ->> 'portalis_number')::boolean, false)
        )
      )
      or new.match_score is distinct from (case new.match_method
        when 'exact_portalis_number' then case
          when (new.match_signals ->> 'hearing_date_exact')::boolean then 0.9800
          else 0.9400
        end
        when 'exact_case_number' then case
          when (new.match_signals ->> 'hearing_date_exact')::boolean then 0.9500
          else 0.9000
        end
        else 0.7500
      end) then
      raise exception using
        errcode = '23514',
        message = 'Judilibre candidates require the closed metadata-only v1 match contract.';
    end if;
    return new;
  end if;

  if new.status = 'auto_matched' then
    raise exception using
      errcode = '23514',
      message = 'Judilibre source-record matches may not be auto-matched.';
  end if;
  if new.status not in ('confirmed', 'rejected', 'superseded') then
    raise exception using
      errcode = '23514',
      message = 'Judilibre match status is outside the closed review workflow.';
  end if;

  select pg_catalog.pg_get_userbyid(procedure_row.proowner) into rpc_owner
  from pg_catalog.pg_proc procedure_row
  where procedure_row.oid =
    'public.review_judilibre_match_candidate(uuid,text,text)'::pg_catalog.regprocedure;
  if current_user is distinct from rpc_owner
    or auth.uid() is null
    or new.reviewer_user_id is distinct from auth.uid() then
    raise exception using
      errcode = '42501',
      message = 'Terminal Judilibre match decisions must use the authenticated review RPC.';
  end if;

  new.decided_at := new.created_at;
  if nullif(pg_catalog.btrim(new.decision_notes), '') is null then
    raise exception using
      errcode = '23514',
      message = 'Terminal Judilibre match decisions require an audit note.';
  end if;

  perform 1
  from public.user_profiles profile
  where profile.user_id = new.reviewer_user_id
    and profile.user_role = 'admin'
  for share;
  if not found then
    raise exception using
      errcode = '42501',
      message = 'Only an administrator may decide a Judilibre match.';
  end if;

  if new.supersedes_match_id is null then
    raise exception using
      errcode = '23514',
      message = 'A terminal Judilibre match must supersede an undecided candidate.';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'immojudis:judilibre-source-decision:' || new.source_record_id::text,
      0
    )
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'immojudis:judilibre-match-successor:' || new.supersedes_match_id::text,
      0
    )
  );
  select prior.* into prior_match
  from public.source_record_matches prior
  where prior.id = new.supersedes_match_id;

  if not found
    or prior_match.status <> 'candidate'
    or prior_match.decided_at is not null
    or prior_match.supersedes_match_id is not null
    or prior_match.created_at > new.created_at then
    raise exception using
      errcode = '23514',
      message = 'A terminal Judilibre match must supersede an earlier undecided root candidate.';
  end if;

  if prior_match.source_record_id is distinct from new.source_record_id
    or prior_match.case_id is distinct from new.case_id
    or prior_match.lot_id is distinct from new.lot_id
    or prior_match.round_id is distinct from new.round_id
    or prior_match.outcome_id is distinct from new.outcome_id
    or prior_match.match_score is distinct from new.match_score
    or prior_match.match_method is distinct from new.match_method
    or prior_match.match_signals is distinct from new.match_signals then
    raise exception using
      errcode = '23514',
      message = 'A Judilibre review decision must preserve the complete candidate evidence.';
  end if;

  if exists (
    select 1
    from public.source_record_matches successor
    where successor.supersedes_match_id = new.supersedes_match_id
  ) then
    raise exception using
      errcode = '23505',
      message = 'The Judilibre candidate already has a terminal successor.';
  end if;
  if exists (
    select 1
    from public.source_record_matches terminal_match
    where terminal_match.source_record_id = new.source_record_id
      and terminal_match.case_id is not distinct from new.case_id
      and terminal_match.lot_id is not distinct from new.lot_id
      and terminal_match.round_id is not distinct from new.round_id
      and terminal_match.outcome_id is not distinct from new.outcome_id
      and terminal_match.status in ('confirmed', 'rejected', 'superseded')
  ) then
    raise exception using
      errcode = '23505',
      message = 'The Judilibre source target already has a terminal decision.';
  end if;
  if new.status = 'confirmed' and exists (
    select 1
    from public.source_record_matches confirmed_match
    where confirmed_match.source_record_id = new.source_record_id
      and confirmed_match.status = 'confirmed'
  ) then
    raise exception using
      errcode = '23505',
      message = 'The Judilibre source record already has a confirmed target.';
  end if;

  return new;
end;
$$;

drop trigger if exists source_record_matches_judilibre_review_guard
on public.source_record_matches;

create trigger source_record_matches_judilibre_review_guard
before insert on public.source_record_matches
for each row execute function app_private.guard_judilibre_source_record_match_insert();

create or replace function public.review_judilibre_match_candidate(
  p_candidate_id uuid,
  p_status text,
  p_decision_notes text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id uuid := auth.uid();
  candidate public.source_record_matches%rowtype;
  inserted_id uuid;
begin
  if caller_id is null then
    raise exception using
      errcode = '28000',
      message = 'An authenticated administrator is required.';
  end if;
  perform 1
  from public.user_profiles profile
  where profile.user_id = caller_id
    and profile.user_role = 'admin'
  for share;
  if not found then
    raise exception using
      errcode = '42501',
      message = 'Only an administrator may decide a Judilibre match.';
  end if;
  if p_status not in ('confirmed', 'rejected', 'superseded') then
    raise exception using
      errcode = '23514',
      message = 'Judilibre review status must be terminal.';
  end if;
  if nullif(pg_catalog.btrim(p_decision_notes), '') is null then
    raise exception using
      errcode = '23514',
      message = 'Terminal Judilibre match decisions require an audit note.';
  end if;

  select candidate_row.* into candidate
  from public.source_record_matches candidate_row
  join public.judicial_source_records record
    on record.id = candidate_row.source_record_id
  join public.data_sources source on source.id = record.source_id
  where candidate_row.id = p_candidate_id
    and source.name = 'judilibre'
  for update of candidate_row;
  if not found
    or candidate.status <> 'candidate'
    or candidate.decided_at is not null
    or candidate.supersedes_match_id is not null then
    raise exception using
      errcode = '23514',
      message = 'Judilibre review requires an undecided root candidate.';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'immojudis:judilibre-source-decision:' || candidate.source_record_id::text,
      0
    )
  );
  if exists (
    select 1
    from public.source_record_matches terminal_match
    where terminal_match.source_record_id = candidate.source_record_id
      and terminal_match.status = 'confirmed'
  ) and p_status = 'confirmed' then
    raise exception using
      errcode = '23505',
      message = 'The Judilibre source record already has a confirmed target.';
  end if;

  insert into public.source_record_matches (
    source_record_id,
    case_id,
    lot_id,
    round_id,
    outcome_id,
    match_score,
    match_method,
    match_signals,
    status,
    reviewer_user_id,
    decision_notes,
    decided_at,
    supersedes_match_id
  ) values (
    candidate.source_record_id,
    candidate.case_id,
    candidate.lot_id,
    candidate.round_id,
    candidate.outcome_id,
    candidate.match_score,
    candidate.match_method,
    candidate.match_signals,
    p_status,
    caller_id,
    pg_catalog.btrim(p_decision_notes),
    clock_timestamp(),
    candidate.id
  )
  returning id into inserted_id;

  return inserted_id;
end;
$$;

create or replace function app_private.guard_judilibre_admin_review_history()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if exists (
    select 1
    from public.source_record_matches match_row
    join public.judicial_source_records record
      on record.id = match_row.source_record_id
    join public.data_sources source on source.id = record.source_id
    where source.name = 'judilibre'
      and match_row.reviewer_user_id = old.user_id
      and match_row.status in ('confirmed', 'rejected', 'superseded')
  ) and (
    tg_op = 'DELETE'
    or new.user_role is distinct from 'admin'
  ) then
    raise exception using
      errcode = '55000',
      message = 'A Judilibre reviewer identity and administrator role are immutable after decision.';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

create trigger user_profiles_judilibre_reviewer_update_guard
before update of user_role on public.user_profiles
for each row execute function app_private.guard_judilibre_admin_review_history();

create trigger user_profiles_judilibre_reviewer_delete_guard
before delete on public.user_profiles
for each row execute function app_private.guard_judilibre_admin_review_history();

create or replace function app_private.guard_judilibre_source_name_update()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.name is distinct from old.name
    and (old.name = 'judilibre' or new.name = 'judilibre') then
    raise exception using
      errcode = '23514',
      message = 'The canonical Judilibre source name is immutable.';
  end if;

  return new;
end;
$$;

drop trigger if exists data_sources_judilibre_name_guard
on public.data_sources;

create trigger data_sources_judilibre_name_guard
before update of name on public.data_sources
for each row execute function app_private.guard_judilibre_source_name_update();

revoke all on function app_private.guard_judilibre_source_record_match_insert()
from public, anon, authenticated, service_role;
revoke all on function app_private.judilibre_match_signals_are_safe(jsonb, text)
from public, anon, authenticated, service_role;
revoke all on function app_private.guard_judilibre_admin_review_history()
from public, anon, authenticated, service_role;
revoke all on function app_private.guard_judilibre_source_name_update()
from public, anon, authenticated, service_role;
revoke all on function public.review_judilibre_match_candidate(uuid, text, text)
from public, anon, service_role;
grant execute on function app_private.judilibre_match_signals_are_safe(jsonb, text)
to service_role;
grant execute on function public.review_judilibre_match_candidate(uuid, text, text)
to authenticated;

comment on function app_private.guard_judilibre_source_record_match_insert() is
  'Fail-closed append guard: Judilibre ingestion may create only closed-contract root candidates; terminal decisions must be copied by the authenticated admin RPC.';

comment on function app_private.judilibre_match_signals_are_safe(jsonb, text) is
  'Validates the exact metadata-only Judilibre candidate signal schema and binds source provenance to judicial_source_records.content_hash; PII, price, address, free text, automatic links and training use are forbidden.';

comment on function public.review_judilibre_match_candidate(uuid, text, text) is
  'Appends an immutable terminal decision for one Judilibre candidate using auth.uid() and a current administrator profile.';

comment on function app_private.guard_judilibre_admin_review_history() is
  'Preserves the administrator status and reviewer identity required to audit historical Judilibre terminal decisions.';

comment on function app_private.guard_judilibre_source_name_update() is
  'Keeps the canonical Judilibre source identity stable for source-scoped review rules.';

commit;
