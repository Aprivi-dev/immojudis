from __future__ import annotations

import json
import stat
from copy import deepcopy
from pathlib import Path

import pytest

from src import source_extraction_backfill as backfill
from src.source_extraction_backfill import (
    PROTECTED_FIELDS,
    UPDATE_ALLOWLIST,
    PlanIntegrityError,
    apply_plan,
    build_plan,
    load_plan,
    plan_backfill,
)


def _row(*, sale_id: str = "sale-1", updated_at: str = "2026-10-02T10:00:00+00:00") -> dict[str, object]:
    return {
        "id": sale_id,
        "updated_at": updated_at,
        "source_name": "avoventes",
        "source_url": f"https://source.example/{sale_id}",
        "title": "Appartement rez-de-jardin",
        "description": "Appartement 3 pièces, 2 chambres. Surface 50 m2.",
        "starting_price_eur": 120000,
        "sale_date": "2026-12-01T00:00:00+00:00",
        "status": "upcoming",
        "latitude": 43.3,
        "longitude": 5.4,
        "investment_score": 8.5,
        "quality_flags": ["legacy_quality_flag"],
        "has_garden": True,
        "has_terrace": True,
        "bedrooms_count": 2,
        "raw_payload": {
            "title": "Appartement rez-de-jardin",
            "description": "Appartement 3 pièces, 2 chambres. Surface 50 m2.",
            "starting_price_eur": 120000,
            "sale_date": "2026-12-01T00:00:00+00:00",
            "status": "upcoming",
            "latitude": 43.3,
            "source_blocks": {"property": "rez-de-jardin, 50 m2"},
        },
    }


def test_plan_is_limited_to_physical_fields_and_private_backup(tmp_path: Path) -> None:
    plan_path = tmp_path / "source-backfill-plan.json"
    backup_path = tmp_path / "source-backfill-backup.json"
    plan = plan_backfill(
        [_row()],
        plan_path=plan_path,
        backup_path=backup_path,
        generated_at="2026-10-02T12:00:00+00:00",
    )

    assert plan["counters"]["planned"] == 1
    values = plan["operations"][0]["values"]
    assert set(values) <= UPDATE_ALLOWLIST
    assert not set(values) & PROTECTED_FIELDS
    assert "starting_price_eur" not in values
    assert "sale_date" not in values
    assert "status" not in values
    assert "quality_flags" not in values

    enriched = values["raw_payload"]["source_extraction_backfill"]
    assert enriched["schema_version"] == "source_extraction_backfill_v1"
    # Existing raw evidence is carried through unchanged; it is not rebuilt
    # from the normalized sale, which could otherwise rewrite protected data.
    assert values["raw_payload"]["starting_price_eur"] == 120000
    assert values["raw_payload"]["status"] == "upcoming"
    assert stat.S_IMODE(plan_path.stat().st_mode) & 0o077 == 0
    assert stat.S_IMODE(backup_path.stat().st_mode) & 0o077 == 0
    assert load_plan(plan_path)["checksum"] == plan["checksum"]


def test_build_plan_skips_rows_without_an_optimistic_concurrency_fence(tmp_path: Path) -> None:
    row_without_id = _row(sale_id="")
    row_without_id.pop("id")
    row_without_timestamp = _row(sale_id="sale-2", updated_at="")
    plan, _backup = build_plan(
        [row_without_id, row_without_timestamp],
        backup_path=tmp_path / "backup.json",
        generated_at="2026-10-02T12:00:00+00:00",
    )

    assert plan["operations"] == []
    assert plan["counters"]["skipped"] == 2
    assert plan["counters"]["skipped_by_reason"] == {
        "missing_id": 1,
        "missing_updated_at": 1,
    }


def test_tampering_with_plan_or_backup_fails_before_http(tmp_path: Path) -> None:
    plan_path = tmp_path / "plan.json"
    backup_path = tmp_path / "backup.json"
    plan_backfill(
        [_row()],
        plan_path=plan_path,
        backup_path=backup_path,
        generated_at="2026-10-02T12:00:00+00:00",
    )

    original = json.loads(plan_path.read_text())
    original["operations"][0]["values"]["status"] = "closed"
    plan_path.write_text(json.dumps(original))
    with pytest.raises(PlanIntegrityError, match="Checksum"):
        load_plan(plan_path)

    # Recreate a valid plan, then modify the mandatory backup.  The HTTP
    # callback must never be reached when the rollback artifact is stale.
    plan_backfill(
        [_row()],
        plan_path=plan_path,
        backup_path=backup_path,
        generated_at="2026-10-02T12:00:00+00:00",
    )
    backup = json.loads(backup_path.read_text())
    backup["rows"][0]["status"] = "closed"
    backup_path.write_text(json.dumps(backup))
    called = False

    def request(*_args, **_kwargs):
        nonlocal called
        called = True
        raise AssertionError("un plan non intègre ne doit jamais appeler PostgREST")

    with pytest.raises(PlanIntegrityError, match="sauvegarde"):
        apply_plan(
            plan_path,
            backup_path=backup_path,
            postgrest_url="https://supabase.example",
            api_key="secret",
            request_fn=request,
        )
    assert called is False


def test_apply_uses_id_and_observed_updated_at_and_skips_empty_match(tmp_path: Path) -> None:
    plan_path = tmp_path / "plan.json"
    backup_path = tmp_path / "backup.json"
    plan = plan_backfill(
        [_row(sale_id="sale-1"), _row(sale_id="sale-2", updated_at="2026-10-02T11:00:00+00:00")],
        plan_path=plan_path,
        backup_path=backup_path,
        generated_at="2026-10-02T12:00:00+00:00",
    )
    calls: list[dict[str, object]] = []

    class Response:
        def __init__(self, status_code: int, body: object):
            self.status_code = status_code
            self.body = body

        def json(self):
            return self.body

    def request(method, url, **kwargs):
        calls.append({"method": method, "url": url, **kwargs})
        return Response(200, [] if len(calls) == 1 else [{"id": "sale-2"}])

    result = apply_plan(
        plan_path,
        backup_path=backup_path,
        postgrest_url="https://supabase.example",
        api_key="secret",
        request_fn=request,
    )

    assert result == {
        "planned": plan["counters"]["planned"],
        "applied": 1,
        "skipped_concurrent": 1,
        "errors": 0,
        "error_details": [],
    }
    assert all(call["method"] == "PATCH" for call in calls)
    assert all(call["url"] == "https://supabase.example/rest/v1/auction_sales" for call in calls)
    assert calls[0]["params"] == {
        "id": "eq.sale-1",
        "updated_at": "eq.2026-10-02T10:00:00+00:00",
    }
    assert calls[1]["params"]["id"] == "eq.sale-2"
    for call in calls:
        body = call["json"]
        assert set(body) <= UPDATE_ALLOWLIST
        assert not set(body) & PROTECTED_FIELDS
        assert call["headers"]["Prefer"] == "return=representation"


def test_apply_rejects_modified_operation_even_when_plan_checksum_is_rebuilt(tmp_path: Path) -> None:
    plan_path = tmp_path / "plan.json"
    backup_path = tmp_path / "backup.json"
    plan = plan_backfill(
        [_row()],
        plan_path=plan_path,
        backup_path=backup_path,
        generated_at="2026-10-02T12:00:00+00:00",
    )
    tampered = dict(plan)
    operation = dict(tampered["operations"][0])
    operation["observed_updated_at"] = "2026-10-03T00:00:00+00:00"
    tampered["operations"] = [operation]
    tampered.pop("checksum")
    tampered["checksum"] = __import__("hashlib").sha256(
        json.dumps(tampered, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()
    plan_path.write_text(json.dumps(tampered))
    with pytest.raises(PlanIntegrityError, match="correspond"):
        apply_plan(
            plan_path,
            backup_path=backup_path,
            postgrest_url="https://supabase.example",
            api_key="secret",
            request_fn=lambda *_args, **_kwargs: pytest.fail("no request"),
        )


def test_listing_completeness_is_projected_exactly_and_replay_is_idempotent(tmp_path: Path) -> None:
    row = _row()
    row["raw_payload"] = {
        **row["raw_payload"],
        "source_blocks": {
            "property": "rez-de-jardin, 50 m2",
            # This must never be fed back into surface reasoning.
            "listing_completeness": {"source_property_features": {"surface_m2": {"value": 9999}}},
        },
    }
    expected_sale = backfill._recompute_sale(row)
    expected_projection = expected_sale.raw_payload["source_blocks"]["listing_completeness"]
    assert "9999" not in backfill._surface_context(expected_sale)

    first_plan, _backup = build_plan(
        [row],
        backup_path=tmp_path / "backup-1.json",
        generated_at="2026-10-02T12:00:00+00:00",
    )
    first_values = first_plan["operations"][0]["values"]
    assert first_values["raw_payload"]["source_blocks"]["listing_completeness"] == expected_projection

    # Model the result of applying the first operation to the next storage
    # snapshot.  A second plan must not rewrite the projection or its
    # namespace merely because its run timestamp is different.
    replay_row = deepcopy(row)
    replay_row.update({key: value for key, value in first_values.items() if key != "raw_payload"})
    replay_row["raw_payload"] = first_values["raw_payload"]
    second_plan, _backup = build_plan(
        [replay_row],
        backup_path=tmp_path / "backup-2.json",
        generated_at="2026-10-02T13:00:00+00:00",
    )
    assert second_plan["counters"]["planned"] == 0
    assert second_plan["counters"]["unchanged"] == 1


def test_projection_survives_application_view_without_raw_payload(tmp_path: Path) -> None:
    row = _row()
    raw_payload = row.pop("raw_payload")
    row["source_blocks"] = raw_payload["source_blocks"]
    expected = backfill._recompute_sale(row).raw_payload["source_blocks"]["listing_completeness"]

    plan, _backup = build_plan(
        [row],
        backup_path=tmp_path / "backup-view.json",
        generated_at="2026-10-02T12:00:00+00:00",
    )
    projected_payload = plan["operations"][0]["values"]["raw_payload"]
    assert projected_payload["source_blocks"]["listing_completeness"] == expected
    assert projected_payload["source_blocks"]["property"] == "rez-de-jardin, 50 m2"
