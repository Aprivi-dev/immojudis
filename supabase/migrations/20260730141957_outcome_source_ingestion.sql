begin;

-- Trusted-only ingestion queue. Its idempotency key makes scheduler retries safe.
create table public.ingestion_jobs (
  id uuid primary key default gen_random_uuid(),
  source_id uuid not null references public.data_sources(id),
  job_kind text not null check (nullif(btrim(job_kind), '') is not null),
  stream_key text not null default 'default' check (nullif(btrim(stream_key), '') is not null),
  idempotency_key text not null check (
    nullif(btrim(idempotency_key), '') is not null
    and char_length(idempotency_key) <= 512
  ),
  payload jsonb not null default '{}'::jsonb check (jsonb_typeof(payload) = 'object'),
  priority smallint not null default 0 check (priority between -100 and 100),
  status text not null default 'pending' check (
    status in (
      'pending', 'leased', 'retry_scheduled', 'succeeded',
      'dead_lettered', 'cancelled'
    )
  ),
  available_at timestamptz not null default now(),
  lease_owner text,
  lease_token uuid,
  leased_at timestamptz,
  lease_expires_at timestamptz,
  attempts integer not null default 0 check (attempts >= 0),
  max_attempts integer not null default 5 check (max_attempts between 1 and 100),
  last_error_class text,
  last_error_code text,
  sanitized_error_message text,
  completed_at timestamptz,
  dead_lettered_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (source_id, job_kind, idempotency_key),
  constraint ingestion_jobs_attempts_within_budget_check check (attempts <= max_attempts),
  constraint ingestion_jobs_retry_budget_check check (
    status <> 'retry_scheduled' or attempts < max_attempts
  ),
  constraint ingestion_jobs_lease_check check (
    (
      status = 'leased'
      and nullif(btrim(lease_owner), '') is not null
      and lease_token is not null
      and leased_at is not null
      and lease_expires_at is not null
      and lease_expires_at > leased_at
    )
    or (
      status <> 'leased'
      and lease_owner is null
      and lease_token is null
      and leased_at is null
      and lease_expires_at is null
    )
  ),
  constraint ingestion_jobs_terminal_state_check check (
    (status = 'succeeded' and completed_at is not null and dead_lettered_at is null)
    or (status = 'dead_lettered' and completed_at is null and dead_lettered_at is not null)
    or (status = 'cancelled' and completed_at is not null and dead_lettered_at is null)
    or (status not in ('succeeded', 'dead_lettered', 'cancelled')
      and completed_at is null and dead_lettered_at is null)
  ),
  constraint ingestion_jobs_sanitized_error_check check (
    sanitized_error_message is null
    or (
      char_length(sanitized_error_message) <= 2000
      and position(chr(10) in sanitized_error_message) = 0
      and position(chr(13) in sanitized_error_message) = 0
      and sanitized_error_message !~* '(authorization|proxy-authorization|set-cookie|x-api-key|api[_-]?key|bearer[[:space:]]|keyid)'
    )
  )
);

create index ingestion_jobs_source_status_available_idx
  on public.ingestion_jobs(source_id, status, available_at, priority desc, created_at);
create index ingestion_jobs_claimable_idx
  on public.ingestion_jobs(priority desc, available_at, created_at)
  where status in ('pending', 'retry_scheduled', 'leased');
create index ingestion_jobs_expired_lease_idx
  on public.ingestion_jobs(lease_expires_at)
  where status = 'leased';

-- One immutable row per capture attempt (HTTP or reviewed local-file import).
-- A successful capture references the deduplicated raw_artifacts row, so
-- identical payloads remain distinct observations.
create table public.source_fetches (
  id uuid primary key default gen_random_uuid(),
  source_id uuid not null references public.data_sources(id),
  ingestion_job_id uuid references public.ingestion_jobs(id) on delete set null,
  raw_artifact_id uuid references public.raw_artifacts(id) on delete restrict,
  fetch_status text not null check (
    fetch_status in (
      'succeeded', 'imported_local', 'not_modified', 'failed',
      'rate_limited', 'blocked_by_policy'
    )
  ),
  capture_transport text not null default 'http' check (
    capture_transport in ('http', 'local_file')
  ),
  http_method text default 'GET' check (
    (capture_transport = 'http' and http_method is not null and http_method in ('GET', 'HEAD', 'POST'))
    or (capture_transport = 'local_file' and http_method is null)
  ),
  requested_url text not null check (
    nullif(btrim(requested_url), '') is not null
    and char_length(requested_url) <= 4096
  ),
  request_fingerprint text not null check (request_fingerprint ~ '^[0-9a-f]{64}$'),
  http_status integer check (http_status between 100 and 599),
  etag text,
  last_modified_at timestamptz,
  content_hash text check (content_hash is null or content_hash ~ '^[0-9a-f]{64}$'),
  byte_size bigint check (byte_size is null or byte_size >= 0),
  mime_type text,
  source_cursor jsonb not null default '{}'::jsonb check (
    jsonb_typeof(source_cursor) = 'object'
  ),
  connector_version text not null check (nullif(btrim(connector_version), '') is not null),
  error_class text,
  error_code text,
  sanitized_error_message text,
  started_at timestamptz not null,
  completed_at timestamptz not null,
  created_at timestamptz not null default now(),
  constraint source_fetches_dates_check check (completed_at >= started_at),
  constraint source_fetches_success_check check (
    fetch_status <> 'succeeded'
    or (
      capture_transport = 'http'
      and http_status is not null
      and http_status between 200 and 299
      and raw_artifact_id is not null
      and content_hash is not null
      and byte_size is not null
      and nullif(btrim(mime_type), '') is not null
    )
  ),
  constraint source_fetches_local_import_check check (
    fetch_status <> 'imported_local'
    or (
      capture_transport = 'local_file'
      and http_status is null
      and raw_artifact_id is not null
      and content_hash is not null
      and byte_size is not null
      and nullif(btrim(mime_type), '') is not null
    )
  ),
  constraint source_fetches_not_modified_check check (
    fetch_status <> 'not_modified'
    or (
      capture_transport = 'http'
      and
      http_status is not null
      and http_status = 304
      and raw_artifact_id is null
      and content_hash is null
      and byte_size is null
    )
  ),
  constraint source_fetches_rate_limited_check check (
    fetch_status <> 'rate_limited'
    or (capture_transport = 'http' and http_status is not null and http_status = 429)
  ),
  constraint source_fetches_artifact_status_check check (
    raw_artifact_id is null or fetch_status in ('succeeded', 'imported_local')
  ),
  constraint source_fetches_error_state_check check (
    (fetch_status in ('succeeded', 'imported_local', 'not_modified')
      and error_class is null and error_code is null and sanitized_error_message is null)
    or (fetch_status not in ('succeeded', 'imported_local', 'not_modified')
      and (http_status is not null or nullif(btrim(error_code), '') is not null))
  ),
  constraint source_fetches_sanitized_error_check check (
    sanitized_error_message is null
    or (
      char_length(sanitized_error_message) <= 2000
      and position(chr(10) in sanitized_error_message) = 0
      and position(chr(13) in sanitized_error_message) = 0
      and sanitized_error_message !~* '(authorization|proxy-authorization|set-cookie|x-api-key|api[_-]?key|bearer[[:space:]]|keyid)'
    )
  )
);

create index source_fetches_source_completed_idx
  on public.source_fetches(source_id, completed_at desc, created_at desc);
create index source_fetches_job_idx
  on public.source_fetches(ingestion_job_id)
  where ingestion_job_id is not null;
create index source_fetches_raw_artifact_idx
  on public.source_fetches(raw_artifact_id)
  where raw_artifact_id is not null;
create index source_fetches_request_fingerprint_idx
  on public.source_fetches(source_id, request_fingerprint, completed_at desc);

-- Immutable, versioned extractor output. A failed extraction carries no payload.
create table public.artifact_extractions (
  id uuid primary key default gen_random_uuid(),
  raw_artifact_id uuid not null references public.raw_artifacts(id) on delete restrict,
  source_fetch_id uuid references public.source_fetches(id) on delete set null,
  extractor_name text not null check (nullif(btrim(extractor_name), '') is not null),
  extractor_version text not null check (nullif(btrim(extractor_version), '') is not null),
  schema_version text not null check (nullif(btrim(schema_version), '') is not null),
  run_number integer not null default 1 check (run_number >= 1),
  extraction_status text not null check (
    extraction_status in ('succeeded', 'partial', 'failed')
  ),
  extracted_data jsonb,
  field_provenance jsonb not null default '{}'::jsonb check (
    jsonb_typeof(field_provenance) = 'object'
  ),
  output_hash text check (output_hash is null or output_hash ~ '^[0-9a-f]{64}$'),
  quality_score numeric(5,4) check (quality_score is null or quality_score between 0 and 1),
  error_code text,
  sanitized_error_message text,
  extracted_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (raw_artifact_id, extractor_name, extractor_version, schema_version, run_number),
  constraint artifact_extractions_payload_check check (
    (extraction_status = 'failed' and extracted_data is null and output_hash is null)
    or (
      extraction_status in ('succeeded', 'partial')
      and extracted_data is not null
      and jsonb_typeof(extracted_data) = 'object'
      and output_hash is not null
    )
  ),
  constraint artifact_extractions_error_check check (
    (extraction_status = 'failed' and nullif(btrim(error_code), '') is not null)
    or (extraction_status <> 'failed' and error_code is null and sanitized_error_message is null)
  ),
  constraint artifact_extractions_sanitized_error_check check (
    sanitized_error_message is null
    or (
      char_length(sanitized_error_message) <= 2000
      and position(chr(10) in sanitized_error_message) = 0
      and position(chr(13) in sanitized_error_message) = 0
      and sanitized_error_message !~* '(authorization|proxy-authorization|set-cookie|x-api-key|api[_-]?key|bearer[[:space:]]|keyid)'
    )
  )
);

create index artifact_extractions_fetch_idx
  on public.artifact_extractions(source_fetch_id)
  where source_fetch_id is not null;

-- Mutable server-side cursor with monotone watermark and DB-managed revision.
create table public.source_sync_checkpoints (
  id uuid primary key default gen_random_uuid(),
  source_id uuid not null references public.data_sources(id),
  stream_key text not null default 'default' check (nullif(btrim(stream_key), '') is not null),
  source_cursor jsonb not null default '{}'::jsonb check (
    jsonb_typeof(source_cursor) = 'object'
  ),
  watermark_at timestamptz,
  connector_version text not null check (nullif(btrim(connector_version), '') is not null),
  last_successful_fetch_id uuid references public.source_fetches(id) on delete set null,
  revision bigint not null default 1 check (revision >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (source_id, stream_key)
);

create index source_sync_checkpoints_fetch_idx
  on public.source_sync_checkpoints(last_successful_fetch_id)
  where last_successful_fetch_id is not null;

-- Immutable source-record versions. They are candidates only until explicit
-- downstream eligibility and matching rules are satisfied. Content hashes may
-- recur non-consecutively (A -> B -> A); record_version is the identity while
-- the worker's locked latest-row comparison deduplicates consecutive captures.
create table public.judicial_source_records (
  id uuid primary key default gen_random_uuid(),
  source_id uuid not null references public.data_sources(id),
  source_fetch_id uuid references public.source_fetches(id) on delete restrict,
  raw_artifact_id uuid references public.raw_artifacts(id) on delete restrict,
  artifact_extraction_id uuid references public.artifact_extractions(id) on delete restrict,
  record_kind text not null check (
    record_kind in (
      'judicial_decision_candidate', 'auction_notice_candidate',
      'auction_hearing_candidate', 'auction_result_candidate',
      'court_reference_candidate', 'territorial_jurisdiction',
      'sale_reference_candidate', 'other_candidate'
    )
  ),
  external_record_id text not null check (
    nullif(btrim(external_record_id), '') is not null
    and char_length(external_record_id) <= 1024
  ),
  record_version integer not null default 1 check (record_version >= 1),
  decision_date date,
  source_updated_at timestamptz,
  published_at timestamptz,
  canonical_url text check (canonical_url is null or char_length(canonical_url) <= 4096),
  normalized_data jsonb not null check (jsonb_typeof(normalized_data) = 'object'),
  content_hash text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  connector_version text not null check (nullif(btrim(connector_version), '') is not null),
  training_eligible boolean not null default false,
  training_eligibility_reason text not null default 'unreviewed_source_record',
  supersedes_record_id uuid references public.judicial_source_records(id) on delete restrict,
  created_at timestamptz not null default now(),
  unique (source_id, external_record_id, record_version),
  constraint judicial_source_records_provenance_check check (
    raw_artifact_id is not null or artifact_extraction_id is not null
  ),
  constraint judicial_source_records_version_check check (
    (record_version = 1 and supersedes_record_id is null)
    or (record_version > 1 and supersedes_record_id is not null)
  ),
  constraint judicial_source_records_no_self_supersession_check check (
    supersedes_record_id is null or supersedes_record_id <> id
  ),
  constraint judicial_source_records_training_reason_check check (
    training_eligible or nullif(btrim(training_eligibility_reason), '') is not null
  ),
  constraint judicial_source_records_candidates_only_check check (
    not training_eligible
  )
);

create index judicial_source_records_fetch_idx
  on public.judicial_source_records(source_fetch_id)
  where source_fetch_id is not null;
create index judicial_source_records_raw_artifact_idx
  on public.judicial_source_records(raw_artifact_id)
  where raw_artifact_id is not null;
create index judicial_source_records_extraction_idx
  on public.judicial_source_records(artifact_extraction_id)
  where artifact_extraction_id is not null;
create index judicial_source_records_supersedes_idx
  on public.judicial_source_records(supersedes_record_id)
  where supersedes_record_id is not null;
create index judicial_source_records_kind_dates_idx
  on public.judicial_source_records(record_kind, decision_date desc, published_at desc);

-- Matching decisions are also immutable: reviews insert a superseding row.
create table public.source_record_matches (
  id uuid primary key default gen_random_uuid(),
  source_record_id uuid not null references public.judicial_source_records(id) on delete restrict,
  case_id uuid references public.auction_cases(id) on delete restrict,
  lot_id uuid references public.auction_lots(id) on delete restrict,
  round_id uuid references public.auction_rounds(id) on delete restrict,
  outcome_id uuid references public.auction_outcomes(id) on delete restrict,
  match_score numeric(5,4) not null check (match_score between 0 and 1),
  match_method text not null check (
    match_method in (
      'exact_external_id', 'exact_case_number', 'exact_portalis_number',
      'parcel_and_date', 'parcel', 'address_and_date', 'court_name_address',
      'address_date_court', 'address_only', 'insufficient_signals',
      'composite', 'manual'
    )
  ),
  match_signals jsonb not null default '{}'::jsonb check (
    jsonb_typeof(match_signals) = 'object'
  ),
  status text not null default 'candidate' check (
    status in (
      'candidate', 'weak_candidate', 'review_required', 'strong_candidate',
      'auto_matched', 'confirmed', 'rejected', 'superseded'
    )
  ),
  reviewer_user_id uuid,
  decision_notes text,
  decided_at timestamptz,
  supersedes_match_id uuid references public.source_record_matches(id) on delete restrict,
  created_at timestamptz not null default now(),
  constraint source_record_matches_target_check check (
    case_id is not null or lot_id is not null or round_id is not null or outcome_id is not null
  ),
  constraint source_record_matches_decision_check check (
    (status in ('candidate', 'weak_candidate', 'review_required', 'strong_candidate')
      and decided_at is null)
    or (status not in ('candidate', 'weak_candidate', 'review_required', 'strong_candidate')
      and decided_at is not null)
  ),
  constraint source_record_matches_auto_score_check check (
    status <> 'auto_matched' or match_score >= 0.9000
  ),
  constraint source_record_matches_auto_non_address_signal_check check (
    status <> 'auto_matched'
    or (
      match_method not in ('address_only', 'manual', 'insufficient_signals')
      and (
        match_signals @> '{"case_number": true}'::jsonb
        or match_signals @> '{"portalis_number": true}'::jsonb
        or match_signals @> '{"court": true}'::jsonb
        or match_signals @> '{"hearing_date": true}'::jsonb
        or match_signals @> '{"lot_number": true}'::jsonb
        or match_signals @> '{"external_id": true}'::jsonb
        or match_signals @> '{"parcel": true}'::jsonb
        or match_signals @> '{"mutation_date": true}'::jsonb
        or match_signals @> '{"event_date": true}'::jsonb
      )
    )
  ),
  constraint source_record_matches_method_signal_requirements_check check (
    status <> 'auto_matched'
    or case match_method
      when 'exact_external_id' then match_signals @> '{"external_id": true}'::jsonb
      when 'exact_case_number' then match_signals @> '{"case_number": true}'::jsonb
      when 'exact_portalis_number' then match_signals @> '{"portalis_number": true}'::jsonb
      when 'parcel_and_date' then
        match_signals @> '{"parcel": true}'::jsonb
        and (
          match_signals @> '{"mutation_date": true}'::jsonb
          or match_signals @> '{"event_date": true}'::jsonb
          or match_signals @> '{"hearing_date": true}'::jsonb
        )
      when 'parcel' then match_signals @> '{"parcel": true}'::jsonb
      when 'address_and_date' then
        match_signals @> '{"address": true}'::jsonb
        and (
          match_signals @> '{"mutation_date": true}'::jsonb
          or match_signals @> '{"event_date": true}'::jsonb
          or match_signals @> '{"hearing_date": true}'::jsonb
        )
      when 'court_name_address' then
        match_signals @> '{"court": true}'::jsonb
        and match_signals @> '{"address": true}'::jsonb
      when 'address_date_court' then
        match_signals @> '{"address": true}'::jsonb
        and match_signals @> '{"court": true}'::jsonb
        and (
          match_signals @> '{"mutation_date": true}'::jsonb
          or match_signals @> '{"event_date": true}'::jsonb
          or match_signals @> '{"hearing_date": true}'::jsonb
        )
      when 'composite' then
        (
          case when match_signals @> '{"address": true}'::jsonb then 1 else 0 end
          + case when match_signals @> '{"case_number": true}'::jsonb then 1 else 0 end
          + case when match_signals @> '{"portalis_number": true}'::jsonb then 1 else 0 end
          + case when match_signals @> '{"court": true}'::jsonb then 1 else 0 end
          + case when match_signals @> '{"hearing_date": true}'::jsonb then 1 else 0 end
          + case when match_signals @> '{"lot_number": true}'::jsonb then 1 else 0 end
          + case when match_signals @> '{"external_id": true}'::jsonb then 1 else 0 end
          + case when match_signals @> '{"parcel": true}'::jsonb then 1 else 0 end
          + case when match_signals @> '{"mutation_date": true}'::jsonb then 1 else 0 end
          + case when match_signals @> '{"event_date": true}'::jsonb then 1 else 0 end
        ) >= 2
      else false
    end
  ),
  constraint source_record_matches_rejection_reason_check check (
    status <> 'rejected' or nullif(btrim(decision_notes), '') is not null
  ),
  constraint source_record_matches_no_self_supersession_check check (
    supersedes_match_id is null or supersedes_match_id <> id
  )
);

create index source_record_matches_record_created_idx
  on public.source_record_matches(source_record_id, created_at desc);
create index source_record_matches_case_idx
  on public.source_record_matches(case_id) where case_id is not null;
create index source_record_matches_lot_idx
  on public.source_record_matches(lot_id) where lot_id is not null;
create index source_record_matches_round_idx
  on public.source_record_matches(round_id) where round_id is not null;
create index source_record_matches_outcome_idx
  on public.source_record_matches(outcome_id) where outcome_id is not null;
create unique index source_record_matches_one_successor_idx
  on public.source_record_matches(supersedes_match_id)
  where supersedes_match_id is not null;

-- Logical deletion/redaction/purge ledger. Physical deletion is performed by a
-- separate privileged retention workflow and is always evidenced here.
create table public.source_purge_events (
  id uuid primary key default gen_random_uuid(),
  source_id uuid not null references public.data_sources(id),
  external_record_id text check (
    external_record_id is null
    or (
      nullif(btrim(external_record_id), '') is not null
      and char_length(external_record_id) <= 1024
    )
  ),
  source_fetch_id uuid references public.source_fetches(id) on delete restrict,
  raw_artifact_id uuid references public.raw_artifacts(id) on delete restrict,
  source_record_id uuid references public.judicial_source_records(id) on delete restrict,
  event_type text not null check (
    event_type in (
      'deletion_requested', 'deletion_completed', 'redaction_requested',
      'redaction_completed', 'retention_expired', 'legal_hold_applied',
      'legal_hold_released', 'purge_failed'
    )
  ),
  reason_code text not null check (nullif(btrim(reason_code), '') is not null),
  request_reference text,
  actor_user_id uuid,
  storage_object_path text,
  evidence_hash text check (evidence_hash is null or evidence_hash ~ '^[0-9a-f]{64}$'),
  details jsonb not null default '{}'::jsonb check (jsonb_typeof(details) = 'object'),
  event_at timestamptz not null default now(),
  supersedes_event_id uuid references public.source_purge_events(id) on delete restrict,
  created_at timestamptz not null default now(),
  constraint source_purge_events_target_check check (
    external_record_id is not null
    or source_fetch_id is not null
    or raw_artifact_id is not null
    or source_record_id is not null
  ),
  constraint source_purge_events_no_self_supersession_check check (
    supersedes_event_id is null or supersedes_event_id <> id
  )
);

create index source_purge_events_source_event_idx
  on public.source_purge_events(source_id, event_at desc);
create index source_purge_events_external_record_idx
  on public.source_purge_events(source_id, external_record_id, event_at desc)
  where external_record_id is not null;
create index source_purge_events_fetch_idx
  on public.source_purge_events(source_fetch_id) where source_fetch_id is not null;
create index source_purge_events_artifact_idx
  on public.source_purge_events(raw_artifact_id) where raw_artifact_id is not null;
create index source_purge_events_record_idx
  on public.source_purge_events(source_record_id) where source_record_id is not null;
create unique index source_purge_events_one_successor_idx
  on public.source_purge_events(supersedes_event_id) where supersedes_event_id is not null;

create or replace function app_private.guard_ingestion_job_mutation()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  source_policy public.data_sources%rowtype;
begin
  if tg_op = 'INSERT' then
    select source.* into source_policy
    from public.data_sources source
    where source.id = new.source_id;

    if not found
      or (
        new.job_kind <> 'source.purge'
        and (
          not source_policy.active
          or source_policy.legal_review_status <> 'approved'
          or source_policy.ingestion_policy <> 'allowed_automated'
        )
      ) then
      raise exception using errcode = '23514', message = 'Ingestion jobs require an active source approved for automation.';
    end if;
    if new.status <> 'pending' or new.attempts <> 0 then
      raise exception using errcode = '23514', message = 'Ingestion jobs must enter the queue as unattempted pending work.';
    end if;
    new.created_at := now();
    new.updated_at := now();
    return new;
  end if;

  if tg_op = 'DELETE' then
    raise exception using errcode = '55000', message = 'Ingestion jobs cannot be deleted.';
  end if;

  if old.status in ('succeeded', 'dead_lettered', 'cancelled')
    and (to_jsonb(new) - 'updated_at') <> (to_jsonb(old) - 'updated_at') then
    raise exception using errcode = '55000', message = 'Terminal ingestion jobs are immutable.';
  end if;

  if new.source_id is distinct from old.source_id
    or new.job_kind is distinct from old.job_kind
    or new.stream_key is distinct from old.stream_key
    or new.idempotency_key is distinct from old.idempotency_key
    or new.payload is distinct from old.payload
    or new.max_attempts is distinct from old.max_attempts
    or new.created_at is distinct from old.created_at then
    raise exception using errcode = '55000', message = 'Ingestion job identity and payload are immutable.';
  end if;

  if not (
    old.status = new.status
    or (old.status in ('pending', 'retry_scheduled') and new.status in ('leased', 'cancelled'))
    or (old.status = 'leased' and new.status in ('retry_scheduled', 'succeeded', 'dead_lettered', 'cancelled'))
  ) then
    raise exception using errcode = '23514', message = 'Invalid ingestion job status transition.';
  end if;

  if new.attempts < old.attempts
    or new.attempts > old.attempts + 1
    or (new.attempts = old.attempts + 1 and new.status <> 'leased') then
    raise exception using errcode = '23514', message = 'Invalid ingestion job attempt transition.';
  end if;

  new.updated_at := now();
  return new;
end;
$$;

create or replace function app_private.validate_source_fetch_insert()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  artifact_row public.raw_artifacts%rowtype;
  job_source_id uuid;
  source_policy public.data_sources%rowtype;
begin
  select source.* into source_policy
  from public.data_sources source
  where source.id = new.source_id;

  if new.fetch_status <> 'blocked_by_policy' and (
    not found
    or not source_policy.active
    or source_policy.legal_review_status <> 'approved'
    or source_policy.ingestion_policy not in ('allowed_automated', 'allowed_manual')
  ) then
    raise exception using errcode = '23514', message = 'Fetches require an active source with an approved ingestion policy.';
  end if;

  if new.ingestion_job_id is not null then
    select job.source_id into job_source_id
    from public.ingestion_jobs job
    where job.id = new.ingestion_job_id;

    if job_source_id is not null and job_source_id <> new.source_id then
      raise exception using errcode = '23514', message = 'Fetch source must match its ingestion job source.';
    end if;
  end if;

  if new.raw_artifact_id is not null then
    select artifact.* into artifact_row
    from public.raw_artifacts artifact
    where artifact.id = new.raw_artifact_id;

    if found and (
      artifact_row.source_id <> new.source_id
      or artifact_row.content_hash <> new.content_hash
      or artifact_row.byte_size <> new.byte_size
      or artifact_row.mime_type <> new.mime_type
    ) then
      raise exception using errcode = '23514', message = 'Fetch artifact provenance does not match the capture metadata.';
    end if;
  end if;

  return new;
end;
$$;

create or replace function app_private.validate_artifact_extraction_insert()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  fetch_found boolean := false;
  fetch_artifact_id uuid;
begin
  if new.source_fetch_id is not null then
    select sf.raw_artifact_id into fetch_artifact_id
    from public.source_fetches sf
    where sf.id = new.source_fetch_id;

    fetch_found := found;
    if fetch_found and fetch_artifact_id is distinct from new.raw_artifact_id then
      raise exception using errcode = '23514', message = 'Extraction fetch must reference the same raw artifact.';
    end if;
  end if;
  return new;
end;
$$;

create or replace function app_private.guard_source_sync_checkpoint()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  fetch_source_id uuid;
  fetch_status_value text;
begin
  if tg_op = 'DELETE' then
    raise exception using errcode = '55000', message = 'Source sync checkpoints cannot be deleted.';
  end if;

  if tg_op = 'INSERT' then
    new.revision := 1;
    new.created_at := now();
    new.updated_at := now();
  elsif tg_op = 'UPDATE' then
    if new.source_id is distinct from old.source_id
      or new.stream_key is distinct from old.stream_key
      or new.created_at is distinct from old.created_at then
      raise exception using errcode = '55000', message = 'Source checkpoint identity is immutable.';
    end if;
    if old.watermark_at is not null
      and (new.watermark_at is null or new.watermark_at < old.watermark_at) then
      raise exception using errcode = '23514', message = 'Source checkpoint watermark cannot move backwards.';
    end if;
    new.revision := old.revision + 1;
    new.updated_at := now();
  end if;

  if new.last_successful_fetch_id is not null then
    select sf.source_id, sf.fetch_status into fetch_source_id, fetch_status_value
    from public.source_fetches sf
    where sf.id = new.last_successful_fetch_id;

    if fetch_source_id is not null and (
      fetch_source_id <> new.source_id
      or fetch_status_value not in ('succeeded', 'imported_local', 'not_modified')
    ) then
      raise exception using errcode = '23514', message = 'Checkpoint fetch must be a successful fetch for the same source.';
    end if;
  end if;

  return new;
end;
$$;

create or replace function app_private.validate_judicial_source_record_insert()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  fetch_source_id uuid;
  fetch_artifact_id uuid;
  artifact_source_id uuid;
  extraction_artifact_id uuid;
  extraction_source_id uuid;
  prior_record public.judicial_source_records%rowtype;
begin
  if new.source_fetch_id is not null then
    select sf.source_id, sf.raw_artifact_id into fetch_source_id, fetch_artifact_id
    from public.source_fetches sf where sf.id = new.source_fetch_id;
    if fetch_source_id is not null and fetch_source_id <> new.source_id then
      raise exception using errcode = '23514', message = 'Source record fetch belongs to another source.';
    end if;
    if new.raw_artifact_id is not null
      and fetch_artifact_id is distinct from new.raw_artifact_id then
      raise exception using errcode = '23514', message = 'Source record fetch and artifact do not match.';
    end if;
  end if;

  if new.raw_artifact_id is not null then
    select artifact.source_id into artifact_source_id
    from public.raw_artifacts artifact where artifact.id = new.raw_artifact_id;
    if artifact_source_id is not null and artifact_source_id <> new.source_id then
      raise exception using errcode = '23514', message = 'Source record artifact belongs to another source.';
    end if;
  end if;

  if new.artifact_extraction_id is not null then
    select extraction.raw_artifact_id, artifact.source_id
    into extraction_artifact_id, extraction_source_id
    from public.artifact_extractions extraction
    join public.raw_artifacts artifact on artifact.id = extraction.raw_artifact_id
    where extraction.id = new.artifact_extraction_id;
    if extraction_source_id is not null and extraction_source_id <> new.source_id then
      raise exception using errcode = '23514', message = 'Source record extraction belongs to another source.';
    end if;
    if new.raw_artifact_id is not null
      and extraction_artifact_id is not null
      and extraction_artifact_id <> new.raw_artifact_id then
      raise exception using errcode = '23514', message = 'Source record extraction and artifact do not match.';
    end if;
    if new.source_fetch_id is not null
      and fetch_artifact_id is distinct from extraction_artifact_id then
      raise exception using errcode = '23514', message = 'Source record fetch and extraction do not match.';
    end if;
  end if;

  if new.supersedes_record_id is not null then
    select prior.* into prior_record
    from public.judicial_source_records prior
    where prior.id = new.supersedes_record_id;

    if found and (
      prior_record.source_id <> new.source_id
      or prior_record.external_record_id <> new.external_record_id
      or prior_record.record_version + 1 <> new.record_version
    ) then
      raise exception using errcode = '23514', message = 'Superseding source records must form one contiguous external-record history.';
    end if;
  end if;

  return new;
end;
$$;

create or replace function app_private.validate_source_record_match_insert()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  prior_source_record_id uuid;
  target_case_id uuid;
  target_lot_id uuid;
  target_round_id uuid;
begin
  if new.lot_id is not null then
    select lot.auction_case_id into target_case_id
    from public.auction_lots lot
    where lot.id = new.lot_id;
    if new.case_id is not null and target_case_id is distinct from new.case_id then
      raise exception using errcode = '23514', message = 'Match lot does not belong to the selected case.';
    end if;
  end if;

  if new.round_id is not null then
    select round_row.lot_id, lot.auction_case_id into target_lot_id, target_case_id
    from public.auction_rounds round_row
    join public.auction_lots lot on lot.id = round_row.lot_id
    where round_row.id = new.round_id;
    if new.lot_id is not null and target_lot_id is distinct from new.lot_id then
      raise exception using errcode = '23514', message = 'Match round does not belong to the selected lot.';
    end if;
    if new.case_id is not null and target_case_id is distinct from new.case_id then
      raise exception using errcode = '23514', message = 'Match round does not belong to the selected case.';
    end if;
  end if;

  if new.outcome_id is not null then
    select outcome.round_id, round_row.lot_id, lot.auction_case_id
    into target_round_id, target_lot_id, target_case_id
    from public.auction_outcomes outcome
    join public.auction_rounds round_row on round_row.id = outcome.round_id
    join public.auction_lots lot on lot.id = round_row.lot_id
    where outcome.id = new.outcome_id;
    if new.round_id is not null and target_round_id is distinct from new.round_id then
      raise exception using errcode = '23514', message = 'Match outcome does not belong to the selected round.';
    end if;
    if new.lot_id is not null and target_lot_id is distinct from new.lot_id then
      raise exception using errcode = '23514', message = 'Match outcome does not belong to the selected lot.';
    end if;
    if new.case_id is not null and target_case_id is distinct from new.case_id then
      raise exception using errcode = '23514', message = 'Match outcome does not belong to the selected case.';
    end if;
  end if;

  if new.supersedes_match_id is not null then
    select prior.source_record_id into prior_source_record_id
    from public.source_record_matches prior
    where prior.id = new.supersedes_match_id;
    if prior_source_record_id is not null and prior_source_record_id <> new.source_record_id then
      raise exception using errcode = '23514', message = 'A match decision may only supersede a match for the same source record.';
    end if;
  end if;
  return new;
end;
$$;

create or replace function app_private.validate_source_purge_event_insert()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  target_source_id uuid;
  prior_event public.source_purge_events%rowtype;
begin
  if new.source_fetch_id is not null then
    select sf.source_id into target_source_id
    from public.source_fetches sf where sf.id = new.source_fetch_id;
    if target_source_id is not null and target_source_id <> new.source_id then
      raise exception using errcode = '23514', message = 'Purge target fetch belongs to another source.';
    end if;
  end if;
  if new.raw_artifact_id is not null then
    select artifact.source_id into target_source_id
    from public.raw_artifacts artifact where artifact.id = new.raw_artifact_id;
    if target_source_id is not null and target_source_id <> new.source_id then
      raise exception using errcode = '23514', message = 'Purge target artifact belongs to another source.';
    end if;
  end if;
  if new.source_record_id is not null then
    select record.source_id into target_source_id
    from public.judicial_source_records record where record.id = new.source_record_id;
    if target_source_id is not null and target_source_id <> new.source_id then
      raise exception using errcode = '23514', message = 'Purge target record belongs to another source.';
    end if;
  end if;
  if new.supersedes_event_id is not null then
    select prior.* into prior_event
    from public.source_purge_events prior
    where prior.id = new.supersedes_event_id;

    if found and prior_event.source_id <> new.source_id then
      raise exception using errcode = '23514', message = 'A purge event may only supersede an event from the same source.';
    end if;
    if found and not (
      (prior_event.external_record_id is not null
        and new.external_record_id is not null
        and prior_event.external_record_id = new.external_record_id)
      or (prior_event.source_fetch_id is not null
        and new.source_fetch_id is not null
        and prior_event.source_fetch_id = new.source_fetch_id)
      or (prior_event.raw_artifact_id is not null
        and new.raw_artifact_id is not null
        and prior_event.raw_artifact_id = new.raw_artifact_id)
      or (prior_event.source_record_id is not null
        and new.source_record_id is not null
        and prior_event.source_record_id = new.source_record_id)
    ) then
      raise exception using errcode = '23514', message = 'Superseding purge events must share a governed target.';
    end if;
  end if;
  return new;
end;
$$;

-- Atomic worker claim. Expired final leases are dead-lettered before a new row
-- is selected; SKIP LOCKED lets multiple workers claim without blocking.
create or replace function app_private.claim_outcome_ingestion_job(
  p_worker_id text,
  p_lease_seconds integer default 300,
  p_source_id uuid default null,
  p_job_kind text default null
)
returns setof public.ingestion_jobs
language plpgsql
security definer
set search_path = ''
as $$
declare
  claimed_job public.ingestion_jobs%rowtype;
begin
  if session_user not in ('postgres', 'service_role')
    and coalesce(current_setting('role', true), '') <> 'service_role'
    and coalesce(current_setting('request.jwt.claim.role', true), '') <> 'service_role'
    and coalesce(
      nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
      ''
    ) <> 'service_role' then
    raise exception using errcode = '42501', message = 'Only the trusted ingestion worker may claim jobs.';
  end if;
  if nullif(btrim(p_worker_id), '') is null or char_length(p_worker_id) > 200 then
    raise exception using errcode = '22023', message = 'A bounded worker identifier is required.';
  end if;
  if p_lease_seconds is null or p_lease_seconds < 30 or p_lease_seconds > 3600 then
    raise exception using errcode = '22023', message = 'Lease duration must be between 30 and 3600 seconds.';
  end if;

  with expired_final as (
    select job.id
    from public.ingestion_jobs job
    where job.status = 'leased'
      and job.lease_expires_at <= now()
      and job.attempts >= job.max_attempts
    order by job.lease_expires_at, job.id
    for update of job skip locked
    limit 100
  )
  update public.ingestion_jobs job
  set
    status = 'dead_lettered',
    lease_owner = null,
    lease_token = null,
    leased_at = null,
    lease_expires_at = null,
    last_error_class = coalesce(job.last_error_class, 'LeaseExpired'),
    last_error_code = coalesce(job.last_error_code, 'lease_expired_after_final_attempt'),
    sanitized_error_message = coalesce(job.sanitized_error_message, 'Final worker lease expired.'),
    dead_lettered_at = now()
  from expired_final
  where job.id = expired_final.id;

  with candidate as (
    select job.id
    from public.ingestion_jobs job
    join public.data_sources source on source.id = job.source_id
    where (
      (job.status in ('pending', 'retry_scheduled') and job.available_at <= now())
      or (job.status = 'leased' and job.lease_expires_at <= now())
    )
      and job.attempts < job.max_attempts
      and (
        job.job_kind = 'source.purge'
        or (
          source.active
          and source.legal_review_status = 'approved'
          and source.ingestion_policy = 'allowed_automated'
        )
      )
      and (p_source_id is null or job.source_id = p_source_id)
      and (p_job_kind is null or job.job_kind = p_job_kind)
    order by job.priority desc, job.available_at, job.created_at, job.id
    for update of job skip locked
    limit 1
  )
  update public.ingestion_jobs job
  set
    status = 'leased',
    lease_owner = p_worker_id,
    lease_token = gen_random_uuid(),
    leased_at = now(),
    lease_expires_at = now() + (p_lease_seconds * interval '1 second'),
    attempts = job.attempts + 1
  from candidate
  where job.id = candidate.id
  returning job.* into claimed_job;

  if found then
    return next claimed_job;
  end if;
  return;
end;
$$;

create or replace function app_private.upsert_outcome_source_checkpoint(
  p_source_id uuid,
  p_stream_key text,
  p_expected_revision bigint,
  p_source_cursor jsonb,
  p_watermark_at timestamptz,
  p_connector_version text,
  p_last_successful_fetch_id uuid default null
)
returns public.source_sync_checkpoints
language plpgsql
security definer
set search_path = ''
as $$
declare
  advanced_checkpoint public.source_sync_checkpoints%rowtype;
  source_policy public.data_sources%rowtype;
begin
  if session_user not in ('postgres', 'service_role')
    and coalesce(current_setting('role', true), '') <> 'service_role'
    and coalesce(current_setting('request.jwt.claim.role', true), '') <> 'service_role'
    and coalesce(
      nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
      ''
    ) <> 'service_role' then
    raise exception using errcode = '42501', message = 'Only the trusted ingestion worker may advance checkpoints.';
  end if;
  if p_source_id is null
    or nullif(btrim(p_stream_key), '') is null
    or (p_expected_revision is not null and p_expected_revision < 1)
    or p_source_cursor is null or jsonb_typeof(p_source_cursor) <> 'object'
    or nullif(btrim(p_connector_version), '') is null then
    raise exception using errcode = '22023', message = 'A source, stream, expected revision, cursor and connector version are required.';
  end if;

  -- Hold a shared row lock until commit so the source cannot be disabled or
  -- lose legal approval between this policy check and the cursor mutation.
  select source.* into source_policy
  from public.data_sources source
  where source.id = p_source_id
  for share;

  if not found
    or not source_policy.active
    or source_policy.legal_review_status <> 'approved'
    or source_policy.ingestion_policy <> 'allowed_automated' then
    raise exception using errcode = '23514', message = 'Checkpoints require an active source approved for automated ingestion.';
  end if;

  if p_expected_revision is null then
    insert into public.source_sync_checkpoints (
      source_id,
      stream_key,
      source_cursor,
      watermark_at,
      connector_version,
      last_successful_fetch_id
    ) values (
      p_source_id,
      p_stream_key,
      p_source_cursor,
      p_watermark_at,
      p_connector_version,
      p_last_successful_fetch_id
    )
    on conflict (source_id, stream_key) do nothing
    returning * into advanced_checkpoint;

    if not found then
      raise exception using
        errcode = '40001',
        message = 'Source checkpoint already exists; expected revision required.';
    end if;
  else
    update public.source_sync_checkpoints checkpoint
    set
      source_cursor = p_source_cursor,
      watermark_at = p_watermark_at,
      connector_version = p_connector_version,
      last_successful_fetch_id = p_last_successful_fetch_id
    where checkpoint.source_id = p_source_id
      and checkpoint.stream_key = p_stream_key
      and checkpoint.revision = p_expected_revision
    returning checkpoint.* into advanced_checkpoint;

    if not found then
      raise exception using errcode = '40001', message = 'Stale source checkpoint revision.';
    end if;
  end if;
  return advanced_checkpoint;
end;
$$;

create or replace function app_private.complete_outcome_ingestion_job(
  p_job_id uuid,
  p_worker_id text,
  p_lease_token uuid
)
returns public.ingestion_jobs
language plpgsql
security definer
set search_path = ''
as $$
declare
  completed_job public.ingestion_jobs%rowtype;
begin
  if session_user not in ('postgres', 'service_role')
    and coalesce(current_setting('role', true), '') <> 'service_role'
    and coalesce(current_setting('request.jwt.claim.role', true), '') <> 'service_role'
    and coalesce(
      nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
      ''
    ) <> 'service_role' then
    raise exception using errcode = '42501', message = 'Only the trusted ingestion worker may complete jobs.';
  end if;
  if nullif(btrim(p_worker_id), '') is null or char_length(p_worker_id) > 200
    or p_job_id is null or p_lease_token is null then
    raise exception using errcode = '22023', message = 'Job, worker and lease token are required.';
  end if;

  update public.ingestion_jobs job
  set
    status = 'succeeded',
    lease_owner = null,
    lease_token = null,
    leased_at = null,
    lease_expires_at = null,
    completed_at = now()
  where job.id = p_job_id
    and job.status = 'leased'
    and job.lease_owner = p_worker_id
    and job.lease_token = p_lease_token
    and job.lease_expires_at > now()
  returning job.* into completed_job;

  if not found then
    raise exception using errcode = '55000', message = 'Stale or expired ingestion job lease.';
  end if;
  return completed_job;
end;
$$;

create or replace function app_private.fail_outcome_ingestion_job(
  p_job_id uuid,
  p_worker_id text,
  p_lease_token uuid,
  p_error_class text,
  p_error_code text,
  p_sanitized_error_message text,
  p_retry_delay_seconds integer default 60
)
returns public.ingestion_jobs
language plpgsql
security definer
set search_path = ''
as $$
declare
  failed_job public.ingestion_jobs%rowtype;
begin
  if session_user not in ('postgres', 'service_role')
    and coalesce(current_setting('role', true), '') <> 'service_role'
    and coalesce(current_setting('request.jwt.claim.role', true), '') <> 'service_role'
    and coalesce(
      nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
      ''
    ) <> 'service_role' then
    raise exception using errcode = '42501', message = 'Only the trusted ingestion worker may fail jobs.';
  end if;
  if nullif(btrim(p_worker_id), '') is null or char_length(p_worker_id) > 200
    or p_job_id is null or p_lease_token is null
    or nullif(btrim(p_error_code), '') is null then
    raise exception using errcode = '22023', message = 'Job, worker, lease token and error code are required.';
  end if;
  if p_retry_delay_seconds is null
    or p_retry_delay_seconds < 0 or p_retry_delay_seconds > 86400 then
    raise exception using errcode = '22023', message = 'Retry delay must be between 0 and 86400 seconds.';
  end if;

  update public.ingestion_jobs job
  set
    status = case
      when job.attempts >= job.max_attempts then 'dead_lettered'
      else 'retry_scheduled'
    end,
    available_at = case
      when job.attempts >= job.max_attempts then job.available_at
      else now() + (p_retry_delay_seconds * interval '1 second')
    end,
    lease_owner = null,
    lease_token = null,
    leased_at = null,
    lease_expires_at = null,
    last_error_class = p_error_class,
    last_error_code = p_error_code,
    sanitized_error_message = p_sanitized_error_message,
    dead_lettered_at = case
      when job.attempts >= job.max_attempts then now()
      else null
    end
  where job.id = p_job_id
    and job.status = 'leased'
    and job.lease_owner = p_worker_id
    and job.lease_token = p_lease_token
    and job.lease_expires_at > now()
  returning job.* into failed_job;

  if not found then
    raise exception using errcode = '55000', message = 'Stale or expired ingestion job lease.';
  end if;
  return failed_job;
end;
$$;

create trigger ingestion_jobs_guard_mutation
before insert or update or delete on public.ingestion_jobs
for each row execute function app_private.guard_ingestion_job_mutation();

create trigger source_fetches_validate_insert
before insert on public.source_fetches
for each row execute function app_private.validate_source_fetch_insert();
create trigger source_fetches_append_only
before update or delete on public.source_fetches
for each row execute function app_private.reject_outcome_graph_mutation();

create trigger artifact_extractions_validate_insert
before insert on public.artifact_extractions
for each row execute function app_private.validate_artifact_extraction_insert();
create trigger artifact_extractions_append_only
before update or delete on public.artifact_extractions
for each row execute function app_private.reject_outcome_graph_mutation();

create trigger source_sync_checkpoints_guard
before insert or update or delete on public.source_sync_checkpoints
for each row execute function app_private.guard_source_sync_checkpoint();

create trigger judicial_source_records_validate_insert
before insert on public.judicial_source_records
for each row execute function app_private.validate_judicial_source_record_insert();
create trigger judicial_source_records_append_only
before update or delete on public.judicial_source_records
for each row execute function app_private.reject_outcome_graph_mutation();

create trigger source_record_matches_validate_insert
before insert on public.source_record_matches
for each row execute function app_private.validate_source_record_match_insert();
create trigger source_record_matches_append_only
before update or delete on public.source_record_matches
for each row execute function app_private.reject_outcome_graph_mutation();

create trigger source_purge_events_validate_insert
before insert on public.source_purge_events
for each row execute function app_private.validate_source_purge_event_insert();
create trigger source_purge_events_append_only
before update or delete on public.source_purge_events
for each row execute function app_private.reject_outcome_graph_mutation();

alter table public.ingestion_jobs enable row level security;
alter table public.source_fetches enable row level security;
alter table public.artifact_extractions enable row level security;
alter table public.source_sync_checkpoints enable row level security;
alter table public.judicial_source_records enable row level security;
alter table public.source_record_matches enable row level security;
alter table public.source_purge_events enable row level security;

revoke all on table
  public.ingestion_jobs,
  public.source_fetches,
  public.artifact_extractions,
  public.source_sync_checkpoints,
  public.judicial_source_records,
  public.source_record_matches,
  public.source_purge_events
from public, anon, authenticated;

grant select, insert on table public.ingestion_jobs to service_role;
grant select on table public.source_sync_checkpoints to service_role;

grant select, insert on table
  public.source_fetches,
  public.artifact_extractions,
  public.judicial_source_records,
  public.source_record_matches,
  public.source_purge_events
to service_role;

insert into storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
) values (
  'outcome-raw-artifacts',
  'outcome-raw-artifacts',
  false,
  104857600,
  array[
    'application/json',
    'application/pdf',
    'application/octet-stream',
    'text/csv',
    'text/plain'
  ]
)
on conflict (id) do update set
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- No anon/authenticated Storage policy is created for this private bucket.
-- Trusted server uploads use the service role and immutable content paths.
grant select on table storage.buckets to service_role;
grant select, insert on table storage.objects to service_role;

revoke all on function app_private.guard_ingestion_job_mutation()
from public, anon, authenticated;
revoke all on function app_private.validate_source_fetch_insert()
from public, anon, authenticated;
revoke all on function app_private.validate_artifact_extraction_insert()
from public, anon, authenticated;
revoke all on function app_private.guard_source_sync_checkpoint()
from public, anon, authenticated;
revoke all on function app_private.validate_judicial_source_record_insert()
from public, anon, authenticated;
revoke all on function app_private.validate_source_record_match_insert()
from public, anon, authenticated;
revoke all on function app_private.validate_source_purge_event_insert()
from public, anon, authenticated;
revoke all on function app_private.claim_outcome_ingestion_job(text, integer, uuid, text)
from public, anon, authenticated;
revoke all on function app_private.upsert_outcome_source_checkpoint(uuid, text, bigint, jsonb, timestamptz, text, uuid)
from public, anon, authenticated;
revoke all on function app_private.complete_outcome_ingestion_job(uuid, text, uuid)
from public, anon, authenticated;
revoke all on function app_private.fail_outcome_ingestion_job(uuid, text, uuid, text, text, text, integer)
from public, anon, authenticated;
grant usage on schema app_private to service_role;
grant execute on function app_private.claim_outcome_ingestion_job(text, integer, uuid, text)
to service_role;
grant execute on function app_private.upsert_outcome_source_checkpoint(uuid, text, bigint, jsonb, timestamptz, text, uuid)
to service_role;
grant execute on function app_private.complete_outcome_ingestion_job(uuid, text, uuid)
to service_role;
grant execute on function app_private.fail_outcome_ingestion_job(uuid, text, uuid, text, text, text, integer)
to service_role;

-- Conservative source registry defaults. ON CONFLICT DO NOTHING preserves any
-- legal review or operator decision already recorded in the environment.
insert into public.data_sources (
  name, publisher, official, base_url, license, terms_url,
  legal_review_status, ingestion_policy, personal_data_possible, active
) values
  (
    'judilibre',
    'Cour de cassation',
    true,
    'https://api.piste.gouv.fr/cassation/judilibre/v1.0',
    'Licence Ouverte / Open Licence 2.0',
    'https://www.data.gouv.fr/dataservices/api-judilibre',
    'pending',
    'disabled',
    true,
    false
  ),
  (
    'dvf_dgfip',
    'Direction generale des Finances publiques',
    true,
    'https://www.data.gouv.fr/datasets/demandes-de-valeurs-foncieres',
    'Licence Ouverte / Open Licence 2.0',
    'https://www.data.gouv.fr/datasets/demandes-de-valeurs-foncieres',
    'approved',
    'allowed_automated',
    true,
    true
  ),
  (
    'justice_open_data',
    'Ministere de la Justice',
    true,
    'https://www.data.gouv.fr/datasets/liste-des-juridictions-competentes-pour-les-communes-de-france',
    'Licence Ouverte / Open Licence 2.0',
    'https://www.data.gouv.fr/organizations/ministere-de-la-justice',
    'approved',
    'allowed_automated',
    false,
    true
  ),
  (
    'encheres_publiques_open_data',
    'Encheres Publiques',
    false,
    'https://www.data.gouv.fr/datasets/distribution-des-prix-de-vente-des-biens-immobiliers-des-tribunaux-judiciaires-francais',
    'Licence Ouverte / Open Licence 2.0',
    'https://www.data.gouv.fr/datasets/distribution-des-prix-de-vente-des-biens-immobiliers-des-tribunaux-judiciaires-francais',
    'pending',
    'allowed_manual',
    false,
    false
  )
on conflict (name) do nothing;

-- The Encheres Publiques CSV is registered only as a hearing candidate index:
-- its observed schema has date, organiser, category, address and URL, but no price.

comment on table public.source_fetches is
  'Immutable HTTP-attempt ledger. Repeated captures may reference one content-deduplicated raw_artifacts row.';
comment on table public.artifact_extractions is
  'Immutable versioned extractor outputs with field provenance and a content hash.';
comment on table public.source_sync_checkpoints is
  'Trusted-worker incremental cursor. Revision and update timestamp are managed by a trigger.';
comment on table public.ingestion_jobs is
  'Trusted-only idempotent ingestion queue with leases, bounded retries, and dead-letter state.';
comment on table public.judicial_source_records is
  'Immutable normalized source-record versions; training eligibility is false by default.';
comment on column public.judicial_source_records.training_eligible is
  'Always false for source candidates. Eligibility begins only after matching and canonical outcome review.';
comment on table public.source_record_matches is
  'Immutable source-to-Outcome-Graph match candidates and superseding review decisions.';
comment on constraint source_record_matches_auto_non_address_signal_check
  on public.source_record_matches is
  'An address may support matching but can never be the sole signal for an automatic match.';
comment on table public.source_purge_events is
  'Immutable logical deletion, redaction, retention, legal-hold, and purge evidence ledger.';

notify pgrst, 'reload schema';

commit;
