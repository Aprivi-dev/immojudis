begin;

create index statistical_source_authorizations_attested_by_idx
  on licitor_ingestion.statistical_source_authorizations(attested_by);

create index statistical_reported_attestations_candidate_version_idx
  on licitor_ingestion.statistical_reported_candidate_attestations(
    candidate_external_id,
    candidate_version_hash
  );

create index statistical_reported_attestations_source_authorization_idx
  on licitor_ingestion.statistical_reported_candidate_attestations(
    source_authorization_id
  );

commit;
