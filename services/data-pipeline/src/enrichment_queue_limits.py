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
