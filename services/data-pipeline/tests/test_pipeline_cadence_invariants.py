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
