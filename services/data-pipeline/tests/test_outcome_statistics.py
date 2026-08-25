from __future__ import annotations

from dataclasses import replace
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from uuid import UUID

import pytest

from src.outcome_statistics.engine import (
    _meets_four_fifths,
    _rate_metric,
    _reliability,
    build_statistics_bundle,
    calculate_period,
    terminal_outcome_at,
)
from src.outcome_statistics.models import OutcomeVersion, RoundObservation

CUTOFF = datetime(2026, 7, 31, 12, tzinfo=UTC)
ALL_CLAIMS = frozenset(
    {
        "outcome_status",
        "initial_starting_price_eur",
        "effective_starting_price_eur",
        "initial_hammer_price_eur",
        "final_hammer_price_eur",
        "finality_status",
        "surenchere_status",
        "result_observed_at",
    }
)
SMALL_COMPLETE_WARNINGS = [
    "Statistiques descriptives historiques, pas une prédiction individuelle.",
    "Seules les preuves A/B validées pour chaque champ sont comptées.",
    "Le ratio de prix exige un prix final procéduralement définitif; le prix initial d’adjudication ne le remplace jamais.",
    "Ratio au marché et délai vers la prochaine audience masqués faute de preuve canonique dédiée.",
    "Échantillon inférieur à 10: toutes les valeurs de la cellule sont masquées.",
]


def _uuid(value: int) -> str:
    return str(UUID(int=value))


def _round(
    index: int,
    *,
    status: str = "held_adjudicated",
    court_index: int = 1,
    claims: frozenset[str] = ALL_CLAIMS,
    double_reviewed: bool = True,
    surenchere_status: str = "not_filed",
    finality_status: str = "procedurally_definitive",
    final_price: Decimal | None = Decimal("150000"),
    initial_hammer_price: Decimal | None = Decimal("125000"),
    feature_snapshot: bool = True,
    with_outcome: bool = True,
) -> RoundObservation:
    scheduled_at = datetime(2025, 8, 1, tzinfo=UTC) + timedelta(hours=index)
    outcomes: tuple[OutcomeVersion, ...] = ()
    if with_outcome:
        outcomes = (
            OutcomeVersion(
                outcome_id=_uuid(1_000_000 + court_index * 10_000 + index),
                version=1,
                valid_from=scheduled_at + timedelta(hours=1),
                valid_to=None,
                created_at=scheduled_at + timedelta(hours=1),
                supersedes_outcome_id=None,
                outcome_status=status,  # type: ignore[arg-type]
                initial_hammer_price_eur=initial_hammer_price,
                final_hammer_price_eur=final_price,
                finality_status=finality_status,  # type: ignore[arg-type]
                surenchere_status=surenchere_status,  # type: ignore[arg-type]
                result_observed_at=scheduled_at + timedelta(days=2),
                eligible_claims=claims,  # type: ignore[arg-type]
                status_independently_double_reviewed=double_reviewed,
                eligibility_evaluated_at=CUTOFF,
            ),
        )
    return RoundObservation(
        round_id=_uuid(100_000 + court_index * 10_000 + index),
        lot_id=_uuid(200_000 + court_index * 10_000 + index),
        court_id=_uuid(300_000 + court_index),
        court_code=f"TJ-{court_index:03d}",
        court_name=f"Tribunal {court_index}",
        judicial_region=f"Région {court_index}",
        round_kind="initial",
        scheduled_at=scheduled_at,
        local_timezone="Europe/Paris",
        feature_snapshot_id=(_uuid(400_000 + court_index * 10_000 + index) if feature_snapshot else None),
        initial_starting_price_eur=Decimal("100000"),
        effective_starting_price_eur=Decimal("110000"),
        outcomes=outcomes,
    )


def _bundle(rows: list[RoundObservation]):
    return build_statistics_bundle(
        rows,
        knowledge_cutoff_at=CUTOFF,
        window_months=12,
        maturity_days=30,
        computed_at=CUTOFF + timedelta(seconds=1),
    )


def test_calculate_period_uses_closed_calendar_months() -> None:
    period = calculate_period(CUTOFF, 12, 30)

    assert period.start.isoformat() == "2025-07-02"
    assert period.end.isoformat() == "2026-07-01"

    with pytest.raises(ValueError):
        calculate_period(CUTOFF, 18, 30)
    with pytest.raises(ValueError):
        calculate_period(CUTOFF.replace(tzinfo=None), 12, 30)

    leap_boundary = calculate_period(datetime(2025, 3, 30, tzinfo=UTC), 12, 30)
    assert leap_boundary.end.isoformat() == "2025-02-28"
    assert leap_boundary.start.isoformat() == "2024-03-01"


def test_builder_v1_rejects_non_initial_rounds() -> None:
    with pytest.raises(ValueError, match="initial rounds only"):
        build_statistics_bundle(
            [],
            knowledge_cutoff_at=CUTOFF,
            window_months=12,
            round_kind="postponed",
            computed_at=CUTOFF,
        )


def test_terminal_outcome_is_selected_strictly_as_of_cutoff_and_valid_to() -> None:
    first = OutcomeVersion(
        outcome_id=_uuid(1),
        version=1,
        valid_from=datetime(2025, 1, 1, tzinfo=UTC),
        valid_to=datetime(2026, 1, 1, tzinfo=UTC),
        created_at=datetime(2025, 1, 1, tzinfo=UTC),
        supersedes_outcome_id=None,
        outcome_status="postponed",
    )
    second = OutcomeVersion(
        outcome_id=_uuid(2),
        version=2,
        valid_from=datetime(2026, 1, 1, tzinfo=UTC),
        valid_to=None,
        created_at=datetime(2026, 1, 2, tzinfo=UTC),
        supersedes_outcome_id=first.outcome_id,
        outcome_status="held_adjudicated",
    )

    historical, reason = terminal_outcome_at((first, second), datetime(2025, 12, 1, tzinfo=UTC))
    assert historical == first
    assert reason is None

    current, reason = terminal_outcome_at((first, second), datetime(2026, 2, 1, tzinfo=UTC))
    assert current == second
    assert reason is None

    expired, reason = terminal_outcome_at((first,), datetime(2026, 2, 1, tzinfo=UTC))
    assert expired is None
    assert reason == "no_terminal_outcome_at_cutoff"

    root_without_valid_to = OutcomeVersion(
        outcome_id=_uuid(10),
        version=1,
        valid_from=datetime(2024, 1, 1, tzinfo=UTC),
        valid_to=None,
        created_at=datetime(2024, 1, 1, tzinfo=UTC),
        supersedes_outcome_id=None,
        outcome_status="postponed",
    )
    expired_middle = OutcomeVersion(
        outcome_id=_uuid(11),
        version=2,
        valid_from=datetime(2025, 1, 1, tzinfo=UTC),
        valid_to=datetime(2026, 1, 1, tzinfo=UTC),
        created_at=datetime(2025, 1, 1, tzinfo=UTC),
        supersedes_outcome_id=root_without_valid_to.outcome_id,
        outcome_status="postponed",
    )
    latest = OutcomeVersion(
        outcome_id=_uuid(12),
        version=3,
        valid_from=datetime(2026, 1, 1, tzinfo=UTC),
        valid_to=None,
        created_at=datetime(2026, 1, 1, tzinfo=UTC),
        supersedes_outcome_id=expired_middle.outcome_id,
        outcome_status="held_adjudicated",
    )
    terminal, reason = terminal_outcome_at(
        (root_without_valid_to, expired_middle, latest),
        datetime(2026, 2, 1, tzinfo=UTC),
    )
    assert terminal == latest
    assert reason is None

    backdated_after_cutoff = OutcomeVersion(
        outcome_id=_uuid(13),
        version=1,
        valid_from=datetime(2025, 1, 1, tzinfo=UTC),
        valid_to=None,
        created_at=datetime(2025, 1, 1, tzinfo=UTC),
        supersedes_outcome_id=None,
        outcome_status="held_adjudicated",
        recorded_at=datetime(2026, 3, 1, tzinfo=UTC),
    )
    invisible, reason = terminal_outcome_at(
        (backdated_after_cutoff,),
        datetime(2026, 2, 1, tzinfo=UTC),
    )
    assert invisible is None
    assert reason == "no_terminal_outcome_at_cutoff"


def test_round_is_the_unit_and_flow_denominators_are_separate() -> None:
    statuses = (
        ["held_no_bid"] * 4
        + ["held_adjudicated"] * 8
        + ["postponed"] * 3
        + ["cancelled"] * 3
        + ["not_requested"] * 2
        + ["unknown"] * 2
    )
    rows = [_round(index, status=status) for index, status in enumerate(statuses)]
    snapshot = _bundle(rows).national

    assert snapshot.eligible_round_count == 22
    assert snapshot.status_sample_size == 20
    assert snapshot.outcome_coverage == pytest.approx(20 / 22, abs=1e-6)
    held = snapshot.statistics["flow"]["held"]
    no_bid = snapshot.statistics["flow"]["noBidIfHeld"]
    adjudicated = snapshot.statistics["flow"]["adjudicatedIfHeld"]
    assert held["numerator"] == 12
    assert held["knownDenominator"] == 20
    assert held["unknownCount"] == 2
    assert no_bid["numerator"] == 4
    assert no_bid["knownDenominator"] == 12
    assert no_bid["eligibleUniverse"] == 12
    assert no_bid["unknownCount"] == 0
    assert no_bid["excludedCount"] == 0
    assert adjudicated["numerator"] == 8
    assert adjudicated["knownDenominator"] == 12


def test_non_adjudicated_legacy_hammer_value_is_never_marked_eligible() -> None:
    snapshot = _bundle(
        [
            _round(
                1,
                status="held_no_bid",
                initial_hammer_price=Decimal("125000"),
            )
        ]
    ).national

    assert snapshot.members[0].status_claim_eligible is True
    assert snapshot.members[0].initial_hammer_price_claim_eligible is False


def test_one_fully_double_reviewed_result_has_exact_small_sample_warnings() -> None:
    snapshot = _bundle([_round(1, double_reviewed=True)]).national

    assert snapshot.statistics["warnings"] == SMALL_COMPLETE_WARNINGS


def test_empty_universe_has_no_review_or_coverage_warning() -> None:
    snapshot = _bundle([]).national

    assert snapshot.statistics["warnings"] == SMALL_COMPLETE_WARNINGS


def test_surenchere_denominator_excludes_open_and_unknown_windows() -> None:
    statuses = ["filed"] * 3 + ["not_filed"] * 5 + ["deadline_expired"] * 2 + ["window_open"] * 2
    rows = [_round(index, surenchere_status=status) for index, status in enumerate(statuses)]
    snapshot = _bundle(rows).national
    filed = snapshot.statistics["surenchere"]["filed"]

    assert snapshot.surenchere_sample_size == 10
    assert filed["numerator"] == 3
    assert filed["knownDenominator"] == 10
    assert filed["eligibleUniverse"] == 12
    assert filed["unknownCount"] == 2
    assert filed["rawValue"] == pytest.approx(0.3)


def test_price_ratio_requires_final_definitive_claim_and_never_uses_initial_hammer() -> None:
    rows = [_round(index) for index in range(32)]
    rows[30] = _round(
        30,
        claims=frozenset(ALL_CLAIMS - {"finality_status"}),
        finality_status="provisional",
    )
    rows[31] = _round(31, final_price=None, initial_hammer_price=Decimal("999999"))
    snapshot = _bundle(rows).national
    distribution = snapshot.statistics["priceRatios"]["finalToInitial"]

    assert snapshot.initial_price_sample_size == 30
    assert distribution["sampleSize"] == 30
    assert distribution["excludedCount"] == 1
    assert distribution["unknownCount"] == 1
    assert distribution["method"] == "log_shrinkage"
    assert distribution["raw"]["p50"] == pytest.approx(1.5)


@pytest.mark.parametrize(
    ("sample_size", "expected"),
    (
        (9, "insufficient_data"),
        (10, "smoothed"),
        (29, "smoothed"),
        (30, "descriptive"),
        (99, "descriptive"),
        (100, "robust"),
    ),
)
def test_reliability_thresholds(sample_size: int, expected: str) -> None:
    snapshot = _bundle([_round(index) for index in range(sample_size)]).national

    assert snapshot.reliability_status == expected
    if sample_size < 10:
        assert snapshot.quality_gate_passed is False
        assert snapshot.statistics["flow"]["held"]["method"] == "suppressed"
        assert snapshot.statistics["flow"]["held"]["knownDenominator"] is None


def test_robust_requires_80_percent_coverage_boundary() -> None:
    assert _reliability(100, True, False) == "descriptive"
    assert _reliability(100, True, True) == "robust"
    assert _meets_four_fifths(1_599_999, 2_000_000) is False
    assert _meets_four_fifths(1_600_000, 2_000_000) is True


def test_published_coverages_use_postgres_half_up_rounding() -> None:
    coverage_rows = [
        *[_round(index) for index in range(105)],
        *[_round(1_000 + index, status="unknown") for index in range(23)],
    ]
    coverage_snapshot = _bundle(coverage_rows).national
    assert coverage_snapshot.status_sample_size == 105
    assert coverage_snapshot.eligible_round_count == 128
    assert coverage_snapshot.outcome_coverage == 0.820313

    freeze_rows = [
        *[_round(index) for index in range(105)],
        *[_round(2_000 + index, feature_snapshot=False) for index in range(23)],
    ]
    freeze_snapshot = _bundle(freeze_rows).national
    assert freeze_snapshot.eligible_round_count == 105
    assert freeze_snapshot.unfrozen_round_count == 23
    assert freeze_snapshot.freeze_coverage == 0.820313


def test_large_valid_beta_interval_converges() -> None:
    metric = _rate_metric(
        numerator=62_500,
        known_denominator=125_000,
        eligible_universe=125_000,
        unknown_count=0,
        exclusion_reasons={},
        quality_gate_passed=True,
        parent_metric=None,
        national=True,
    )

    assert metric["method"] == "beta_binomial"
    assert metric["confidenceInterval"]["low"] < 0.5
    assert metric["confidenceInterval"]["high"] > 0.5


def test_quality_gate_uses_first_500_and_suppresses_every_public_cell() -> None:
    rows = [
        _round(
            index,
            double_reviewed=(index < 99 or index == 500),
        )
        for index in range(501)
    ]
    snapshot = _bundle(rows).national

    assert snapshot.double_reviewed_count == 100
    assert snapshot.quality_gate_passed is False
    assert snapshot.reliability_status == "insufficient_data"
    metrics = [*snapshot.statistics["flow"].values(), snapshot.statistics["surenchere"]["filed"]]
    distributions = [
        *snapshot.statistics["priceRatios"].values(),
        *snapshot.statistics["delays"].values(),
    ]
    for metric in metrics:
        assert metric == {
            "rawValue": None,
            "adjustedValue": None,
            "numerator": None,
            "knownDenominator": None,
            "eligibleUniverse": None,
            "unknownCount": None,
            "excludedCount": None,
            "exclusionReasons": {},
            "confidenceInterval": None,
            "method": "suppressed",
        }
    for distribution in distributions:
        assert distribution["method"] == "suppressed"
        assert distribution["sampleSize"] is None
        assert distribution["eligibleUniverse"] is None
        assert distribution["raw"] is None
        assert distribution["adjusted"] is None
        assert distribution["exclusionReasons"] == {}


def test_local_publication_requires_a_publishable_national_parent() -> None:
    rows = [
        *[_round(index, court_index=1, double_reviewed=False) for index in range(500)],
        *[_round(1_000 + index, court_index=2, double_reviewed=True) for index in range(100)],
    ]
    bundle = _bundle(rows)
    local = next(item for item in bundle.tribunals if item.court_code == "TJ-002")

    assert bundle.national.quality_gate_passed is False
    assert local.status_sample_size == 100
    assert local.quality_gate_passed is False
    assert local.reliability_status == "insufficient_data"
    assert local.statistics["flow"]["held"]["method"] == "suppressed"
    assert (
        "Référence nationale non publiable: toutes les valeurs locales sont masquées." in local.statistics["warnings"]
    )


def test_national_distribution_under_30_is_redacted_and_tribunal_uses_parent_log_shrinkage() -> None:
    under_30 = _bundle([_round(index) for index in range(29)]).national
    assert under_30.statistics["priceRatios"]["finalToInitial"]["method"] == "suppressed"

    rows = [
        *[_round(index, court_index=1, final_price=Decimal(120000 + index * 1000)) for index in range(30)],
        *[_round(index, court_index=2, final_price=Decimal(200000 + index * 1000)) for index in range(30)],
    ]
    bundle = _bundle(rows)
    national_distribution = bundle.national.statistics["priceRatios"]["finalToInitial"]
    tribunal_distribution = bundle.tribunals[0].statistics["priceRatios"]["finalToInitial"]

    assert national_distribution["method"] == "log_shrinkage"
    assert tribunal_distribution["method"] == "log_shrinkage"
    assert tribunal_distribution["parentSampleSize"] == 60
    assert tribunal_distribution["adjusted"] != tribunal_distribution["raw"]
    assert tribunal_distribution["adjusted"]["p10"] <= tribunal_distribution["adjusted"]["p50"]
    assert tribunal_distribution["adjusted"]["p50"] <= tribunal_distribution["adjusted"]["p90"]
    assert bundle.national.statistics["priceRatios"]["finalToMarket"]["sampleSize"] is None


def test_unfrozen_rounds_are_excluded_from_universe_with_aggregate_warning() -> None:
    rows = [_round(index) for index in range(10)] + [_round(100, feature_snapshot=False)]
    snapshot = _bundle(rows).national

    assert snapshot.eligible_round_count == 10
    assert len(snapshot.members) == 10
    assert all(member.feature_snapshot_id for member in snapshot.members)
    assert "round_not_frozen_at_cutoff" in snapshot.statistics["warnings"]
    assert snapshot.unfrozen_round_count == 1
    tribunal = _bundle(rows).tribunals[0]
    assert "round_not_frozen_at_cutoff" in tribunal.statistics["warnings"]
    assert tribunal.unfrozen_round_count == 1


def test_unfrozen_only_court_still_gets_a_suppressed_snapshot() -> None:
    frozen = _round(1, court_index=1)
    unfrozen = _round(2, court_index=2, feature_snapshot=False)
    bundle = _bundle([frozen, unfrozen])
    tribunal = next(item for item in bundle.tribunals if item.court_code == "TJ-002")

    assert tribunal.eligible_round_count == 0
    assert tribunal.unfrozen_round_count == 1
    assert tribunal.freeze_coverage == 0.0
    assert tribunal.quality_gate_passed is False
    assert tribunal.reliability_status == "insufficient_data"
    assert tribunal.members == ()
    assert tuple(item.round_id for item in tribunal.unfrozen_rounds) == (unfrozen.round_id,)
    assert tribunal.statistics["flow"]["held"]["method"] == "suppressed"
    assert "unfrozenRounds" not in tribunal.statistics
    assert unfrozen.round_id not in repr(tribunal.statistics)


def test_unfrozen_private_manifest_is_deterministic_and_identity_sensitive() -> None:
    first_round = _round(100, feature_snapshot=False)
    second_round = _round(101, feature_snapshot=False)
    first = _bundle([first_round, second_round]).national
    reordered = _bundle([second_round, first_round]).national
    replaced = _bundle([first_round, _round(102, feature_snapshot=False)]).national
    mutated_identity = _bundle(
        [
            replace(first_round, scheduled_at=first_round.scheduled_at + timedelta(minutes=1)),
            second_round,
        ]
    ).national

    assert first.unfrozen_round_count == 2
    assert [item.round_id for item in first.unfrozen_rounds] == sorted((first_round.round_id, second_round.round_id))
    assert first.unfrozen_rounds == reordered.unfrozen_rounds
    assert first.source_manifest_hash == reordered.source_manifest_hash
    assert first.source_manifest_hash != replaced.source_manifest_hash
    assert first.source_manifest_hash != mutated_identity.source_manifest_hash


def test_low_freeze_coverage_suppresses_an_otherwise_large_verified_sample() -> None:
    rows = [_round(index) for index in range(100)] + [
        _round(1_000 + index, feature_snapshot=False) for index in range(30)
    ]
    snapshot = _bundle(rows).national

    assert snapshot.eligible_round_count == 100
    assert snapshot.unfrozen_round_count == 30
    assert snapshot.freeze_coverage == pytest.approx(100 / 130, abs=1e-6)
    assert snapshot.quality_gate_passed is False
    assert snapshot.reliability_status == "insufficient_data"
    assert snapshot.statistics["flow"]["held"]["method"] == "suppressed"
    assert (
        "Couverture du gel antérieur au cutoff inférieure à 80 %: publication supprimée."
        in snapshot.statistics["warnings"]
    )


def test_hashes_are_deterministic_and_change_with_the_manifest() -> None:
    rows = [_round(index) for index in range(30)]
    first = _bundle(rows).national
    reordered = _bundle(list(reversed(rows))).national
    changed = _bundle([*rows[:-1], _round(29, status="cancelled")]).national

    assert first.source_manifest_hash == reordered.source_manifest_hash
    assert first.statistics_hash == reordered.statistics_hash
    assert first.statistics_hash != changed.statistics_hash


def test_duplicate_round_never_double_counts_evidence() -> None:
    row = _round(1)
    with pytest.raises(ValueError, match="duplicate auction round") as captured:
        _bundle([row, row])

    assert row.round_id not in str(captured.value)
    assert str(captured.value) == "duplicate auction round in statistics input"


def test_engine_validation_errors_do_not_echo_court_or_timezone_identifiers() -> None:
    first = _round(1)
    inconsistent = replace(_round(2), court_name="Autre tribunal")
    with pytest.raises(ValueError) as court_error:
        _bundle([first, inconsistent])

    assert first.court_id not in str(court_error.value)
    assert str(court_error.value) == "inconsistent court metadata in statistics input"

    secret_timezone = f"invalid/{_uuid(999)}"
    with pytest.raises(ValueError) as timezone_error:
        _bundle([replace(first, local_timezone=secret_timezone)])

    assert secret_timezone not in str(timezone_error.value)
    assert str(timezone_error.value) == "unknown local timezone in statistics input"
