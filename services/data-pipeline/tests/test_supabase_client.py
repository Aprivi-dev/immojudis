from src.normalize import normalize_sale
from src.storage import supabase_client
from src.storage.supabase_client import _sanitize_postgrest_payload, _secondary_source_urls


def test_sanitize_postgrest_payload_removes_null_characters_recursively() -> None:
    payload = {
        "result": [
            {
                "text": "surface\x00 habitable",
                "pages": [{"text": "page\x00 1"}, {"confidence": 0.7}],
            }
        ],
        "untouched": None,
    }

    assert _sanitize_postgrest_payload(payload) == {
        "result": [
            {
                "text": "surface habitable",
                "pages": [{"text": "page 1"}, {"confidence": 0.7}],
            }
        ],
        "untouched": None,
    }


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


def test_delete_vench_sales_without_surface_removes_observations_then_sales(monkeypatch) -> None:
    monkeypatch.setattr(
        supabase_client,
        "load_settings",
        lambda: {"supabase_url": "https://supabase.test", "supabase_service_role_key": "secret"},
    )

    class Response:
        def __init__(self, rows):
            self._rows = rows

        is_error = False

        def json(self):
            return self._rows

    responses = [
        [{"source_url": "https://vench.test/no-surface"}],
        [],
    ]

    def fake_get(endpoint, params, headers, timeout):
        assert endpoint == "https://supabase.test/rest/v1/auction_sales"
        assert params["source_name"] == "eq.vench"
        assert params["surface_m2"] == "is.null"
        assert params["habitable_surface_m2"] == "is.null"
        assert params["carrez_surface_m2"] == "is.null"
        assert params["app_surface_m2"] == "is.null"
        assert params["land_surface_m2"] == "is.null"
        return Response(responses.pop(0))

    calls = []
    monkeypatch.setattr(supabase_client.httpx, "get", fake_get)
    monkeypatch.setattr(
        supabase_client,
        "_postgrest_delete",
        lambda supabase_url, api_key, table, params: calls.append(table),
    )

    assert supabase_client.delete_vench_sales_without_surface_in_supabase() == 1
    assert calls == ["auction_observations", "auction_sales"]


def test_delete_vench_sales_without_surface_is_best_effort_on_lookup_error(monkeypatch) -> None:
    monkeypatch.setattr(
        supabase_client,
        "load_settings",
        lambda: {"supabase_url": "https://supabase.test", "supabase_service_role_key": "secret"},
    )

    class Response:
        is_error = True
        status_code = 522
        text = "connection timed out"

    monkeypatch.setattr(supabase_client.httpx, "get", lambda *args, **kwargs: Response())

    assert supabase_client.delete_vench_sales_without_surface_in_supabase() == 0


def test_upsert_sales_prefers_direct_postgres_when_db_url_is_configured(monkeypatch) -> None:
    sale = normalize_sale(
        {
            "source_name": "avoventes",
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
        lambda db_url, sales: calls.append((db_url, "delete_secondary", len(sales))) or 0,
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

    assert supabase_client.upsert_sales_to_supabase([sale]) == 1
    assert calls == [
        ("postgresql://example", "auction_sales", 1),
        ("postgresql://example", "delete_secondary", 1),
        ("https://supabase.test", "asset_tables", 1),
    ]


def test_upsert_observations_prefers_direct_postgres_when_db_url_is_configured(monkeypatch) -> None:
    sale = normalize_sale(
        {
            "source_name": "avoventes",
            "source_url": "https://example.test/sale",
            "observations": [{"source_name": "avoventes", "source_url": "https://example.test/sale"}],
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
        "auction_risks",
        "auction_risks",
        "auction_risk_occurrences",
        "auction_risk_occurrences",
        "auction_score_factors",
        "auction_score_factors",
    ]
    assert delete_calls[0][1].count("https://example.test") == supabase_client.POSTGREST_SOURCE_URL_DELETE_BATCH_SIZE
    assert delete_calls[1][1].count("https://example.test") == 1


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
