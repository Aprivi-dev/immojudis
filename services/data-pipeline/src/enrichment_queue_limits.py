"""Plafonds d'un passage du travailleur de la file d'enrichissement (``python -m src.queued_runner``).

``src.queued_runner`` les applique : ses deux variables d'environnement peuvent les abaisser, jamais les dépasser.
``src.autonomous_runner``, qui lance le travailleur, les pose sous ces noms. Module feuille : le lanceur lit ici sans
importer le travailleur, dont l'import charge ``src.main`` (et sa configuration des journaux) avec toute la chaîne
d'enrichissement.

Depuis la voie d'enrichissement séparée des collectes (17/11/2026), une unité planifiée enchaîne plusieurs passages
(« cycles ») de ces plafonds ; le travailleur rend compte de chaque passage au lanceur dans le fichier nommé par
``ENRICHMENT_WORKER_REPORT_ENV`` (raison d'arrêt, tâches traitées).
"""

from __future__ import annotations

import json
import logging
import os

ENRICHMENT_MAX_JOBS = 180
ENRICHMENT_BUDGET_SECONDS = 1200
ENRICHMENT_MAX_JOBS_ENV = "PIPELINE_ENRICHMENT_MAX_JOBS"
ENRICHMENT_BUDGET_SECONDS_ENV = "PIPELINE_ENRICHMENT_BUDGET_SECONDS"
#: Chemin du compte rendu JSON d'un passage du travailleur, posé par le lanceur ; absent, rien n'est écrit.
ENRICHMENT_WORKER_REPORT_ENV = "PIPELINE_ENRICHMENT_WORKER_REPORT"
#: Raison d'arrêt du travailleur qui a cédé la place à une collecte (``src.collection_priority``).
COLLECTION_PENDING_STOP_REASON = "collection_pending"
#: Raison d'arrêt du travailleur qui n'a plus rien trouvé à prendre dans la file.
QUEUES_EMPTY_STOP_REASON = "queues_empty"


def finish_worker_pass(stop_reason: str, yielded: bool, handled: int, handled_by_family: dict[str, int]) -> str:
    """Raison d'arrêt finale d'un passage du travailleur, rendue au lanceur dans ``ENRICHMENT_WORKER_REPORT_ENV``.

    ``yielded`` : le passage a cédé la place à une collecte. Sans la variable (lancement manuel, tests), rien n'est
    écrit ; une écriture impossible est seulement notée, l'unité s'arrête alors après ce passage.
    """
    reason = COLLECTION_PENDING_STOP_REASON if yielded else stop_reason
    path = (os.getenv(ENRICHMENT_WORKER_REPORT_ENV) or "").strip()
    if path:
        report = {"stop_reason": reason, "handled": handled, "handled_by_family": dict(handled_by_family)}
        try:
            with open(path, "w", encoding="utf-8") as handle:
                json.dump(report, handle)
        except OSError as exc:
            logging.getLogger(__name__).warning("Enrichment worker report not written: %s", exc)
    return reason


def read_worker_report(path: str) -> dict[str, object] | None:
    """Le compte rendu écrit par ``finish_worker_pass`` ; None s'il manque ou est illisible."""
    try:
        with open(path, encoding="utf-8") as handle:
            report = json.load(handle)
    except (OSError, ValueError):
        return None
    return report if isinstance(report, dict) else None
