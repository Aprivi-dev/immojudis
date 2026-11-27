"""Versions candidates de la lecture des pièces, essayées avant de remplacer celle de production.

Une nouvelle version (autre consigne, autre choix des pages, autre budget) s'ajoute ici comme un
``ReadingProfile`` dans :data:`CANDIDATE_PROFILES`. ``scripts/document_reading_trial.py`` la lit alors en lecture
seule à côté du profil de production, le même jour et sur les mêmes ventes, et rend les points gardés et rejetés
de chacun. Elle ne passe en production (``document_reading.PRODUCTION_PROFILE`` et
``DOCUMENT_READING_VERSION``) qu'après un essai concluant.

Historique : la v4 a été essayée ici le 10/11/2026 (profils « v4 » et « v4_wide ») avant de devenir la version
de production.

Candidat en cours, « v5 » (27/11/2026) : la v4, plus un champ « check » par point : ce qu'il reste à vérifier
(lors de la visite, dans une pièce, auprès de l'avocat poursuivant, de la mairie ou du syndic), en une phrase à
l'infinitif. Ni montant, ni conseil sur l'achat : ``document_reading_check.checked_check`` retire un « check » qui en
porte, sans retirer son point. Le choix des pages, le budget de texte, le nombre de points et la longueur de
réponse autorisée sont ceux de la v4. À juger à l'essai : le nombre de points gardés ne doit pas baisser par
rapport au témoin, aucune réponse ne doit être coupée par ce champ de plus (colonne « sortie coupée » du
rapport), et les « check » doivent être propres au dossier.
"""

from __future__ import annotations

from dataclasses import replace

from src.document_reading import PRODUCTION_PROFILE, SYSTEM_PROMPT, ReadingProfile
from src.document_reading_check import checked_check

V5_VERSION = "document_reading_v5"

_V4_ANSWER_RULE = "Réponds uniquement par un objet JSON :\n"
_V4_QUOTE_FIELD = '"document": "D1", "page": 3, "quote": "extrait exact", '

_V5_CHECK_RULE = (
    "- \"check\" dit ce qu'il reste à VÉRIFIER pour ce point, en une seule phrase courte qui commence par un "
    "verbe à l'infinitif : « Regarder l'état du plafond de la cuisine lors de la visite », « Demander le bail "
    "à l'avocat poursuivant », « Lire le règlement de la zone en mairie ». Il porte sur ce que le texte laisse "
    "ouvert : ce qui n'a pas pu être contrôlé, ce qui manque au dossier, ce qui est annoncé sans être prouvé. "
    "N'y écris ni montant, ni délai, ni nom de personne, ni coordonnées, ni avis sur l'intérêt d'acheter ou "
    "d'enchérir, ni conseil juridique. Si rien de précis ne reste à vérifier, écris une chaîne vide : un "
    "« check » passe-partout (« Vérifier ce point ») est rejeté.\n"
)
_V5_CHECK_FIELD = '"check": "ce qu\'il reste à vérifier, à l\'infinitif, ou chaîne vide", '


def _v5_system_prompt() -> str:
    """The v4 prompt with the rule and the field of « check »; fails loudly if the v4 prompt changed shape."""
    if SYSTEM_PROMPT.count(_V4_ANSWER_RULE) != 1 or SYSTEM_PROMPT.count(_V4_QUOTE_FIELD) != 1:
        raise RuntimeError("La consigne v4 a changé : la consigne v5 doit être réécrite à partir d'elle.")
    return SYSTEM_PROMPT.replace(_V4_ANSWER_RULE, _V5_CHECK_RULE + _V4_ANSWER_RULE).replace(
        _V4_QUOTE_FIELD, _V4_QUOTE_FIELD + _V5_CHECK_FIELD
    )


V5_PROFILE: ReadingProfile = replace(
    PRODUCTION_PROFILE,
    version=V5_VERSION,
    system_prompt=_v5_system_prompt(),
    check_rule=checked_check,
)

CANDIDATE_PROFILES: dict[str, ReadingProfile] = {"v5": V5_PROFILE}
