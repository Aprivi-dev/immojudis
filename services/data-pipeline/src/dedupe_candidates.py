"""Rapport des doublons que le balayage fusionnerait, sans aucune écriture.

``python -m src.dedupe_candidates`` (workflow « Dedupe candidates report », ou
``DEDUPE_RECONCILE_MODE=candidates`` pendant une collecte complète) liste, pour relecture par le
propriétaire avant d'activer ``DEDUPE_RECONCILE_ENABLED``, les paires que
``reconcile_duplicate_sales_in_supabase`` supprimerait : ligne conservée, ligne supprimée (identifiant,
source, commune, date, mise à prix) et raison de la fusion. Aucune adresse, aucun contact. Le format du
rapport est dans ``src.storage.duplicate_sweep``.
"""

from __future__ import annotations

import argparse
import logging
from pathlib import Path

from src.storage.duplicate_sweep import DuplicateSweepPlan, emit_candidates_report
from src.storage.supabase_client import plan_duplicate_reconciliation

LOGGER = logging.getLogger(__name__)


def report_duplicate_candidates(*, output: Path | None = None) -> DuplicateSweepPlan | None:
    """Calcule et publie le rapport. Lecture seule ; ``None`` si Supabase n'est pas configuré."""
    plan = plan_duplicate_reconciliation(max_merges=None)
    if plan is None:
        LOGGER.warning("Duplicate candidates: Supabase is not configured; nothing to report.")
        return None
    emit_candidates_report(plan, output=output)
    return plan


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=None, help="Écrit aussi le rapport en JSON.")
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    return 0 if report_duplicate_candidates(output=args.output) is not None else 1


if __name__ == "__main__":
    raise SystemExit(main())
