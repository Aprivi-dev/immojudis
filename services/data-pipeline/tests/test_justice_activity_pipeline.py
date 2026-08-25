from __future__ import annotations

from datetime import UTC, date, datetime

from src.justice_activity_pipeline import (
    CourtCoverageProfile,
    CourtReference,
    JusticeActivityPipelineError,
    JusticeActivityRepository,
    build_coverage_report,
    build_judicial_region_reference,
    enrich_court_judicial_regions,
    match_activity_records,
    normalize_court_name,
    select_pilot_regions,
    statjur_official_reference,
)
from src.official_sources.justice_activity import (
    JusticeActivityMetric,
    JusticeActivityParseResult,
    JusticeJurisdictionActivityRecord,
)


def _record(code: str, name: str, value: int = 5) -> JusticeJurisdictionActivityRecord:
    metric = JusticeActivityMetric(status="observed", value=value)
    return JusticeJurisdictionActivityRecord(
        source_court_code=code,
        source_court_name=name,
        activity_year=2019,
        new_sales_seizures=metric,
        terminated_sales_seizures=metric,
        canonical_hash=(code[-1] or "0") * 64,
    )


def _result(records: tuple[JusticeJurisdictionActivityRecord, ...]) -> JusticeActivityParseResult:
    return JusticeActivityParseResult(
        activity_year=2019,
        source_version="v26.02.2",
        national=_record("00000000", "FRANCE", 186),
        records=records,
        content_hash="a" * 64,
    )


def test_normalize_court_name_handles_old_and_current_labels() -> None:
    assert normalize_court_name("Tribunal de grande instance de Bordeaux") == "bordeaux"
    assert normalize_court_name("TJ BORDEAUX") == "bordeaux"
    assert normalize_court_name("Tribunal judiciaire d'Évry-Courcouronnes") == "evry courcouronnes"
    assert statjur_official_reference("00100119") == ("1", "119")
    assert statjur_official_reference("00915273") == ("9", "15273")


def test_match_activity_records_is_exact_and_fails_closed_on_ambiguity() -> None:
    courts = (
        CourtReference("1", "TJ33063", "Tribunal judiciaire de Bordeaux", "Bordeaux"),
        CourtReference("2", "same", "TJ Saint-Denis", "Paris"),
        CourtReference("3", "other", "TJ Saint-Denis", "La Réunion"),
    )
    matches = match_activity_records(
        (
            _record("33000001", "BORDEAUX"),
            _record("99000001", "SAINT-DENIS"),
            _record("88000001", "VILLE INCONNUE"),
        ),
        courts,
    )

    assert matches[0].status == "exact_name"
    assert matches[0].court == courts[0]
    assert matches[1].status == "ambiguous"
    assert matches[1].court is None
    assert matches[1].candidate_court_ids == ("2", "3")
    assert matches[2].status == "unmatched"


def test_match_activity_records_prefers_the_official_origin_and_srj_identity() -> None:
    court = CourtReference(
        "1",
        "agen",
        "TJ Agen renommé",
        "Agen",
        official_origin_code="1",
        official_srj_code="119",
    )
    match = match_activity_records((_record("00100119", "ANCIEN LIBELLÉ"),), (court,))[0]

    assert match.status == "exact_official_reference"
    assert match.court == court


def test_official_competence_reference_enriches_appellate_regions() -> None:
    reference = build_judicial_region_reference(
        (
            {
                "tj_origin_code": "1",
                "tj_srj_code": "119",
                "tj_name": "Tribunal judiciaire d'Agen",
                "ca_name": "Cour d'Appel d'Agen",
            },
            {
                "tj_origin_code": "1",
                "tj_srj_code": "94",
                "tj_name": "Tribunal judiciaire de Bordeaux",
                "ca_name": "Cour d'Appel de Bordeaux",
            },
        )
    )
    courts = (
        CourtReference("1", "agen", "TJ Agen", None, "1", "119"),
        CourtReference("2", "bordeaux", "TJ Bordeaux", None),
    )

    enriched = enrich_court_judicial_regions(courts, reference)

    assert enriched[0].judicial_region == "Cour d'Appel d'Agen"
    assert enriched[1].judicial_region == "Cour d'Appel de Bordeaux"


def test_coverage_report_keeps_historical_and_current_periods_separate() -> None:
    record = _record("33000001", "BORDEAUX", 9)
    court = CourtReference("1", "TJ33063", "TJ Bordeaux", "Bordeaux")
    matches = match_activity_records((record,), (court,))
    report = build_coverage_report(
        result=_result((record,)),
        matches=matches,
        catalogue_counts={"1": 12},
        catalogue_total_sales=20,
        generated_at=datetime(2026, 8, 24, 12, tzinfo=UTC),
    )

    assert report.periods_comparable is False
    assert report.official_activity_year == 2019
    assert report.catalogue_window_months == 36
    assert report.courts[0].catalogue_sales_36m == 12
    assert report.courts[0].official_new_cases_value == 9
    assert report.courts[0].catalogue_profile_publishable is True
    assert report.catalogue_total_sales_36m == 20
    assert report.catalogue_exact_court_sales_36m == 12
    assert report.catalogue_exact_court_assignment_rate == 0.6


def test_pilot_selection_includes_distinct_volume_bands() -> None:
    profiles: list[CourtCoverageProfile] = []
    for region_index, volume in enumerate((2, 10, 40, 80), start=1):
        for court_index in range(3):
            profiles.append(
                CourtCoverageProfile(
                    court_id=f"{region_index}-{court_index}",
                    court_code=f"TJ{region_index}{court_index}",
                    court_name=f"TJ {region_index}-{court_index}",
                    judicial_region=f"Région {region_index}",
                    catalogue_sales_36m=volume,
                    catalogue_profile_publishable=volume >= 5,
                    official_activity_year=2019,
                    official_new_cases_status="observed",
                    official_new_cases_value=volume,
                    official_terminated_cases_status="observed",
                    official_terminated_cases_value=volume,
                )
            )

    pilots = select_pilot_regions(profiles, count=3)

    assert len(pilots) == 3
    assert {pilot.volume_band for pilot in pilots} == {"low", "medium", "high"}


class _FakeCursor:
    def __init__(self, *, policy: tuple[object, ...], import_id: str | None) -> None:
        self.policy = policy
        self.import_id = import_id
        self.fetchone_value: tuple[object, ...] | None = None
        self.calls: list[tuple[str, tuple[object, ...] | None]] = []

    def __enter__(self) -> _FakeCursor:
        return self

    def __exit__(self, *_args: object) -> None:
        return None

    def execute(self, statement: str, parameters: tuple[object, ...] | None = None) -> None:
        compact = " ".join(statement.split())
        self.calls.append((compact, parameters))
        if "from public.data_sources" in compact:
            self.fetchone_value = self.policy
        elif "returning id::text" in compact:
            self.fetchone_value = (self.import_id,) if self.import_id else None
        else:
            self.fetchone_value = None

    def fetchone(self) -> tuple[object, ...] | None:
        return self.fetchone_value


class _FakeConnection:
    def __init__(self, cursor: _FakeCursor) -> None:
        self.fake_cursor = cursor
        self.commits = 0

    def __enter__(self) -> _FakeConnection:
        return self

    def __exit__(self, *_args: object) -> None:
        return None

    def cursor(self) -> _FakeCursor:
        return self.fake_cursor

    def commit(self) -> None:
        self.commits += 1


class _CoverageCursor:
    def __init__(self) -> None:
        self.calls: list[tuple[str, tuple[object, ...] | None]] = []
        self.description: list[object] = []
        self._rows: list[tuple[object, ...]] = []
        self._one: tuple[object, ...] | None = None

    def __enter__(self) -> _CoverageCursor:
        return self

    def __exit__(self, *_args: object) -> None:
        return None

    def execute(self, statement: str, parameters: tuple[object, ...] | None = None) -> None:
        compact = " ".join(statement.split())
        self.calls.append((compact, parameters))
        if "from public.outcome_courts court" in compact:
            column_names = (
                "court_id",
                "code",
                "name",
                "judicial_region",
                "court_origin_code",
                "court_srj_code",
                "catalogue_sales",
            )
            self.description = [
                type("_Column", (), {"name": column_name})() for column_name in column_names
            ]
            self._rows = [
                (
                    "court-1",
                    "justice_tj_1_94",
                    "TJ Bordeaux",
                    "Cour d'Appel de Bordeaux",
                    "1",
                    "94",
                    6,
                )
            ]
            self._one = None
        else:
            self.description = [type("_Column", (), {"name": "count"})()]
            self._rows = []
            self._one = (29,)

    def fetchall(self) -> list[tuple[object, ...]]:
        return self._rows

    def fetchone(self) -> tuple[object, ...] | None:
        return self._one


def test_repository_counts_only_verified_judicial_sales() -> None:
    cursor = _CoverageCursor()
    connection = _FakeConnection(cursor)  # type: ignore[arg-type]
    repository = JusticeActivityRepository(connect=lambda _db_url: connection)

    courts, counts, total = repository.load_courts_and_catalogue_counts(
        "postgresql://not-used",
        as_of=date(2026, 8, 24),
    )

    assert courts[0].official_origin_code == "1"
    assert courts[0].official_srj_code == "94"
    assert counts == {"court-1": 6}
    assert total == 29
    court_query, total_query = (call[0] for call in cursor.calls)
    assert "public.outcome_court_official_references" in court_query
    assert "sale.sale_venue_type = 'tribunal'" in court_query
    assert "sale.sale_verification_status in ('verified', 'cross_checked')" in court_query
    assert "sale.sale_venue_type = 'tribunal'" in total_query
    assert "sale.sale_verification_status in ('verified', 'cross_checked')" in total_query


def test_repository_persists_matched_and_unmatched_rows_append_only() -> None:
    records = (_record("00100119", "AGEN"), _record("99000001", "VILLE HISTORIQUE"))
    court = CourtReference("court-1", "agen", "TJ Agen", "Agen", "1", "119")
    matches = match_activity_records(records, (court,))
    cursor = _FakeCursor(
        policy=("source-1", True, True, "approved", "allowed_automated"),
        import_id="import-1",
    )
    connection = _FakeConnection(cursor)
    repository = JusticeActivityRepository(connect=lambda _db_url: connection)

    summary = repository.persist(
        "postgresql://not-used",
        result=_result(records),
        matches=matches,
        fetched_at=datetime(2026, 8, 24, 12, tzinfo=UTC),
    )

    assert summary.inserted is True
    assert summary.matched_rows == 1
    assert summary.unmatched_rows == 1
    activity_inserts = [call for call in cursor.calls if "insert into public.justice_jurisdiction_activity (" in call[0]]
    assert len(activity_inserts) == 2
    assert activity_inserts[0][1] is not None and activity_inserts[0][1][5] == "exact_official_reference"
    assert activity_inserts[1][1] is not None and activity_inserts[1][1][1] is None
    assert connection.commits == 1


def test_repository_rejects_a_closed_source_policy_before_writing() -> None:
    record = _record("00100119", "AGEN")
    cursor = _FakeCursor(
        policy=("source-1", True, False, "pending", "disabled"),
        import_id="import-1",
    )
    repository = JusticeActivityRepository(connect=lambda _db_url: _FakeConnection(cursor))

    try:
        repository.persist(
            "postgresql://not-used",
            result=_result((record,)),
            matches=match_activity_records((record,), ()),
            fetched_at=datetime(2026, 8, 24, 12, tzinfo=UTC),
        )
    except JusticeActivityPipelineError as exc:
        assert "approved" in str(exc)
    else:  # pragma: no cover - explicit failure makes the guard obvious.
        raise AssertionError("closed source policy should fail before an import insert")

    assert not any("insert into" in statement for statement, _parameters in cursor.calls)
