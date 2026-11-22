"""Invariant : l'alerte critique ``.missed`` ne doit pas s'ouvrir à chaque cycle de collecte.

Trois valeurs doivent rester cohérentes :

* ``INVENTORY_CADENCE`` (``src/autonomous_runner.py``), la cadence réelle par source ;
* le littéral SQL de ``claim_autonomous_pipeline_run`` (échéance provisoire) ;
* le seuil de l'alerte ``pipeline.source.<source>.missed`` dans
  ``observe_autonomous_pipeline``.

Les migrations remplacent les corps de fonction sur place : la valeur effective est celle
de la dernière migration (par ordre de version) qui la définit. Les chaînes ``$old$...$old$``
des migrations de remplacement sont des valeurs attendues avant correctif, pas des définitions.
"""
from __future__ import annotations

import re
from datetime import timedelta
from pathlib import Path

from src.autonomous_runner import INVENTORY_CADENCE

MIGRATIONS = Path(__file__).resolve().parents[3] / "supabase" / "migrations"

# Délai de répartition (GitHub) et durée d'un run, puis deux passages de l'ordonnanceur.
DISPATCH_AND_RUN_MARGIN = timedelta(minutes=50)
SCHEDULER_TICK = timedelta(minutes=15)

_OLD_SECTION = re.compile(r"\$old\$.*?\$old\$", re.DOTALL)
_CLAIM_CADENCE = re.compile(r"next_inventory_at\s*=\s*now_at\s*\+\s*interval\s*'(\d+)\s+(hour|minute)s?'")
_MISSED_THRESHOLD = re.compile(
    r"\)\s*<\s*p_now\s*-\s*interval\s*'(\d+)\s+(hour|minute)s?'\s*;"
)


def _interval(amount: str, unit: str) -> timedelta:
    return timedelta(**{f"{unit}s": int(amount)})


def _effective_interval(pattern: re.Pattern[str], *, required_text: str | None = None) -> tuple[timedelta, str]:
    """Return the interval defined by the latest migration matching ``pattern``."""
    found: tuple[timedelta, str] | None = None
    for path in sorted(MIGRATIONS.glob("*.sql")):
        text = _OLD_SECTION.sub("", path.read_text(encoding="utf-8"))
        if required_text is not None and required_text not in text:
            continue
        matches = pattern.findall(text)
        if not matches:
            continue
        assert len(matches) == 1, f"{path.name}: {len(matches)} définitions concurrentes de {pattern.pattern}"
        found = (_interval(*matches[0]), path.name)
    assert found is not None, f"aucune migration ne définit {pattern.pattern}"
    return found


def test_claim_placeholder_follows_the_inventory_cadence() -> None:
    claim, migration = _effective_interval(_CLAIM_CADENCE)

    assert claim == INVENTORY_CADENCE, (
        f"{migration}: l'échéance provisoire de claim_autonomous_pipeline_run ({claim}) "
        f"doit rester égale à INVENTORY_CADENCE ({INVENTORY_CADENCE})"
    )


def test_missed_alert_threshold_leaves_room_for_a_healthy_cycle() -> None:
    claim, _ = _effective_interval(_CLAIM_CADENCE)
    threshold, migration = _effective_interval(_MISSED_THRESHOLD, required_text=".missed")
    cadence = max(INVENTORY_CADENCE, claim)
    minimum = cadence + DISPATCH_AND_RUN_MARGIN + 2 * SCHEDULER_TICK

    assert threshold > minimum, (
        f"{migration}: le seuil de pipeline.source.<source>.missed ({threshold}) doit dépasser "
        f"la cadence {cadence} + {DISPATCH_AND_RUN_MARGIN} + 2 x {SCHEDULER_TICK} = {minimum}, "
        "sinon l'alerte critique s'ouvre à chaque cycle"
    )


_ENRICHMENT_LEASE = re.compile(r"'running_lease_seconds'\s*,\s*(\d+)")
# Passage d'operational-health, qui appelle le planificateur (docs/operations/planification.md).
HEALTH_TICK = timedelta(minutes=30)
# Démarrage du workflow (paquets, dépendances, caches) avant que le lanceur ne prenne l'exécution.
WORKFLOW_STARTUP = timedelta(minutes=5)


def _enrichment_lease() -> tuple[timedelta, str]:
    found: tuple[timedelta, str] | None = None
    for path in sorted(MIGRATIONS.glob("*.sql")):
        matches = _ENRICHMENT_LEASE.findall(path.read_text(encoding="utf-8"))
        if matches:
            assert len(matches) == 1, f"{path.name}: {len(matches)} baux d'exécution de la file"
            found = (timedelta(seconds=int(matches[0])), path.name)
    assert found is not None, "aucune migration n'écrit running_lease_seconds"
    return found


def test_an_enrichment_unit_ends_inside_its_lease_and_before_the_tick_that_follows() -> None:
    from src import autonomous_runner as runner

    lease, migration = _enrichment_lease()
    unit = lease - timedelta(seconds=runner.ENRICHMENT_LEASE_MARGIN_SECONDS)
    one_cycle = timedelta(seconds=runner.ENRICHMENT_WORKER_TIMEOUT_SECONDS + runner.DOCUMENT_BACKLOG_BUDGET_SECONDS
                          + runner.DOCUMENT_READING_BUDGET_SECONDS + runner.DOCUMENT_VISION_BUDGET_SECONDS
                          + runner.ADDRESS_POSITIONS_BUDGET_SECONDS
                          + runner.PDF_PHOTOS_BUDGET_SECONDS + runner.LICITOR_HISTORY_BUDGET_SECONDS
                          + runner.LICITOR_SNAPSHOT_ONLY_SECONDS)
    assert unit >= one_cycle, f"{migration}: une unité de {unit} ne tient pas un passage complet ({one_cycle})"
    # Le bail est un multiple du passage d'operational-health : l'unité suivante part au passage qui suit la fin.
    assert lease % HEALTH_TICK == timedelta(0), f"{migration}: bail {lease} hors cadence {HEALTH_TICK}"
    assert unit + WORKFLOW_STARTUP < lease
    # Alerte pipeline.import.unhealthy : une exécution running depuis plus de 3 h.
    assert lease < timedelta(hours=3)


def test_a_collection_prewait_fits_in_its_dispatch_lease() -> None:
    from src import autonomous_runner as runner

    # Bail d'une exécution en file : 60 minutes après le lancement (claim_autonomous_pipeline_run).
    queued_lease = timedelta(minutes=60)
    prewait = timedelta(seconds=runner.COLLECTION_CATALOGUE_PREWAIT_SECONDS)
    assert prewait + WORKFLOW_STARTUP + HEALTH_TICK <= queued_lease


def test_python_and_sql_read_the_queue_lease_with_one_rule() -> None:
    """Point F6 : le lanceur et l'expiration des baux valident running_lease_seconds de la même façon."""
    from src.autonomous_runner import RUNNING_LEASE_SECONDS_PATTERN

    _lease, migration = _enrichment_lease()
    text = (MIGRATIONS / migration).read_text(encoding="utf-8")
    assert f"r.summary->>'running_lease_seconds' ~ '^{RUNNING_LEASE_SECONDS_PATTERN}$'" in text
    assert re.fullmatch(RUNNING_LEASE_SECONDS_PATTERN, str(int(_lease.total_seconds())))
