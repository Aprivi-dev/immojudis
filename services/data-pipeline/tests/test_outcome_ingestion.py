from __future__ import annotations

import hashlib
from datetime import UTC, datetime

import pytest

from src.official_sources.base import canonical_sha256
from src.official_sources.judilibre import JudilibreDecision
from src.outcome_ingestion.artifact_store import (
    RawArtifactStorageError,
    SupabaseRawArtifactStore,
    raw_artifact_object_path,
)
from src.outcome_ingestion.judilibre_ingestion import normalized_judilibre_decision
from src.outcome_ingestion.repository import (
    OutcomeIngestionRepository,
    SourcePolicy,
    SourcePolicyError,
    SourceRecordProjection,
    SuccessfulCapture,
    request_fingerprint,
)


class FakeBucket:
    def __init__(self) -> None:
        self.calls: list[dict[str, object]] = []

    def upload(self, **kwargs: object) -> None:
        self.calls.append(kwargs)


class FakeStorage:
    def __init__(self, bucket: FakeBucket) -> None:
        self.bucket = bucket
        self.names: list[str] = []

    def from_(self, name: str) -> FakeBucket:
        self.names.append(name)
        return self.bucket


class FakeClient:
    def __init__(self) -> None:
        self.bucket = FakeBucket()
        self.storage = FakeStorage(self.bucket)


class RecordingCursor:
    def __init__(self, rows: list[object]) -> None:
        self.rows = list(rows)
        self.calls: list[tuple[str, object]] = []

    def __enter__(self) -> RecordingCursor:
        return self

    def __exit__(self, *_args: object) -> None:
        return None

    def execute(self, statement: str, parameters: object = None) -> None:
        self.calls.append((" ".join(statement.split()), parameters))

    def fetchone(self) -> object:
        return self.rows.pop(0)


class RecordingConnection:
    def __init__(self, cursor: RecordingCursor) -> None:
        self._cursor = cursor
        self.commits = 0

    def __enter__(self) -> RecordingConnection:
        return self

    def __exit__(self, *_args: object) -> None:
        return None

    def cursor(self) -> RecordingCursor:
        return self._cursor

    def commit(self) -> None:
        self.commits += 1


def test_policy_is_fail_closed_and_channel_specific() -> None:
    approved = SourcePolicy(
        id="source-1",
        name="justice_open_data",
        official=True,
        legal_review_status="approved",
        ingestion_policy="allowed_automated",
        active=True,
    )
    approved.assert_allows("automated")
    approved.assert_allows("manual")

    pending = SourcePolicy(
        id="source-2",
        name="judilibre",
        official=True,
        legal_review_status="pending",
        ingestion_policy="disabled",
        active=False,
    )
    with pytest.raises(SourcePolicyError, match="does not allow"):
        pending.assert_allows("automated")

    manual = SourcePolicy(
        id="source-3",
        name="encheres_publiques_open_data",
        official=False,
        legal_review_status="approved",
        ingestion_policy="allowed_manual",
        active=True,
    )
    manual.assert_allows("manual")
    with pytest.raises(SourcePolicyError, match="automated"):
        manual.assert_allows("automated")


def test_storage_path_hides_external_identifier_and_upload_is_immutable() -> None:
    payload = b'{"id":"decision-sensitive"}'
    digest = hashlib.sha256(payload).hexdigest()
    path = raw_artifact_object_path(
        source_name="Judilibre",
        external_record_id="decision-sensitive",
        content_hash=digest,
        mime_type="application/json",
    )
    assert path.startswith("judilibre/")
    assert "decision-sensitive" not in path
    assert path.endswith(f"/{digest}.json")

    client = FakeClient()
    stored = SupabaseRawArtifactStore(client).put_bytes(
        source_name="Judilibre",
        external_record_id="decision-sensitive",
        payload=payload,
        mime_type="application/json",
    )
    assert stored.object_path == path
    assert stored.byte_size == len(payload)
    assert client.storage.names == ["outcome-raw-artifacts"]
    assert client.bucket.calls[0]["file_options"] == {
        "cache-control": "31536000",
        "content-type": "application/json",
        "upsert": "false",
    }


def test_storage_configuration_error_does_not_echo_credentials() -> None:
    with pytest.raises(RawArtifactStorageError) as raised:
        SupabaseRawArtifactStore.from_settings(
            {"supabase_url": "https://project.supabase.co", "supabase_service_role_key": ""}
        )
    assert "service-role-secret" not in str(raised.value)


def test_request_fingerprint_is_deterministic_and_stored_url_can_drop_query() -> None:
    first = request_fingerprint(
        "get",
        "https://api.piste.gouv.fr/cassation/judilibre/v1.0/decision?id=sensitive",
        {"id": "decision-1", "resolve_references": False},
    )
    second = request_fingerprint(
        "GET",
        "https://api.piste.gouv.fr/cassation/judilibre/v1.0/decision?id=other",
        {"resolve_references": False, "id": "decision-1"},
    )
    assert first == second
    assert len(first) == 64


def test_repository_persists_the_full_provenance_chain_in_one_transaction() -> None:
    cursor = RecordingCursor(
        [
            ("source-1", "dvf_dgfip", True, "approved", "allowed_automated", True),
            ("artifact-1",),
            ("fetch-1",),
            ("extraction-1",),
            None,
            ("record-1",),
        ]
    )
    connection = RecordingConnection(cursor)
    repository = OutcomeIngestionRepository("postgresql://example", connect=lambda _url: connection)
    now = datetime(2026, 7, 30, 12, 0, tzinfo=UTC)
    payload = b'{"mutation_nature":"Adjudication"}'
    stored = SupabaseRawArtifactStore(FakeClient()).put_bytes(
        source_name="dvf_dgfip",
        external_record_id="dvf-adjudication-1",
        payload=payload,
        mime_type="application/json",
    )

    persisted = repository.persist_successful_record(
        source_name="dvf_dgfip",
        channel="automated",
        capture=SuccessfulCapture(
            requested_url="https://www.data.gouv.fr/api/1/datasets/r/resource?token=not-stored",
            external_record_id="dvf-adjudication-1",
            canonical_url="https://www.data.gouv.fr/datasets/demandes-de-valeurs-foncieres",
            stored_artifact=stored,
            connector_version="dvf-adjudication/1",
            started_at=now,
            completed_at=now,
        ),
        projection=SourceRecordProjection(
            record_kind="auction_result_candidate",
            normalized_data={"schema_version": "dvf_adjudication_candidate_v1", "training_eligible": False},
            extractor_name="dvf_adjudication",
            extractor_version="1",
            schema_version="dvf_adjudication_candidate_v1",
        ),
    )

    assert persisted.source_record_id == "record-1"
    assert persisted.record_version == 1
    assert persisted.inserted_new_version is True
    assert connection.commits == 1
    statements = "\n".join(statement for statement, _parameters in cursor.calls)
    assert "insert into public.raw_artifacts" in statements
    assert "insert into public.source_fetches" in statements
    assert "insert into public.artifact_extractions" in statements
    assert "insert into public.judicial_source_records" in statements
    assert "from public.data_sources where name = %s for share" in cursor.calls[0][0]
    fetch_parameters = next(
        parameters for statement, parameters in cursor.calls if "insert into public.source_fetches" in statement
    )
    assert fetch_parameters[2:5] == ("succeeded", "http", "GET")
    assert "?token=" not in fetch_parameters[5]


def test_judilibre_raw_correction_versions_and_purge_targets_latest_artifact() -> None:
    first_decision = JudilibreDecision.model_validate(
        {
            "id": "decision-1",
            "jurisdiction": "tj",
            "decision_date": "2025-05-14",
            "update_date": "2025-05-15",
            "type": "Jugement",
            "solution": "Adjudication",
            "text": "Texte judiciaire initial contenant Mme Exemple.",
        }
    )
    corrected_decision = first_decision.model_copy(update={"text": "Texte judiciaire corrigé contenant Mme Exemple."})
    first_projection = normalized_judilibre_decision(first_decision)
    corrected_projection = normalized_judilibre_decision(corrected_decision)
    first_output_hash = canonical_sha256(first_projection)
    corrected_output_hash = canonical_sha256(corrected_projection)

    first_cursor = RecordingCursor(
        [
            ("source-1", "judilibre", True, "approved", "allowed_automated", True),
            ("artifact-1",),
            ("fetch-1",),
            ("extraction-1",),
            None,
            ("record-1",),
        ]
    )
    duplicate_cursor = RecordingCursor(
        [
            ("source-1", "judilibre", True, "approved", "allowed_automated", True),
            ("artifact-1",),
            ("fetch-duplicate",),
            None,
            ("extraction-1",),
            ("record-1", 1, first_output_hash),
        ]
    )
    corrected_cursor = RecordingCursor(
        [
            ("source-1", "judilibre", True, "approved", "allowed_automated", True),
            ("artifact-2",),
            ("fetch-2",),
            ("extraction-2",),
            ("record-1", 1, first_output_hash),
            ("record-2",),
        ]
    )
    reverted_cursor = RecordingCursor(
        [
            ("source-1", "judilibre", True, "approved", "allowed_automated", True),
            ("artifact-1",),
            ("fetch-3",),
            None,
            ("extraction-1",),
            ("record-2", 2, corrected_output_hash),
            ("record-3",),
        ]
    )
    purge_cursor = RecordingCursor(
        [
            ("source-1", "judilibre", True, "approved", "allowed_automated", True),
            ("record-3", "fetch-3", "artifact-1"),
            ("purge-1",),
        ]
    )
    connections = iter(
        [
            RecordingConnection(first_cursor),
            RecordingConnection(duplicate_cursor),
            RecordingConnection(corrected_cursor),
            RecordingConnection(reverted_cursor),
            RecordingConnection(purge_cursor),
        ]
    )
    repository = OutcomeIngestionRepository(
        "postgresql://example",
        connect=lambda _url: next(connections),
    )
    now = datetime(2026, 7, 30, 12, 0, tzinfo=UTC)
    artifact_store = SupabaseRawArtifactStore(FakeClient())

    def persist(
        decision: JudilibreDecision,
        normalized_data: dict[str, object],
    ) -> object:
        stored = artifact_store.put_bytes(
            source_name="judilibre",
            external_record_id=decision.id,
            payload=decision.canonical_json(),
            mime_type="application/json",
        )
        assert normalized_data["raw_representation_sha256"] == stored.content_hash
        return repository.persist_successful_record(
            source_name="judilibre",
            channel="automated",
            capture=SuccessfulCapture(
                requested_url="https://api.piste.gouv.fr/cassation/judilibre/v1.0/decision",
                external_record_id=decision.id,
                canonical_url=f"https://www.courdecassation.fr/decision/{decision.id}",
                stored_artifact=stored,
                connector_version="judilibre-outcome/4",
                started_at=now,
                completed_at=now,
                request_parameters={"id": decision.id},
            ),
            projection=SourceRecordProjection(
                record_kind="judicial_decision_candidate",
                normalized_data=normalized_data,
                extractor_name="judilibre_metadata_projection",
                extractor_version="2",
                schema_version="judilibre_decision_candidate_v2",
                decision_date=decision.decision_date,
            ),
        )

    first_persisted = persist(first_decision, first_projection)
    duplicate_persisted = persist(first_decision, first_projection)
    corrected_persisted = persist(corrected_decision, corrected_projection)
    reverted_persisted = persist(first_decision, first_projection)
    purge_id = repository.record_source_deletion(
        source_name="judilibre",
        external_record_id="decision-1",
        event_at=now,
        reason_code="judilibre_transaction_deleted",
        connector_version="judilibre-outcome/4",
    )

    assert first_persisted.record_version == 1
    assert duplicate_persisted.record_version == 1
    assert duplicate_persisted.inserted_new_version is False
    assert corrected_persisted.record_version == 2
    assert corrected_persisted.inserted_new_version is True
    assert reverted_persisted.record_version == 3
    assert reverted_persisted.inserted_new_version is True
    assert purge_id == "purge-1"
    corrected_record_parameters = next(
        parameters
        for statement, parameters in corrected_cursor.calls
        if "insert into public.judicial_source_records" in statement
    )
    assert corrected_record_parameters[1:4] == (
        "fetch-2",
        "artifact-2",
        "extraction-2",
    )
    reverted_record_parameters = next(
        parameters
        for statement, parameters in reverted_cursor.calls
        if "insert into public.judicial_source_records" in statement
    )
    assert reverted_record_parameters[1:4] == (
        "fetch-3",
        "artifact-1",
        "extraction-1",
    )
    purge_parameters = next(
        parameters
        for statement, parameters in purge_cursor.calls
        if "insert into public.source_purge_events" in statement
    )
    assert purge_parameters[1:4] == ("fetch-3", "artifact-1", "record-3")
    assert purge_parameters[4] == "decision-1"


def test_checkpoint_advance_uses_revision_guarded_rpc() -> None:
    now = datetime(2026, 7, 30, 12, 0, tzinfo=UTC)
    cursor = RecordingCursor(
        [
            ("source-1", "judilibre", True, "approved", "allowed_automated", True),
            ({"date": now.isoformat()}, now, "judilibre-outcome/1", 4),
        ]
    )
    connection = RecordingConnection(cursor)
    repository = OutcomeIngestionRepository("postgresql://example", connect=lambda _url: connection)

    checkpoint = repository.advance_checkpoint(
        source_name="judilibre",
        channel="automated",
        stream_key="transactional_history",
        expected_revision=3,
        source_cursor={"date": now.isoformat()},
        watermark_at=now,
        connector_version="judilibre-outcome/1",
    )

    assert checkpoint.revision == 4
    rpc_statement, rpc_parameters = cursor.calls[1]
    assert "app_private.upsert_outcome_source_checkpoint" in rpc_statement
    assert rpc_parameters[2] == 3
    assert connection.commits == 1


def test_append_match_candidate_is_serialized_and_idempotent_for_current_target() -> None:
    cursor = RecordingCursor([("match-existing",)])
    connection = RecordingConnection(cursor)
    repository = OutcomeIngestionRepository("postgresql://example", connect=lambda _url: connection)

    match_id = repository.append_match_candidate(
        source_record_id="record-1",
        case_id="case-1",
        lot_id="lot-1",
        round_id="round-1",
        match_score="0.8500",
        match_method="parcel_and_date",
        match_signals={"parcel": True, "mutation_date": True},
    )

    assert match_id == "match-existing"
    assert connection.commits == 1
    assert "pg_advisory_xact_lock" in cursor.calls[0][0]
    assert "select match_row.id" in cursor.calls[1][0]
    assert all("insert into public.source_record_matches" not in call[0] for call in cursor.calls)


def test_append_match_candidate_inserts_candidate_only_when_target_is_new() -> None:
    cursor = RecordingCursor([None, ("match-new",)])
    connection = RecordingConnection(cursor)
    repository = OutcomeIngestionRepository("postgresql://example", connect=lambda _url: connection)

    match_id = repository.append_match_candidate(
        source_record_id="record-1",
        case_id="case-1",
        lot_id="lot-1",
        round_id=None,
        match_score="0.6500",
        match_method="parcel",
        match_signals={"parcel": True, "automatic_link_allowed": False},
    )

    assert match_id == "match-new"
    assert connection.commits == 1
    insert = next(call for call in cursor.calls if "insert into public.source_record_matches" in call[0])
    assert "'candidate'" in insert[0]
