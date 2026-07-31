from __future__ import annotations

from collections.abc import Iterable
from datetime import UTC, date, datetime
from types import SimpleNamespace

import pytest

from src.official_sources.base import OfficialSourceConfigurationError
from src.official_sources.judilibre import (
    JudilibreDecision,
    JudilibreHistoryPage,
    JudilibreSearchPage,
    JudilibreSearchQuery,
)
from src.outcome_ingestion.judilibre_ingestion import (
    JUDILIBRE_SEARCH_PROFILES,
    JudilibreOutcomeIngestor,
    normalized_judilibre_decision,
    validate_judilibre_search_request,
)
from src.outcome_ingestion.repository import PersistedSourceRecord


def _decision(**overrides: object) -> JudilibreDecision:
    payload: dict[str, object] = {
        "id": "decision-1",
        "jurisdiction": "tj",
        "location": "tj33063",
        "formation": "Juge de l'exécution",
        "decision_date": "2025-05-14",
        "update_date": "2025-05-15",
        "type": "Jugement",
        "solution": "Adjudication",
        "text": "Mme Exemple, magistrate, prononce une adjudication à 185 000 euros.",
        "zones": {"introduction": "Identités à ne pas projeter"},
        "summary": "Résumé pouvant encore contenir une identité.",
    }
    payload.update(overrides)
    return JudilibreDecision.model_validate(payload)


def _search_page(
    *,
    page: int,
    page_size: int,
    identifiers: tuple[str, ...],
    total: int,
    next_page: str | None = None,
    relaxed: bool = False,
) -> JudilibreSearchPage:
    return JudilibreSearchPage.model_validate(
        {
            "page": page,
            "page_size": page_size,
            "total": total,
            "next_page": next_page,
            "relaxed": relaxed,
            "results": [
                {
                    "id": identifier,
                    "jurisdiction": "tj",
                    "decision_date": "2025-05-14",
                    "summary": "Donnée sensible qui ne doit pas entrer dans la provenance.",
                    "highlights": {"text": ["Mme Exemple"]},
                }
                for identifier in identifiers
            ],
        }
    )


class FakeClient:
    base_url = "https://api.piste.gouv.fr/cassation/judilibre/v1.0"
    transactional_history_path = "/transactionalhistory"
    history_page_size = 10
    page_size = 2

    def __init__(
        self,
        decision: JudilibreDecision,
        pages: list[JudilibreHistoryPage] | None = None,
        search_pages: list[JudilibreSearchPage] | None = None,
    ) -> None:
        self.returned_decision = decision
        self.pages = pages or []
        self.search_pages = search_pages or []
        self.decision_ids: list[str] = []
        self.search_queries: list[JudilibreSearchQuery] = []
        self.history_cursors: list[object] = []
        self.events: list[str] = []

    def decision(self, decision_id: str, *, resolve_references: bool) -> JudilibreDecision:
        self.events.append(f"decision:{decision_id}")
        self.decision_ids.append(decision_id)
        assert resolve_references is False
        return self.returned_decision.model_copy(update={"id": decision_id})

    def iter_transactional_history(self, cursor: object, *, max_pages: int) -> object:
        self.history_cursors.append(cursor)
        for index, page in enumerate(self.pages[:max_pages], start=1):
            self.events.append(f"history:{index}")
            yield page

    def transactional_history(self, cursor: object) -> JudilibreHistoryPage:
        index = len(self.history_cursors)
        self.history_cursors.append(cursor)
        self.events.append(f"history:{index + 1}")
        return self.pages[index]

    def search(self, query: JudilibreSearchQuery) -> JudilibreSearchPage:
        self.events.append(f"search:{query.page}")
        self.search_queries.append(query)
        return self.search_pages[query.page]


class FakeRepository:
    def __init__(self, *, tracked_ids: set[str] | None = None) -> None:
        self.policies: list[tuple[str, str]] = []
        self.deletions: list[dict[str, object]] = []
        self.checkpoints: list[dict[str, object]] = []
        self.source_record_id_lookups: list[tuple[str, list[str]]] = []
        self.loaded_checkpoint = None
        self.tracked_ids = tracked_ids

    def require_source_policy(self, source_name: str, channel: str) -> None:
        self.policies.append((source_name, channel))

    def record_source_deletion(self, **kwargs: object) -> str:
        self.deletions.append(kwargs)
        return "purge-1"

    def load_checkpoint(self, **_kwargs: object) -> object:
        return self.loaded_checkpoint

    def advance_checkpoint(self, **kwargs: object) -> object:
        self.checkpoints.append(kwargs)
        return SimpleNamespace()

    def source_record_ids_exist(
        self,
        source_name: str,
        external_record_ids: Iterable[str],
    ) -> set[str]:
        identifiers = list(external_record_ids)
        self.source_record_id_lookups.append((source_name, identifiers))
        if self.tracked_ids is None:
            return set(identifiers)
        return set(identifiers) & self.tracked_ids


class FakeService:
    def __init__(self, *, fail: bool = False) -> None:
        self.records: list[object] = []
        self.fail = fail

    def ingest_json_record(self, record: object, **_kwargs: object) -> PersistedSourceRecord:
        if self.fail:
            raise RuntimeError("persistence failed")
        self.records.append(record)
        return PersistedSourceRecord(
            source_id="source-1",
            raw_artifact_id="artifact-1",
            source_fetch_id="fetch-1",
            artifact_extraction_id="extract-1",
            source_record_id="record-1",
            record_version=1,
            inserted_new_version=True,
        )


def test_normalized_projection_excludes_text_summary_zones_and_personal_identities() -> None:
    first_decision = _decision()
    projection = normalized_judilibre_decision(first_decision)
    corrected_projection = normalized_judilibre_decision(
        first_decision.model_copy(update={"text": "Texte judiciaire corrigé sans autre changement."})
    )

    assert projection["training_eligible"] is False
    assert projection["personal_identity_features_allowed"] is False
    assert projection["text_storage"] == "private_raw_artifact"
    serialized = str(projection)
    assert "magistrate" not in serialized
    assert "Mme Exemple" not in serialized
    assert "Résumé" not in serialized
    assert "zones" not in projection
    assert len(str(projection["raw_representation_sha256"])) == 64
    assert projection["raw_representation_sha256"] != corrected_projection["raw_representation_sha256"]
    assert {key: value for key, value in projection.items() if key != "raw_representation_sha256"} == {
        key: value for key, value in corrected_projection.items() if key != "raw_representation_sha256"
    }


def test_fetch_checks_policy_before_network_and_persists_private_raw_decision() -> None:
    repository = FakeRepository()
    service = FakeService()
    client = FakeClient(_decision())
    ingestor = JudilibreOutcomeIngestor(client=client, repository=repository, service=service)

    persisted = ingestor.fetch_decision("decision-1")

    assert persisted is not None
    assert repository.policies == [("judilibre", "automated")]
    assert client.decision_ids == ["decision-1"]
    record = service.records[0]
    assert record.record_kind == "judicial_decision_candidate"
    assert record.raw_payload["text"].startswith("Mme Exemple")
    assert "text" not in record.normalized_data
    assert record.decision_date == date(2025, 5, 14)
    assert record.published_at is None
    assert record.request_parameters == {"id": "decision-1", "resolve_references": False}


def test_to_be_deleted_decision_is_tombstoned_without_storage() -> None:
    repository = FakeRepository()
    service = FakeService()
    ingestor = JudilibreOutcomeIngestor(
        client=FakeClient(_decision(to_be_deleted=True)),
        repository=repository,
        service=service,
    )

    assert ingestor.fetch_decision("decision-1") is None
    assert service.records == []
    assert repository.deletions[0]["external_record_id"] == "decision-1"
    assert repository.deletions[0]["reason_code"] == "judilibre_to_be_deleted"


def test_sync_processes_updates_and_deletions_then_advances_checkpoint() -> None:
    page = JudilibreHistoryPage.model_validate(
        {
            "transactions": [
                {"id": "decision-a", "action": "updated", "date": "2025-05-15T10:00:00Z"},
                {"id": "decision-b", "action": "deleted", "date": "2025-05-15T10:01:00Z"},
            ],
            "page_size": 10,
            "total": 2,
            "query_date": "2025-05-15T11:00:00Z",
            "next_page": None,
        }
    )
    repository = FakeRepository()
    service = FakeService()
    ingestor = JudilibreOutcomeIngestor(
        client=FakeClient(_decision(), pages=[page]),
        repository=repository,
        service=service,
    )

    summary = ingestor.sync(since=date(2025, 5, 1))

    assert summary.pages == 1
    assert summary.created_or_updated == 1
    assert summary.deletions == 1
    assert summary.stored_versions == 1
    assert summary.checkpoint_advanced is True
    assert repository.deletions[0]["external_record_id"] == "decision-b"
    assert repository.checkpoints[0]["source_cursor"] == {
        "schema_version": "judilibre_history_checkpoint_v2",
        "date": "2025-05-15T11:00:00Z",
        "page_size": 10,
        "scan_complete": True,
    }
    assert repository.checkpoints[0]["expected_revision"] is None
    assert service.records[0].source_cursor == {
        "stream_key": "transactional_history",
        "history_query_date": "2025-05-15T11:00:00Z",
        "transaction_action": "updated",
        "transaction_date": "2025-05-15T10:00:00Z",
    }


def test_sync_uses_loaded_checkpoint_revision_for_compare_and_swap() -> None:
    page = JudilibreHistoryPage.model_validate(
        {
            "transactions": [],
            "page_size": 10,
            "total": 0,
            "query_date": "2025-05-15T11:00:00Z",
            "next_page": None,
        }
    )
    repository = FakeRepository()
    repository.loaded_checkpoint = SimpleNamespace(
        source_cursor={"date": "2025-05-14T11:00:00Z", "page_size": 10},
        watermark_at=datetime(2025, 5, 14, 11, tzinfo=UTC),
        revision=7,
    )
    ingestor = JudilibreOutcomeIngestor(
        client=FakeClient(_decision(), pages=[page]),
        repository=repository,
        service=FakeService(),
    )

    summary = ingestor.sync()

    assert summary.checkpoint_advanced is True
    assert repository.checkpoints[0]["expected_revision"] == 7


def test_sync_rejects_an_ephemeral_from_id_checkpoint_before_network() -> None:
    repository = FakeRepository()
    repository.loaded_checkpoint = SimpleNamespace(
        source_cursor={
            "schema_version": "judilibre_history_checkpoint_v2",
            "date": "2025-05-15T10:02:00Z",
            "page_size": 10,
            "scan_complete": False,
            "scan_origin": "2025-05-01T00:00:00Z",
            "scan_watermark": "2025-05-15T11:00:00Z",
            "committed_through_event_at": "2025-05-15T10:01:00Z",
            "from_id": "2025-05-15T10:01:00Z&expired-elastic-id",
        },
        watermark_at=datetime(2025, 5, 1, tzinfo=UTC),
        revision=1,
    )
    client = FakeClient(_decision())
    ingestor = JudilibreOutcomeIngestor(
        client=client,
        repository=repository,
        service=FakeService(),
    )

    with pytest.raises(OfficialSourceConfigurationError, match="ephemeral from_id"):
        ingestor.sync()

    assert client.events == []
    assert repository.checkpoints == []


@pytest.mark.parametrize(
    "source_cursor",
    [
        {
            "schema_version": "judilibre_history_checkpoint_v999",
            "date": "2025-05-15T10:00:00Z",
            "page_size": 10,
            "scan_complete": True,
        },
        {
            "schema_version": "judilibre_history_checkpoint_v2",
            "date": "2025-05-15T10:00:00Z",
            "page_size": 10,
            "scan_complete": True,
            "from_id": "opaque-but-expired",
        },
        {
            "schema_version": "judilibre_history_checkpoint_v2",
            "page_size": 10,
            "scan_complete": True,
        },
        {"page_size": 10},
    ],
)
def test_sync_rejects_malformed_complete_checkpoints_before_network(
    source_cursor: dict[str, object],
) -> None:
    repository = FakeRepository()
    repository.loaded_checkpoint = SimpleNamespace(
        source_cursor=source_cursor,
        watermark_at=datetime(2025, 5, 15, 10, tzinfo=UTC),
        revision=1,
    )
    client = FakeClient(_decision())
    ingestor = JudilibreOutcomeIngestor(
        client=client,
        repository=repository,
        service=FakeService(),
    )

    with pytest.raises(OfficialSourceConfigurationError, match="checkpoint"):
        ingestor.sync(since=date(2025, 5, 1))

    assert client.events == []
    assert repository.checkpoints == []


def test_sync_never_advances_checkpoint_after_partial_failure() -> None:
    page = JudilibreHistoryPage.model_validate(
        {
            "transactions": [{"id": "decision-a", "action": "updated", "date": "2025-05-15T10:00:00Z"}],
            "page_size": 10,
            "total": 1,
            "query_date": "2025-05-15T11:00:00Z",
            "next_page": None,
        }
    )
    repository = FakeRepository()
    ingestor = JudilibreOutcomeIngestor(
        client=FakeClient(_decision(), pages=[page]),
        repository=repository,
        service=FakeService(fail=True),
    )

    with pytest.raises(RuntimeError, match="persistence failed"):
        ingestor.sync(since=datetime(2025, 5, 1, tzinfo=UTC))
    assert repository.checkpoints == []


def test_sync_persists_an_intermediate_cursor_when_max_pages_bounds_a_segment() -> None:
    pages = [
        JudilibreHistoryPage.model_validate(
            {
                "transactions": [{"id": "decision-a", "action": "deleted", "date": "2025-05-15T10:00:00Z"}],
                "page_size": 10,
                "total": 20,
                "query_date": "2025-05-15T11:00:00Z",
                "next_page": (
                    "date=2025-05-01T00%3A00%3A00Z&page_size=10&from_id=2025-05-15T10%3A00%3A00Z%26elastic-a"
                ),
            }
        ),
        JudilibreHistoryPage.model_validate(
            {
                "transactions": [
                    {"id": "decision-b", "action": "updated", "date": "2025-05-15T10:00:00Z"},
                    {"id": "decision-c", "action": "updated", "date": "2025-05-15T10:01:00Z"},
                ],
                "page_size": 10,
                "total": 19,
                "query_date": "2025-05-15T11:00:01Z",
                "next_page": None,
            }
        ),
    ]
    repository = FakeRepository()
    client = FakeClient(_decision(), pages=pages)
    ingestor = JudilibreOutcomeIngestor(
        client=client,
        repository=repository,
        service=FakeService(),
    )

    summary = ingestor.sync(since=date(2025, 5, 1), max_pages=1)

    assert summary.pages == 2
    assert summary.created_or_updated == 1
    assert summary.deletions == 1
    assert summary.scan_complete is False
    assert summary.checkpoint_advanced is True
    assert repository.checkpoints[0]["source_cursor"] == {
        "schema_version": "judilibre_history_checkpoint_v2",
        "date": "2025-05-15T10:01:00Z",
        "page_size": 10,
        "scan_complete": False,
        "scan_origin": "2025-05-01",
        "committed_through_event_at": "2025-05-15T10:00:00Z",
        "scan_watermark": "2025-05-15T11:00:00Z",
    }
    assert repository.checkpoints[0]["watermark_at"] == datetime(2025, 5, 1, tzinfo=UTC)
    assert client.history_cursors[1].from_id == "2025-05-15T10:00:00Z&elastic-a"
    assert "from_id" not in repository.checkpoints[0]["source_cursor"]
    assert client.events == [
        "history:1",
        "history:2",
        "decision:decision-b",
    ]


def test_sync_resumes_a_max_records_segment_and_promotes_only_at_terminal_page() -> None:
    first_page = JudilibreHistoryPage.model_validate(
        {
            "transactions": [
                {"id": "decision-a", "action": "updated", "date": "2025-05-15T10:00:00Z"},
                {"id": "decision-b", "action": "updated", "date": "2025-05-15T10:01:00Z"},
                {"id": "decision-c", "action": "updated", "date": "2025-05-15T10:02:00Z"},
            ],
            "page_size": 10,
            "total": 3,
            "query_date": "2025-05-15T11:00:00Z",
            "next_page": None,
        }
    )
    repository = FakeRepository()
    first_client = FakeClient(_decision(), pages=[first_page])
    first_ingestor = JudilibreOutcomeIngestor(
        client=first_client,
        repository=repository,
        service=FakeService(),
    )

    first_summary = first_ingestor.sync(
        since=date(2025, 5, 1),
        max_records=2,
    )

    assert first_summary.created_or_updated == 2
    assert first_summary.scan_complete is False
    assert first_summary.checkpoint_advanced is True
    intermediate = repository.checkpoints[-1]
    assert intermediate["source_cursor"] == {
        "schema_version": "judilibre_history_checkpoint_v2",
        "date": "2025-05-15T10:02:00Z",
        "page_size": 10,
        "scan_complete": False,
        "scan_origin": "2025-05-01",
        "committed_through_event_at": "2025-05-15T10:01:00Z",
        "scan_watermark": "2025-05-15T11:00:00Z",
    }
    assert intermediate["watermark_at"] == datetime(2025, 5, 1, tzinfo=UTC)

    repository.loaded_checkpoint = SimpleNamespace(
        source_cursor=intermediate["source_cursor"],
        watermark_at=intermediate["watermark_at"],
        revision=1,
    )
    terminal_page = JudilibreHistoryPage.model_validate(
        {
            "transactions": [{"id": "decision-c", "action": "updated", "date": "2025-05-15T10:02:00Z"}],
            "page_size": 10,
            "total": 1,
            "query_date": "2025-05-15T11:00:03Z",
            "next_page": None,
        }
    )
    second_client = FakeClient(_decision(), pages=[terminal_page])
    second_ingestor = JudilibreOutcomeIngestor(
        client=second_client,
        repository=repository,
        service=FakeService(),
    )

    second_summary = second_ingestor.sync(max_records=2)

    assert second_summary.created_or_updated == 1
    assert second_summary.scan_complete is True
    assert second_summary.checkpoint_advanced is True
    resumed_cursor = second_client.history_cursors[0]
    assert resumed_cursor.date == "2025-05-15T10:02:00Z"
    assert resumed_cursor.from_id is None
    assert repository.checkpoints[-1]["expected_revision"] == 1
    assert repository.checkpoints[-1]["source_cursor"] == {
        "schema_version": "judilibre_history_checkpoint_v2",
        "date": "2025-05-15T11:00:00Z",
        "page_size": 10,
        "scan_complete": True,
    }
    assert repository.checkpoints[-1]["watermark_at"] == datetime(2025, 5, 15, 11, tzinfo=UTC)


def test_sync_partial_resume_can_progress_beyond_the_first_scan_query_date() -> None:
    repository = FakeRepository()

    def run_segment(
        *,
        page: JudilibreHistoryPage,
        revision: int | None,
        since: date | None = None,
    ) -> tuple[object, FakeClient]:
        if revision is not None:
            previous = repository.checkpoints[-1]
            repository.loaded_checkpoint = SimpleNamespace(
                source_cursor=previous["source_cursor"],
                watermark_at=previous["watermark_at"],
                revision=revision,
            )
        client = FakeClient(_decision(), pages=[page])
        summary = JudilibreOutcomeIngestor(
            client=client,
            repository=repository,
            service=FakeService(),
        ).sync(since=since, max_records=1)
        return summary, client

    first_summary, _ = run_segment(
        page=JudilibreHistoryPage.model_validate(
            {
                "transactions": [
                    {"id": "decision-a", "action": "updated", "date": "2025-05-15T10:00:00Z"},
                    {"id": "decision-b", "action": "updated", "date": "2025-05-15T10:01:00Z"},
                ],
                "page_size": 10,
                "total": 2,
                "query_date": "2025-05-15T10:05:00Z",
                "next_page": None,
            }
        ),
        revision=None,
        since=date(2025, 5, 1),
    )
    assert first_summary.scan_complete is False
    assert repository.checkpoints[-1]["source_cursor"]["date"] == "2025-05-15T10:01:00Z"
    assert repository.checkpoints[-1]["source_cursor"]["scan_watermark"] == ("2025-05-15T10:05:00Z")

    second_summary, second_client = run_segment(
        page=JudilibreHistoryPage.model_validate(
            {
                "transactions": [
                    {"id": "decision-b", "action": "updated", "date": "2025-05-15T10:01:00Z"},
                    {"id": "decision-c", "action": "updated", "date": "2025-05-15T10:06:00Z"},
                ],
                "page_size": 10,
                "total": 2,
                "query_date": "2025-05-15T10:10:00Z",
                "next_page": None,
            }
        ),
        revision=1,
    )
    assert second_summary.scan_complete is False
    assert second_client.history_cursors[0].date == "2025-05-15T10:01:00Z"
    assert second_client.history_cursors[0].from_id is None
    assert repository.checkpoints[-1]["source_cursor"]["date"] == "2025-05-15T10:06:00Z"
    assert repository.checkpoints[-1]["source_cursor"]["scan_watermark"] == ("2025-05-15T10:05:00Z")

    third_summary, third_client = run_segment(
        page=JudilibreHistoryPage.model_validate(
            {
                "transactions": [{"id": "decision-c", "action": "updated", "date": "2025-05-15T10:06:00Z"}],
                "page_size": 10,
                "total": 1,
                "query_date": "2025-05-15T10:11:00Z",
                "next_page": None,
            }
        ),
        revision=2,
    )
    assert third_summary.scan_complete is True
    assert third_client.history_cursors[0].date == "2025-05-15T10:06:00Z"
    assert third_client.history_cursors[0].from_id is None
    assert repository.checkpoints[-1]["source_cursor"]["date"] == ("2025-05-15T10:05:00Z")
    assert repository.checkpoints[-1]["watermark_at"] == datetime(2025, 5, 15, 10, 5, tzinfo=UTC)


def test_sync_max_records_never_splits_an_event_timestamp_cohort() -> None:
    page = JudilibreHistoryPage.model_validate(
        {
            "transactions": [
                {"id": "decision-a", "action": "updated", "date": "2025-05-15T10:00:00Z"},
                {"id": "decision-b", "action": "updated", "date": "2025-05-15T10:00:00Z"},
                {"id": "decision-c", "action": "updated", "date": "2025-05-15T10:01:00Z"},
            ],
            "page_size": 10,
            "total": 3,
            "query_date": "2025-05-15T11:00:00Z",
            "next_page": None,
        }
    )
    repository = FakeRepository()
    client = FakeClient(_decision(), pages=[page])
    ingestor = JudilibreOutcomeIngestor(
        client=client,
        repository=repository,
        service=FakeService(),
    )

    summary = ingestor.sync(
        since=date(2025, 5, 1),
        max_records=1,
    )

    assert summary.created_or_updated == 2
    assert summary.scan_complete is False
    assert client.decision_ids == ["decision-a", "decision-b"]
    assert repository.checkpoints[0]["source_cursor"]["date"] == ("2025-05-15T10:01:00Z")
    assert "from_id" not in repository.checkpoints[0]["source_cursor"]


def test_oversized_timestamp_cohort_drains_to_terminal_instead_of_retrying_forever(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        "src.outcome_ingestion.judilibre_ingestion.JUDILIBRE_HISTORY_COHORT_EXTENSION_PAGES_BEFORE_TERMINAL_DRAIN",
        1,
    )
    pages = [
        JudilibreHistoryPage.model_validate(
            {
                "transactions": [{"id": "decision-a", "action": "updated", "date": "2025-05-15T10:00:00Z"}],
                "page_size": 10,
                "total": 3,
                "query_date": "2025-05-15T11:00:00Z",
                "next_page": (
                    "date=2025-05-01T00%3A00%3A00Z&page_size=10&from_id=2025-05-15T10%3A00%3A00Z%26elastic-a"
                ),
            }
        ),
        JudilibreHistoryPage.model_validate(
            {
                "transactions": [{"id": "decision-b", "action": "updated", "date": "2025-05-15T10:00:00Z"}],
                "page_size": 10,
                "total": 2,
                "query_date": "2025-05-15T11:00:01Z",
                "next_page": (
                    "date=2025-05-01T00%3A00%3A00Z&page_size=10&from_id=2025-05-15T10%3A00%3A00Z%26elastic-b"
                ),
            }
        ),
        JudilibreHistoryPage.model_validate(
            {
                "transactions": [{"id": "decision-c", "action": "updated", "date": "2025-05-15T10:01:00Z"}],
                "page_size": 10,
                "total": 1,
                "query_date": "2025-05-15T11:00:02Z",
                "next_page": None,
            }
        ),
    ]
    repository = FakeRepository()
    client = FakeClient(_decision(), pages=pages)
    ingestor = JudilibreOutcomeIngestor(
        client=client,
        repository=repository,
        service=FakeService(),
    )

    summary = ingestor.sync(since=date(2025, 5, 1), max_pages=1)

    assert summary.pages == 3
    assert summary.created_or_updated == 3
    assert summary.scan_complete is True
    assert summary.checkpoint_advanced is True
    assert client.decision_ids == ["decision-a", "decision-b", "decision-c"]
    assert repository.checkpoints[0]["source_cursor"]["scan_complete"] is True


def test_sync_uses_earliest_page_query_date_as_overlap_watermark() -> None:
    pages = [
        JudilibreHistoryPage.model_validate(
            {
                "transactions": [{"id": "decision-a", "action": "deleted", "date": "2025-05-15T10:00:00Z"}],
                "page_size": 10,
                "total": 2,
                "query_date": "2025-05-15T11:00:00Z",
                "next_page": "date=2025-05-01T00%3A00%3A00Z&page_size=10&from_id=next",
            }
        ),
        JudilibreHistoryPage.model_validate(
            {
                "transactions": [{"id": "decision-b", "action": "deleted", "date": "2025-05-15T10:01:00Z"}],
                "page_size": 10,
                "total": 2,
                "query_date": "2025-05-15T11:00:03Z",
                "next_page": None,
            }
        ),
    ]
    repository = FakeRepository()
    ingestor = JudilibreOutcomeIngestor(
        client=FakeClient(_decision(), pages=pages),
        repository=repository,
        service=FakeService(),
    )

    summary = ingestor.sync(since=date(2025, 5, 1), max_pages=2)

    assert summary.checkpoint_advanced is True
    assert repository.checkpoints[0]["source_cursor"]["date"] == "2025-05-15T11:00:00Z"


@pytest.mark.parametrize(
    ("kwargs", "message"),
    [
        ({"max_pages": 0}, "max_pages"),
        ({"max_records": 0}, "max_records"),
        ({"stream_key": "  "}, "stream_key"),
    ],
)
def test_sync_rejects_invalid_bounds_before_policy_or_network(
    kwargs: dict[str, object],
    message: str,
) -> None:
    repository = FakeRepository()
    client = FakeClient(_decision())
    ingestor = JudilibreOutcomeIngestor(
        client=client,
        repository=repository,
        service=FakeService(),
    )

    with pytest.raises(ValueError, match=message):
        ingestor.sync(since=date(2025, 5, 1), **kwargs)

    assert repository.policies == []
    assert client.events == []


def test_sync_consumes_short_lived_history_cursors_before_fetching_decisions() -> None:
    pages = [
        JudilibreHistoryPage.model_validate(
            {
                "transactions": [{"id": "decision-a", "action": "updated", "date": "2025-05-15T10:00:00Z"}],
                "page_size": 10,
                "total": 2,
                "query_date": "2025-05-15T11:00:00Z",
                "next_page": "date=2025-05-01T00%3A00%3A00Z&page_size=10&from_id=next",
            }
        ),
        JudilibreHistoryPage.model_validate(
            {
                "transactions": [{"id": "decision-b", "action": "updated", "date": "2025-05-15T10:01:00Z"}],
                "page_size": 10,
                "total": 2,
                "query_date": "2025-05-15T11:00:00Z",
                "next_page": None,
            }
        ),
    ]
    repository = FakeRepository()
    client = FakeClient(_decision(), pages=pages)
    ingestor = JudilibreOutcomeIngestor(
        client=client,
        repository=repository,
        service=FakeService(),
    )

    summary = ingestor.sync(since=date(2025, 5, 1), max_pages=2)

    assert summary.checkpoint_advanced is True
    assert client.events == [
        "history:1",
        "history:2",
        "decision:decision-a",
        "decision:decision-b",
    ]


def test_sync_filters_national_history_to_one_batch_of_tracked_ids() -> None:
    page = JudilibreHistoryPage.model_validate(
        {
            "transactions": [
                {"id": "tracked-a", "action": "updated", "date": "2025-05-15T10:00:00Z"},
                {"id": "tracked-b", "action": "deleted", "date": "2025-05-15T10:01:00Z"},
                {"id": "new-c", "action": "created", "date": "2025-05-15T10:02:00Z"},
                {"id": "new-d", "action": "deleted", "date": "2025-05-15T10:03:00Z"},
                {"id": "new-c", "action": "updated", "date": "2025-05-15T10:04:00Z"},
            ],
            "page_size": 10,
            "total": 5,
            "query_date": "2025-05-15T11:00:00Z",
            "next_page": None,
        }
    )
    repository = FakeRepository(tracked_ids={"tracked-a", "tracked-b"})
    client = FakeClient(_decision(), pages=[page])
    ingestor = JudilibreOutcomeIngestor(
        client=client,
        repository=repository,
        service=FakeService(),
    )

    summary = ingestor.sync(since=date(2025, 5, 1))

    assert summary.created_or_updated == 1
    assert summary.deletions == 1
    assert summary.ignored_untracked == 3
    assert summary.checkpoint_advanced is True
    assert client.decision_ids == ["tracked-a"]
    assert [item["external_record_id"] for item in repository.deletions] == ["tracked-b"]
    assert repository.source_record_id_lookups == [
        (
            "judilibre",
            ["tracked-a", "tracked-b", "new-c", "new-d", "new-c"],
        )
    ]


def test_sync_can_checkpoint_a_terminal_chain_containing_only_untracked_ids() -> None:
    page = JudilibreHistoryPage.model_validate(
        {
            "transactions": [
                {"id": "new-a", "action": "created", "date": "2025-05-15T10:00:00Z"},
                {"id": "new-b", "action": "deleted", "date": "2025-05-15T10:01:00Z"},
            ],
            "page_size": 10,
            "total": 2,
            "query_date": "2025-05-15T11:00:00Z",
            "next_page": None,
        }
    )
    repository = FakeRepository(tracked_ids=set())
    client = FakeClient(_decision(), pages=[page])
    ingestor = JudilibreOutcomeIngestor(
        client=client,
        repository=repository,
        service=FakeService(),
    )

    summary = ingestor.sync(since=date(2025, 5, 1))

    assert summary.ignored_untracked == 2
    assert summary.created_or_updated == 0
    assert summary.deletions == 0
    assert summary.checkpoint_advanced is True
    assert client.decision_ids == []
    assert repository.deletions == []


def test_targeted_search_profiles_and_bounds_are_closed() -> None:
    assert set(JUDILIBRE_SEARCH_PROFILES) == {
        "saisie_immobiliere_v1",
        "vente_forcee_v1",
        "adjudication_v1",
        "surenchere_v1",
    }
    profile = validate_judilibre_search_request(
        profile="saisie_immobiliere_v1",
        date_start=date(2025, 5, 1),
        date_end=date(2025, 5, 31),
        max_results=500,
        today=date(2025, 6, 1),
    )
    assert profile.query == "saisie immobilière"
    assert profile.jurisdictions == ("tj",)
    assert profile.operator == "exact"

    invalid_requests = [
        {"profile": "unknown", "date_start": date(2025, 5, 1), "date_end": date(2025, 5, 1), "max_results": 1},
        {
            "profile": "adjudication_v1",
            "date_start": date(2025, 5, 2),
            "date_end": date(2025, 5, 1),
            "max_results": 1,
        },
        {
            "profile": "adjudication_v1",
            "date_start": date(2025, 3, 31),
            "date_end": date(2025, 5, 1),
            "max_results": 1,
        },
        {
            "profile": "adjudication_v1",
            "date_start": date(2025, 5, 1),
            "date_end": date(2025, 5, 2),
            "max_results": 501,
        },
        {
            "profile": "adjudication_v1",
            "date_start": date(2025, 5, 1),
            "date_end": date(2025, 6, 2),
            "max_results": 1,
        },
    ]
    for request in invalid_requests:
        with pytest.raises(ValueError):
            validate_judilibre_search_request(**request, today=date(2025, 6, 1))


def test_targeted_search_buffers_complete_metadata_then_persists_with_provenance() -> None:
    search_pages = [
        _search_page(
            page=0,
            page_size=2,
            identifiers=("decision-a", "decision-b"),
            total=3,
            next_page="opaque-next-page",
        ),
        _search_page(
            page=1,
            page_size=2,
            identifiers=("decision-c",),
            total=3,
        ),
    ]
    repository = FakeRepository()
    service = FakeService()
    client = FakeClient(_decision(), search_pages=search_pages)
    ingestor = JudilibreOutcomeIngestor(client=client, repository=repository, service=service)

    summary = ingestor.sync_targeted_search(
        profile="adjudication_v1",
        date_start=date(2025, 5, 1),
        date_end=date(2025, 5, 31),
        max_results=10,
    )

    assert summary.pages == 2
    assert summary.metadata_examined == 3
    assert summary.reported_total == 3
    assert summary.selected_decisions == 3
    assert summary.stored_versions == 3
    assert summary.truncated is False
    assert summary.checkpoint_advanced is True
    assert client.events == [
        "search:0",
        "search:1",
        "decision:decision-a",
        "decision:decision-b",
        "decision:decision-c",
    ]
    first_query = client.search_queries[0]
    assert first_query.query == "adjudication"
    assert first_query.operator == "exact"
    assert first_query.jurisdiction == ["tj"]
    assert first_query.field == ["dispositif", "motivations", "expose", "sommaire"]
    first_record = service.records[0]
    assert first_record.source_cursor["profile_id"] == "adjudication_v1"
    assert first_record.source_cursor["result_rank"] == 0
    assert first_record.source_cursor["reported_total"] == 3
    assert first_record.request_parameters["discovery_query"]["query"] == "adjudication"
    assert first_record.request_parameters["id"] == "decision-a"
    serialized_provenance = str((first_record.source_cursor, first_record.request_parameters))
    assert "Mme Exemple" not in serialized_provenance
    assert "Donnée sensible" not in serialized_provenance
    checkpoint = repository.checkpoints[0]
    assert checkpoint["stream_key"] == ("targeted_search:adjudication_v1:2025-05-01:2025-05-31")
    assert checkpoint["source_cursor"]["metadata_complete"] is True
    assert checkpoint["watermark_at"] == datetime(2025, 6, 1, tzinfo=UTC)


def test_targeted_search_refuses_truncation_without_decision_fetch_or_checkpoint() -> None:
    repository = FakeRepository()
    service = FakeService()
    client = FakeClient(
        _decision(),
        search_pages=[
            _search_page(
                page=0,
                page_size=2,
                identifiers=("decision-a", "decision-b"),
                total=11,
                next_page="opaque-next-page",
            )
        ],
    )
    ingestor = JudilibreOutcomeIngestor(client=client, repository=repository, service=service)

    summary = ingestor.sync_targeted_search(
        profile="adjudication_v1",
        date_start=date(2025, 5, 1),
        date_end=date(2025, 5, 31),
        max_results=10,
    )

    assert summary.truncated is True
    assert summary.reported_total == 11
    assert summary.metadata_examined == 2
    assert summary.selected_decisions == 0
    assert client.decision_ids == []
    assert service.records == []
    assert repository.checkpoints == []


def test_targeted_search_rejects_relaxed_results_without_checkpoint() -> None:
    repository = FakeRepository()
    client = FakeClient(
        _decision(),
        search_pages=[
            _search_page(
                page=0,
                page_size=1,
                identifiers=("decision-a",),
                total=1,
                relaxed=True,
            )
        ],
    )
    ingestor = JudilibreOutcomeIngestor(
        client=client,
        repository=repository,
        service=FakeService(),
    )

    with pytest.raises(OfficialSourceConfigurationError, match="relaxed"):
        ingestor.sync_targeted_search(
            profile="adjudication_v1",
            date_start=date(2025, 5, 1),
            date_end=date(2025, 5, 31),
            max_results=1,
        )

    assert client.decision_ids == []
    assert repository.checkpoints == []


def test_targeted_search_does_not_checkpoint_after_persistence_failure() -> None:
    repository = FakeRepository()
    client = FakeClient(
        _decision(),
        search_pages=[
            _search_page(
                page=0,
                page_size=1,
                identifiers=("decision-a",),
                total=1,
            )
        ],
    )
    ingestor = JudilibreOutcomeIngestor(
        client=client,
        repository=repository,
        service=FakeService(fail=True),
    )

    with pytest.raises(RuntimeError, match="persistence failed"):
        ingestor.sync_targeted_search(
            profile="adjudication_v1",
            date_start=date(2025, 5, 1),
            date_end=date(2025, 5, 31),
            max_results=1,
        )

    assert repository.checkpoints == []


def test_targeted_search_can_checkpoint_an_empty_complete_window() -> None:
    repository = FakeRepository()
    client = FakeClient(
        _decision(),
        search_pages=[_search_page(page=0, page_size=1, identifiers=(), total=0)],
    )
    ingestor = JudilibreOutcomeIngestor(
        client=client,
        repository=repository,
        service=FakeService(),
    )

    summary = ingestor.sync_targeted_search(
        profile="surenchere_v1",
        date_start=date(2025, 5, 1),
        date_end=date(2025, 5, 1),
        max_results=1,
    )

    assert summary.metadata_examined == 0
    assert summary.selected_decisions == 0
    assert summary.checkpoint_advanced is True
    assert len(repository.checkpoints) == 1


def test_targeted_search_rejects_bounds_before_policy_or_network() -> None:
    repository = FakeRepository()
    client = FakeClient(_decision())
    ingestor = JudilibreOutcomeIngestor(
        client=client,
        repository=repository,
        service=FakeService(),
    )

    with pytest.raises(ValueError, match="31 days"):
        ingestor.sync_targeted_search(
            profile="adjudication_v1",
            date_start=date(2025, 1, 1),
            date_end=date(2025, 2, 1),
            max_results=10,
        )

    assert repository.policies == []
    assert client.events == []
