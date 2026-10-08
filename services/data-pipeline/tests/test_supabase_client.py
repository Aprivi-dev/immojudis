import hashlib
import json
import os
from contextlib import nullcontext
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest

from src.court_competence import CompetentCourtAssignment
from src.enrichment.display_quality import DISPLAY_QUALITY_VERSION
from src.models import AuctionSale
from src.normalize import normalize_sale
from src.reviewed_aliases import registry_from_rows
from src.storage import supabase_client
from src.storage.supabase_client import (
    POSTGREST_MAX_PAYLOAD_DEPTH,
    _sanitize_postgrest_payload,
    _secondary_source_urls,
)

_REAL_FETCH_REVIEWED_ALIAS_REGISTRY = supabase_client._fetch_reviewed_alias_registry


@pytest.fixture(autouse=True)
def isolate_enrichment_queue(monkeypatch):
    monkeypatch.setattr(supabase_client, "_enqueue_due_enrichment", lambda *args: None)
    # Claim persistence has its own focused tests below; catalogue publication
    # tests should not make network calls for the additive evidence table.
    monkeypatch.setattr(supabase_client, "_write_fact_claims_rest", lambda *args: 0)
    monkeypatch.setattr(
        supabase_client,
        "_fetch_reviewed_alias_registry",
        lambda *args: registry_from_rows([]),
    )


def test_finish_enrichment_respects_retry_after_and_exact_lease(monkeypatch):
    captured = {}

    def patch(url, **kwargs):
        captured.update(kwargs)
        return httpx.Response(200, json=[{"id": "job"}], request=httpx.Request('PATCH', url))

    monkeypatch.setattr(supabase_client, 'load_settings', lambda: {'supabase_url':'https://supabase.test','supabase_service_role_key':'test-only'})
    monkeypatch.setattr(supabase_client.httpx, 'patch', patch)
    lease = datetime(2026, 9, 13, tzinfo=UTC)
    retry_at = datetime(2099, 1, 1, tzinfo=UTC)
    assert supabase_client.finish_auction_enrichment_job_in_supabase(
        'job', succeeded=False, attempt_count=1, locked_at=lease, retry_not_before=retry_at.isoformat()
    ) is True
    assert captured['params'] == {'select': 'id', 'id':'eq.job','status':'eq.running','attempt_count':'eq.1','locked_at':f'eq.{lease.isoformat()}'}
    assert captured['headers']['Prefer'] == 'return=representation'
    assert captured['json']['next_attempt_at'] == retry_at.isoformat()


def test_finish_enrichment_reports_lost_lease(monkeypatch):
    monkeypatch.setattr(
        supabase_client,
        'load_settings',
        lambda: {'supabase_url': 'https://supabase.test', 'supabase_service_role_key': 'test-only'},
    )
    monkeypatch.setattr(
        supabase_client.httpx,
        'patch',
        lambda url, **kwargs: httpx.Response(200, json=[], request=httpx.Request('PATCH', url)),
    )

    assert supabase_client.finish_auction_enrichment_job_in_supabase(
        'job', succeeded=False, cancelled=True, attempt_count=2, locked_at='2026-09-13T08:00:00+00:00'
    ) is False


@pytest.mark.parametrize("response_body", [[{}], [{"id": "other-job"}], [{"id": "job"}, {"id": "job"}], "malformed"])
def test_finish_enrichment_requires_exact_cas_receipt(monkeypatch, response_body):
    monkeypatch.setattr(
        supabase_client,
        'load_settings',
        lambda: {'supabase_url': 'https://supabase.test', 'supabase_service_role_key': 'test-only'},
    )

    def patch(url, **kwargs):
        if response_body == "malformed":
            return httpx.Response(200, content=b"not-json", request=httpx.Request('PATCH', url))
        return httpx.Response(200, json=response_body, request=httpx.Request('PATCH', url))

    monkeypatch.setattr(supabase_client.httpx, 'patch', patch)
    assert supabase_client.finish_auction_enrichment_job_in_supabase('job', succeeded=True) is (
        response_body == [{"id": "job"}]
    )


def test_pdf_prerequisite_lookup_ignores_exhausted_jobs(monkeypatch) -> None:
    monkeypatch.setattr(
        supabase_client,
        "load_settings",
        lambda: {
            "supabase_url": "https://supabase.test",
            "supabase_service_role_key": "test-only",
        },
    )
    seen = []
    rows = [
        {"status": "failed", "attempt_count": 4, "max_attempts": 4},
        {"status": "queued", "attempt_count": 1, "max_attempts": 4},
    ]

    def fake_get(url, **kwargs):
        seen.append(kwargs["params"])
        return httpx.Response(200, json=rows, request=httpx.Request("GET", url))

    monkeypatch.setattr(supabase_client.httpx, "get", fake_get)
    assert supabase_client.has_eligible_pdf_job_for_sale("https://example.test/sale")
    rows.pop()
    assert not supabase_client.has_eligible_pdf_job_for_sale("https://example.test/sale")
    rows[0]["status"] = "running"
    assert supabase_client.has_eligible_pdf_job_for_sale("https://example.test/sale")
    assert seen[0]["source_url"] == "eq.https://example.test/sale"


def test_postgrest_upsert_batch_retries_cloudflare_520(monkeypatch) -> None:
    responses = iter(
        [
            httpx.Response(520, request=httpx.Request("POST", "https://supabase.test/rest/v1/properties")),
            httpx.Response(201, request=httpx.Request("POST", "https://supabase.test/rest/v1/properties")),
        ]
    )
    attempts: list[int] = []

    def fake_post(*args, **kwargs):
        attempts.append(1)
        return next(responses)

    monkeypatch.setattr(supabase_client.httpx, "post", fake_post)
    monkeypatch.setattr(supabase_client.time, "sleep", lambda _seconds: None)

    response = supabase_client._postgrest_upsert_batch(
        "https://supabase.test/rest/v1/properties",
        "secret",
        "properties",
        [{"source_url": "https://example.test/sale"}],
        "source_url",
    )

    assert response.status_code == 201
    assert len(attempts) == 2


def test_postgrest_read_retries_cloudflare_521(monkeypatch) -> None:
    responses = iter(
        [
            httpx.Response(521, request=httpx.Request("GET", "https://supabase.test/rest/v1/auction_sales")),
            httpx.Response(200, request=httpx.Request("GET", "https://supabase.test/rest/v1/auction_sales")),
        ]
    )
    attempts = []
    monkeypatch.setattr(supabase_client.httpx, "get", lambda *_args, **_kwargs: attempts.append(1) or next(responses))
    monkeypatch.setattr(supabase_client.time, "sleep", lambda _seconds: None)

    response = supabase_client._postgrest_request_with_retries(
        "GET", "https://supabase.test/rest/v1/auction_sales", "known_sale_details"
    )

    assert response.status_code == 200
    assert len(attempts) == 2


def test_known_sale_preflight_uses_postgres_when_configured(monkeypatch) -> None:
    alias_id = "00000000-0000-0000-0000-000000000081"
    canonical_id = "00000000-0000-0000-0000-000000000082"
    alias_url = "https://cessions.test/mn222"
    canonical_url = "https://notaires.test/mn222"
    monkeypatch.setattr(supabase_client, "load_settings", lambda: {
        "supabase_url": "https://supabase.test",
        "supabase_service_role_key": "secret",
        "supabase_db_url": "postgresql://test",
    })

    class FakeDb:
        isolation = False

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def execute(self, query, params=None):
            if query == "set transaction isolation level repeatable read":
                self.isolation = True
                return SimpleNamespace(fetchall=lambda: [])
            if "to_regclass" in query and "to_regprocedure" in query:
                return SimpleNamespace(
                    fetchone=lambda: (
                        "app_private.auction_sale_source_presence",
                        "app_private.auction_sale_source_presence_json(uuid)",
                    )
                )
            if "list_reviewed_publication_aliases" in query:
                return SimpleNamespace(fetchall=lambda: [(
                    alias_id, canonical_id, alias_url, canonical_url,
                    "reviewed-pair", {}, "2026-09-13T08:33:51Z", "test",
                )])
            assert "select to_jsonb(sale)" in query
            assert "jsonb_build_object" in query
            assert "raw_payload->'source_checks'" in query
            assert "auction_sale_source_presence_json(id)" in query
            assert params == (supabase_client.KNOWN_SALE_DETAIL_PAGE_SIZE,)
            return SimpleNamespace(fetchall=lambda: [
                ({"id": alias_id, "source_url": alias_url, "source_urls": [],
                  "raw_payload": {
                      "source_checks": {alias_url: {"checked_at": "now"}},
                      "source_presence": {"licitor": {"availability": "available"}},
                  }},),
                ({"id": canonical_id, "source_url": canonical_url, "source_urls": [],
                  "raw_payload": {
                      "source_checks": {canonical_url: {"checked_at": "now"}},
                      "source_presence": {"licitor": {"availability": "available"}},
                  }},),
            ])

    databases = []

    def fake_connect(_url):
        database = FakeDb()
        databases.append(database)
        return database

    monkeypatch.setattr(supabase_client, "_postgres_connect", fake_connect)
    monkeypatch.setattr(supabase_client.httpx, "get", lambda *_a, **_kw: pytest.fail("REST preflight used"))

    details = supabase_client.fetch_known_sale_details()

    assert details[alias_url]["id"] == canonical_id
    assert details[canonical_url]["id"] == canonical_id
    assert details[canonical_url]["raw_payload"] == {
        "source_checks": {canonical_url: {"checked_at": "now"}},
        "source_presence": {"licitor": {"availability": "available"}},
    }
    assert databases[0].isolation is True


def test_known_sale_projection_keeps_source_contract_and_compact_presence() -> None:
    required = {
        "source_property_features",
        "source_property_feature_evidence",
        "source_property_features_meta",
        "source_procedure_profile",
        "source_field_observations",
        "source_evidence",
        "source_evidence_provenance",
        "source_energy_diagnostics",
        "source_sale_schedule",
        "date_precision",
        "sale_date_precision",
        "operator_land_surface_conflict",
        "operator_land_surface_scope",
        "source_display_constraints",
        "geocode",
        "tribunal_assignment",
    }

    assert required.issubset(set(supabase_client.KNOWN_SALE_RAW_PAYLOAD_KEYS))
    for field in (
        "latitude",
        "longitude",
        "risk_notes",
        "investment_score",
        "investment_summary",
    ):
        assert field in supabase_client.KNOWN_SALE_DETAIL_SELECT.split(",")
    compact_select = supabase_client._known_sale_postgres_select(compact_presence=True)
    assert "app_private.auction_sale_source_presence_json(id)" in compact_select
    for key in required:
        assert f"raw_payload->'{key}'" in compact_select


def test_known_sale_index_projection_omits_enrichment_payload() -> None:
    index_select = supabase_client._known_sale_postgres_select(
        compact_presence=True,
        include_enrichment_payload=False,
    )

    assert "raw_payload->'source_checks'" in index_select
    assert "raw_payload->'source_evidence'" not in index_select
    assert "raw_payload->'llm_display_description'" not in index_select
    assert "auction_sale_source_presence_json(id)" in index_select


def test_fetch_known_sale_details_filters_direct_rows_for_payload_hydration(monkeypatch) -> None:
    source_url = "https://example.test/observed"
    monkeypatch.setattr(
        supabase_client,
        "load_settings",
        lambda: {
            "supabase_url": "https://supabase.test",
            "supabase_service_role_key": "secret",
            "supabase_db_url": "postgresql://test",
        },
    )
    calls: list[tuple[str, object]] = []

    class FakeDb:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def execute(self, query, params=None):
            calls.append((query, params))
            if query == "set transaction isolation level repeatable read":
                return SimpleNamespace(fetchall=lambda: [])
            if "to_regclass" in query and "to_regprocedure" in query:
                return SimpleNamespace(fetchone=lambda: (None, None))
            if "list_reviewed_publication_aliases" in query:
                return SimpleNamespace(fetchall=lambda: [])
            assert "source_url = any(%s::text[])" in query
            assert "source_urls ?| %s" in query
            assert "raw_payload->'source_evidence'" in query
            assert params == ([source_url], [source_url], supabase_client.KNOWN_SALE_DETAIL_PAGE_SIZE)
            return SimpleNamespace(fetchall=lambda: [(
                {
                    "id": "00000000-0000-0000-0000-000000000099",
                    "source_url": source_url,
                    "source_urls": [],
                    "raw_payload": {"source_evidence": {"url": source_url}},
                },
            )])

    monkeypatch.setattr(supabase_client, "_postgres_connect", lambda _url: FakeDb())

    details = supabase_client.fetch_known_sale_details(
        source_urls=[source_url],
        include_enrichment_payload=True,
    )

    assert details[source_url]["raw_payload"] == {"source_evidence": {"url": source_url}}
    assert len(calls) == 4


def test_fetch_known_sale_details_hydrates_reviewed_alias_canonical_row(monkeypatch) -> None:
    alias_id = "00000000-0000-0000-0000-000000000101"
    canonical_id = "00000000-0000-0000-0000-000000000102"
    alias_url = "https://example.test/alias"
    canonical_url = "https://example.test/canonical"
    monkeypatch.setattr(
        supabase_client,
        "load_settings",
        lambda: {
            "supabase_url": "https://supabase.test",
            "supabase_service_role_key": "secret",
            "supabase_db_url": "postgresql://test",
        },
    )

    class FakeDb:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def execute(self, query, params=None):
            if query == "set transaction isolation level repeatable read":
                return SimpleNamespace(fetchall=lambda: [])
            if "to_regclass" in query and "to_regprocedure" in query:
                return SimpleNamespace(fetchone=lambda: (None, None))
            if "list_reviewed_publication_aliases" in query:
                return SimpleNamespace(fetchall=lambda: [(
                    alias_id,
                    canonical_id,
                    alias_url,
                    canonical_url,
                    "reviewed-alias",
                    {},
                    "2026-10-08T00:00:00Z",
                    "test",
                )])
            assert "id = any(%s::uuid[])" in query
            assert params == ([alias_url], [alias_url], [canonical_id], supabase_client.KNOWN_SALE_DETAIL_PAGE_SIZE)
            return SimpleNamespace(fetchall=lambda: [(
                {
                    "id": canonical_id,
                    "source_url": canonical_url,
                    "source_urls": [],
                    "raw_payload": {"llm_display_description": "preserved"},
                },
            )])

    monkeypatch.setattr(supabase_client, "_postgres_connect", lambda _url: FakeDb())

    details = supabase_client.fetch_known_sale_details(
        source_urls=[alias_url],
        include_enrichment_payload=True,
    )

    assert details[alias_url]["id"] == canonical_id
    assert details[alias_url]["raw_payload"] == {"llm_display_description": "preserved"}


def test_known_sale_projection_executes_in_disposable_postgres() -> None:
    url = os.getenv("PIPELINE_TEST_DB_URL")
    if not url:
        pytest.skip("Requires disposable PostgreSQL")

    from psycopg.types.json import Jsonb

    payload = {
        "source_checks": {"example": {"checked_at": "now"}},
        "source_property_features": {"surface_m2": 100},
        "source_presence": None,
        "llm_display_description": None,
        "unlisted_payload": {"must_not_be_forwarded": True},
    }
    with supabase_client._postgres_connect(url) as db:
        row = db.execute(
            "select "
            f"{supabase_client.KNOWN_SALE_RAW_PAYLOAD_PROJECTION} "
            "from (values (%s::jsonb)) as input(raw_payload)",
            (Jsonb(payload),),
        ).fetchone()

    assert row == ({
        "source_checks": {"example": {"checked_at": "now"}},
        "source_property_features": {"surface_m2": 100},
    },)


def test_run_lifecycle_uses_postgres_after_cloudflare_521(monkeypatch) -> None:
    monkeypatch.setattr(supabase_client, "load_settings", lambda: {
        "supabase_url": "https://supabase.test",
        "supabase_service_role_key": "secret",
        "supabase_db_url": "postgresql://test",
    })
    monkeypatch.setattr(
        supabase_client,
        "_postgrest_request_with_retries",
        lambda *_args, **_kwargs: httpx.Response(521, request=httpx.Request("PATCH", "https://supabase.test")),
    )
    calls = []

    class FakeDb:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def execute(self, query, params):
            calls.append((query, params))
            return SimpleNamespace(fetchone=lambda: ("run-1",))

    monkeypatch.setattr(supabase_client, "_postgres_connect", lambda _url: FakeDb())

    assert supabase_client.start_existing_run_in_supabase("run-1", "all", True) == "run-1"
    supabase_client.finish_run_in_supabase(
        "run-1", "failed", {"stage": "known_sale_lookup", "amount": Decimal("12.5")},
        {"supabase": ["lookup\x00 failed"]},
    )

    assert len(calls) == 2
    assert "status='running'" in calls[0][0]
    assert calls[0][1] == ("all", True, "run-1")
    assert "summary=coalesce(summary" in calls[1][0]
    assert calls[1][1][0] == "failed"
    assert calls[1][1][1].obj == {"stage": "known_sale_lookup", "amount": 12.5}
    assert calls[1][1][2].obj == {"supabase": ["lookup failed"]}
    assert calls[1][1][-1] == "run-1"


def test_run_start_payloads_use_one_deterministic_updated_at(monkeypatch) -> None:
    frozen = datetime(2026, 10, 1, 9, 30, tzinfo=UTC)
    monkeypatch.setattr(supabase_client, "datetime", SimpleNamespace(now=lambda _tz: frozen))
    monkeypatch.setattr(
        supabase_client,
        "load_settings",
        lambda: {
            "supabase_url": "https://supabase.test",
            "supabase_service_role_key": "secret",
        },
    )
    requests: list[tuple[str, dict[str, object]]] = []

    def fake_request(method, endpoint, table, **kwargs):
        requests.append((method, kwargs["json"]))
        if method == "POST":
            return httpx.Response(201, json=[{"id": "run-new"}], request=httpx.Request(method, endpoint))
        return httpx.Response(204, request=httpx.Request(method, endpoint))

    monkeypatch.setattr(supabase_client, "_postgrest_request_with_retries", fake_request)

    assert supabase_client.create_run_in_supabase("all", True) == "run-new"
    assert supabase_client.start_existing_run_in_supabase("run-existing", "all", True) == "run-existing"

    expected = frozen.isoformat()
    assert requests == [
        (
            "POST",
            {
                "status": "running",
                "source": "all",
                "use_llm": True,
                "started_at": expected,
                "updated_at": expected,
            },
        ),
        (
            "PATCH",
            {
                "status": "running",
                "source": "all",
                "use_llm": True,
                "started_at": expected,
                "finished_at": None,
                "updated_at": expected,
            },
        ),
    ]


def test_run_progress_payload_includes_deterministic_updated_at(monkeypatch) -> None:
    frozen = datetime(2026, 10, 1, 9, 31, tzinfo=UTC)
    monkeypatch.setattr(supabase_client, "datetime", SimpleNamespace(now=lambda _tz: frozen))
    monkeypatch.setattr(
        supabase_client,
        "load_settings",
        lambda: {
            "supabase_url": "https://supabase.test",
            "supabase_service_role_key": "secret",
        },
    )
    captured: dict[str, object] = {}

    def fake_request(method, endpoint, table, **kwargs):
        captured.update(kwargs)
        return httpx.Response(204, request=httpx.Request(method, endpoint))

    monkeypatch.setattr(supabase_client, "_postgrest_request_with_retries", fake_request)

    supabase_client.update_run_progress_in_supabase(
        "run-progress",
        {"mode": "llm_description_backfill", "completed": 1},
        {"llm_backfill": []},
    )

    assert captured["json"] == {
        "summary": {"mode": "llm_description_backfill", "completed": 1},
        "errors": {"llm_backfill": []},
        "updated_at": frozen.isoformat(),
    }


def test_run_finish_payload_includes_deterministic_updated_at(monkeypatch) -> None:
    frozen = datetime(2026, 10, 1, 9, 32, tzinfo=UTC)
    monkeypatch.setattr(supabase_client, "datetime", SimpleNamespace(now=lambda _tz: frozen))
    monkeypatch.setattr(
        supabase_client,
        "load_settings",
        lambda: {
            "supabase_url": "https://supabase.test",
            "supabase_service_role_key": "secret",
        },
    )
    captured: dict[str, object] = {}

    def fake_request(method, endpoint, table, **kwargs):
        captured.update(kwargs)
        return httpx.Response(204, request=httpx.Request(method, endpoint))

    monkeypatch.setattr(supabase_client, "_postgrest_request_with_retries", fake_request)

    supabase_client.finish_run_in_supabase(
        "run-finish",
        "succeeded",
        {"stage": "complete"},
        {"runner": []},
    )

    assert captured["json"] == {
        "status": "succeeded",
        "finished_at": frozen.isoformat(),
        "updated_at": frozen.isoformat(),
        "summary": {"stage": "complete"},
        "errors": {"runner": []},
    }


def test_sanitize_postgrest_payload_removes_null_characters_recursively() -> None:
    payload = {
        "result": [
            {
                "text": "surface\x00 habitable",
                "pages": [{"text": "page\x00 1"}, {"confidence": 0.7}],
            }
        ],
        "untouched": None,
        "decimal_values": [Decimal("187"), Decimal("39.67")],
    }

    assert _sanitize_postgrest_payload(payload) == {
        "result": [
            {
                "text": "surface habitable",
                "pages": [{"text": "page 1"}, {"confidence": 0.7}],
            }
        ],
        "untouched": None,
        "decimal_values": [187, 39.67],
    }


def test_sanitize_postgrest_payload_allows_finite_aliases() -> None:
    shared = {"value": "same object"}
    payload = {"first": shared, "second": [shared]}

    assert _sanitize_postgrest_payload(payload) == {
        "first": {"value": "same object"},
        "second": [{"value": "same object"}],
    }


def test_sanitize_postgrest_payload_rejects_cycles_with_json_path() -> None:
    payload: dict[str, object] = {}
    payload["self"] = payload

    with pytest.raises(ValueError, match=r"cycle detected at root\['self'\].*root"):
        _sanitize_postgrest_payload(payload)


def test_sanitize_postgrest_payload_rejects_excessive_nesting() -> None:
    payload: dict[str, object] = {}
    cursor = payload
    for _ in range(POSTGREST_MAX_PAYLOAD_DEPTH + 1):
        child: dict[str, object] = {}
        cursor["next"] = child
        cursor = child

    with pytest.raises(ValueError, match="maximum nesting depth"):
        _sanitize_postgrest_payload(payload)


def test_secondary_source_urls_excludes_batch_primary_urls() -> None:
    first = normalize_sale(
        {
            "source_name": "vench",
            "source_url": "https://vench.test/rich",
        }
    )
    first.source_urls.append("https://avoventes.test/poor")
    second = normalize_sale(
        {
            "source_name": "licitor",
            "source_url": "https://licitor.test/keep",
            "source_urls": ["https://licitor.test/keep"],
        }
    )

    assert _secondary_source_urls([first, second]) == ["https://avoventes.test/poor"]


def test_known_signatures_only_include_scored_rows(monkeypatch) -> None:
    monkeypatch.setattr(
        supabase_client,
        "fetch_known_sale_details",
        lambda: {
            "https://example.test/scored": {
                "_signature": "2027-01-10|100000",
                "score_version": "v1",
            },
            "https://example.test/unscored": {
                "_signature": "2027-01-11|200000",
                "score_version": None,
            },
        },
    )

    assert supabase_client.fetch_known_sale_signatures() == {
        "https://example.test/scored": "2027-01-10|100000"
    }


def test_fetch_known_sale_details_uses_bounded_pages(monkeypatch) -> None:
    monkeypatch.setattr(
        supabase_client,
        "load_settings",
        lambda: {"supabase_url": "https://supabase.test", "supabase_service_role_key": "secret"},
    )
    calls: list[tuple[str, str]] = []

    class Response:
        is_error = False
        status_code = 200
        text = ""

        def __init__(self, rows):
            self._rows = rows

        def json(self):
            return self._rows

    first_page = [
        {"source_url": f"https://example.test/{index}", "source_urls": []}
        for index in range(supabase_client.KNOWN_SALE_DETAIL_PAGE_SIZE)
    ]

    def fake_get(endpoint, params, headers, timeout):
        calls.append((params["limit"], params["offset"]))
        return Response(first_page if params["offset"] == "0" else [])

    monkeypatch.setattr(supabase_client.httpx, "get", fake_get)

    details = supabase_client.fetch_known_sale_details()

    assert len(details) == supabase_client.KNOWN_SALE_DETAIL_PAGE_SIZE
    assert calls == [("100", "0"), ("100", "100")]


def test_reviewed_alias_rpc_rejects_non_list_payload(monkeypatch) -> None:
    class Response:
        is_error = False
        status_code = 200

        def json(self):
            return {}

    monkeypatch.setattr(supabase_client.httpx, "post", lambda *args, **kwargs: Response())
    monkeypatch.setattr(
        supabase_client,
        "_fetch_reviewed_alias_registry",
        _REAL_FETCH_REVIEWED_ALIAS_REGISTRY,
    )

    with pytest.raises(supabase_client.ReviewedAliasRegistryError, match="Malformed"):
        supabase_client._fetch_reviewed_alias_registry("https://supabase.test", "secret")


def test_fetch_known_sale_details_overrides_reviewed_alias_after_full_pagination(monkeypatch) -> None:
    alias_id = "00000000-0000-0000-0000-000000000081"
    canonical_id = "00000000-0000-0000-0000-000000000082"
    alias_url = "https://cessions.test/mn222"
    canonical_url = "https://notaires.test/mn222"
    monkeypatch.setattr(
        supabase_client,
        "load_settings",
        lambda: {"supabase_url": "https://supabase.test", "supabase_service_role_key": "secret"},
    )
    monkeypatch.setattr(
        supabase_client,
        "_fetch_reviewed_alias_registry",
        lambda *_args: registry_from_rows(
            [
                (
                    alias_id,
                    canonical_id,
                    alias_url,
                    canonical_url,
                    "agde-mn222",
                    {"audit": "docs/audits/agde-identity-review-20260913.json"},
                    "2026-09-13T08:33:51Z",
                    "test",
                )
            ]
        ),
    )
    monkeypatch.setattr(supabase_client, "KNOWN_SALE_DETAIL_PAGE_SIZE", 1)

    class Response:
        is_error = False
        status_code = 200
        text = ""

        def __init__(self, rows):
            self._rows = rows

        def json(self):
            return self._rows

    pages = {
        "0": [{"id": alias_id, "source_url": alias_url, "source_urls": []}],
        "1": [{"id": canonical_id, "source_url": canonical_url, "source_urls": []}],
        "2": [],
    }
    monkeypatch.setattr(
        supabase_client.httpx,
        "get",
        lambda _endpoint, params, headers, timeout: Response(pages[params["offset"]]),
    )

    details = supabase_client.fetch_known_sale_details()

    assert details[alias_url]["id"] == canonical_id
    assert details[alias_url]["source_url"] == canonical_url


def test_fetch_known_sale_details_raises_instead_of_returning_partial_data(monkeypatch) -> None:
    monkeypatch.setattr(
        supabase_client,
        "load_settings",
        lambda: {"supabase_url": "https://supabase.test", "supabase_service_role_key": "secret"},
    )

    class Response:
        is_error = True
        status_code = 500
        text = "canceling statement due to statement timeout"

    monkeypatch.setattr(supabase_client.httpx, "get", lambda *args, **kwargs: Response())

    with pytest.raises(RuntimeError, match="statement timeout"):
        supabase_client.fetch_known_sale_details()


def test_enriched_hashes_require_current_llm_description_when_requested(monkeypatch) -> None:
    monkeypatch.setattr(
        supabase_client,
        "load_settings",
        lambda: {"supabase_url": "https://supabase.test", "supabase_service_role_key": "secret"},
    )

    class Response:
        is_error = False

        def json(self):
            return [
                {
                    "content_hash": "hash-current",
                    "raw_payload": {
                        "llm_display_description": "Synthèse IA prête. " * 5,
                        "llm_display_quality_version": DISPLAY_QUALITY_VERSION,
                        "llm_display_status": "accepted",
                        "llm_prompt_version": "auction_llm_v5",
                    },
                },
                {
                    "content_hash": "hash-missing",
                    "raw_payload": {
                        "source_description": "Description brute.",
                    },
                },
                {
                    "content_hash": "hash-stale",
                    "raw_payload": {
                        "llm_display_description": "Ancienne synthèse.",
                        "llm_prompt_version": "auction_llm_v4",
                    },
                },
            ]

    def fake_get(endpoint, params, headers, timeout):
        assert endpoint == "https://supabase.test/rest/v1/auction_sales"
        assert params["select"] == "content_hash,raw_payload"
        assert params["score_version"] == "not.is.null"
        return Response()

    monkeypatch.setattr(supabase_client.httpx, "get", fake_get)

    assert supabase_client.fetch_enriched_content_hashes(
        ["hash-current", "hash-missing", "hash-stale"],
        require_llm_description=True,
        prompt_version="auction_llm_v5",
    ) == {"hash-current"}


def test_enriched_hashes_use_compact_postgres_projection(monkeypatch) -> None:
    monkeypatch.setattr(
        supabase_client,
        "load_settings",
        lambda: {
            "supabase_url": "https://supabase.test",
            "supabase_service_role_key": "secret",
            "supabase_db_url": "postgresql://test",
        },
    )
    captured: dict[str, object] = {}

    class Cursor:
        def fetchall(self):
            return [
                (
                    "hash-current",
                    {"coverage_status": "source_only"},
                    "Synthèse IA prête et suffisamment longue pour être publiée sur la fiche. " * 2,
                    DISPLAY_QUALITY_VERSION,
                    "accepted",
                    "auction_llm_v5",
                    "display-v1",
                    "provider/model",
                ),
                ("hash-missing", None, None, None, None, None, None, None),
            ]

    class Database:
        def execute(self, query, params):
            captured["query"] = query
            captured["params"] = params
            return Cursor()

    monkeypatch.setattr(
        supabase_client,
        "_postgres_connect",
        lambda *_args, **_kwargs: nullcontext(Database()),
    )

    assert supabase_client.fetch_enriched_content_hashes(
        ["hash-current", "hash-missing"],
        require_llm_description=True,
        require_document_analysis=True,
        prompt_version="auction_llm_v5",
    ) == {"hash-current"}
    query = str(captured["query"])
    assert "raw_payload->'document_analysis'" in query
    assert "raw_payload,\n" not in query
    assert set(captured["params"][0]) == {"hash-current", "hash-missing"}


def test_enriched_hashes_keep_legacy_score_only_mode(monkeypatch) -> None:
    monkeypatch.setattr(
        supabase_client,
        "load_settings",
        lambda: {"supabase_url": "https://supabase.test", "supabase_service_role_key": "secret"},
    )

    class Response:
        is_error = False

        def json(self):
            return [
                {"content_hash": "hash-current", "raw_payload": {}},
                {"content_hash": "hash-missing", "raw_payload": {}},
            ]

    monkeypatch.setattr(supabase_client.httpx, "get", lambda *args, **kwargs: Response())

    assert supabase_client.fetch_enriched_content_hashes(
        ["hash-current", "hash-missing"],
        require_llm_description=False,
    ) == {"hash-current", "hash-missing"}


def test_enriched_hashes_require_successful_document_analysis_when_requested(monkeypatch) -> None:
    monkeypatch.setattr(
        supabase_client,
        "load_settings",
        lambda: {"supabase_url": "https://supabase.test", "supabase_service_role_key": "secret"},
    )

    class Response:
        is_error = False

        def json(self):
            return [
                {
                    "content_hash": "hash-extracted",
                    "raw_payload": {
                        "document_analysis": {
                            "coverage_status": "partial",
                            "documents_listed": 3,
                            "documents_extracted": 1,
                        }
                    },
                },
                {
                    "content_hash": "hash-source-only",
                    "raw_payload": {
                        "document_analysis": {
                            "coverage_status": "source_only",
                            "documents_listed": 0,
                            "documents_extracted": 0,
                        }
                    },
                },
                {
                    "content_hash": "hash-not-extracted",
                    "raw_payload": {
                        "document_analysis": {
                            "coverage_status": "documents_not_extracted",
                            "documents_listed": 3,
                            "documents_extracted": 0,
                        }
                    },
                },
                {
                    "content_hash": "hash-policy-blocked-current",
                    "raw_payload": {
                        "document_analysis": {
                            "coverage_status": "partial",
                            "documents_listed": 1,
                            "documents_extracted": 0,
                            "failed_documents": 0,
                            "blocked_documents": 1,
                            "blocked_document_urls": ["https://www.licitor.com/data/pub/media/pv.pdf"],
                            "blocked_document_reasons": [{
                                "url": "https://www.licitor.com/data/pub/media/pv.pdf",
                                "reason": "robots.txt disallows fetching this Licitor document",
                            }],
                            "input_fingerprint": "document-fingerprint-current",
                            "checked_at": datetime.now(UTC).isoformat(),
                        }
                    },
                },
                {
                    "content_hash": "hash-policy-blocked-stale",
                    "raw_payload": {
                        "document_analysis": {
                            "coverage_status": "partial",
                            "documents_listed": 1,
                            "documents_extracted": 0,
                            "failed_documents": 0,
                            "blocked_documents": 1,
                            "blocked_document_urls": ["https://www.licitor.com/data/pub/media/pv.pdf"],
                            "blocked_document_reasons": [{
                                "url": "https://www.licitor.com/data/pub/media/pv.pdf",
                                "reason": "robots.txt disallows fetching this Licitor document",
                            }],
                            "input_fingerprint": "document-fingerprint-stale",
                            "checked_at": "2026-01-01T00:00:00+00:00",
                        }
                    },
                },
                {
                    "content_hash": "hash-policy-blocked-without-fingerprint",
                    "raw_payload": {
                        "document_analysis": {
                            "coverage_status": "partial",
                            "documents_listed": 1,
                            "documents_extracted": 0,
                            "failed_documents": 0,
                            "blocked_documents": 1,
                            "blocked_document_urls": ["https://www.licitor.com/data/pub/media/pv.pdf"],
                            "blocked_document_reasons": [{
                                "url": "https://www.licitor.com/data/pub/media/pv.pdf",
                                "reason": "robots.txt disallows fetching this Licitor document",
                            }],
                            "checked_at": datetime.now(UTC).isoformat(),
                        }
                    },
                },
                {"content_hash": "hash-never-analyzed", "raw_payload": {}},
            ]

    monkeypatch.setattr(supabase_client.httpx, "get", lambda *args, **kwargs: Response())

    assert supabase_client.fetch_enriched_content_hashes(
        [
            "hash-extracted",
            "hash-source-only",
            "hash-not-extracted",
            "hash-policy-blocked-current",
            "hash-policy-blocked-stale",
            "hash-policy-blocked-without-fingerprint",
            "hash-never-analyzed",
        ],
        require_document_analysis=True,
    ) == {"hash-extracted", "hash-source-only", "hash-policy-blocked-current"}


def test_fetch_sales_needing_llm_descriptions_filters_current_rows(monkeypatch) -> None:
    monkeypatch.setattr(
        supabase_client,
        "load_settings",
        lambda: {"supabase_url": "https://supabase.test", "supabase_service_role_key": "secret"},
    )
    captured: dict[str, object] = {}

    class Response:
        is_error = False

        def json(self):
            return [
                {
                    "source_name": "avoventes", "starting_price_eur": 10000,
                    "surface_m2": 80,
                    "source_url": "https://example.test/current",
                    "status": "upcoming",
                    "raw_payload": {
                        "llm_display_description": "Synthèse courante. " * 5,
                        "llm_display_quality_version": DISPLAY_QUALITY_VERSION,
                        "llm_display_status": "accepted",
                        "llm_prompt_version": "auction_llm_v6_display",
                    },
                },
                {
                    "source_name": "notaires",
                    "surface_m2": 80,
                    "source_url": "https://example.test/missing",
                    "status": "upcoming",
                    "title": "Maison 85 m²",
                    "raw_payload": {"source_blocks": {"description": "Maison avec jardin."}},
                },
                {
                    "source_name": "encheres_publiques",
                    "surface_m2": 80,
                    "source_url": "https://example.test/stale",
                    "status": "active",
                    "title": "Appartement",
                    "raw_payload": {
                        "llm_display_description": "Ancienne synthèse.",
                        "llm_prompt_version": "auction_llm_v5",
                    },
                },
                {
                    "source_name": "notaires",
                    "surface_m2": 80,
                    "source_url": "https://example.test/recent-failure",
                    "status": "upcoming",
                    "title": "Maison en échec récent",
                    "raw_payload": {
                        "source_blocks": {"description": "Maison."},
                        "llm_display_error_at": datetime.now(UTC).isoformat(),
                        "llm_display_error_prompt_version": "auction_llm_v6_display",
                    },
                },
                {
                    "source_name": "notaires",
                    "surface_m2": 80,
                    "source_url": "https://example.test/old-failure",
                    "status": "upcoming",
                    "title": "Maison en ancien échec",
                    "raw_payload": {
                        "source_blocks": {"description": "Maison."},
                        "llm_display_error_at": (datetime.now(UTC) - timedelta(hours=25)).isoformat(),
                        "llm_display_error_prompt_version": "auction_llm_v6_display",
                    },
                },
            ]

    def fake_get(endpoint, params, headers, timeout):
        captured["endpoint"] = endpoint
        captured["params"] = params
        return Response()

    monkeypatch.setattr(supabase_client.httpx, "get", fake_get)

    sales = supabase_client.fetch_sales_needing_llm_descriptions(
        limit=10,
        prompt_version="auction_llm_v6_display",
        statuses=("active", "upcoming"),
    )

    assert captured["endpoint"] == "https://supabase.test/rest/v1/auction_sales"
    assert captured["params"]["status"] == 'in.("active","upcoming")'
    assert [sale.source_url for sale in sales] == [
        "https://example.test/missing",
        "https://example.test/stale",
        "https://example.test/old-failure",
    ]


def test_legacy_vench_cleanup_does_not_delete_existing_rows(monkeypatch):
    monkeypatch.setattr(supabase_client, "load_settings", lambda: pytest.fail("legacy cleanup accessed DB"))
    assert supabase_client.delete_vench_sales_without_surface_in_supabase() == 0


def test_delete_expired_sales_uses_atomic_retention_rpc(monkeypatch):
    monkeypatch.setattr(supabase_client, "load_settings", lambda: {"supabase_url": "https://supabase.test", "supabase_service_role_key": "test"})
    calls = []
    results = [{"deleted": 25, "remaining": 1, "busy": False}, {"deleted": 1, "remaining": 0, "busy": False}]
    def post(url, **kwargs):
        calls.append((url, kwargs["json"]))
        return httpx.Response(200, json=results.pop(0), request=httpx.Request("POST", url))
    monkeypatch.setattr(supabase_client.httpx, "post", post)
    assert supabase_client.delete_expired_sales_in_supabase(datetime(2026, 7, 9, 12, tzinfo=UTC)) == 26
    assert len(calls) == 2
    assert calls[0] == ("https://supabase.test/rest/v1/rpc/purge_expired_auction_sales", {"p_now": "2026-07-09T12:00:00+00:00", "p_limit": 25})


def test_delete_expired_sales_stops_on_busy(monkeypatch):
    monkeypatch.setattr(supabase_client, "load_settings", lambda: {"supabase_url": "https://supabase.test", "supabase_service_role_key": "test"})
    calls = []
    def post(url, **kwargs):
        calls.append(url)
        return httpx.Response(200, json={"deleted": 0, "remaining": None, "busy": True}, request=httpx.Request("POST", url))
    monkeypatch.setattr(supabase_client.httpx, "post", post)
    assert supabase_client.delete_expired_sales_in_supabase() == 0
    assert len(calls) == 1


def test_upsert_sales_prefers_direct_postgres_when_db_url_is_configured(monkeypatch) -> None:
    monkeypatch.setattr("src.publication_identity.resolve_publication_identities", lambda connection, sales: sales)
    sale = normalize_sale(
        {
            "source_name": "avoventes", "starting_price_eur": 10000,
            "source_url": "https://example.test/sale",
            "source_urls": ["https://example.test/sale"],
            "raw_payload": {"text": "hello\x00"},
        }
    )
    calls: list[tuple[str, str, int]] = []

    monkeypatch.setattr(
        supabase_client,
        "load_settings",
        lambda: {
            "supabase_url": "https://supabase.test",
            "supabase_service_role_key": "secret",
            "supabase_db_url": "postgresql://example",
        },
    )
    monkeypatch.setattr(
        supabase_client,
        "_postgres_upsert",
        lambda db_url, table, payload, on_conflict: calls.append((db_url, table, len(payload))),
    )
    monkeypatch.setattr(
        supabase_client,
        "_delete_secondary_sale_rows_with_postgres",
        lambda *args: (_ for _ in ()).throw(
            AssertionError("upsert must not delete secondary rows before the Outcome Graph bridge")
        ),
    )
    monkeypatch.setattr(
        supabase_client,
        "_sync_normalized_sale_tables_with_rest",
        lambda supabase_url, api_key, sales, now, **kwargs: calls.append(
            (supabase_url, "normalized_tables", len(sales))
        ),
    )
    monkeypatch.setattr(
        supabase_client,
        "_upsert_with_rest",
        lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("REST upsert should not run")),
    )
    monkeypatch.setattr(
        supabase_client,
        "_upsert_asset_tables_with_rest",
        lambda supabase_url, api_key, sales, now: calls.append((supabase_url, "asset_tables", len(sales))),
    )

    monkeypatch.setattr(supabase_client, "_postgres_connect", lambda _: nullcontext(SimpleNamespace(execute=lambda *args: None)))
    monkeypatch.setattr(supabase_client, "_transaction_write", lambda table, payload, conflict: calls.append(("postgresql://example", table, len(payload))))
    assert supabase_client.upsert_sales_to_supabase([sale]) == 1
    assert calls == [
        ("postgresql://example", "auction_sales", 1),
        ("https://supabase.test", "normalized_tables", 1),
        ("https://supabase.test", "asset_tables", 1),
    ]


def test_upsert_sales_via_rest_does_not_delete_secondary_rows(monkeypatch) -> None:
    sale = normalize_sale(
        {
            "source_name": "avoventes", "starting_price_eur": 10000,
            "source_url": "https://example.test/primary",
            "source_urls": [
                "https://example.test/primary",
                "https://example.test/secondary",
            ],
        }
    )
    calls: list[str] = []

    monkeypatch.setattr(
        supabase_client,
        "load_settings",
        lambda: {
            "supabase_url": "https://supabase.test",
            "supabase_service_role_key": "secret",
        },
    )
    monkeypatch.setattr(
        supabase_client,
        "_upsert_with_rest",
        lambda *args, **kwargs: calls.append("upsert"),
    )
    monkeypatch.setattr(
        supabase_client,
        "_delete_secondary_sale_rows",
        lambda *args: (_ for _ in ()).throw(
            AssertionError("upsert must not delete secondary rows before the Outcome Graph bridge")
        ),
    )
    monkeypatch.setattr(
        supabase_client,
        "_sync_normalized_sale_tables_with_rest",
        lambda *args, **kwargs: calls.append("normalized"),
    )
    monkeypatch.setattr(
        supabase_client,
        "_upsert_asset_tables_with_rest",
        lambda *args, **kwargs: calls.append("assets"),
    )

    assert supabase_client.upsert_sales_to_supabase([sale]) == 1
    assert calls == ["upsert", "normalized", "assets"]


def test_committed_publication_version_allows_following_enrichment_checkpoint(monkeypatch) -> None:
    sale = normalize_sale({
        "source_name": "avoventes",
        "source_url": "https://example.test/checkpoint",
        "starting_price_eur": 10000,
    })
    stored_version = None

    def execute(statement, params=None):
        if "select updated_at from public.auction_sales" in str(statement):
            return SimpleNamespace(fetchone=lambda: (stored_version,))
        return SimpleNamespace(fetchone=lambda: None)

    def write(table, payload, _conflict, **_kwargs):
        nonlocal stored_version
        if table == "auction_sales":
            stored_version = datetime.fromisoformat(payload[0]["updated_at"])

    monkeypatch.setattr(supabase_client, "load_settings", lambda: {
        "supabase_url": "https://supabase.test",
        "supabase_service_role_key": "secret",
        "supabase_db_url": "postgresql://example",
    })
    monkeypatch.setattr(supabase_client, "_postgres_connect", lambda _: nullcontext(SimpleNamespace(execute=execute)))
    monkeypatch.setattr(supabase_client, "_transaction_write", write)
    monkeypatch.setattr(supabase_client, "_sync_normalized_sale_tables_with_rest", lambda *args, **kwargs: None)
    monkeypatch.setattr(supabase_client, "_upsert_asset_tables_with_rest", lambda *args: None)
    monkeypatch.setattr(
        "src.publication_identity.resolve_publication_identities",
        lambda _db, sales: [item.model_copy(deep=True) for item in sales],
    )

    assert supabase_client.upsert_sales_to_supabase([sale]) == 1
    assert sale.updated_at == stored_version
    assert supabase_client.upsert_sales_to_supabase([sale], refresh_last_seen=False) == 1
    assert sale.updated_at == stored_version


def test_upsert_sales_neutralizes_room_bedroom_contradiction_before_storage(monkeypatch) -> None:
    sale = normalize_sale(
        {
            "source_name": "encheres_immobilieres",
            "source_url": "https://example.test/inconsistent-rooms",
            "starting_price_eur": 10000,
        }
    )
    sale.rooms_count = 3
    sale.bedrooms_count = 4
    captured: list[dict[str, object]] = []
    monkeypatch.setattr(
        supabase_client,
        "load_settings",
        lambda: {
            "supabase_url": "https://supabase.test",
            "supabase_service_role_key": "secret",
        },
    )
    monkeypatch.setattr(
        supabase_client,
        "_upsert_with_rest",
        lambda _url, _key, payload: captured.extend(payload),
    )
    monkeypatch.setattr(supabase_client, "_sync_normalized_sale_tables_with_rest", lambda *args, **kwargs: None)
    monkeypatch.setattr(supabase_client, "_upsert_asset_tables_with_rest", lambda *args, **kwargs: None)

    assert supabase_client.upsert_sales_to_supabase([sale]) == 1

    assert captured[0]["rooms_count"] is None
    assert captured[0]["bedrooms_count"] is None
    assert captured[0]["raw_payload"]["rooms_bedrooms_conflict_evidence"]["rooms_count"] == 3


def test_upsert_sales_registers_verified_competent_court_before_sale(monkeypatch) -> None:
    assignment = CompetentCourtAssignment(
        insee_code="01187",
        commune_name="HAUT VALROMEY",
        court_code="justice_tj_1_39",
        court_name="TJ Bourg-en-Bresse",
        official_court_name="Tribunal judiciaire de Bourg-en-Bresse",
        court_origin_code="1",
        court_srj_code="39",
        court_department="01",
        court_city="Bourg-en-Bresse",
        reference_sha256="c" * 64,
    )
    sale = normalize_sale(
        {
            "source_name": "avoventes", "starting_price_eur": 10000,
            "source_url": "https://example.test/haut-valromey",
            "tribunal": assignment.court_name,
            "tribunal_code": assignment.court_code,
            "raw_payload": {"tribunal_assignment": assignment.evidence()},
        }
    )
    sale.raw_payload["tribunal_assignment"] = assignment.evidence()
    calls: list[tuple[str, object]] = []
    monkeypatch.setattr(
        supabase_client,
        "load_settings",
        lambda: {
            "supabase_url": "https://supabase.test",
            "supabase_service_role_key": "secret",
        },
    )
    monkeypatch.setattr(
        supabase_client,
        "_postgrest_upsert",
        lambda _url, _key, table, payload, on_conflict: calls.append((table, (payload, on_conflict))),
    )
    monkeypatch.setattr(
        supabase_client,
        "_upsert_with_rest",
        lambda *_args, **_kwargs: calls.append(("auction_sales", None)),
    )
    monkeypatch.setattr(
        supabase_client,
        "_sync_normalized_sale_tables_with_rest",
        lambda *args, **kwargs: None,
    )
    monkeypatch.setattr(
        supabase_client,
        "_upsert_asset_tables_with_rest",
        lambda *args, **kwargs: None,
    )

    assert supabase_client.upsert_sales_to_supabase([sale]) == 1

    assert calls[0][0] == "tribunals"
    tribunal_payload, on_conflict = calls[0][1]
    assert on_conflict == "code"
    assert tribunal_payload[0]["code"] == "justice_tj_1_39"
    assert calls[1] == ("auction_sales", None)


def test_secondary_sale_cleanup_is_explicit_and_uses_postgres(monkeypatch) -> None:
    sale = normalize_sale(
        {
            "source_name": "avoventes",
            "source_url": "https://example.test/primary",
            "source_urls": [
                "https://example.test/primary",
                "https://example.test/secondary",
            ],
        }
    )
    calls: list[str] = []

    monkeypatch.setattr(
        supabase_client,
        "load_settings",
        lambda: {
            "supabase_url": "https://supabase.test",
            "supabase_service_role_key": "secret",
            "supabase_db_url": "postgresql://example",
        },
    )
    monkeypatch.setattr(
        supabase_client,
        "_delete_secondary_sale_rows_with_postgres",
        lambda db_url, sales: calls.append("delete_secondary") or 1,
    )
    monkeypatch.setattr(
        supabase_client,
        "_delete_secondary_sale_rows",
        lambda *args: (_ for _ in ()).throw(AssertionError("REST fallback should not run")),
    )

    assert supabase_client.delete_secondary_sales_in_supabase([sale]) == 1
    assert calls == ["delete_secondary"]


def test_secondary_sale_cleanup_skips_reviewed_alias_before_any_delete(monkeypatch) -> None:
    alias_id = "00000000-0000-0000-0000-000000000091"
    canonical_id = "00000000-0000-0000-0000-000000000092"
    alias_url = "https://cessions.test/mt301"
    canonical_url = "https://notaires.test/mt301"
    sale = normalize_sale(
        {
            "source_name": "notaires",
            "source_url": canonical_url,
            "source_urls": [canonical_url, alias_url],
        }
    )
    registry = registry_from_rows(
        [
            (
                alias_id,
                canonical_id,
                alias_url,
                canonical_url,
                "agde-mt301",
                {"audit": "docs/audits/agde-identity-review-20260913.json"},
                "2026-09-13T08:33:51Z",
                "test",
            )
        ]
    )
    monkeypatch.setattr(
        supabase_client,
        "load_settings",
        lambda: {
            "supabase_url": "https://supabase.test",
            "supabase_service_role_key": "secret",
        },
    )
    monkeypatch.setattr(supabase_client, "_fetch_reviewed_alias_registry", lambda *_args: registry)
    deleted: list[list[str]] = []
    monkeypatch.setattr(
        supabase_client,
        "_postgrest_delete_by_source_urls",
        lambda _url, _key, _table, urls: deleted.append(urls) or len(urls),
    )

    assert supabase_client.delete_secondary_sales_in_supabase([sale]) == 0
    assert deleted == []


def test_secondary_cleanup_does_not_fallback_after_registry_failure(monkeypatch) -> None:
    sale = normalize_sale(
        {
            "source_name": "notaires",
            "source_url": "https://notaires.test/canonical",
            "source_urls": ["https://notaires.test/canonical", "https://cessions.test/alias"],
        }
    )
    monkeypatch.setattr(
        supabase_client,
        "load_settings",
        lambda: {
            "supabase_url": "https://supabase.test",
            "supabase_service_role_key": "secret",
            "supabase_db_url": "postgresql://example",
        },
    )
    monkeypatch.setattr(
        supabase_client,
        "_delete_secondary_sale_rows_with_postgres",
        lambda *_args: (_ for _ in ()).throw(
            supabase_client.ReviewedAliasRegistryError("registry unavailable under lock")
        ),
    )
    monkeypatch.setattr(
        supabase_client,
        "_delete_secondary_sale_rows",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("registry failure must not fall back")),
    )

    with pytest.raises(supabase_client.ReviewedAliasRegistryError, match="under lock"):
        supabase_client.delete_secondary_sales_in_supabase([sale])


def test_dedupe_candidate_fetch_excludes_both_reviewed_parent_ids(monkeypatch) -> None:
    alias_id = "00000000-0000-0000-0000-000000000101"
    canonical_id = "00000000-0000-0000-0000-000000000102"
    other_id = "00000000-0000-0000-0000-000000000103"
    alias_url = "https://cessions.test/alias"
    canonical_url = "https://notaires.test/canonical"
    registry = registry_from_rows(
        [
            (
                alias_id,
                canonical_id,
                alias_url,
                canonical_url,
                "review",
                {"audit": "docs/audits/agde-identity-review-20260913.json"},
                "2026-09-13T08:33:51Z",
                "test",
            )
        ]
    )
    rows = []
    for sale_id, source_name, source_url in (
        (alias_id, "cessions_etat", alias_url),
        (canonical_id, "notaires", canonical_url),
        (other_id, "notaires", "https://notaires.test/other"),
    ):
        sale = normalize_sale({"source_name": source_name, "source_url": source_url, "starting_price_eur": 1000})
        rows.append({**sale.to_storage_dict(exclude_none=False), "id": sale_id, "status": "upcoming"})

    class Response:
        is_error = False
        status_code = 200
        text = ""

        def json(self):
            return rows

    monkeypatch.setattr(supabase_client.httpx, "get", lambda *args, **kwargs: Response())

    candidates = supabase_client._fetch_dedupe_candidate_sales(
        "https://supabase.test",
        "secret",
        statuses=("upcoming",),
        limit=20,
        reviewed_aliases=registry,
    )

    assert [sale.id for sale in candidates] == [other_id]


def test_upsert_sales_can_preserve_last_seen_during_recompute(monkeypatch) -> None:
    sale = normalize_sale(
        {
            "source_name": "licitor", "starting_price_eur": 10000,
            "source_url": "https://example.test/licitor-sale",
        }
    )
    sale.last_seen_at = datetime(2026, 7, 1, 9, 30, tzinfo=UTC)
    sale.updated_at = sale.last_seen_at
    captured: dict[str, object] = {}

    monkeypatch.setattr(
        supabase_client,
        "load_settings",
        lambda: {
            "supabase_url": "https://supabase.test",
            "supabase_service_role_key": "secret",
            "supabase_db_url": "postgresql://example",
        },
    )
    monkeypatch.setattr(
        supabase_client,
        "_postgres_upsert",
        lambda db_url, table, payload, on_conflict: captured.setdefault("payload", payload),
    )
    monkeypatch.setattr(supabase_client, "_delete_secondary_sale_rows_with_postgres", lambda *args: 0)
    monkeypatch.setattr(
        supabase_client,
        "_sync_normalized_sale_tables_with_rest",
        lambda supabase_url, api_key, sales, now, **kwargs: captured.setdefault(
            "refresh_last_seen", kwargs.get("refresh_last_seen")
        ),
    )
    monkeypatch.setattr(supabase_client, "_upsert_asset_tables_with_rest", lambda *args: None)

    monkeypatch.setattr(supabase_client, "_postgres_connect", lambda _: nullcontext(SimpleNamespace(execute=lambda *args: SimpleNamespace(fetchone=lambda: (sale.updated_at,)))))
    monkeypatch.setattr(supabase_client, "_transaction_write", lambda table, payload, conflict: captured.setdefault("payload", payload))
    assert supabase_client.upsert_sales_to_supabase([sale], refresh_last_seen=False) == 1

    payload = captured["payload"]
    assert isinstance(payload, list)
    assert payload[0]["last_seen_at"] == "2026-07-01T09:30:00+00:00"
    assert captured["refresh_last_seen"] is False


def test_reconcile_duplicate_sales_in_supabase_merges_historical_rows(monkeypatch) -> None:
    notaires = normalize_sale(
        {
            "source_name": "notaires",
            "source_url": "https://www.immo-interactif.fr/encheres-en-ligne/maison/merignac-33/2008146",
            "address": "33 Avenue Léon Blum, 33700 Mérignac",
            "city": "Mérignac",
            "postal_code": "33700",
            "department": "33",
            "starting_price_eur": "330 000 €",
            "sale_date": "22 juillet 2026 à 10h00",
            "surface_m2": "94 m²",
        }
    )
    encheres_publiques = normalize_sale(
        {
            "source_name": "encheres_publiques",
            "source_url": "https://www.encheres-publiques.com/encheres/immobilier/maisons/merignac-33/belle-maison_129746",
            "address": "33 Av. Léon Blum, 33700 Mérignac, France",
            "city": "Mérignac",
            "postal_code": "33700",
            "department": "33",
            "starting_price_eur": "330 000 €",
            "sale_date": "22 juillet 2026 à 10h00",
            "surface_m2": "94 m²",
        }
    )
    rows = [
        {**sale.to_storage_dict(exclude_none=False), "status": "upcoming"}
        for sale in (notaires, encheres_publiques)
    ]
    captured: dict[str, object] = {}

    monkeypatch.setattr(
        supabase_client,
        "load_settings",
        lambda: {
            "supabase_url": "https://supabase.test",
            "supabase_service_role_key": "secret",
            "dedupe_reconcile_max_rows": 20,
        },
    )

    class Response:
        is_error = False
        status_code = 200
        text = ""

        def json(self):
            return rows

    def fake_get(endpoint, params, headers, timeout):
        captured["fetch_endpoint"] = endpoint
        captured["fetch_params"] = params
        return Response()

    def fake_delete(supabase_url, api_key, sales, **kwargs):
        captured["delete_sales"] = sales
        return len(supabase_client._secondary_source_urls(sales))

    monkeypatch.setattr(supabase_client.httpx, "get", fake_get)
    monkeypatch.setattr(
        supabase_client,
        "_upsert_with_rest",
        lambda supabase_url, api_key, payload: captured.setdefault("upsert_payload", payload),
    )
    monkeypatch.setattr(supabase_client, "_delete_secondary_sale_rows", fake_delete)
    monkeypatch.setattr(
        supabase_client,
        "_sync_normalized_sale_tables_with_rest",
        lambda supabase_url, api_key, sales, now: captured.setdefault("normalized_sales", sales),
    )
    monkeypatch.setattr(
        supabase_client,
        "_upsert_asset_tables_with_rest",
        lambda supabase_url, api_key, sales, now: captured.setdefault("asset_sales", sales),
    )

    deleted = supabase_client.reconcile_duplicate_sales_in_supabase(limit=20)

    assert deleted == 1
    assert captured["fetch_endpoint"] == "https://supabase.test/rest/v1/auction_sales"
    assert captured["fetch_params"]["status"] == 'in.("active","upcoming","unknown")'
    payload = captured["upsert_payload"]
    assert isinstance(payload, list)
    assert len(payload) == 1
    assert payload[0]["dedupe_confidence"] == "address"
    assert payload[0]["source_urls"] == [
        "https://www.encheres-publiques.com/encheres/immobilier/maisons/merignac-33/belle-maison_129746",
        "https://www.immo-interactif.fr/encheres-en-ligne/maison/merignac-33/2008146",
    ]


def test_normalized_sale_rows_split_property_and_judicial_context() -> None:
    sale = normalize_sale(
        {
            "source_name": "avoventes",
            "source_url": "https://example.test/sale",
            "source_urls": ["https://example.test/sale", "https://licitor.test/sale"],
            "primary_source": "avoventes",
            "department": "33",
            "city": "Bordeaux",
            "address": "12 rue Sainte-Catherine",
            "property_type": "apartment",
            "surface_m2": 42,
            "rooms_count": 2,
            "latitude": 44.84,
            "longitude": -0.57,
            "tribunal": "TJ Bordeaux",
            "tribunal_code": "bordeaux",
            "starting_price_eur": 120000,
            "lawyer_name": "Me Source",
            "lawyer_contact": "source@example.test",
            "documents": [{"label": "Cahier des conditions", "url": "https://example.test/cdc.pdf"}],
            "raw_payload": {"source": "fixture"},
        }
    )

    properties = supabase_client._property_rows_for_sales([sale], "2026-07-06T10:00:00+00:00")
    judicial_sales = supabase_client._judicial_sale_rows_for_sales([sale], "2026-07-06T10:00:00+00:00")

    assert len(properties) == 1
    assert properties[0]["source_url"] == "https://example.test/sale"
    assert properties[0]["source_urls"] == ["https://example.test/sale", "https://licitor.test/sale"]
    assert properties[0]["address"] == "12 rue Sainte-Catherine"
    assert properties[0]["property_type"] == "apartment"
    assert properties[0]["surface_m2"] == 42.0
    assert properties[0]["rooms_count"] == 2
    assert properties[0]["latitude"] == 44.84
    assert properties[0]["longitude"] == -0.57
    assert isinstance(properties[0]["raw_payload"], dict)
    assert properties[0]["last_seen_at"] == "2026-07-06T10:00:00+00:00"
    assert judicial_sales[0]["property_source_url"] == "https://example.test/sale"
    assert judicial_sales[0]["tribunal_code"] == "bordeaux"
    assert judicial_sales[0]["starting_price_eur"] == 120000.0
    assert judicial_sales[0]["source_lawyer_name"] == "Me Source"
    assert judicial_sales[0]["source_lawyer_contact"] == "source@example.test"
    assert judicial_sales[0]["documents_count"] == 1
    assert "referenced_lawyer_id" not in judicial_sales[0]

    sale.last_seen_at = datetime(2026, 7, 1, 9, 30, tzinfo=UTC)
    preserved_properties = supabase_client._property_rows_for_sales(
        [sale],
        "2026-07-06T10:00:00+00:00",
        refresh_last_seen=False,
    )
    preserved_judicial_sales = supabase_client._judicial_sale_rows_for_sales(
        [sale],
        "2026-07-06T10:00:00+00:00",
        refresh_last_seen=False,
    )
    assert preserved_properties[0]["last_seen_at"] == "2026-07-01T09:30:00+00:00"
    assert preserved_judicial_sales[0]["last_seen_at"] == "2026-07-01T09:30:00+00:00"


def test_sync_normalized_sale_tables_upserts_properties_before_judicial_sales(monkeypatch) -> None:
    sale = normalize_sale(
        {
            "source_name": "licitor",
            "source_url": "https://example.test/sale",
            "city": "Pau",
        }
    )
    calls: list[tuple[str, str, str, int]] = []

    monkeypatch.setattr(
        supabase_client,
        "_postgrest_upsert",
        lambda supabase_url, api_key, table, payload, on_conflict: calls.append(
            (supabase_url, table, on_conflict, len(payload))
        ),
    )

    supabase_client._sync_normalized_sale_tables_with_rest(
        "https://supabase.test",
        "secret",
        [sale],
        "2026-07-06T10:00:00+00:00",
    )

    assert calls == [
        ("https://supabase.test", "properties", "source_url", 1),
        ("https://supabase.test", "judicial_sales", "source_url", 1),
    ]


def test_upsert_observations_prefers_direct_postgres_when_db_url_is_configured(monkeypatch) -> None:
    sale = normalize_sale(
        {
            "source_name": "avoventes", "starting_price_eur": 10000,
            "source_url": "https://example.test/sale",
            "observations": [{"source_name": "avoventes", "starting_price_eur": 10000, "source_url": "https://example.test/sale"}],
        }
    )
    calls: list[tuple[str, str, int]] = []

    monkeypatch.setattr(
        supabase_client,
        "load_settings",
        lambda: {
            "supabase_url": "https://supabase.test",
            "supabase_service_role_key": "secret",
            "supabase_db_url": "postgresql://example",
        },
    )
    monkeypatch.setattr(
        supabase_client,
        "_postgres_upsert",
        lambda db_url, table, payload, on_conflict: calls.append((db_url, table, len(payload))),
    )
    monkeypatch.setattr(
        supabase_client,
        "_postgrest_upsert",
        lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("REST observation upsert should not run")),
    )

    assert supabase_client.upsert_observations_to_supabase([sale]) == 1
    assert calls == [("postgresql://example", "auction_observations", 1)]


def test_upsert_documents_deduplicates_document_urls(monkeypatch) -> None:
    sale = normalize_sale(
        {
            "source_name": "avoventes", "starting_price_eur": 10000,
            "source_url": "https://example.test/sale",
            "documents": [
                {"url": "https://example.test/pv.pdf", "label": "PV descriptif"},
                {"url": "https://example.test/pv.pdf", "label": "PV descriptif duplicate"},
                {"url": "https://example.test/ccv.pdf", "label": "CCV"},
            ],
        }
    )
    calls: list[tuple[str, list[dict[str, object]], str]] = []

    monkeypatch.setattr(
        supabase_client,
        "load_settings",
        lambda: {"supabase_url": "https://supabase.test", "supabase_service_role_key": "secret"},
    )
    monkeypatch.setattr(
        supabase_client,
        "_postgrest_upsert",
        lambda supabase_url, api_key, table, payload, on_conflict: calls.append(
            (table, payload, on_conflict)
        ),
    )

    assert supabase_client.upsert_documents_to_supabase([sale]) == 2
    assert calls[0][0] == "auction_documents"
    assert calls[0][2] == "source_url,document_url"
    assert [row["document_url"] for row in calls[0][1]] == [
        "https://example.test/pv.pdf",
        "https://example.test/ccv.pdf",
    ]
    assert calls[0][1][0]["label"] == "PV descriptif duplicate"


@pytest.mark.parametrize(
    "value",
    ["+" + "a" * 63, "-" + "a" * 63, "0x" + "a" * 62],
)
def test_sha256_rejects_non_hex_prefixes(value: str) -> None:
    assert not supabase_client._is_sha256(value)


@pytest.mark.parametrize("value", ["a" * 64, "A" * 64])
def test_sha256_accepts_lowercase_and_uppercase_hex(value: str) -> None:
    assert supabase_client._is_sha256(value)


def _persisted_pdf_sale_fixture(
    document_count: int = 4,
    *,
    cache_dir: Path | None = None,
) -> tuple[AuctionSale, list[dict[str, object]]]:
    from src.pdf_document_selection import _store_document_analysis_status

    labels = (
        "PV descriptif",
        "Cahier des conditions de vente",
        "Diagnostic de performance énergétique",
        "Annonce de vente",
    )
    documents = [
        {
            "label": labels[index],
            "url": f"https://example.test/persisted-{index}.pdf",
            "document_type": "pv_huissier" if index == 0 else "other",
        }
        for index in range(document_count)
    ]
    pdf_texts = [
        {
            "label": document["label"],
            "url": document["url"],
            "type": "pdf",
            "document_type": document["document_type"],
            "file_path": f"/private/tmp/persisted-{index}.pdf",
            "text": f"Texte complet du document {index} avec surface {index + 1} m2.",
            "text_chars": len(f"Texte complet du document {index} avec surface {index + 1} m2."),
            "sha256": hashlib.sha256(f"pdf-bytes-{index}".encode()).hexdigest(),
            "cache_version": supabase_client.PDF_TEXT_CACHE_VERSION,
            "complete": True,
            "failed_pages": [],
            "extraction_status": "extracted",
            "extraction_method": "pymupdf_pages",
            "page_count": 1,
        }
        for index, document in enumerate(documents)
    ]
    sale = AuctionSale(
        source_name="avoventes",
        source_url="https://example.test/persisted-sale",
        starting_price_eur=Decimal("100000"),
        documents=documents,
    )
    _store_document_analysis_status(sale, documents, pdf_texts)
    if cache_dir is not None:
        from src import pdf_fact_extraction

        previous_cache_dir = pdf_fact_extraction.PDF_TEXTS_DIR
        pdf_fact_extraction.PDF_TEXTS_DIR = cache_dir
        try:
            cache_path = pdf_fact_extraction._write_pdf_text_cache(sale, pdf_texts)
            pdf_texts = json.loads(cache_path.read_text(encoding="utf-8"))
        finally:
            pdf_fact_extraction.PDF_TEXTS_DIR = previous_cache_dir
    return sale, pdf_texts


def _persisted_extraction_row(sale: AuctionSale, pdf_texts: list[dict[str, object]]) -> dict[str, object]:
    return {
        "source_url": sale.source_url,
        "provider": supabase_client.PDF_EXTRACTION_PROVIDER,
        "model": supabase_client.PDF_EXTRACTION_MODEL,
        "input_hash": sale.content_hash or sale.source_url,
        "schema_version": supabase_client.PDF_EXTRACTION_SCHEMA_VERSION,
        "result": [dict(item) for item in pdf_texts],
        "updated_at": "2026-09-29T01:24:38+00:00",
    }


def test_upsert_documents_rehydrates_complete_persisted_pdf_text_after_reconstruction(
    monkeypatch,
    tmp_path,
) -> None:
    sale, pdf_texts = _persisted_pdf_sale_fixture(cache_dir=tmp_path / "extractor-cache")
    extraction_row = _persisted_extraction_row(sale, pdf_texts)
    # The source sale can receive a newer whole-record hash while the
    # document manifest and persisted PDF bytes remain identical.
    sale.content_hash = "newer-source-record-hash"
    reconstructed = AuctionSale(**sale.model_dump())
    monkeypatch.setattr(supabase_client, "PDF_TEXTS_DIR", tmp_path)
    monkeypatch.setattr(
        supabase_client,
        "load_settings",
        lambda: {"supabase_url": "https://supabase.test", "supabase_service_role_key": "secret"},
    )
    reads: list[dict[str, object]] = []
    writes: list[list[dict[str, object]]] = []

    def fake_get(endpoint, **kwargs):
        reads.append(kwargs["params"])
        return httpx.Response(200, json=[extraction_row], request=httpx.Request("GET", endpoint))

    monkeypatch.setattr(supabase_client.httpx, "get", fake_get)
    monkeypatch.setattr(
        supabase_client,
        "_postgrest_upsert",
        lambda _url, _key, _table, payload, on_conflict: writes.append(payload),
    )

    assert not supabase_client.documents_are_current(reconstructed)
    assert supabase_client._load_pdf_texts(reconstructed) == []
    assert all(
        item["complete"] is True
        and item["extraction_status"] == "extracted"
        and item["failed_pages"] == []
        for item in pdf_texts
    )
    assert supabase_client.upsert_documents_to_supabase([reconstructed]) == 4
    assert len(reads) == 1
    assert reads[0]["provider"] == "eq.pdf_text"
    assert reads[0]["model"] == f"eq.{supabase_client.PDF_EXTRACTION_MODEL}"
    assert reads[0]["schema_version"] == f"eq.{supabase_client.PDF_EXTRACTION_SCHEMA_VERSION}"
    assert len(writes) == 1
    assert all(row["extraction_status"] == "extracted" for row in writes[0])
    assert all(row["file_path"] is None for row in writes[0])
    assert all(row["download_status"] == "verified" for row in writes[0])
    assert all(
        row["raw_payload"]["extraction"]["provenance"] == "persisted_pdf_text"
        and row["raw_payload"]["extraction"]["proof_version"] == 1
        and row["raw_payload"]["extraction"]["verified_at"]
        == reconstructed.raw_payload["document_analysis"]["cache_proof"]["verified_at"]
        for row in writes[0]
    )


def test_persisted_pdf_text_corruption_fails_closed_for_every_document(monkeypatch, tmp_path) -> None:
    sale, pdf_texts = _persisted_pdf_sale_fixture(cache_dir=tmp_path / "extractor-cache")
    corrupted = [dict(item) for item in pdf_texts]
    corrupted[0]["text"] = "Texte modifié après la preuve persistée."
    extraction_row = _persisted_extraction_row(sale, corrupted)
    monkeypatch.setattr(supabase_client, "PDF_TEXTS_DIR", tmp_path)
    monkeypatch.setattr(
        supabase_client,
        "load_settings",
        lambda: {"supabase_url": "https://supabase.test", "supabase_service_role_key": "secret"},
    )
    writes: list[list[dict[str, object]]] = []
    monkeypatch.setattr(
        supabase_client.httpx,
        "get",
        lambda endpoint, **_kwargs: httpx.Response(
            200,
            json=[extraction_row],
            request=httpx.Request("GET", endpoint),
        ),
    )
    monkeypatch.setattr(
        supabase_client,
        "_postgrest_upsert",
        lambda _url, _key, _table, payload, on_conflict: writes.append(payload),
    )

    assert supabase_client.upsert_documents_to_supabase([sale]) == 4
    assert len(writes) == 1
    assert all(row["extraction_status"] != "extracted" for row in writes[0])
    assert all(row["raw_payload"]["extraction"]["text_present"] is False for row in writes[0])


def test_persisted_pdf_rest_timeout_is_single_attempt_and_pending(monkeypatch, tmp_path) -> None:
    sale, _pdf_texts = _persisted_pdf_sale_fixture(cache_dir=tmp_path / "extractor-cache")
    monkeypatch.setattr(supabase_client, "PDF_TEXTS_DIR", tmp_path)
    monkeypatch.setattr(
        supabase_client,
        "load_settings",
        lambda: {"supabase_url": "https://supabase.test", "supabase_service_role_key": "secret"},
    )
    calls: list[object] = []
    writes: list[list[dict[str, object]]] = []

    def timeout_once(endpoint, **_kwargs):
        calls.append(endpoint)
        raise httpx.ReadTimeout("optional persisted PDF lookup timed out")

    monkeypatch.setattr(supabase_client.httpx, "get", timeout_once)
    monkeypatch.setattr(
        supabase_client,
        "_postgrest_upsert",
        lambda _url, _key, _table, payload, on_conflict: writes.append(payload),
    )

    assert supabase_client.upsert_documents_to_supabase([sale]) == 4
    assert len(calls) == 1
    assert len(writes) == 1
    assert all(row["extraction_status"] != "extracted" for row in writes[0])


def test_mixed_pdf_manifest_never_queries_or_materializes_persisted_subset(monkeypatch, tmp_path) -> None:
    from src.pdf_document_selection import _store_document_analysis_status

    sale, pdf_texts = _persisted_pdf_sale_fixture(cache_dir=tmp_path / "extractor-cache")
    _store_document_analysis_status(sale, sale.documents, pdf_texts[:3])
    monkeypatch.setattr(supabase_client, "PDF_TEXTS_DIR", tmp_path)
    monkeypatch.setattr(
        supabase_client,
        "load_settings",
        lambda: {"supabase_url": "https://supabase.test", "supabase_service_role_key": "secret"},
    )
    reads: list[object] = []
    writes: list[list[dict[str, object]]] = []
    monkeypatch.setattr(
        supabase_client.httpx,
        "get",
        lambda endpoint, **_kwargs: reads.append(endpoint) or pytest.fail("partial manifest queried"),
    )
    monkeypatch.setattr(
        supabase_client,
        "_postgrest_upsert",
        lambda _url, _key, _table, payload, on_conflict: writes.append(payload),
    )

    assert supabase_client.upsert_documents_to_supabase([sale]) == 4
    assert reads == []
    assert len(writes) == 1
    assert all(row["extraction_status"] != "extracted" for row in writes[0])


@pytest.mark.parametrize("variant", ["partial", "legacy"])
def test_persisted_pdf_roundtrip_rejects_partial_or_legacy_result_markers(
    monkeypatch,
    tmp_path,
    variant: str,
) -> None:
    sale, pdf_texts = _persisted_pdf_sale_fixture(cache_dir=tmp_path / "extractor-cache")
    extraction_row = _persisted_extraction_row(sale, pdf_texts)
    assert all(
        document["complete"] is True
        and document["extraction_status"] == "extracted"
        and document["failed_pages"] == []
        for document in extraction_row["result"]
    )
    proof_documents = sale.raw_payload["document_analysis"]["cache_proof"]["documents"]
    assert all(document["complete"] is True for document in proof_documents)

    if variant == "partial":
        extraction_row["result"][0].update(
            complete=False,
            extraction_status="incomplete",
            failed_pages=[1],
        )
    else:
        for document in extraction_row["result"]:
            document.pop("complete")
            document.pop("extraction_status")
            document.pop("failed_pages")

    monkeypatch.setattr(supabase_client, "PDF_TEXTS_DIR", tmp_path / "worker-cache")
    monkeypatch.setattr(
        supabase_client.httpx,
        "get",
        lambda endpoint, **_kwargs: httpx.Response(
            200,
            json=[extraction_row],
            request=httpx.Request("GET", endpoint),
        ),
    )

    assert supabase_client._fetch_persisted_pdf_texts_for_sales(
        [sale],
        "https://supabase.test",
        "secret",
    ) == {}


def test_upsert_cadastre_parcels_uses_service_role_rest_upsert(monkeypatch) -> None:
    calls = []
    monkeypatch.setattr(
        supabase_client,
        "load_settings",
        lambda: {"supabase_url": "https://supabase.test", "supabase_service_role_key": "secret"},
    )
    monkeypatch.setattr(
        supabase_client,
        "_postgrest_upsert",
        lambda supabase_url, api_key, table, payload, on_conflict: calls.append(
            (supabase_url, api_key, table, payload, on_conflict)
        ),
    )

    count = supabase_client.upsert_cadastre_parcels_to_supabase(
        [
            {
                "source_url": "https://example.test/sale",
                "parcel_key": "33063-AB-0123",
                "section": "AB",
                "parcel_number": "0123",
            },
            {
                "source_url": "https://example.test/sale",
                "parcel_key": "33063-AB-0123",
                "section": "AB corrected",
            },
            {"source_url": "https://example.test/ignored"},
        ]
    )

    assert count == 1
    assert calls[0][0] == "https://supabase.test"
    assert calls[0][1] == "secret"
    assert calls[0][2] == "auction_cadastre_parcels"
    assert calls[0][3][0]["parcel_key"] == "33063-AB-0123"
    assert calls[0][3][0]["section"] == "AB corrected"
    assert calls[0][3][0]["parcel_number"] == "0123"
    assert calls[0][3][0]["updated_at"]
    assert calls[0][4] == "source_url,parcel_key"


def test_upsert_dpe_diagnostics_uses_service_role_rest_upsert(monkeypatch) -> None:
    calls = []
    monkeypatch.setattr(
        supabase_client,
        "load_settings",
        lambda: {"supabase_url": "https://supabase.test", "supabase_service_role_key": "secret"},
    )
    monkeypatch.setattr(
        supabase_client,
        "_postgrest_upsert",
        lambda supabase_url, api_key, table, payload, on_conflict: calls.append(
            (supabase_url, api_key, table, payload, on_conflict)
        ),
    )

    count = supabase_client.upsert_dpe_diagnostics_to_supabase(
        [
            {
                "source_url": "https://example.test/sale",
                "diagnostic_number": "2133E0178774F",
                "dpe_class": "E",
            },
            {
                "source_url": "https://example.test/sale",
                "diagnostic_number": "2133E0178774F",
                "dpe_class": "D",
            },
            {"source_url": "https://example.test/ignored"},
        ]
    )

    assert count == 1
    assert calls[0][0] == "https://supabase.test"
    assert calls[0][1] == "secret"
    assert calls[0][2] == "auction_dpe_diagnostics"
    assert calls[0][3][0]["diagnostic_number"] == "2133E0178774F"
    assert calls[0][3][0]["dpe_class"] == "D"
    assert calls[0][3][0]["updated_at"]
    assert calls[0][4] == "source_url,diagnostic_number"


def test_postgres_connect_disables_prepared_statements_for_pooler(monkeypatch) -> None:
    calls: dict[str, object] = {}
    connection = object()

    class Psycopg:
        def connect(self, *args, **kwargs):
            calls["args"] = args
            calls["kwargs"] = kwargs
            return connection

    monkeypatch.setattr(supabase_client, "psycopg", Psycopg())

    assert supabase_client._postgres_connect("postgresql://example") is connection
    assert calls["args"] == ("postgresql://example",)
    assert calls["kwargs"] == {
        "connect_timeout": supabase_client.POSTGRES_CONNECT_TIMEOUT,
        "prepare_threshold": None,
    }


def test_postgres_connect_retries_transient_pool_checkout(monkeypatch) -> None:
    calls = 0
    connection = object()

    class Psycopg:
        def connect(self, *_args, **_kwargs):
            nonlocal calls
            calls += 1
            if calls < 3:
                raise RuntimeError("ECHECKOUTTIMEOUT: unable to check out connection from the pool")
            return connection

    monkeypatch.setattr(supabase_client, "psycopg", Psycopg())
    monkeypatch.setattr(supabase_client.time, "sleep", lambda _seconds: None)

    assert supabase_client._postgres_connect("postgresql://example") is connection
    assert calls == 3


def test_postgres_connect_can_skip_retries_for_optional_telemetry(monkeypatch) -> None:
    calls: list[dict[str, object]] = []

    class Psycopg:
        def connect(self, *_args, **kwargs):
            calls.append(kwargs)
            raise RuntimeError("connection timeout")

    monkeypatch.setattr(supabase_client, "psycopg", Psycopg())

    with pytest.raises(RuntimeError, match="connection timeout"):
        supabase_client._postgres_connect(
            "postgresql://example", connect_timeout=3, retry_delays=()
        )

    assert calls == [{"connect_timeout": 3, "prepare_threshold": None}]


def test_asset_table_cleanup_batches_source_url_deletes(monkeypatch) -> None:
    sales = [
        normalize_sale(
            {
                "source_name": "licitor",
                "source_url": f"https://example.test/annonce/{index}/" + ("path-" * 30),
            }
        )
        for index in range(supabase_client.POSTGREST_SOURCE_URL_DELETE_BATCH_SIZE + 1)
    ]
    delete_calls: list[tuple[str, str]] = []

    monkeypatch.setattr(supabase_client, "_postgrest_upsert", lambda *args, **kwargs: None)
    monkeypatch.setattr(supabase_client, "_postgrest_insert", lambda *args, **kwargs: None)
    monkeypatch.setattr(supabase_client, "upsert_documents_to_supabase", lambda *args, **kwargs: 0)
    monkeypatch.setattr(supabase_client, "upsert_extractions_to_supabase", lambda *args, **kwargs: 0)
    monkeypatch.setattr(
        supabase_client,
        "_postgrest_delete",
        lambda supabase_url, api_key, table, params: delete_calls.append((table, params["source_url"])),
    )

    supabase_client._upsert_asset_tables_with_rest(
        "https://supabase.test",
        "secret",
        sales,
        "2026-06-30T13:00:00+00:00",
    )

    assert [table for table, _filter in delete_calls] == [
        "auction_surface_derivations",
        "auction_surface_derivations",
        "auction_surface_measurements",
        "auction_surface_measurements",
        "auction_risks",
        "auction_risks",
        "auction_risk_occurrences",
        "auction_risk_occurrences",
        "auction_urban_planning_signals",
        "auction_urban_planning_signals",
        "auction_score_factors",
        "auction_score_factors",
    ]
    assert delete_calls[0][1].count("https://example.test") == supabase_client.POSTGREST_SOURCE_URL_DELETE_BATCH_SIZE
    assert delete_calls[1][1].count("https://example.test") == 1


def test_surface_reasoning_rows_preserve_evidence_and_formula() -> None:
    sale = normalize_sale(
        {
            "source_name": "encheres_immobilieres",
            "source_url": "https://example.test/surface-persistence",
        }
    )
    sale.raw_payload["surface_analysis"] = {
        "version": "surface_reasoning_v1",
        "selected_derivation_id": "derivation-1",
        "measurements": [
            {
                "measurement_id": "measurement-1",
                "asset_id": "asset-main",
                "space_label": "séjour",
                "category": "habitable",
                "value_m2": "19.56",
                "included_in_habitable_sum": True,
                "confidence": 0.93,
                "extraction_method": "llm",
                "evidence": {
                    "quote": "séjour (19,56 m²)",
                    "document_label": "PV descriptif",
                    "page_number": 3,
                },
            }
        ],
        "candidates": [],
        "derivations": [
            {
                "derivation_id": "derivation-1",
                "asset_id": "asset-main",
                "kind": "calculated_room_sum",
                "value_m2": "19.56",
                "operand_measurement_ids": ["measurement-1"],
                "formula": "19.56 = 19.56 m²",
                "validation_status": "partial",
                "confidence": 0.68,
                "warnings": ["room_measurement_set_may_be_incomplete"],
            }
        ],
    }

    measurements = supabase_client._surface_measurement_rows_for_sale(sale)
    derivations = supabase_client._surface_derivation_rows_for_sale(sale)

    assert measurements[0]["evidence_quote"] == "séjour (19,56 m²)"
    assert measurements[0]["page_number"] == 3
    assert measurements[0]["reasoning_version"] == "surface_reasoning_v1"
    assert derivations[0]["formula"] == "19.56 = 19.56 m²"
    assert derivations[0]["is_selected"] is True
    assert derivations[0]["operand_measurement_keys"] == [measurements[0]["measurement_key"]]


def test_fail_stale_running_runs_marks_rows_failed(monkeypatch) -> None:
    monkeypatch.setattr(
        supabase_client,
        "load_settings",
        lambda: {"supabase_url": "https://supabase.test", "supabase_service_role_key": "secret"},
    )

    class Response:
        is_error = False

        def json(self):
            return [
                {
                    "id": "run-1",
                    "summary": {"trigger": "admin_dashboard"},
                    "errors": {},
                    "started_at": "2026-06-29T14:41:12Z",
                }
            ]

    def fake_get(endpoint, params, headers, timeout):
        assert endpoint == "https://supabase.test/rest/v1/auction_runs"
        assert params["status"] == "eq.running"
        assert params["started_at"].startswith("lt.")
        return Response()

    finished = []
    monkeypatch.setattr(supabase_client.httpx, "get", fake_get)
    monkeypatch.setattr(
        supabase_client,
        "finish_run_in_supabase",
        lambda run_id, status, summary, errors: finished.append((run_id, status, summary, errors)),
    )

    assert supabase_client.fail_stale_running_runs_in_supabase(max_age_minutes=190) == 1
    assert finished[0][0] == "run-1"
    assert finished[0][1] == "failed"
    assert "stale_cleanup" in finished[0][2]
    assert finished[0][3]["runner"]


def test_has_active_running_run_checks_recent_running_rows(monkeypatch) -> None:
    monkeypatch.setattr(
        supabase_client,
        "load_settings",
        lambda: {"supabase_url": "https://supabase.test", "supabase_service_role_key": "secret"},
    )

    class Response:
        is_error = False
        text = ""

        def json(self):
            return [{"id": "run-active"}]

    def fake_get(endpoint, params, headers, timeout):
        assert endpoint == "https://supabase.test/rest/v1/auction_runs"
        assert params["select"] == "id"
        assert params["status"] == "eq.running"
        assert params["started_at"].startswith("gte.")
        assert params["limit"] == "1"
        return Response()

    monkeypatch.setattr(supabase_client.httpx, "get", fake_get)

    assert supabase_client.has_active_running_run_in_supabase(max_age_minutes=190) is True


def test_update_run_progress_in_supabase_patches_running_row(monkeypatch) -> None:
    frozen = datetime(2026, 10, 1, 9, 33, tzinfo=UTC)
    monkeypatch.setattr(supabase_client, "datetime", SimpleNamespace(now=lambda _tz: frozen))
    monkeypatch.setattr(
        supabase_client,
        "load_settings",
        lambda: {"supabase_url": "https://supabase.test", "supabase_service_role_key": "secret"},
    )
    captured: dict[str, object] = {}

    class Response:
        is_error = False
        text = ""

    def fake_patch(endpoint, params, headers, json, timeout):
        captured["endpoint"] = endpoint
        captured["params"] = params
        captured["json"] = json
        return Response()

    monkeypatch.setattr(supabase_client.httpx, "patch", fake_patch)

    supabase_client.update_run_progress_in_supabase(
        "run-progress",
        {"mode": "llm_description_backfill", "completed": 1},
        {"llm_backfill": []},
    )

    assert captured["endpoint"] == "https://supabase.test/rest/v1/auction_runs"
    assert captured["params"] == {"id": "eq.run-progress", "status": "eq.running"}
    assert captured["json"] == {
        "summary": {"mode": "llm_description_backfill", "completed": 1},
        "errors": {"llm_backfill": []},
        "updated_at": frozen.isoformat(),
    }


def test_fetch_next_data_refresh_request_locks_queued_row(monkeypatch) -> None:
    monkeypatch.setattr(
        supabase_client,
        "load_settings",
        lambda: {"supabase_url": "https://supabase.test", "supabase_service_role_key": "secret"},
    )

    class Response:
        is_error = False
        text = ""

        def __init__(self, rows):
            self._rows = rows

        def json(self):
            return self._rows

    def fake_get(endpoint, params, headers, timeout):
        assert endpoint == "https://supabase.test/rest/v1/data_refresh_requests"
        assert params["status"] == "eq.queued"
        assert params["order"] == "priority.desc,created_at.asc"
        return Response(
            [
                {
                    "id": "refresh-1",
                    "source_url": "https://example.test/sale",
                    "request_kind": "dpe",
                    "status": "queued",
                }
            ]
        )

    def fake_patch(endpoint, params, headers, json, timeout):
        assert endpoint == "https://supabase.test/rest/v1/data_refresh_requests"
        assert params == {"id": "eq.refresh-1", "status": "eq.queued"}
        assert json["status"] == "running"
        assert json["started_at"]
        return Response([{**json, "id": "refresh-1", "request_kind": "dpe"}])

    monkeypatch.setattr(supabase_client.httpx, "get", fake_get)
    monkeypatch.setattr(supabase_client.httpx, "patch", fake_patch)

    request = supabase_client.fetch_next_data_refresh_request_from_supabase()

    assert request is not None
    assert request["id"] == "refresh-1"
    assert request["status"] == "running"
    assert request["request_kind"] == "dpe"


def test_fetch_sale_for_data_refresh_returns_auction_sale(monkeypatch) -> None:
    monkeypatch.setattr(
        supabase_client,
        "load_settings",
        lambda: {"supabase_url": "https://supabase.test", "supabase_service_role_key": "secret"},
    )

    class Response:
        is_error = False
        text = ""

        def json(self):
            return [
                {
                    "source_name": "avoventes",
                    "source_url": "https://example.test/sale",
                    "city": "Bordeaux",
                    "latitude": 44.84,
                    "longitude": -0.57,
                    "source_urls": ["https://example.test/sale"],
                    "visit_dates": None,
                    "documents": None,
                    "raw_payload": {},
                }
            ]

    def fake_get(endpoint, params, headers, timeout):
        assert endpoint == "https://supabase.test/rest/v1/auction_sales"
        assert params["source_url"] == "eq.https://example.test/sale"
        assert "source_name" in params["select"]
        return Response()

    monkeypatch.setattr(supabase_client.httpx, "get", fake_get)

    sale = supabase_client.fetch_sale_for_data_refresh("https://example.test/sale")

    assert sale is not None
    assert sale.source_name == "avoventes"
    assert sale.source_url == "https://example.test/sale"
    assert float(sale.latitude or 0) == 44.84
    assert sale.visit_dates == []
    assert sale.documents == []


def test_publication_commits_completed_batches_before_later_batch_failure(monkeypatch):
    monkeypatch.setattr("src.publication_identity.resolve_publication_identities", lambda connection, sales: sales)
    from contextlib import contextmanager
    monkeypatch.setattr(supabase_client, 'load_settings', lambda: {
        'supabase_url': 'https://supabase.test', 'supabase_service_role_key': 'test',
        'supabase_db_url': 'postgresql://test',
    })
    events = []
    @contextmanager
    def connect(url):
        try:
            yield SimpleNamespace(execute=lambda *args: None)
        except RuntimeError:
            events.append('rollback')
            raise
        else:
            events.append('commit')
    monkeypatch.setattr(supabase_client, '_postgres_connect', connect)
    batch_sizes = []
    def write(table, payload, conflict):
        batch_sizes.append(len(payload))
        if len(batch_sizes) == 2:
            raise RuntimeError('second batch failed')
    monkeypatch.setattr(supabase_client, '_transaction_write', write)
    for name in ['_sync_normalized_sale_tables_with_rest', '_upsert_asset_tables_with_rest', '_enqueue_due_enrichment']:
        monkeypatch.setattr(supabase_client, name, lambda *args, **kwargs: None)
    sales = [AuctionSale(source_name='test', source_url=f'https://example.test/{i}', starting_price_eur=100) for i in range(26)]
    with pytest.raises(RuntimeError, match='second batch'):
        supabase_client.upsert_sales_to_supabase(sales)
    assert batch_sizes == [25, 1]
    assert events == ['commit', 'rollback']
    assert supabase_client._PUBLICATION_CONNECTION.get() is None
