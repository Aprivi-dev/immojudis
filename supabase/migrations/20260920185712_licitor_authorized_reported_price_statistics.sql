begin;

-- Record the operator-confirmed permission separately from Licitor collector
-- payloads. Permission to reuse the data does not make Licitor an official
-- source and does not establish the procedural finality of a sale.
create table licitor_ingestion.statistical_source_authorizations (
  id uuid primary key default gen_random_uuid(),
  source_name text not null check (source_name = 'licitor'),
  authorization_basis text not null check (
    authorization_basis = 'operator_confirmed_verbal_consent'
  ),
  authorization_reference text not null check (
    pg_catalog.btrim(authorization_reference) <> ''
  ),
  statistical_scope text not null check (
    statistical_scope = 'aggregate_reported_adjudication_prices'
  ),
  granted_by_role text not null check (pg_catalog.btrim(granted_by_role) <> ''),
  attested_by uuid not null references auth.users(id) on delete restrict,
  evidence jsonb not null check (
    jsonb_typeof(evidence) = 'object' and evidence <> '{}'::jsonb
  ),
  authorized_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (source_name, authorization_reference, statistical_scope)
);

create table licitor_ingestion.statistical_reported_candidate_attestations (
  candidate_external_id text not null
    references licitor_ingestion.candidates(external_id) on delete restrict,
  candidate_capture_sha256 text not null
    check (candidate_capture_sha256 ~ '^[a-f0-9]{64}$'),
  candidate_version_hash text not null
    check (candidate_version_hash ~ '^[a-f0-9]{64}$'),
  decision text not null check (
    decision = 'approved_for_aggregate_reported_statistics'
  ),
  candidate_grade text not null check (candidate_grade = 'C'),
  evidence_grade text not null check (evidence_grade = 'C'),
  finality_status text not null check (
    finality_status = 'source_reported_not_officially_verified'
  ),
  publication_scope text not null check (
    publication_scope = 'aggregate_reported_adjudication_prices_only'
  ),
  source_authorization_id uuid not null
    references licitor_ingestion.statistical_source_authorizations(id)
    on delete restrict,
  evidence jsonb not null check (
    jsonb_typeof(evidence) = 'object' and evidence <> '{}'::jsonb
  ),
  reviewed_at timestamptz not null default now(),
  primary key (
    candidate_external_id,
    candidate_capture_sha256,
    candidate_version_hash
  ),
  foreign key (candidate_external_id, candidate_version_hash)
    references licitor_ingestion.candidate_versions(external_id, version_hash)
    on delete restrict
);

create index statistical_reported_candidate_attestations_candidate_idx
  on licitor_ingestion.statistical_reported_candidate_attestations(
    candidate_external_id,
    reviewed_at desc
  );

alter table licitor_ingestion.statistical_source_authorizations
  enable row level security;
alter table licitor_ingestion.statistical_reported_candidate_attestations
  enable row level security;

revoke all on
  licitor_ingestion.statistical_source_authorizations,
  licitor_ingestion.statistical_reported_candidate_attestations
from public, anon, authenticated, licitor_collector;
grant select, insert on
  licitor_ingestion.statistical_source_authorizations,
  licitor_ingestion.statistical_reported_candidate_attestations
to service_role;

create or replace function app_private.reject_licitor_statistical_authorization_mutation()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  raise exception 'Licitor statistical authorizations and reported-price attestations are append-only';
end;
$function$;

revoke all on function app_private.reject_licitor_statistical_authorization_mutation()
from public, anon, authenticated, service_role, licitor_collector;

create trigger statistical_source_authorizations_append_only
before update or delete on licitor_ingestion.statistical_source_authorizations
for each row execute function app_private.reject_licitor_statistical_authorization_mutation();

create trigger statistical_reported_candidate_attestations_append_only
before update or delete on licitor_ingestion.statistical_reported_candidate_attestations
for each row execute function app_private.reject_licitor_statistical_authorization_mutation();

comment on table licitor_ingestion.statistical_source_authorizations is
  'Append-only evidence of permission to use a third-party source for a narrowly defined statistical purpose. It does not confer official-source status.';
comment on table licitor_ingestion.statistical_reported_candidate_attestations is
  'Append-only grade-C attestation binding one current Licitor capture/version to aggregate-only reported-price statistics. It is not proof of procedural finality.';

-- Preserve the strict A/B definitive route while adding an explicitly limited
-- route for grade-C prices reported by Licitor. The latter must match the
-- current immutable candidate version, its capture, the recorded permission,
-- and deterministic structural safety checks.
create or replace view licitor_ingestion.statistics_eligible_candidates
with (security_invoker = true) as
select
  candidate.*,
  reviewed.version_hash as candidate_version_hash,
  reviewed.candidate_capture_sha256 as reviewed_capture_sha256,
  reviewed.reviewer_id as statistical_reviewer_id,
  reviewed.reviewed_at as statistical_reviewed_at
from licitor_ingestion.statistics_candidates candidate
join lateral (
  select selected.*
  from (
    select
      version.version_hash,
      review.candidate_capture_sha256,
      review.reviewer_id,
      review.reviewed_at,
      1 as review_priority
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

    union all

    select
      version.version_hash,
      attestation.candidate_capture_sha256,
      source_authorization.attested_by as reviewer_id,
      attestation.reviewed_at,
      2 as review_priority
    from licitor_ingestion.candidate_versions version
    join licitor_ingestion.statistical_reported_candidate_attestations attestation
      on attestation.candidate_external_id = version.external_id
     and attestation.candidate_version_hash = version.version_hash
     and attestation.candidate_capture_sha256 = candidate.payload->>'source_content_hash'
    join licitor_ingestion.statistical_source_authorizations source_authorization
      on source_authorization.id = attestation.source_authorization_id
     and source_authorization.source_name = 'licitor'
     and source_authorization.authorization_basis = 'operator_confirmed_verbal_consent'
     and source_authorization.statistical_scope = 'aggregate_reported_adjudication_prices'
     and source_authorization.authorization_reference =
       candidate.payload->>'authorization_reference'
    where version.external_id = candidate.external_id
      and version.payload = candidate.payload
      and attestation.decision = 'approved_for_aggregate_reported_statistics'
      and attestation.candidate_grade = 'C'
      and attestation.evidence_grade = 'C'
      and attestation.finality_status = 'source_reported_not_officially_verified'
      and attestation.publication_scope = 'aggregate_reported_adjudication_prices_only'
      and pg_catalog.lower(coalesce(candidate.payload->>'source_name', '')) = 'licitor'
      and candidate.payload->>'status' = 'adjudicated'
      and candidate.payload @> '{
        "publication_eligible": false,
        "training_eligible": false,
        "candidate_grade": "C",
        "evidence_grade": "C",
        "review_status": "pending",
        "finality_status": "unknown",
        "source_is_official": false,
        "authorization_basis": "operator_reported_verbal_consent"
      }'::jsonb
      and nullif(pg_catalog.btrim(candidate.payload->>'source_page_url'), '') is not null
      and case
        when jsonb_typeof(candidate.payload->'source_capture_evidence') = 'array'
          then jsonb_array_length(candidate.payload->'source_capture_evidence') > 0
        else false
      end
      and coalesce(candidate.payload->>'sale_venue_type', 'tribunal') = 'tribunal'
      and pg_catalog.pg_input_is_valid(candidate.payload->>'sale_date', 'date')
      and case
        when pg_catalog.pg_input_is_valid(
          candidate.payload->>'starting_price_eur', 'numeric'
        ) then (candidate.payload->>'starting_price_eur')::numeric > 1000
        else false
      end
      and case
        when pg_catalog.pg_input_is_valid(
          candidate.payload->>'adjudication_price_eur', 'numeric'
        ) then (candidate.payload->>'adjudication_price_eur')::numeric > 0
        else false
      end
      and not (coalesce(candidate.payload->'quality_flags', '[]'::jsonb) ?| array[
        'index_detail_date_conflict',
        'conflicting_announcement_alias_capture',
        'cached_reparse_failed',
        'source_result_changed_pending_review',
        'lot_missing_in_latest_capture'
      ])
  ) selected
  order by selected.review_priority, selected.reviewed_at desc, selected.version_hash desc
  limit 1
) reviewed on true;

revoke all on licitor_ingestion.statistics_eligible_candidates
from public, anon, authenticated, licitor_collector;
grant select on licitor_ingestion.statistics_eligible_candidates to service_role;

comment on view licitor_ingestion.statistics_eligible_candidates is
  'Private current-version projection: strict A/B definitive reviews, or authorized grade-C Licitor-reported prices limited to descriptive aggregates and never represented as official/final.';

-- New builds are cryptographically distinguished from the earlier strict-only
-- gate. Old v1 attestations remain valid records but are not republished by the
-- v2 publication view.
alter table public.adjudication_price_statistics_source_attestations
  drop constraint adjudication_price_statistics_source__source_gate_version_check;
alter table public.adjudication_price_statistics_source_attestations
  add constraint adjudication_price_statistics_source_gate_version_check
  check (source_gate_version in (
    'licitor_reviewed_candidate_v1',
    'licitor_authorized_reported_price_v2'
  ));

-- Reapply both guarded functions with the v2 gate marker. This retains their
-- complete manifest validation, MVCC checks, privileges and signatures.
do $migration$
declare
  function_signature regprocedure;
  definition text;
begin
  foreach function_signature in array array[
    'app_private.attest_licitor_statistics_build_source(uuid,integer,text)'::regprocedure,
    'licitor_ingestion.stage_adjudication_price_statistics_build(text[])'::regprocedure
  ] loop
    select pg_catalog.pg_get_functiondef(function_signature) into definition;
    if definition is null
       or position('licitor_reviewed_candidate_v1' in definition) = 0 then
      raise exception 'Unexpected Licitor statistics gate function: %', function_signature;
    end if;
    execute pg_catalog.replace(
      definition,
      'licitor_reviewed_candidate_v1',
      'licitor_authorized_reported_price_v2'
    );
  end loop;
end;
$migration$;

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
where attestation.source_gate_version = 'licitor_authorized_reported_price_v2'
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
  'Server-only descriptive aggregates of authorized Licitor-reported prices. These grade-C source values are neither official registry evidence nor proof of procedural finality.';

commit;
