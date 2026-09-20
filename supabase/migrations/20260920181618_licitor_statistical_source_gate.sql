begin;

-- Licitor collector rows remain immutable acquisition candidates. A separate,
-- private decision table is the only way to authorize one current capture and
-- version for a statistical build; the collector payload is never rewritten.
create table licitor_ingestion.statistical_candidate_reviews (
  candidate_external_id text not null
    references licitor_ingestion.candidates(external_id) on delete restrict,
  candidate_capture_sha256 text not null
    check (candidate_capture_sha256 ~ '^[a-f0-9]{64}$'),
  candidate_version_hash text not null
    check (candidate_version_hash ~ '^[a-f0-9]{64}$'),
  decision text not null check (decision = 'approved'),
  candidate_grade text not null check (candidate_grade in ('A', 'B')),
  evidence_grade text not null check (evidence_grade in ('A', 'B')),
  finality_status text not null check (finality_status = 'procedurally_definitive'),
  publication_eligible boolean not null check (publication_eligible),
  reviewer_id uuid not null references auth.users(id) on delete restrict,
  evidence jsonb not null check (
    jsonb_typeof(evidence) = 'object' and evidence <> '{}'::jsonb
  ),
  reviewed_at timestamptz not null default now(),
  primary key (candidate_external_id, candidate_capture_sha256, candidate_version_hash),
  foreign key (candidate_external_id, candidate_version_hash)
    references licitor_ingestion.candidate_versions(external_id, version_hash)
    on delete restrict
);

create index statistical_candidate_reviews_candidate_idx
  on licitor_ingestion.statistical_candidate_reviews(candidate_external_id, reviewed_at desc);

revoke all on licitor_ingestion.statistical_candidate_reviews
  from public, anon, authenticated, licitor_collector;
grant select, insert on licitor_ingestion.statistical_candidate_reviews
  to service_role;
alter table licitor_ingestion.statistical_candidate_reviews enable row level security;

create or replace function app_private.reject_licitor_statistical_candidate_review_mutation()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  raise exception 'Licitor statistical candidate reviews are append-only';
end;
$function$;

revoke all on function app_private.reject_licitor_statistical_candidate_review_mutation()
  from public, anon, authenticated, service_role, licitor_collector;

create trigger statistical_candidate_reviews_append_only
before update or delete on licitor_ingestion.statistical_candidate_reviews
for each row execute function app_private.reject_licitor_statistical_candidate_review_mutation();

comment on table licitor_ingestion.statistical_candidate_reviews is
  'Private append-only approval for one Licitor candidate capture/version. It never mutates the collector candidate payload.';

-- The current candidate is eligible only when its current payload and current
-- candidate-version hash match an explicit reviewed decision. A changed
-- capture or reparse therefore disappears until it is reviewed again.
create view licitor_ingestion.statistics_eligible_candidates
with (security_invoker = true) as
select
  candidate.*,
  reviewed.version_hash as candidate_version_hash,
  reviewed.candidate_capture_sha256 as reviewed_capture_sha256,
  reviewed.reviewer_id as statistical_reviewer_id,
  reviewed.reviewed_at as statistical_reviewed_at
from licitor_ingestion.statistics_candidates candidate
join lateral (
  select
    version.version_hash,
    review.candidate_capture_sha256,
    review.reviewer_id,
    review.reviewed_at
  from licitor_ingestion.candidate_versions version
  join licitor_ingestion.statistical_candidate_reviews review
    on review.candidate_external_id = version.external_id
   and review.candidate_version_hash = version.version_hash
   and review.candidate_capture_sha256 = candidate.payload->>'source_content_hash'
  where version.external_id = candidate.external_id
    and version.payload = candidate.payload
    and review.decision = 'approved'
    and review.candidate_grade in ('A', 'B')
    and review.evidence_grade in ('A', 'B')
    and review.finality_status = 'procedurally_definitive'
    and review.publication_eligible
  order by review.reviewed_at desc, version.version_hash desc
  limit 1
) reviewed on true;

revoke all on licitor_ingestion.statistics_eligible_candidates
  from public, anon, authenticated, licitor_collector;
grant select on licitor_ingestion.statistics_eligible_candidates to service_role;
grant select on licitor_ingestion.candidate_versions to service_role;

comment on view licitor_ingestion.statistics_eligible_candidates is
  'Private reviewed Licitor source. The current candidate payload, capture hash, and candidate-version hash must all match an immutable A/B definitive approval.';

-- Keep the collector-facing diagnostic unchanged. A separate private reviewed
-- projection is derived from its definition so acquisition users retain raw
-- diagnostics while staging consumers see only reviewed candidates.
do $migration$
declare
  definition text;
  updated_definition text;
begin
  select pg_catalog.pg_get_viewdef(
    'licitor_ingestion.diagnostic_price_statistics'::regclass,
    true
  ) into definition;
  if definition is null
     or position('licitor_ingestion.statistics_candidates' in definition) = 0 then
    raise exception 'Unexpected raw Licitor diagnostic source view';
  end if;
  updated_definition := pg_catalog.replace(
    definition,
    'licitor_ingestion.statistics_candidates',
    'licitor_ingestion.statistics_eligible_candidates'
  );
  execute pg_catalog.format(
    'create view licitor_ingestion.reviewed_diagnostic_price_statistics with (security_invoker=true) as %s',
    updated_definition
  );
end;
$migration$;

revoke all on licitor_ingestion.reviewed_diagnostic_price_statistics
  from public, anon, authenticated, licitor_collector;
grant select on licitor_ingestion.reviewed_diagnostic_price_statistics
  to service_role;

-- Court mappings use reviewed raw diagnostics. Canonical and enrichment
-- aggregates already carry their own candidate parsing and switch directly to
-- the eligible projection; the raw diagnostic remains collector-readable.
do $migration$
declare
  definition text;
  updated_definition text;
begin
  select pg_catalog.pg_get_viewdef(
    'licitor_ingestion.diagnostic_court_mappings'::regclass,
    true
  ) into definition;
  if definition is null
     or position('licitor_ingestion.diagnostic_price_statistics' in definition) = 0 then
    raise exception 'Unexpected Licitor court-mapping source view';
  end if;
  updated_definition := pg_catalog.replace(
    definition,
    'licitor_ingestion.diagnostic_price_statistics',
    'licitor_ingestion.reviewed_diagnostic_price_statistics'
  );
  execute pg_catalog.format(
    'create or replace view licitor_ingestion.diagnostic_court_mappings with (security_invoker=true) as %s',
    updated_definition
  );
end;
$migration$;

do $migration$
declare
  view_name text;
  definition text;
begin
  foreach view_name in array array[
    'diagnostic_canonical_price_statistics',
    'diagnostic_price_enrichments'
  ] loop
    select pg_catalog.pg_get_viewdef(
      pg_catalog.to_regclass('licitor_ingestion.' || view_name), true
    ) into definition;
    if definition is null
       or position('licitor_ingestion.statistics_candidates' in definition) = 0 then
      raise exception 'Unexpected Licitor reviewed aggregate source view: %', view_name;
    end if;
    execute pg_catalog.format(
      'create or replace view licitor_ingestion.%I with (security_invoker=true) as %s',
      view_name,
      pg_catalog.replace(
        definition,
        'licitor_ingestion.statistics_candidates',
        'licitor_ingestion.statistics_eligible_candidates'
      )
    );
  end loop;
end;
$migration$;

-- An attestation is separate from the immutable build/snapshot rows. Legacy
-- builds have no row and are quarantined by the published view; their
-- snapshots remain untouched and recoverable for audit.
create table public.adjudication_price_statistics_source_attestations (
  build_id uuid primary key
    references public.adjudication_price_statistics_builds(id) on delete restrict,
  source_gate_version text not null check (
    source_gate_version = 'licitor_reviewed_candidate_v1'
  ),
  eligible_candidate_count integer not null check (eligible_candidate_count > 0),
  eligible_candidate_manifest_hash text not null check (
    eligible_candidate_manifest_hash ~ '^[a-f0-9]{64}$'
  ),
  attested_at timestamptz not null default now()
);

alter table public.adjudication_price_statistics_source_attestations enable row level security;
revoke all on public.adjudication_price_statistics_source_attestations
  from public, anon, authenticated, service_role, licitor_collector;
grant select on public.adjudication_price_statistics_source_attestations to service_role;

create trigger adjudication_price_statistics_source_attestations_append_only
before update or delete on public.adjudication_price_statistics_source_attestations
for each row execute function app_private.reject_adjudication_price_statistics_mutation();

comment on table public.adjudication_price_statistics_source_attestations is
  'Append-only source attestation for a new Licitor build. No attestation means the legacy build remains quarantined from publication.';

-- SECURITY DEFINER is used only to insert the attestation into its private
-- table. The supplied count and manifest are recomputed from the same
-- repeatable-read eligible projection used by staging.
create or replace function app_private.attest_licitor_statistics_build_source(
  p_build_id uuid,
  p_eligible_candidate_count integer,
  p_eligible_candidate_manifest_hash text
)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_actual_count integer;
  v_actual_manifest_hash text;
  v_expected_build_manifest_hash text;
  v_build_manifest_hash text;
  v_source_name text;
  v_existing public.adjudication_price_statistics_source_attestations%rowtype;
begin
  if p_eligible_candidate_count is null
     or p_eligible_candidate_count <= 0
     or p_eligible_candidate_manifest_hash is null
     or p_eligible_candidate_manifest_hash !~ '^[a-f0-9]{64}$' then
    raise exception 'Invalid Licitor source attestation payload';
  end if;

  select
    count(*)::integer,
    pg_catalog.encode(
      extensions.digest(
        coalesce(
          pg_catalog.string_agg(
            pg_catalog.jsonb_build_object(
              'external_id', candidate.external_id,
              'capture_sha256', candidate.reviewed_capture_sha256,
              'version_hash', candidate.candidate_version_hash
            )::text,
            E'\n' order by candidate.external_id, candidate.candidate_version_hash
          ),
          ''
        ),
        'sha256'
      ),
      'hex'
    )
  into v_actual_count, v_actual_manifest_hash
  from licitor_ingestion.statistics_eligible_candidates candidate;

  if p_eligible_candidate_count is distinct from v_actual_count
     or p_eligible_candidate_manifest_hash is distinct from v_actual_manifest_hash then
    raise exception 'Licitor source attestation does not match the reviewed candidate projection';
  end if;

  -- The candidate manifest is part of the build manifest itself. This prevents
  -- a manually inserted/replayed attestation from being attached to a build
  -- whose statistics were hashed from another source gate or candidate set.
  select
    pg_catalog.encode(
      extensions.digest(
        coalesce(
          pg_catalog.string_agg(
            pg_catalog.jsonb_build_object(
              'scope_type', stats.scope_type,
              'court_id', stats.court_id,
              'court_code', stats.court_code,
              'scope_label', stats.scope_label,
              'judicial_region', stats.judicial_region,
              'period_start', stats.period_start,
              'period_end', stats.period_end,
              'minimum_sample', stats.minimum_sample,
              'sample_size', stats.sample_size,
              'extra_statistics', stats.extra_statistics,
              'median_ratio', stats.median_hammer_to_starting_ratio,
              'above_starting_rate', stats.above_starting_rate,
              'at_least_double_rate', stats.at_least_double_rate,
              'median_hammer_price', stats.median_hammer_price_eur,
              'median_starting_price', stats.median_starting_price_eur,
              'diagnostic_status', stats.diagnostic_status,
              'methodology_version', stats.methodology_version,
              'source_gate_version', 'licitor_reviewed_candidate_v1',
              'eligible_candidate_count', p_eligible_candidate_count,
              'eligible_candidate_manifest_hash', p_eligible_candidate_manifest_hash
            )::text,
            E'\n' order by stats.scope_type, stats.court_code nulls first
          ),
          ''
        ),
        'sha256'
      ),
      'hex'
    )
  into v_expected_build_manifest_hash
  from licitor_ingestion.diagnostic_enriched_price_statistics stats;

  select build.source_name, build.source_manifest_hash
  into v_source_name, v_build_manifest_hash
  from public.adjudication_price_statistics_builds build
  where build.id = p_build_id;
  if not found or v_source_name <> 'licitor' then
    raise exception 'Licitor source attestation requires an existing Licitor build';
  end if;
  if v_build_manifest_hash is distinct from v_expected_build_manifest_hash then
    raise exception 'Licitor source attestation is not linked to the build source manifest';
  end if;

  select *
  into v_existing
  from public.adjudication_price_statistics_source_attestations attestation
  where attestation.build_id = p_build_id;
  if found then
    if v_existing.source_gate_version <> 'licitor_reviewed_candidate_v1'
       or v_existing.eligible_candidate_count <> p_eligible_candidate_count
       or v_existing.eligible_candidate_manifest_hash <> p_eligible_candidate_manifest_hash then
      raise exception 'Conflicting Licitor source attestation';
    end if;
    return;
  end if;

  insert into public.adjudication_price_statistics_source_attestations (
    build_id,
    source_gate_version,
    eligible_candidate_count,
    eligible_candidate_manifest_hash
  ) values (
    p_build_id,
    'licitor_reviewed_candidate_v1',
    p_eligible_candidate_count,
    p_eligible_candidate_manifest_hash
  );
end;
$function$;

revoke all on function app_private.attest_licitor_statistics_build_source(uuid, integer, text)
  from public, anon, authenticated, service_role, licitor_collector;

comment on function app_private.attest_licitor_statistics_build_source(uuid, integer, text) is
  'Private attestation called by the SECURITY DEFINER staging function. Count, candidate manifest, and build source manifest are recomputed before insertion.';

-- Reapply the current MVCC staging function instead of patching a historical
-- lock comment. The caller must already be in REPEATABLE READ/SERIALIZABLE;
-- all candidate and diagnostic reads, attestation, and snapshots share it.
create or replace function licitor_ingestion.stage_adjudication_price_statistics_build(
  p_source_run_ids text[]
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_build_id uuid;
  v_manifest_hash text;
  v_eligible_candidate_manifest_hash text;
  v_eligible_candidate_count integer;
  v_active_count integer;
  v_national_sample integer;
  v_mapped_sample integer;
  v_unmatched_sample integer;
  v_court_count integer;
  v_period_start date;
  v_period_end date;
begin
  if current_setting('transaction_isolation') not in ('repeatable read', 'serializable') then
    raise exception 'Stage statistics in a REPEATABLE READ transaction';
  end if;
  if p_source_run_ids is null or cardinality(p_source_run_ids) = 0 then
    raise exception 'At least one completed source run is required';
  end if;
  if exists (
    select 1
    from unnest(p_source_run_ids) requested(run_id)
    left join licitor_ingestion.runs source_run on source_run.id = requested.run_id
    where source_run.id is null
       or source_run.status not in ('completed', 'completed_with_errors')
  ) then
    raise exception 'Every source run must exist and be completed';
  end if;
  if exists (
    select 1 from licitor_ingestion.runs
    where status in ('ready', 'running')
  ) then
    raise exception 'Cannot freeze statistics while a collection run is active';
  end if;

  select
    count(*)::integer,
    pg_catalog.encode(
      extensions.digest(
        coalesce(
          pg_catalog.string_agg(
            pg_catalog.jsonb_build_object(
              'external_id', candidate.external_id,
              'capture_sha256', candidate.reviewed_capture_sha256,
              'version_hash', candidate.candidate_version_hash
            )::text,
            E'\n' order by candidate.external_id, candidate.candidate_version_hash
          ),
          ''
        ),
        'sha256'
      ),
      'hex'
    )
  into v_eligible_candidate_count, v_eligible_candidate_manifest_hash
  from licitor_ingestion.statistics_eligible_candidates candidate;

  if v_eligible_candidate_count is null or v_eligible_candidate_count = 0 then
    raise exception 'No reviewed Licitor candidate is eligible for a statistics build';
  end if;

  select
    pg_catalog.encode(
      extensions.digest(
        coalesce(
          pg_catalog.string_agg(
            pg_catalog.jsonb_build_object(
              'scope_type', stats.scope_type,
              'court_id', stats.court_id,
              'court_code', stats.court_code,
              'scope_label', stats.scope_label,
              'judicial_region', stats.judicial_region,
              'period_start', stats.period_start,
              'period_end', stats.period_end,
              'minimum_sample', stats.minimum_sample,
              'sample_size', stats.sample_size,
              'extra_statistics', stats.extra_statistics,
              'median_ratio', stats.median_hammer_to_starting_ratio,
              'above_starting_rate', stats.above_starting_rate,
              'at_least_double_rate', stats.at_least_double_rate,
              'median_hammer_price', stats.median_hammer_price_eur,
              'median_starting_price', stats.median_starting_price_eur,
              'diagnostic_status', stats.diagnostic_status,
              'methodology_version', stats.methodology_version,
              'source_gate_version', 'licitor_reviewed_candidate_v1',
              'eligible_candidate_count', v_eligible_candidate_count,
              'eligible_candidate_manifest_hash', v_eligible_candidate_manifest_hash
            )::text,
            E'\n' order by stats.scope_type, stats.court_code nulls first
          ),
          ''
        ),
        'sha256'
      ),
      'hex'
    ),
    min(stats.period_start),
    max(stats.period_end),
    max(stats.sample_size) filter (where stats.scope_type = 'national'),
    count(*) filter (where stats.scope_type = 'tribunal')
  into v_manifest_hash, v_period_start, v_period_end, v_national_sample, v_court_count
  from licitor_ingestion.diagnostic_enriched_price_statistics stats;

  if v_national_sample is null or v_period_start is null or v_period_end is null then
    raise exception 'The canonical diagnostic set is empty';
  end if;

  select count(*) into v_active_count from licitor_ingestion.active_candidates;
  select
    coalesce(sum(mapping.sample_size) filter (
      where mapping.mapping_status in (
        'unique_official_name_contained',
        'unique_verified_historical_alias'
      )
    ), 0),
    coalesce(sum(mapping.sample_size) filter (
      where mapping.mapping_status not in (
        'unique_official_name_contained',
        'unique_verified_historical_alias'
      )
    ), 0)
  into v_mapped_sample, v_unmatched_sample
  from licitor_ingestion.diagnostic_court_mappings mapping;

  select build.id into v_build_id
  from public.adjudication_price_statistics_builds build
  where build.source_manifest_hash = v_manifest_hash;
  if v_build_id is not null then
    if not exists (
      select 1
      from public.adjudication_price_statistics_source_attestations attestation
      where attestation.build_id = v_build_id
        and attestation.source_gate_version = 'licitor_reviewed_candidate_v1'
        and attestation.eligible_candidate_count = v_eligible_candidate_count
        and attestation.eligible_candidate_manifest_hash = v_eligible_candidate_manifest_hash
    ) then
      raise exception 'Existing Licitor build has no matching source attestation';
    end if;
    return v_build_id;
  end if;

  insert into public.adjudication_price_statistics_builds (
    source_name,
    source_run_ids,
    period_start,
    period_end,
    window_months,
    minimum_sample,
    active_candidate_lots,
    national_sample_size,
    mapped_sample_size,
    unmatched_sample_size,
    canonical_court_count,
    methodology_version,
    source_manifest_hash
  ) values (
    'licitor',
    p_source_run_ids,
    v_period_start,
    v_period_end,
    36,
    10,
    v_active_count,
    v_national_sample,
    v_mapped_sample,
    v_unmatched_sample,
    v_court_count,
    'licitor_canonical_price_statistics_v1',
    v_manifest_hash
  ) returning id into v_build_id;

  perform app_private.attest_licitor_statistics_build_source(
    v_build_id,
    v_eligible_candidate_count,
    v_eligible_candidate_manifest_hash
  );

  insert into public.adjudication_price_statistics_snapshots (
    build_id,
    scope_type,
    court_id,
    court_code,
    scope_label,
    judicial_region,
    period_start,
    period_end,
    minimum_sample,
    sample_size,
    median_hammer_to_starting_ratio,
    above_starting_rate,
    at_least_double_rate,
    median_hammer_price_eur,
    median_starting_price_eur,
    quality_status,
    methodology_version,
    statistics_hash,
    extra_statistics
  )
  select
    v_build_id,
    stats.scope_type,
    stats.court_id,
    stats.court_code,
    stats.scope_label,
    stats.judicial_region,
    stats.period_start,
    stats.period_end,
    stats.minimum_sample,
    stats.sample_size,
    stats.median_hammer_to_starting_ratio,
    stats.above_starting_rate,
    stats.at_least_double_rate,
    stats.median_hammer_price_eur,
    stats.median_starting_price_eur,
    stats.diagnostic_status,
    stats.methodology_version,
    pg_catalog.encode(
      extensions.digest(
        pg_catalog.jsonb_build_object(
          'build_id', v_build_id,
          'scope_type', stats.scope_type,
          'court_id', stats.court_id,
          'sample_size', stats.sample_size,
          'extra_statistics', stats.extra_statistics,
          'median_ratio', stats.median_hammer_to_starting_ratio,
          'above_starting_rate', stats.above_starting_rate,
          'at_least_double_rate', stats.at_least_double_rate,
          'median_hammer_price', stats.median_hammer_price_eur,
          'median_starting_price', stats.median_starting_price_eur
        )::text,
        'sha256'
      ),
      'hex'
    ),
    stats.extra_statistics
  from licitor_ingestion.diagnostic_enriched_price_statistics stats;

  return v_build_id;
end;
$function$;

revoke all on function licitor_ingestion.stage_adjudication_price_statistics_build(text[])
  from public, anon, authenticated, service_role, licitor_collector;
grant execute on function licitor_ingestion.stage_adjudication_price_statistics_build(text[])
  to service_role;

-- Staging now owns the only write path for immutable builds and snapshots.
-- Keeping direct INSERT here would let service_role append cells that were
-- never covered by the reviewed-source manifest and its attestation.
revoke insert on table
  public.adjudication_price_statistics_builds,
  public.adjudication_price_statistics_snapshots
from service_role;

create or replace view public.published_adjudication_price_statistics
with (security_invoker = true) as
select
  snapshot.id,
  snapshot.build_id,
  snapshot.scope_type,
  snapshot.court_id,
  snapshot.court_code,
  snapshot.scope_label,
  snapshot.judicial_region,
  snapshot.period_start,
  snapshot.period_end,
  snapshot.minimum_sample,
  snapshot.sample_size,
  snapshot.median_hammer_to_starting_ratio,
  snapshot.above_starting_rate,
  snapshot.at_least_double_rate,
  snapshot.median_hammer_price_eur,
  snapshot.median_starting_price_eur,
  snapshot.methodology_version,
  build.source_name,
  build.built_at,
  review.reviewed_at,
  snapshot.extra_statistics
from public.adjudication_price_statistics_snapshots snapshot
join public.adjudication_price_statistics_builds build
  on build.id = snapshot.build_id
join public.adjudication_price_statistics_build_reviews review
  on review.build_id = build.id
join public.adjudication_price_statistics_source_attestations attestation
  on attestation.build_id = build.id
where attestation.source_gate_version = 'licitor_reviewed_candidate_v1'
  and review.decision = 'approved'
  and review.rights_basis_confirmed
  and review.methodology_approved
  and review.court_mappings_approved
  and snapshot.sample_size >= snapshot.minimum_sample
  and snapshot.quality_status = 'sample_threshold_met_not_reviewed';

revoke all on public.published_adjudication_price_statistics
  from public, anon, authenticated, service_role;
grant select on public.published_adjudication_price_statistics to service_role;

comment on view public.published_adjudication_price_statistics is
  'Server-only reviewed Licitor cells. A source attestation is required for new publication; legacy snapshots without one remain stored but quarantined.';

commit;
