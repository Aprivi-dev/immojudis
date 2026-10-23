"""Qualité de la position d'une vente : drapeaux, distance à la commune, comparaison du nom de voie.

Fonctions pures (aucun réseau, aucune base) ; l'orchestration est dans ``src.geocode``.

Drapeaux de position (``quality_flags``), exposés à la garde de la vue aérienne :

* ``implausible_coordinates``  : les coordonnées de la source sont impossibles pour la vente (hors du
  département, ou à plus de ``IMPLAUSIBLE_DISTANCE_KM`` du centre de sa commune) ; le point est retiré.
* ``unverified_source_coordinates`` : les coordonnées de la source sont possibles mais suspectes (à plus de
  ``SUSPECT_DISTANCE_KM`` du centre de leur commune) et aucune adresse n'a pu les confirmer ; le point reste.
* ``geocode_outside_department`` : le géocodage a trouvé un point hors du département de la vente ; il a été refusé.

Un drapeau décrit la position actuelle : dès qu'une position vérifiée remplace ou confirme le point, ils sont retirés
(``clear_position_flags``). Le recalcul des ventes repart d'une liste vide et ne garde que ces trois drapeaux, et
``probable_duplicate``.

``probable_duplicate`` n'est pas un drapeau de position : il vient d'un rapprochement entre plusieurs lignes
(``src.probable_duplicates``), que le recalcul d'une seule ligne ne sait pas refaire. La vente est probablement la
copie d'une autre : la vue aérienne « bâtiment » de la fiche est refusée, car deux copies peuvent porter des points
différents. Il n'est jamais retiré par ``clear_position_flags`` ; seul le prochain passage de
``src.probable_duplicates`` le retire, quand la condition a disparu.
"""

from __future__ import annotations

import math
import re
import unicodedata
from collections.abc import Iterable
from difflib import SequenceMatcher

IMPLAUSIBLE_COORDINATES = "implausible_coordinates"
UNVERIFIED_SOURCE_COORDINATES = "unverified_source_coordinates"
GEOCODE_OUTSIDE_DEPARTMENT = "geocode_outside_department"
POSITION_FLAGS = frozenset({IMPLAUSIBLE_COORDINATES, UNVERIFIED_SOURCE_COORDINATES, GEOCODE_OUTSIDE_DEPARTMENT})
PROBABLE_DUPLICATE = "probable_duplicate"
# Ce que le recalcul d'une ligne garde de la liste lue en base (il ne peut pas le redéduire du texte de la vente).
PRESERVED_FLAGS = POSITION_FLAGS | {PROBABLE_DUPLICATE}

# Une commune française dépasse rarement 12 km du centre à sa limite ; aucune ne dépasse 40 km (Arles, la plus
# étendue de métropole, fait environ 40 km dans sa plus grande longueur : son centre est à moins de 30 km de
# toute limite).
SUSPECT_DISTANCE_KM = 12.0
IMPLAUSIBLE_DISTANCE_KM = 40.0

EARTH_RADIUS_KM = 6371.0088


def preserved_position_flags(flags: object) -> list[str]:
    """Les drapeaux de position (et ``probable_duplicate``) d'une liste lue en base, dans l'ordre, sans doublon."""
    if not isinstance(flags, list):
        return []
    return list(dict.fromkeys(flag for flag in flags if isinstance(flag, str) and flag in PRESERVED_FLAGS))


def add_position_flag(flags: list[str], flag: str) -> None:
    if flag not in flags:
        flags.append(flag)


def remove_flags(flags: list[str], names: Iterable[str]) -> list[str]:
    removed = set(names)
    return [flag for flag in flags if flag not in removed]


def distance_km(latitude_a: float, longitude_a: float, latitude_b: float, longitude_b: float) -> float:
    """Distance orthodromique (haversine) en kilomètres."""
    phi_a, phi_b = math.radians(latitude_a), math.radians(latitude_b)
    delta_phi = phi_b - phi_a
    delta_lambda = math.radians(longitude_b - longitude_a)
    h = math.sin(delta_phi / 2) ** 2 + math.cos(phi_a) * math.cos(phi_b) * math.sin(delta_lambda / 2) ** 2
    return 2 * EARTH_RADIUS_KM * math.asin(min(1.0, math.sqrt(h)))


def classify_distance_to_commune(distance: float) -> str | None:
    """``implausible`` / ``unverified`` / ``None`` (cohérent) selon la distance au centre de la commune."""
    if distance > IMPLAUSIBLE_DISTANCE_KM:
        return "implausible"
    if distance > SUSPECT_DISTANCE_KM:
        return "unverified"
    return None


# --- nom de voie ---------------------------------------------------------------------------------

_STREET_TYPES = frozenset(
    {
        "rue", "avenue", "av", "boulevard", "bd", "bld", "chemin", "ch", "route", "rte", "impasse", "imp",
        "place", "pl", "allee", "all", "quai", "cours", "square", "passage", "pass", "voie", "sentier", "faubourg",
        "fbg", "fg", "rond", "point", "esplanade", "promenade", "parvis", "montee", "traverse", "clos", "ruelle",
        "venelle", "mail", "cite", "villa", "chaussee", "lotissement", "residence", "hameau", "lieu", "dit",
        "cheminement", "sente", "boucle", "carrefour",
    }
)
_LEADING_STREET_TYPES = frozenset(
    {
        "rue", "avenue", "av", "boulevard", "bd", "bld", "chemin", "ch", "route", "rte", "impasse", "imp",
        "place", "pl", "allee", "all", "quai", "cours", "square", "passage", "voie", "sentier", "faubourg",
        "fbg", "fg", "esplanade", "promenade", "parvis", "montee", "traverse", "ruelle", "venelle", "mail",
        "chaussee", "cheminement", "sente", "boucle", "carrefour",
    }
)
_STOP_WORDS = frozenset({"de", "du", "des", "la", "le", "les", "l", "d", "et", "au", "aux", "en", "a"})
# Titres et prénoms de rues : leur omission ou leur ajout ne change pas la voie (« rue Jaurès » / « rue Jean Jaurès »
# n'en font pas partie : un prénom ordinaire ne se devine pas).
_TITLES = frozenset(
    {
        "saint", "sainte", "general", "marechal", "president", "docteur", "professeur", "abbe", "commandant",
        "colonel", "capitaine", "lieutenant", "pasteur", "maire", "pere", "frere", "sergent", "amiral",
        "ingenieur", "maitre", "me", "dr", "pr", "gal", "mal", "cdt", "cne", "lt", "col",
    }
)
_ABBREVIATIONS = {"st": "saint", "ste": "sainte"}
_LEADING_NUMBERS = re.compile(
    r"^\s*(?:n[°o]\s*)?\d+\s*(?:bis|ter|quater|[a-d])?\b(?:\s*(?:,|et|-|/|à|a)\s*\d+\s*(?:bis|ter|quater|[a-d])?\b)*[\s,.-]*",
    re.IGNORECASE,
)
_POSTAL_CODE = re.compile(r"\b\d{5}\b")


def _fold(text: str) -> str:
    decomposed = unicodedata.normalize("NFKD", text)
    return "".join(char for char in decomposed if not unicodedata.combining(char)).lower()


def _words(text: str) -> list[str]:
    return [_ABBREVIATIONS.get(word, word) for word in re.findall(r"[a-z0-9]+", _fold(text))]


def street_name_tokens(text: str | None, *, require_street_type: bool) -> frozenset[str] | None:
    """Mots significatifs du nom de voie, ou ``None`` quand il n'y a pas de voie à comparer.

    ``"5 rue du Château, 33000 Bordeaux"`` -> ``{"chateau"}`` ; ``"Rue du Château d'Eau"`` -> ``{"chateau", "eau"}``.
    Avec ``require_street_type``, une adresse qui ne commence pas par un type de voie (lieu-dit, « Résidence Les
    Pins ») n'a pas de voie comparable.
    """
    if not text:
        return None
    segment = _POSTAL_CODE.split(str(text), maxsplit=1)[0]
    segment = _LEADING_NUMBERS.sub("", segment, count=1)
    segment = segment.split(",", 1)[0]
    words = _words(segment)
    if require_street_type and (not words or words[0] not in _LEADING_STREET_TYPES):
        return None
    tokens = frozenset(word for word in words if word not in _STREET_TYPES and word not in _STOP_WORDS)
    return tokens or None


def _same_token(left: str, right: str) -> bool:
    return left == right or (len(left) > 4 and len(right) > 4 and SequenceMatcher(None, left, right).ratio() >= 0.85)


def street_names_match(query_tokens: frozenset[str] | None, result_tokens: frozenset[str] | None, score: float) -> bool:
    """Le nom de voie trouvé est-il celui demandé ?

    Sans voie d'un côté ou de l'autre, rien ne permet de refuser : vrai. Sinon les mots doivent se retrouver, aux
    fautes de frappe près ; les mots en trop ou en moins sont tolérés s'ils ne sont que des titres (« Général »,
    « Saint »), ou, quand la BAN est sûre d'elle (score 0,85 et plus), si la moitié des mots se retrouve (prénom
    omis). Un score de 0,6 ne suffit pas : « 5 rue du Château » ne devient pas « rue du Château d'Eau ».
    """
    if not query_tokens or not result_tokens:
        return True
    unmatched_query = {token for token in query_tokens if not any(_same_token(token, other) for other in result_tokens)}
    unmatched_result = {token for token in result_tokens if not any(_same_token(token, other) for other in query_tokens)}
    extra = unmatched_query | unmatched_result
    if not extra:
        return True
    if all(token in _TITLES or len(token) == 1 for token in extra):
        return True
    shared = len(query_tokens) - len(unmatched_query)
    union = shared + len(unmatched_query) + len(unmatched_result)
    return score >= 0.85 and shared > 0 and shared / union >= 0.5
