import os
from contextlib import nullcontext

import pytest

from src.normalize import normalize_sale
from src.storage import supabase_client
from src.storage.supabase_client import _postgres_connect


def _sale(source_url: str, observations: list[dict[str, object]]):
    return normalize_sale(
        {
            "source_name": "licitor",
            "source_url": source_url,
            "starting_price_eur": 100000,
            "observations": observations,
        }
    )


def test_observation_batch_deduplicates_urls_and_keeps_admissible_rows(monkeypatch) -> None:
    calls: list[list[dict[str, object]]] = []
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
        lambda _db_url, _table, payload, on_conflict: calls.append(payload),
    )
    monkeypatch.setattr(
        supabase_client,
        "_rest_parented_observation_payload",
        lambda _url, _key, payload: payload,
    )

    sale = _sale(
        "https://sale.test/canonical",
        [
            {
                "source_url": "https://source.test/b",
                "raw_payload": {"version": "new"},
                "observed_at": "2026-09-13T12:00:00Z",
            },
            {"source_url": "https://source.test/a", "raw_payload": {"version": "one"}},
            {"source_url": "https://source.test/b", "raw_payload": {"version": "old"}},
            {"source_url": ""},
        ],
    )
    sale.observations.extend([None, "invalid"])

    result = supabase_client.upsert_observations_to_supabase([sale])

    assert result == 2
    assert len(calls) == 1
    payload = calls[0]
    assert [row["source_url"] for row in payload] == [
        "https://source.test/a",
        "https://source.test/b",
    ]
    selected = payload[1]
    assert selected["raw_payload"] == {"version": "new"}
    assert selected["observed_at"] == "2026-09-13T12:00:00+00:00"


def test_observation_batch_does_not_regress_when_stale_retry_follows_newer_version(monkeypatch) -> None:
    captured: list[list[dict[str, object]]] = []
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
        lambda _url, _key, _table, payload, on_conflict: captured.append(payload),
    )
    monkeypatch.setattr(
        supabase_client,
        "_rest_parented_observation_payload",
        lambda _url, _key, payload: payload,
    )

    newer = _sale(
        "https://sale.test/new",
        [
            {
                "source_url": "https://source.test/retry",
                "external_id": "current",
                "raw_payload": {"version": 2, "title": "current"},
                "observed_at": "2026-09-13T12:00:00Z",
            }
        ],
    )
    stale_retry = _sale(
        "https://sale.test/old",
        [
            {
                "source_url": "https://source.test/retry",
                "external_id": "stale",
                "raw_payload": {"version": 1, "title": "stale"},
                "observed_at": "2026-09-13T11:00:00Z",
            }
        ],
    )

    assert supabase_client.upsert_observations_to_supabase([newer, stale_retry]) == 1

    row = captured[0][0]
    assert row["external_id"] == "current"
    assert row["raw_payload"] == {"version": 2, "title": "current"}
    assert row["observed_at"] == "2026-09-13T12:00:00+00:00"


def test_observation_batch_fails_closed_when_direct_parent_guard_fails(monkeypatch) -> None:
    postgres_calls: list[list[dict[str, object]]] = []
    rest_calls: list[list[dict[str, object]]] = []
    monkeypatch.setattr(
        supabase_client,
        "load_settings",
        lambda: {
            "supabase_url": "https://supabase.test",
            "supabase_service_role_key": "secret",
            "supabase_db_url": "postgresql://example",
        },
    )

    def fail_postgres(_db_url, _table, payload, on_conflict):
        postgres_calls.append(payload)
        raise RuntimeError("test direct-write failure")

    monkeypatch.setattr(supabase_client, "_postgres_upsert", fail_postgres)
    monkeypatch.setattr(
        supabase_client,
        "_postgrest_upsert",
        lambda _url, _key, _table, payload, on_conflict: rest_calls.append(payload),
    )

    with pytest.raises(RuntimeError, match="test direct-write failure"):
        supabase_client.upsert_observations_to_supabase([
            _sale("https://sale.test/fallback", [{"source_url": "https://source.test/duplicate"}]),
        ])
    assert len(postgres_calls) == 1
    assert rest_calls == []


def test_rest_observation_parent_guard_filters_unknown_canonicals(monkeypatch) -> None:
    class Response:
        is_error = False
        status_code = 200
        text = ""
        request = None

        @staticmethod
        def json():
            return [{"source_url": "https://sale.test/persisted"}]

    monkeypatch.setattr(
        supabase_client,
        "_postgrest_request_with_retries",
        lambda *args, **kwargs: Response(),
    )
    payload = [
        {"source_url": "https://source.test/ok", "canonical_source_url": "https://sale.test/persisted"},
        {"source_url": "https://source.test/missing", "canonical_source_url": "https://sale.test/quarantined"},
    ]

    assert supabase_client._rest_parented_observation_payload("https://supabase.test", "secret", payload) == [payload[0]]


def test_observations_skip_missing_canonical_parent_inside_parent_guard(monkeypatch) -> None:
    url = os.getenv("PIPELINE_TEST_DB_URL")
    if not url:
        pytest.skip("Requires disposable PostgreSQL")
    with _postgres_connect(url) as db:
        try:
            db.execute("""
                create table auction_sales(
                    source_url text primary key,
                    source_urls jsonb not null default '[]'::jsonb
                )
            """)
            db.execute("""
                create table auction_observations(
                    source_url text primary key,
                    source_name text not null,
                    external_id text,
                    canonical_source_url text references auction_sales(source_url) on delete set null,
                    content_hash text,
                    raw_payload jsonb,
                    observed_at timestamptz default now(),
                    updated_at timestamptz default now()
                )
            """)
            db.execute(
                "insert into auction_sales(source_url) values (%s)",
                ("https://sale.test/persisted",),
            )
            monkeypatch.setattr(
                supabase_client,
                "load_settings",
                lambda: {
                    "supabase_url": "https://supabase.test",
                    "supabase_service_role_key": "secret",
                    "supabase_db_url": url,
                },
            )
            monkeypatch.setattr(supabase_client, "_postgres_connect", lambda _url: nullcontext(db))

            persisted = _sale("https://sale.test/persisted", [{"source_url": "https://source.test/ok"}])
            missing = _sale("https://sale.test/quarantined", [{"source_url": "https://source.test/missing"}])

            assert supabase_client.upsert_observations_to_supabase([persisted, missing]) == 1
            rows = db.execute(
                "select source_url, canonical_source_url from auction_observations order by source_url"
            ).fetchall()
            assert [
                tuple(value.decode() if isinstance(value, bytes) else value for value in row)
                for row in rows
            ] == [("https://source.test/ok", "https://sale.test/persisted")]
        finally:
            db.rollback()
