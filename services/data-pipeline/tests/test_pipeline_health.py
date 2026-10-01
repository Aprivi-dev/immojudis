import json

from src.pipeline_health import compact_queue_claimability, summarize_queue_activity


def test_claimability_snapshot_whitelists_counts_without_replacing_raw_backlog() -> None:
    metrics = {
        "backlog": 40,
        "older_than_24h": 32,
        "claimable_due": 14,
        "excluded_due": 21,
        "source_url": "https://private.example/receipt",
        "contact": "private@example.test",
    }

    assert compact_queue_claimability(metrics) == {"claimable_due": 14, "excluded_due": 21}
    assert metrics["backlog"] == 40
    assert metrics["older_than_24h"] == 32


def test_claimability_legacy_or_partial_observation_is_not_invented_as_zero() -> None:
    assert compact_queue_claimability(None) is None
    assert compact_queue_claimability({"backlog": 40, "older_than_24h": 32}) is None
    assert compact_queue_claimability({"claimable_due": 0}) is None
    assert compact_queue_claimability({"claimable_due": 0, "excluded_due": 0}) == {
        "claimable_due": 0,
        "excluded_due": 0,
    }


def test_claimability_snapshot_rejects_invalid_count_evidence() -> None:
    for value in (-1, True, "21", None):
        assert compact_queue_claimability({"claimable_due": value, "excluded_due": 0}) is None
        assert compact_queue_claimability({"claimable_due": 0, "excluded_due": value}) is None


def test_queue_activity_aggregates_families_without_listing_identifiers() -> None:
    rows = [
        {
            "type": "source_detail",
            "status": "queued",
            "count": 4,
            "exhausted": 0,
            "overdue": 3,
            "created_24h": 1,
            "completed_24h": 0,
            "failed_24h": 0,
            "cancelled_24h": 0,
            "oldest_pending_created_at": "2026-09-25T10:00:00+00:00",
        },
        {
            "type": "source_detail",
            "status": "completed",
            "count": 6,
            "exhausted": 0,
            "overdue": 0,
            "created_24h": 2,
            "completed_24h": 2,
            "failed_24h": 0,
            "cancelled_24h": 0,
            "oldest_pending_created_at": None,
        },
        {
            "type": "display_description",
            "status": "failed",
            "count": 3,
            "exhausted": 2,
            "overdue": 1,
            "created_24h": 0,
            "completed_24h": 0,
            "failed_24h": 2,
            "cancelled_24h": 0,
            "oldest_pending_created_at": "2026-09-26T10:00:00+00:00",
        },
    ]

    report = summarize_queue_activity(rows)

    assert [family["type"] for family in report["families"]] == [
        "display_description",
        "source_detail",
    ]
    source_detail = report["families"][1]
    assert source_detail["status_counts"] == {"queued": 4, "completed": 6}
    assert source_detail["rows_created_24h"] == 3
    assert source_detail["rows_completed_24h"] == 2
    assert source_detail["pending_rows"] == 4
    assert source_detail["overdue_rows_48h"] == 3
    assert source_detail["exhausted_rows"] == 0
    assert source_detail["oldest_pending_created_at"] == "2026-09-25T10:00:00+00:00"
    assert "source_url" not in json.dumps(report)


def test_queue_activity_explicitly_refuses_to_claim_net_throughput() -> None:
    report = summarize_queue_activity(
        [
            {
                "type": "pdf",
                "status": "completed",
                "count": 5,
                "exhausted": 0,
                "overdue": 0,
                "created_24h": 5,
                "completed_24h": 5,
                "failed_24h": 0,
                "cancelled_24h": 0,
                "oldest_pending_created_at": None,
            }
        ]
    )

    assert report["throughput"]["calculable"] is False
    assert "upsert" in report["throughput"]["reason"]
    assert "status transitions" in report["throughput"]["reason"]


def test_queue_activity_handles_empty_queue() -> None:
    assert summarize_queue_activity([]) == {
        "window_hours": 24,
        "families": [],
        "throughput": {
            "calculable": False,
            "reason": (
                "auction_enrichment_jobs does not record enqueue/upsert attempts "
                "or status transitions; these counters cannot establish net ingress, "
                "drain, or jobs per hour"
            ),
        },
    }
