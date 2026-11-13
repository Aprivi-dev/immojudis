"""Plafonds d'un passage du travailleur de la file d'enrichissement (``python -m src.queued_runner``).

``src.queued_runner`` les applique : ses deux variables d'environnement peuvent les abaisser, jamais les dépasser.
``src.autonomous_runner``, qui lance le travailleur, les pose sous ces noms. Module feuille : le lanceur lit ici sans
importer le travailleur, dont l'import charge ``src.main`` (et sa configuration des journaux) avec toute la chaîne
d'enrichissement.
"""

from __future__ import annotations

ENRICHMENT_MAX_JOBS = 180
ENRICHMENT_BUDGET_SECONDS = 1200
ENRICHMENT_MAX_JOBS_ENV = "PIPELINE_ENRICHMENT_MAX_JOBS"
ENRICHMENT_BUDGET_SECONDS_ENV = "PIPELINE_ENRICHMENT_BUDGET_SECONDS"
