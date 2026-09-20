begin;

select plan(3);

select ok(
  to_regclass(
    'licitor_ingestion.statistical_source_authorizations_attested_by_idx'
  ) is not null,
  'source authorization reviewer foreign keys are indexed'
);

select ok(
  to_regclass(
    'licitor_ingestion.statistical_reported_attestations_candidate_version_idx'
  ) is not null,
  'reported candidate-version foreign keys are indexed'
);

select ok(
  to_regclass(
    'licitor_ingestion.statistical_reported_attestations_source_authorization_idx'
  ) is not null,
  'reported source-authorization foreign keys are indexed'
);

select * from finish();

rollback;
