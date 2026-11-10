"""Versions candidates de la lecture des pièces, essayées avant de remplacer celle de production.

Une nouvelle version (autre consigne, autre choix des pages, autre budget) s'ajoute ici comme un
``ReadingProfile`` dans :data:`CANDIDATE_PROFILES`. ``scripts/document_reading_trial.py`` la lit alors en lecture
seule à côté du profil de production, le même jour et sur les mêmes ventes, et rend les points gardés et rejetés
de chacun. Elle ne passe en production (``document_reading.PRODUCTION_PROFILE`` et
``DOCUMENT_READING_VERSION``) qu'après un essai concluant.

Historique : la v4 a été essayée ici le 10/11/2026 (profils « v4 » et « v4_wide ») avant de devenir la version
de production. Aucun candidat n'est en cours.
"""

from __future__ import annotations

from src.document_reading import ReadingProfile

CANDIDATE_PROFILES: dict[str, ReadingProfile] = {}
