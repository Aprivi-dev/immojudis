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
