begin;

select plan(76);

select has_table('public', 'ingestion_jobs', 'Outcome ingestion has a durable job queue');
select has_table('public', 'source_fetches', 'each source fetch attempt is recorded');
select has_table('public', 'artifact_extractions', 'artifact extraction runs are versioned');
select has_table('public', 'source_sync_checkpoints', 'incremental source cursors are persisted');
select has_table('public', 'judicial_source_records', 'normalized judicial source records are versioned');
select has_table('public', 'source_record_matches', 'source matches remain reviewable evidence');
select has_table('public', 'source_purge_events', 'deletion and purge actions have an audit ledger');

select ok(
  (
    select count(*) = 7 and bool_and(relrowsecurity)
    from pg_class
    join pg_namespace on pg_namespace.oid = pg_class.relnamespace
    where pg_namespace.nspname = 'public'
      and pg_class.relname in (
        'ingestion_jobs', 'source_fetches', 'artifact_extractions',
        'source_sync_checkpoints', 'judicial_source_records',
        'source_record_matches', 'source_purge_events'
      )
  ),
  'RLS is enabled on every source-ingestion table'
);

select ok(
  (
    select bool_and(
      not has_table_privilege('anon', format('public.%I', relation_name), 'SELECT')
    )
    from unnest(array[
      'ingestion_jobs', 'source_fetches', 'artifact_extractions',
      'source_sync_checkpoints', 'judicial_source_records',
      'source_record_matches', 'source_purge_events'
    ]::text[]) as source_table(relation_name)
  ),
  'anonymous requests cannot inspect source ingestion state'
);

select ok(
  (
    select bool_and(
      not has_table_privilege('authenticated', format('public.%I', relation_name), 'SELECT')
    )
    from unnest(array[
      'ingestion_jobs', 'source_fetches', 'artifact_extractions',
      'source_sync_checkpoints', 'judicial_source_records',
      'source_record_matches', 'source_purge_events'
    ]::text[]) as source_table(relation_name)
  ),
  'authenticated requests cannot bypass the server ingestion boundary'
);

select ok(
  not has_table_privilege('service_role', 'public.ingestion_jobs', 'UPDATE')
  and not has_table_privilege('service_role', 'public.source_sync_checkpoints', 'INSERT')
  and not has_table_privilege('service_role', 'public.source_sync_checkpoints', 'UPDATE'),
  'queue and checkpoint mutations are restricted to lease- and revision-aware RPCs'
);

select ok(
  not has_table_privilege('service_role', 'public.source_fetches', 'UPDATE')
  and not has_table_privilege('service_role', 'public.artifact_extractions', 'UPDATE')
  and not has_table_privilege('service_role', 'public.judicial_source_records', 'UPDATE')
  and not has_table_privilege('service_role', 'public.source_record_matches', 'UPDATE')
  and not has_table_privilege('service_role', 'public.source_purge_events', 'UPDATE'),
  'append-only provenance tables expose no direct update grant'
);

select ok(
  not has_function_privilege(
    'authenticated',
    'app_private.claim_outcome_ingestion_job(text,integer,uuid,text)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'app_private.upsert_outcome_source_checkpoint(uuid,text,bigint,jsonb,timestamptz,text,uuid)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'app_private.complete_outcome_ingestion_job(uuid,text,uuid)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'app_private.fail_outcome_ingestion_job(uuid,text,uuid,text,text,text,integer)',
    'EXECUTE'
  ),
  'authenticated callers cannot claim, complete, fail, or checkpoint ingestion work'
);

select ok(
  has_function_privilege(
    'service_role',
    'app_private.claim_outcome_ingestion_job(text,integer,uuid,text)',
    'EXECUTE'
  )
  and has_function_privilege(
    'service_role',
    'app_private.upsert_outcome_source_checkpoint(uuid,text,bigint,jsonb,timestamptz,text,uuid)',
    'EXECUTE'
  )
  and has_function_privilege(
    'service_role',
    'app_private.complete_outcome_ingestion_job(uuid,text,uuid)',
    'EXECUTE'
  )
  and has_function_privilege(
    'service_role',
    'app_private.fail_outcome_ingestion_job(uuid,text,uuid,text,text,text,integer)',
    'EXECUTE'
  ),
  'the trusted worker may use the guarded ingestion state transitions'
);

select ok(
  (
    select prosecdef
    from pg_proc
    where oid = 'app_private.claim_outcome_ingestion_job(text,integer,uuid,text)'::regprocedure
  ),
  'job claiming runs in the tightly granted security-definer boundary'
);

select ok(
  pg_get_functiondef(
    'app_private.claim_outcome_ingestion_job(text,integer,uuid,text)'::regprocedure
  ) ~* 'for update([[:space:]]+of[[:space:]]+job)?[[:space:]]+skip locked',
  'job claiming uses SKIP LOCKED for concurrent workers'
);

select ok(
  (
    select official
      and legal_review_status = 'approved'
      and ingestion_policy = 'allowed_automated'
      and active
      and personal_data_possible
      and terms_version = 'reviewed_2026-08-20'
    from public.data_sources
    where name = 'judilibre'
  ),
  'Judilibre is approved only with the reviewed production source policy'
);

select ok(
  (
    select count(*) = 2
      and bool_and(official)
      and bool_and(legal_review_status = 'approved')
      and bool_and(ingestion_policy = 'allowed_automated')
      and bool_and(active)
    from public.data_sources
    where name in ('dvf_dgfip', 'justice_open_data')
  ),
  'official DVF and Justice datasets are approved for automated ingestion'
);

select ok(
  (
    select personal_data_possible
    from public.data_sources
    where name = 'dvf_dgfip'
  ),
  'DVF is conservatively classified as potentially containing personal data'
);

select ok(
  (
    select not official
      and legal_review_status = 'pending'
      and ingestion_policy = 'allowed_manual'
      and not active
    from public.data_sources
    where name = 'encheres_publiques_open_data'
  ),
  'the third-party hearing index stays manual and inactive pending review'
);

select ok(
  (
    select column_default = 'false'
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'judicial_source_records'
      and column_name = 'training_eligible'
  ),
  'new source records are not training-eligible by default'
);

select ok(
  (
    select not public
      and file_size_limit = 104857600
      and allowed_mime_types @> array[
        'application/json', 'application/pdf', 'application/octet-stream',
        'text/csv', 'text/plain'
      ]::text[]
    from storage.buckets
    where id = 'outcome-raw-artifacts'
  ),
  'raw Outcome artifacts use a bounded private Storage bucket'
);

select ok(
  not exists (
    select 1
    from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and (
        coalesce(qual, '') ilike '%outcome-raw-artifacts%'
        or coalesce(with_check, '') ilike '%outcome-raw-artifacts%'
      )
  ),
  'the raw artifact bucket has no browser-facing Storage policy'
);

select ok(
  has_table_privilege('service_role', 'storage.buckets', 'SELECT')
  and has_table_privilege('service_role', 'storage.objects', 'SELECT')
  and has_table_privilege('service_role', 'storage.objects', 'INSERT')
  and has_table_privilege('service_role', 'storage.objects', 'DELETE'),
  'only the trusted server path receives capture and physical-purge Storage grants'
);

insert into public.data_sources (
  id, name, publisher, official, base_url, license,
  legal_review_status, ingestion_policy, active
) values (
  'a1000000-0000-4000-8000-000000000099',
  'outcome-disabled-pgtap',
  'Test publisher',
  true,
  'https://example.test/disabled-source',
  'Test-only',
  'pending',
  'disabled',
  false
);

set local role service_role;

select throws_ok(
  $$insert into public.ingestion_jobs (
      source_id, job_kind, idempotency_key
    ) values (
      (select id from public.data_sources where name = 'outcome-disabled-pgtap'),
      'judilibre_history', 'judilibre-disabled-source-test'
    )$$,
  '23514',
  'Ingestion jobs require an active source approved for automation.',
  'a pending disabled source cannot enter the automated ingestion queue'
);

select throws_ok(
  $$select app_private.upsert_outcome_source_checkpoint(
      (select id from public.data_sources where name = 'outcome-disabled-pgtap'),
      'history', null, '{}'::jsonb, null, 'test-connector/1.0.0', null
    )$$,
  '23514',
  'Checkpoints require an active source approved for automated ingestion.',
  'a pending disabled source cannot advance an ingestion checkpoint'
);

select lives_ok(
  $$insert into public.ingestion_jobs (
      id, source_id, job_kind, stream_key, idempotency_key, payload, priority
    ) values (
      'a1700000-0000-4000-8000-000000000003',
      (select id from public.data_sources where name = 'outcome-disabled-pgtap'),
      'source.purge', 'deletions', 'disabled-source-purge-test',
      '{"external_record_id":"deleted-upstream"}'::jsonb, 100
    )$$,
  'a compliance purge may be queued after its source is disabled'
);

select is(
  (
    select status
    from app_private.claim_outcome_ingestion_job(
      'pgtap-purge-worker',
      300,
      (select id from public.data_sources where name = 'outcome-disabled-pgtap'),
      'source.purge'
    )
  ),
  'leased',
  'a disabled-source purge remains claimable without reopening collection jobs'
);

insert into public.data_sources (
  id, name, publisher, official, base_url, license,
  legal_review_status, ingestion_policy, active
) values (
  'a1000000-0000-4000-8000-000000000001',
  'outcome-ingestion-pgtap',
  'Test publisher',
  true,
  'https://example.test/source',
  'Test-only',
  'approved',
  'allowed_automated',
  true
);

insert into public.raw_artifacts (
  id, source_id, external_record_id, canonical_url, storage_object_path,
  mime_type, byte_size, content_hash, captured_at, connector_version
) values (
  'a1100000-0000-4000-8000-000000000001',
  'a1000000-0000-4000-8000-000000000001',
  'record-1',
  'https://example.test/source/record-1',
  'outcome-sources/test/record-1.json',
  'application/json',
  17,
  repeat('a', 64),
  '2026-07-30T10:00:00Z',
  'test-connector/1.0.0'
);

select lives_ok(
  $$insert into public.source_fetches (
      id, source_id, raw_artifact_id, fetch_status, requested_url,
      request_fingerprint, http_status, content_hash, byte_size, mime_type,
      connector_version, started_at, completed_at
    ) values
      (
        'a1200000-0000-4000-8000-000000000001',
        'a1000000-0000-4000-8000-000000000001',
        'a1100000-0000-4000-8000-000000000001',
        'succeeded', 'https://example.test/source/record-1', repeat('1', 64),
        200, repeat('a', 64), 17, 'application/json', 'test-connector/1.0.0',
        '2026-07-30T10:00:00Z', '2026-07-30T10:00:01Z'
      ),
      (
        'a1200000-0000-4000-8000-000000000002',
        'a1000000-0000-4000-8000-000000000001',
        'a1100000-0000-4000-8000-000000000001',
        'succeeded', 'https://example.test/source/record-1', repeat('2', 64),
        200, repeat('a', 64), 17, 'application/json', 'test-connector/1.0.0',
        '2026-07-30T11:00:00Z', '2026-07-30T11:00:01Z'
      )$$,
  'identical responses remain two fetch attempts referencing one raw artifact'
);

select ok(
  (
    select count(*) = 2 and count(distinct raw_artifact_id) = 1
    from public.source_fetches
    where source_id = 'a1000000-0000-4000-8000-000000000001'
  ),
  'fetch-attempt multiplicity is independent from content deduplication'
);

select lives_ok(
  $$insert into public.source_fetches (
      id, source_id, raw_artifact_id, fetch_status, capture_transport,
      http_method, requested_url, request_fingerprint, http_status,
      content_hash, byte_size, mime_type, connector_version, started_at, completed_at
    ) values (
      'a1200000-0000-4000-8000-000000000003',
      'a1000000-0000-4000-8000-000000000001',
      'a1100000-0000-4000-8000-000000000001',
      'imported_local', 'local_file', null,
      'https://example.test/source/local-file', repeat('3', 64), null,
      repeat('a', 64), 17, 'application/json', 'test-connector/1.0.0',
      '2026-07-30T11:05:00Z', '2026-07-30T11:05:01Z'
    )$$,
  'a local-file import never claims an HTTP request or response status'
);

select throws_ok(
  $$insert into public.source_fetches (
      source_id, raw_artifact_id, fetch_status, requested_url,
      request_fingerprint, http_status, content_hash, byte_size, mime_type,
      connector_version, started_at, completed_at
    ) values (
      'a1000000-0000-4000-8000-000000000001',
      'a1100000-0000-4000-8000-000000000001',
      'succeeded', 'https://example.test/source/missing-success-status',
      repeat('4', 64), null, repeat('a', 64), 17, 'application/json',
      'test-connector/1.0.0',
      '2026-07-30T11:10:00Z', '2026-07-30T11:10:01Z'
    )$$,
  '23514',
  'new row for relation "source_fetches" violates check constraint "source_fetches_success_check"',
  'a successful fetch must carry an explicit 2xx HTTP status'
);

select throws_ok(
  $$insert into public.source_fetches (
      source_id, fetch_status, requested_url, request_fingerprint, http_status,
      connector_version, started_at, completed_at
    ) values (
      'a1000000-0000-4000-8000-000000000001',
      'not_modified', 'https://example.test/source/missing-304-status',
      repeat('5', 64), null, 'test-connector/1.0.0',
      '2026-07-30T11:20:00Z', '2026-07-30T11:20:01Z'
    )$$,
  '23514',
  'new row for relation "source_fetches" violates check constraint "source_fetches_not_modified_check"',
  'a not-modified fetch must carry an explicit HTTP 304 status'
);

select throws_ok(
  $$insert into public.source_fetches (
      source_id, fetch_status, requested_url, request_fingerprint, http_status,
      connector_version, error_code, started_at, completed_at
    ) values (
      'a1000000-0000-4000-8000-000000000001',
      'rate_limited', 'https://example.test/source/missing-429-status',
      repeat('6', 64), null, 'test-connector/1.0.0', 'rate_limited',
      '2026-07-30T11:30:00Z', '2026-07-30T11:30:01Z'
    )$$,
  '23514',
  'new row for relation "source_fetches" violates check constraint "source_fetches_rate_limited_check"',
  'a rate-limited fetch must carry an explicit HTTP 429 status'
);

select lives_ok(
  $$insert into public.artifact_extractions (
      id, raw_artifact_id, source_fetch_id, extractor_name, extractor_version,
      schema_version, extraction_status, extracted_data, field_provenance,
      output_hash, quality_score
    ) values (
      'a1300000-0000-4000-8000-000000000001',
      'a1100000-0000-4000-8000-000000000001',
      'a1200000-0000-4000-8000-000000000001',
      'judicial-json', '1.0.0', 'judicial-source-v1', 'succeeded',
      '{"id":"record-1"}'::jsonb,
      '{"id":{"pointer":"/id"}}'::jsonb,
      repeat('b', 64), 0.9900
    )$$,
  'a successful extraction records version, payload hash, and field provenance'
);

select lives_ok(
  $$insert into public.judicial_source_records (
      id, source_id, source_fetch_id, raw_artifact_id, artifact_extraction_id,
      record_kind, external_record_id, decision_date, source_updated_at,
      published_at, canonical_url, normalized_data, content_hash, connector_version
    ) values (
      'a1400000-0000-4000-8000-000000000001',
      'a1000000-0000-4000-8000-000000000001',
      'a1200000-0000-4000-8000-000000000001',
      'a1100000-0000-4000-8000-000000000001',
      'a1300000-0000-4000-8000-000000000001',
      'judicial_decision_candidate', 'record-1', '2026-07-29', '2026-07-30T09:00:00Z',
      '2026-07-30T09:30:00Z', 'https://example.test/source/record-1',
      '{"jurisdiction":"TJ Test"}'::jsonb, repeat('c', 64), 'test-connector/1.0.0'
    )$$,
  'a normalized source record retains its complete capture provenance'
);

select lives_ok(
  $$do $source_record_reversion$
    begin
      insert into public.judicial_source_records (
        id, source_id, source_fetch_id, raw_artifact_id, artifact_extraction_id,
        record_kind, external_record_id, record_version, decision_date,
        normalized_data, content_hash, connector_version, supersedes_record_id
      ) values (
        'a1400000-0000-4000-8000-000000000002',
        'a1000000-0000-4000-8000-000000000001',
        'a1200000-0000-4000-8000-000000000001',
        'a1100000-0000-4000-8000-000000000001',
        'a1300000-0000-4000-8000-000000000001',
        'judicial_decision_candidate', 'record-1', 2, '2026-07-29',
        '{"jurisdiction":"TJ Corrige"}'::jsonb, repeat('d', 64), 'test-connector/1.0.0',
        'a1400000-0000-4000-8000-000000000001'
      );
      insert into public.judicial_source_records (
        id, source_id, source_fetch_id, raw_artifact_id, artifact_extraction_id,
        record_kind, external_record_id, record_version, decision_date,
        normalized_data, content_hash, connector_version, supersedes_record_id
      ) values (
        'a1400000-0000-4000-8000-000000000003',
        'a1000000-0000-4000-8000-000000000001',
        'a1200000-0000-4000-8000-000000000001',
        'a1100000-0000-4000-8000-000000000001',
        'a1300000-0000-4000-8000-000000000001',
        'judicial_decision_candidate', 'record-1', 3, '2026-07-29',
        '{"jurisdiction":"TJ Test"}'::jsonb, repeat('c', 64), 'test-connector/1.0.0',
        'a1400000-0000-4000-8000-000000000002'
      );
    end
  $source_record_reversion$;$$,
  'a non-consecutive source correction may return to a prior content hash'
);

select ok(
  (
    select not training_eligible
      and training_eligibility_reason = 'unreviewed_source_record'
    from public.judicial_source_records
    where id = 'a1400000-0000-4000-8000-000000000001'
  ),
  'ingested records remain excluded from training until explicitly promoted'
);

select throws_ok(
  $$insert into public.judicial_source_records (
      source_id, source_fetch_id, raw_artifact_id, artifact_extraction_id,
      record_kind, external_record_id, normalized_data, content_hash,
      connector_version, training_eligible, training_eligibility_reason
    ) values (
      'a1000000-0000-4000-8000-000000000001',
      'a1200000-0000-4000-8000-000000000001',
      'a1100000-0000-4000-8000-000000000001',
      'a1300000-0000-4000-8000-000000000001',
      'judicial_decision_candidate', 'record-training-bypass',
      '{"jurisdiction":"TJ Test"}'::jsonb, repeat('d', 64),
      'test-connector/1.0.0', true, 'attempted_direct_promotion'
    )$$,
  '23514',
  'new row for relation "judicial_source_records" violates check constraint "judicial_source_records_candidates_only_check"',
  'source candidates cannot be promoted directly into model training'
);

reset role;

select throws_ok(
  $$update public.source_fetches
    set connector_version = 'tampered'
    where id = 'a1200000-0000-4000-8000-000000000001'$$,
  '55000',
  'public.source_fetches is append-only; insert a correcting version instead.',
  'fetch provenance cannot be rewritten'
);

select throws_ok(
  $$update public.judicial_source_records
    set normalized_data = '{"tampered":true}'::jsonb
    where id = 'a1400000-0000-4000-8000-000000000001'$$,
  '55000',
  'public.judicial_source_records is append-only; insert a correcting version instead.',
  'normalized source history cannot be rewritten'
);

set local role service_role;

select throws_ok(
  $$insert into public.source_fetches (
      source_id, fetch_status, requested_url, request_fingerprint, http_status,
      connector_version, error_code, sanitized_error_message, started_at, completed_at
    ) values (
      'a1000000-0000-4000-8000-000000000001', 'failed',
      'https://example.test/source/failure', repeat('3', 64), 500,
      'test-connector/1.0.0', 'http_error', 'Authorization: Bearer secret',
      '2026-07-30T12:00:00Z', '2026-07-30T12:00:01Z'
    )$$,
  '23514',
  'new row for relation "source_fetches" violates check constraint "source_fetches_sanitized_error_check"',
  'fetch errors cannot persist common credential-bearing headers'
);

insert into public.outcome_courts (id, code, name)
values (
  'a1500000-0000-4000-8000-000000000001',
  'TJ-INGESTION-TEST',
  'Tribunal judiciaire ingestion test'
);

insert into public.auction_cases (id, court_id, court_case_number, procedure_type)
values (
  'a1600000-0000-4000-8000-000000000001',
  'a1500000-0000-4000-8000-000000000001',
  'RG-INGESTION-1',
  'saisie_immobiliere'
);

insert into public.auction_cases (id, court_id, court_case_number, procedure_type)
values (
  'a1600000-0000-4000-8000-000000000002',
  'a1500000-0000-4000-8000-000000000001',
  'RG-INGESTION-2',
  'saisie_immobiliere'
);

insert into public.auction_lots (id, auction_case_id, lot_number)
values (
  'a1610000-0000-4000-8000-000000000001',
  'a1600000-0000-4000-8000-000000000002',
  '1'
);

select throws_ok(
  $$insert into public.source_record_matches (
      source_record_id, case_id, match_score, match_method, match_signals,
      status, decided_at
    ) values (
      'a1400000-0000-4000-8000-000000000001',
      'a1600000-0000-4000-8000-000000000001',
      0.9900, 'address_only', '{"address":true}'::jsonb, 'auto_matched', now()
    )$$,
  '23514',
  'new row for relation "source_record_matches" violates check constraint "source_record_matches_auto_non_address_signal_check"',
  'an address-only method can never auto-match a judicial record'
);

select throws_ok(
  $$insert into public.source_record_matches (
      source_record_id, case_id, match_score, match_method, match_signals,
      status, decided_at
    ) values (
      'a1400000-0000-4000-8000-000000000001',
      'a1600000-0000-4000-8000-000000000001',
      0.9900, 'composite', '{"address":true}'::jsonb, 'auto_matched', now()
    )$$,
  '23514',
  'new row for relation "source_record_matches" violates check constraint "source_record_matches_auto_non_address_signal_check"',
  'renaming an address-only match as composite does not bypass the evidence rule'
);

select lives_ok(
  $$insert into public.source_record_matches (
      id, source_record_id, case_id, match_score, match_method, match_signals,
      status, decided_at
    ) values (
      'a1800000-0000-4000-8000-000000000001',
      'a1400000-0000-4000-8000-000000000001',
      'a1600000-0000-4000-8000-000000000001',
      0.9900, 'address_date_court',
      '{"address":true,"court":true,"hearing_date":true}'::jsonb,
      'auto_matched', now()
    )$$,
  'an automatic match is accepted when address is corroborated by non-address signals'
);

select lives_ok(
  $$insert into public.source_record_matches (
      source_record_id, case_id, match_score, match_method, match_signals,
      status, decided_at
    ) values (
      'a1400000-0000-4000-8000-000000000001',
      'a1600000-0000-4000-8000-000000000001',
      0.9900, 'parcel_and_date',
      '{"parcel":true,"mutation_date":true}'::jsonb,
      'auto_matched', now()
    )$$,
  'DVF-style parcel-and-date provenance has an explicit explainable match method'
);

select throws_ok(
  $$insert into public.source_record_matches (
      source_record_id, case_id, match_score, match_method, match_signals,
      status, decided_at
    ) values (
      'a1400000-0000-4000-8000-000000000001',
      'a1600000-0000-4000-8000-000000000001',
      0.9900, 'parcel_and_date', '{"parcel":true}'::jsonb,
      'auto_matched', now()
    )$$,
  '23514',
  'new row for relation "source_record_matches" violates check constraint "source_record_matches_method_signal_requirements_check"',
  'parcel-and-date cannot auto-match when its date signal is absent'
);

select throws_ok(
  $$insert into public.source_record_matches (
      source_record_id, case_id, lot_id, match_score, match_method,
      match_signals, status
    ) values (
      'a1400000-0000-4000-8000-000000000001',
      'a1600000-0000-4000-8000-000000000001',
      'a1610000-0000-4000-8000-000000000001',
      0.7000, 'parcel', '{"parcel":true}'::jsonb, 'review_required'
    )$$,
  '23514',
  'Match lot does not belong to the selected case.',
  'match targets must describe one coherent Outcome Graph hierarchy'
);

select lives_ok(
  $$insert into public.source_record_matches (
      source_record_id, case_id, match_score, match_method, match_signals, status
    ) values (
      'a1400000-0000-4000-8000-000000000001',
      'a1600000-0000-4000-8000-000000000001',
      0.1000, 'insufficient_signals', '{"exact_address":false}'::jsonb,
      'weak_candidate'
    )$$,
  'a weak DVF candidate remains reviewable without pretending it is a decision'
);

select lives_ok(
  $$select app_private.upsert_outcome_source_checkpoint(
      'a1000000-0000-4000-8000-000000000001',
      'history', null, '{"page":1}'::jsonb, '2026-07-29T00:00:00Z',
      'test-connector/1.0.0', 'a1200000-0000-4000-8000-000000000001'
    )$$,
  'the guarded checkpoint RPC creates a missing stream at revision one'
);

select is(
  (
    select revision from public.source_sync_checkpoints
    where source_id = 'a1000000-0000-4000-8000-000000000001'
      and stream_key = 'history'
  ),
  1::bigint,
  'checkpoint revision starts at one regardless of caller input'
);

select throws_ok(
  $$select app_private.upsert_outcome_source_checkpoint(
      'a1000000-0000-4000-8000-000000000001',
      'history', null, '{"page":99}'::jsonb, '2026-07-29T00:00:00Z',
      'test-connector/1.0.0', 'a1200000-0000-4000-8000-000000000001'
    )$$,
  '40001',
  'Source checkpoint already exists; expected revision required.',
  'checkpoint creation cannot silently overwrite an existing stream'
);

select lives_ok(
  $$select app_private.upsert_outcome_source_checkpoint(
      'a1000000-0000-4000-8000-000000000001',
      'history',
      1,
      '{"page":2}'::jsonb,
      '2026-07-30T00:00:00Z',
      'test-connector/1.0.1',
      'a1200000-0000-4000-8000-000000000002'
    )$$,
  'a worker advances a checkpoint by presenting its expected revision'
);

select is(
  (
    select revision from public.source_sync_checkpoints
    where source_id = 'a1000000-0000-4000-8000-000000000001'
      and stream_key = 'history'
  ),
  2::bigint,
  'checkpoint updates increment the server-managed revision'
);

select throws_ok(
  $$select app_private.upsert_outcome_source_checkpoint(
      'a1000000-0000-4000-8000-000000000001',
      'history', 1, '{"page":3}'::jsonb, '2026-07-31T00:00:00Z',
      'test-connector/1.0.2', 'a1200000-0000-4000-8000-000000000002'
    )$$,
  '40001',
  'Stale source checkpoint revision.',
  'a stale writer cannot overwrite a newer source cursor'
);

select throws_ok(
  $$select app_private.upsert_outcome_source_checkpoint(
      'a1000000-0000-4000-8000-000000000001',
      'history', 2, '{"page":3}'::jsonb, '2026-07-01T00:00:00Z',
      'test-connector/1.0.2', 'a1200000-0000-4000-8000-000000000002'
    )$$,
  '23514',
  'Source checkpoint watermark cannot move backwards.',
  'an incremental checkpoint cannot move its watermark backwards'
);

select throws_ok(
  $$insert into public.source_purge_events (source_id, event_type, reason_code)
    values (
      'a1000000-0000-4000-8000-000000000001',
      'deletion_requested', 'test_without_target'
    )$$,
  '23514',
  'new row for relation "source_purge_events" violates check constraint "source_purge_events_target_check"',
  'a purge event must identify at least one governed target'
);

select lives_ok(
  $$insert into public.source_purge_events (
      id, source_id, source_record_id, event_type, reason_code, request_reference
    ) values (
      'a1a00000-0000-4000-8000-000000000001',
      'a1000000-0000-4000-8000-000000000001',
      'a1400000-0000-4000-8000-000000000001',
      'deletion_requested', 'retention_test', 'test-request-1'
    )$$,
  'a governed deletion request is captured without deleting provenance rows'
);

select lives_ok(
  $$insert into public.source_purge_events (
      id, source_id, source_record_id, event_type, reason_code,
      request_reference, supersedes_event_id
    ) values (
      'a1a00000-0000-4000-8000-000000000002',
      'a1000000-0000-4000-8000-000000000001',
      'a1400000-0000-4000-8000-000000000001',
      'deletion_completed', 'retention_test', 'test-request-1',
      'a1a00000-0000-4000-8000-000000000001'
    )$$,
  'a purge completion may supersede an earlier event for the same target'
);

select throws_ok(
  $$insert into public.source_purge_events (
      source_id, external_record_id, event_type, reason_code,
      request_reference, supersedes_event_id
    ) values (
      'a1000000-0000-4000-8000-000000000001',
      'another-record', 'deletion_completed', 'retention_test',
      'test-request-2', 'a1a00000-0000-4000-8000-000000000002'
    )$$,
  '23514',
  'Superseding purge events must share a governed target.',
  'purge histories cannot jump between governed targets'
);

select lives_ok(
  $$insert into public.source_purge_events (
      source_id, external_record_id, event_type, reason_code, request_reference
    ) values (
      'a1000000-0000-4000-8000-000000000001',
      'remote-deletion-before-first-capture',
      'deletion_completed', 'upstream_tombstone', 'transactional-history-1'
    )$$,
  'an upstream tombstone can be recorded before its external ID was ever ingested'
);

insert into public.ingestion_jobs (
  id, source_id, job_kind, stream_key, idempotency_key, priority, max_attempts
) values (
  'a1700000-0000-4000-8000-000000000001',
  'a1000000-0000-4000-8000-000000000001',
  'judicial_history',
  'history',
  'history-2026-07-30',
  10,
  2
);

select throws_ok(
  $$insert into public.ingestion_jobs (
      source_id, job_kind, stream_key, idempotency_key
    ) values (
      'a1000000-0000-4000-8000-000000000001',
      'judicial_history', 'history', 'history-2026-07-30'
    )$$,
  '23505',
  'duplicate key value violates unique constraint "ingestion_jobs_source_id_job_kind_idempotency_key_key"',
  'the queue rejects a duplicate scheduler delivery'
);

select is(
  (
    select status
    from app_private.claim_outcome_ingestion_job(
      'pgtap-worker',
      300,
      'a1000000-0000-4000-8000-000000000001',
      'judicial_history'
    )
  ),
  'leased',
  'claiming atomically moves one ready job into leased state'
);

select ok(
  (
    select attempts = 1
      and lease_owner = 'pgtap-worker'
      and lease_expires_at > leased_at
    from public.ingestion_jobs
    where id = 'a1700000-0000-4000-8000-000000000001'
  ),
  'a claim records its worker, lease window, and bounded attempt count'
);

create temporary table pgtap_initial_ingestion_lease as
select lease_token
from public.ingestion_jobs
where id = 'a1700000-0000-4000-8000-000000000001';

reset role;

update public.ingestion_jobs
set
  leased_at = now() - interval '2 minutes',
  lease_expires_at = now() - interval '1 minute'
where id = 'a1700000-0000-4000-8000-000000000001';

set local role service_role;

select ok(
  (
    select status = 'leased'
      and attempts = 2
      and lease_owner = 'pgtap-worker-b'
      and lease_token <> (
        select lease_token from pgtap_initial_ingestion_lease
      )
    from app_private.claim_outcome_ingestion_job(
      'pgtap-worker-b',
      300,
      'a1000000-0000-4000-8000-000000000001',
      'judicial_history'
    )
  ),
  'an expired lease is reclaimed with a new generation token'
);

select throws_ok(
  $$select app_private.complete_outcome_ingestion_job(
      'a1700000-0000-4000-8000-000000000001',
      'pgtap-worker',
      (select lease_token from pgtap_initial_ingestion_lease)
    )$$,
  '55000',
  'Stale or expired ingestion job lease.',
  'an expired worker cannot complete a job after reassignment'
);

select lives_ok(
  $$select app_private.complete_outcome_ingestion_job(
      'a1700000-0000-4000-8000-000000000001',
      'pgtap-worker-b',
      (
        select lease_token from public.ingestion_jobs
        where id = 'a1700000-0000-4000-8000-000000000001'
      )
    )$$,
  'the current lease owner can move a job into a valid terminal state'
);

insert into public.ingestion_jobs (
  id, source_id, job_kind, stream_key, idempotency_key, max_attempts
) values (
  'a1700000-0000-4000-8000-000000000002',
  'a1000000-0000-4000-8000-000000000001',
  'judicial_retry_test',
  'history',
  'retry-lifecycle-2026-07-30',
  2
);

select is(
  (
    select status
    from app_private.claim_outcome_ingestion_job(
      'pgtap-retry-worker',
      300,
      'a1000000-0000-4000-8000-000000000001',
      'judicial_retry_test'
    )
  ),
  'leased',
  'a retry test job is leased for its first bounded attempt'
);

select is(
  (
    select status
    from app_private.fail_outcome_ingestion_job(
      'a1700000-0000-4000-8000-000000000002',
      'pgtap-retry-worker',
      (
        select lease_token from public.ingestion_jobs
        where id = 'a1700000-0000-4000-8000-000000000002'
      ),
      'TransientHttpError', 'http_503', 'Remote service unavailable.', 0
    )
  ),
  'retry_scheduled',
  'a failure before the retry budget is exhausted schedules another attempt'
);

select ok(
  (
    select status = 'leased' and attempts = 2
    from app_private.claim_outcome_ingestion_job(
      'pgtap-retry-worker',
      300,
      'a1000000-0000-4000-8000-000000000001',
      'judicial_retry_test'
    )
  ),
  'a scheduled retry can be reclaimed for its final bounded attempt'
);

select throws_ok(
  $$select app_private.fail_outcome_ingestion_job(
      'a1700000-0000-4000-8000-000000000002',
      'pgtap-retry-worker',
      (
        select lease_token from public.ingestion_jobs
        where id = 'a1700000-0000-4000-8000-000000000002'
      ),
      'TransientHttpError', 'http_503', 'Remote service unavailable.', null
    )$$,
  '22023',
  'Retry delay must be between 0 and 86400 seconds.',
  'a null retry delay is rejected instead of bypassing delay bounds'
);

select is(
  (
    select status
    from app_private.fail_outcome_ingestion_job(
      'a1700000-0000-4000-8000-000000000002',
      'pgtap-retry-worker',
      (
        select lease_token from public.ingestion_jobs
        where id = 'a1700000-0000-4000-8000-000000000002'
      ),
      'TransientHttpError', 'http_503', 'Remote service unavailable.', 0
    )
  ),
  'dead_lettered',
  'the final failed attempt enters the dead-letter state'
);

select ok(
  (
    select status = 'dead_lettered'
      and dead_lettered_at is not null
      and lease_owner is null
      and lease_token is null
      and last_error_code = 'http_503'
    from public.ingestion_jobs
    where id = 'a1700000-0000-4000-8000-000000000002'
  ),
  'dead-letter evidence is durable and no stale lease remains'
);

reset role;

select throws_ok(
  $$update public.ingestion_jobs
    set priority = 99
    where id = 'a1700000-0000-4000-8000-000000000001'$$,
  '55000',
  'Terminal ingestion jobs are immutable.',
  'terminal queue evidence cannot be rewritten'
);

select throws_ok(
  $$update public.artifact_extractions
    set quality_score = 0.1000
    where id = 'a1300000-0000-4000-8000-000000000001'$$,
  '55000',
  'public.artifact_extractions is append-only; insert a correcting version instead.',
  'extraction outputs cannot be rewritten'
);

select throws_ok(
  $$update public.source_purge_events
    set reason_code = 'tampered'
    where id = 'a1a00000-0000-4000-8000-000000000001'$$,
  '55000',
  'public.source_purge_events is append-only; insert a correcting version instead.',
  'purge evidence cannot be rewritten'
);

select * from finish();

rollback;
