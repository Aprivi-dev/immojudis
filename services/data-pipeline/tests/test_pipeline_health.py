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


# --- visibilité matérialisée du catalogue (point 13) ------------------------------------------------


class _Cursor:
    def __init__(self, value):
        self.value = value

    def fetchone(self):
        return (self.value,)


class _Savepoint:
    def __init__(self, connection):
        self.connection = connection

    def __enter__(self):
        self.connection.savepoints += 1

    def __exit__(self, *exc):
        return False


class _ProjectionConnection:
    """Répond aux requêtes de contrôle par des comptes fixes, repérées par un fragment de leur texte."""

    def __init__(self, *, has_rule=True, counts=None, fail=None):
        self.has_rule = has_rule
        self.counts = counts or {}
        self.fail = fail
        self.queries: list[str] = []
        self.savepoints = 0

    def transaction(self):
        return _Savepoint(self)

    def execute(self, sql, params=None):
        self.queries.append(sql)
        if self.fail:
            raise self.fail
        if "to_regprocedure" in sql:
            return _Cursor(self.has_rule)
        for fragment, value in self.counts.items():
            if fragment in sql:
                return _Cursor(value)
        return _Cursor(0)


def test_catalogue_projection_report_counts_drift_status_only_quarantines_and_state_listings() -> None:
    from src.pipeline_health import catalogue_projection_report

    connection = _ProjectionConnection(
        counts={
            "interval '48 hours'": 2,
            "status = 'quarantined'": 5,
            "catalogue_state_observed_at": 3,
        }
    )

    report = catalogue_projection_report(connection, full_scan=False)

    assert report == {
        "available": True,
        "quarantine_rule": "payload_keys",
        "quarantine_drift_48h": 2,
        "quarantine_drift_full": None,
        "status_quarantined_without_flag": 5,
        "state_listings_leaving_7d": 3,
    }
    assert connection.savepoints == 1
    drift = next(sql for sql in connection.queries if "48 hours" in sql)
    # La requête limitée lit la colonne et la règle à trois clés ; la fenêtre des fiches de l'État est 7 à 14 jours.
    assert "app_private.catalogue_quarantine_from_payload(raw_payload)" in drift
    state = next(sql for sql in connection.queries if "catalogue_state_observed_at" in sql)
    assert "interval '14 days'" in state and "interval '7 days'" in state
    # Tout est en comptes : aucune adresse ni contenu de vente.
    assert all(sql.lstrip().startswith(("select count(*)", "select to_regprocedure")) for sql in connection.queries)


def test_the_full_drift_query_runs_only_when_asked() -> None:
    from src.pipeline_health import catalogue_projection_report

    weekly = _ProjectionConnection(counts={"where catalogue_quarantined is distinct": 4})
    report = catalogue_projection_report(weekly, full_scan=True)

    assert report["quarantine_drift_full"] == 4
    daily = _ProjectionConnection()
    assert catalogue_projection_report(daily, full_scan=False)["quarantine_drift_full"] is None
    assert len([sql for sql in daily.queries if "is distinct from" in sql]) == 1


def test_before_the_migration_the_report_falls_back_to_the_single_key_and_never_raises() -> None:
    from src.pipeline_health import catalogue_projection_report

    legacy = _ProjectionConnection(has_rule=False)
    report = catalogue_projection_report(legacy, full_scan=False)
    assert report["quarantine_rule"] == "publication_quarantine_only"
    assert not any("catalogue_quarantine_from_payload(raw_payload)" in sql for sql in legacy.queries)

    broken = _ProjectionConnection(fail=RuntimeError("column does not exist"))
    assert catalogue_projection_report(broken, full_scan=True) == {"available": False, "error": "RuntimeError"}


def test_full_drift_is_weekly_on_monday_and_can_be_forced(monkeypatch) -> None:
    from datetime import UTC, datetime

    from src.pipeline_health import full_drift_due

    monkeypatch.delenv("PIPELINE_HEALTH_FULL_DRIFT", raising=False)
    assert full_drift_due(datetime(2026, 10, 19, 9, 0, tzinfo=UTC))  # un lundi
    assert not full_drift_due(datetime(2026, 10, 20, 9, 0, tzinfo=UTC))
    monkeypatch.setenv("PIPELINE_HEALTH_FULL_DRIFT", "true")
    assert full_drift_due(datetime(2026, 10, 20, 9, 0, tzinfo=UTC))
    monkeypatch.setenv("PIPELINE_HEALTH_FULL_DRIFT", "false")
    assert not full_drift_due(datetime(2026, 10, 19, 9, 0, tzinfo=UTC))


def test_a_quarantine_drift_degrades_the_health_but_the_informational_counts_do_not() -> None:
    from src.pipeline_health import health_failed

    base = {"queue": [], "sources": [], "latest_collection": {}}
    informational = {
        "available": True,
        "quarantine_drift_48h": 0,
        "quarantine_drift_full": None,
        "status_quarantined_without_flag": 12,
        "state_listings_leaving_7d": 30,
    }
    assert not health_failed({**base, "catalogue_projection": informational})
    assert health_failed({**base, "catalogue_projection": {**informational, "quarantine_drift_48h": 1}})
    assert health_failed({**base, "catalogue_projection": {**informational, "quarantine_drift_full": 3}})
    assert not health_failed({**base, "catalogue_projection": {"available": False, "error": "UndefinedColumn"}})
