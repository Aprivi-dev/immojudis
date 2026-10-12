begin;

set local lock_timeout = '5s';

-- Collecte automatique de l'historique des adjudications Licitor (décision du
-- propriétaire du 12/10/2026). Elle ne réintroduit aucun cron : le planificateur
-- unique (claim_autonomous_pipeline_run → data-pipeline.yml → autonomous_runner)
-- lance un « tick » du collecteur après chaque passage de la file
-- d'enrichissement (services/data-pipeline/src/sources/licitor_history_refresh.py).

-- 1. The scheduled pipeline connects with the main database URL and switches to
--    the narrow collector role for the network part, so the collector keeps its
--    own grants and row level security without a second credential. postgres
--    already administers the role; it only lacks the SET option (PG16 default).
do $grant$
begin
  if exists (select 1 from pg_roles where rolname = 'licitor_collector') then
    execute 'grant licitor_collector to postgres with set true, inherit false';
  end if;
exception
  when insufficient_privilege then
    raise notice 'licitor_collector: SET option not granted (%), the refresh will report it', sqlerrm;
end;
$grant$;

-- 2. The monthly campaign (36-month window, results of the last 90 days
--    refetched) is created by the scheduled refresh, at most once a month.
update licitor_ingestion.control
set monthly_enabled = true, updated_at = now()
where singleton and not monthly_enabled;

-- 3. Newly collected lots join the statistics through the same deterministic
--    structural gate as the 3 798 lots attested on 20/09/2026: a grade-C price
--    reported by Licitor, used for aggregates only, under the recorded permission.
create or replace function app_private.attest_licitor_reported_candidates()
returns integer
language sql
volatile
security definer
set search_path = ''
as $function$
  with attested as (
    insert into licitor_ingestion.statistical_reported_candidate_attestations (
      candidate_external_id,
      candidate_capture_sha256,
      candidate_version_hash,
      decision,
      candidate_grade,
      evidence_grade,
      finality_status,
      publication_scope,
      source_authorization_id,
      evidence
    )
    select distinct on (candidate.external_id)
      candidate.external_id,
      candidate.payload->>'source_content_hash',
      version.version_hash,
      'approved_for_aggregate_reported_statistics',
      'C',
      'C',
      'source_reported_not_officially_verified',
      'aggregate_reported_adjudication_prices_only',
      source_authorization.id,
      jsonb_build_object(
        'use', 'aggregate_only',
        'review_method', 'deterministic_structural_gate',
        'review_actor', 'scheduled_licitor_history_refresh',
        'source_status', 'third_party_non_official',
        'authorization_reference', source_authorization.authorization_reference,
        'procedural_finality_verified', false
      )
    from licitor_ingestion.statistics_candidates candidate
    join licitor_ingestion.candidate_versions version
      on version.external_id = candidate.external_id
     and version.payload = candidate.payload
    join licitor_ingestion.statistical_source_authorizations source_authorization
      on source_authorization.source_name = 'licitor'
     and source_authorization.authorization_basis = 'operator_confirmed_verbal_consent'
     and source_authorization.statistical_scope = 'aggregate_reported_adjudication_prices'
     and source_authorization.authorization_reference = candidate.payload->>'authorization_reference'
    where coalesce(candidate.payload->>'source_content_hash', '') ~ '^[a-f0-9]{64}$'
      and version.version_hash ~ '^[a-f0-9]{64}$'
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
      and jsonb_typeof(candidate.payload->'source_capture_evidence') = 'array'
      and jsonb_array_length(candidate.payload->'source_capture_evidence') > 0
      and coalesce(candidate.payload->>'sale_venue_type', 'tribunal') = 'tribunal'
      and pg_catalog.pg_input_is_valid(candidate.payload->>'sale_date', 'date')
      and pg_catalog.pg_input_is_valid(candidate.payload->>'starting_price_eur', 'numeric')
      and pg_catalog.pg_input_is_valid(candidate.payload->>'adjudication_price_eur', 'numeric')
      and (candidate.payload->>'starting_price_eur')::numeric > 1000
      and (candidate.payload->>'adjudication_price_eur')::numeric > 0
      and not (coalesce(candidate.payload->'quality_flags', '[]'::jsonb) ?| array[
        'index_detail_date_conflict',
        'conflicting_announcement_alias_capture',
        'cached_reparse_failed',
        'source_result_changed_pending_review',
        'lot_missing_in_latest_capture'
      ])
      and not exists (
        select 1
        from licitor_ingestion.statistical_reported_candidate_attestations existing
        where existing.candidate_external_id = candidate.external_id
          and existing.candidate_capture_sha256 = candidate.payload->>'source_content_hash'
          and existing.candidate_version_hash = version.version_hash
      )
    order by candidate.external_id, version.version_hash
    on conflict do nothing
    returning 1
  )
  select count(*)::integer from attested;
$function$;

revoke all on function app_private.attest_licitor_reported_candidates() from public, anon, authenticated, licitor_collector;
grant execute on function app_private.attest_licitor_reported_candidates() to service_role;

comment on function app_private.attest_licitor_reported_candidates() is
  'Attests every current Licitor candidate version that passes the deterministic structural gate of statistics_eligible_candidates. Run by the scheduled history refresh after each collector tick; append-only and idempotent.';

commit;
