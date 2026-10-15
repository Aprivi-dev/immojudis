"""Libellés de tribunal et de commune pollués par le texte voisin d'une annonce.

Exemples réels : « TJ Tribunal Judiciaire de NANCY le », « TJ Béziers Suite À Des Poursuites… »,
ville « USAGE D'HABITATION à Chanteheux ». Un libellé de tribunal est rattaché au référentiel
national des tribunaux (``court_competence``) au lieu de garder le texte brut ; une valeur qui ne
se rattache à rien et qui est visiblement polluée reste absente.
"""

from __future__ import annotations

import re
import unicodedata

_MAX_COURT_NAME_WORDS = 7
_LEADING_COURT_WORDS = re.compile(
    r"^(?:tj|tribunal judiciaire|tribunal de grande instance|tgi)\b(?:\s+(?:de la|de l|du|des|de|d))?\s*"
)
# Mots qui ne font jamais partie d'un nom de tribunal : leur présence signale du texte d'annonce.
_STRONG_NOISE_WORDS = frozenset(
    {
        "suite",
        "poursuite",
        "poursuites",
        "statuant",
        "audience",
        "audiences",
        "adjudication",
        "adjudications",
        "saisie",
        "vente",
        "ventes",
        "cedex",
        "cahier",
        "conditions",
        "lot",
        "lots",
        "mise",
        "prix",
    }
)
# Mots qui peuvent suivre un nom de tribunal sans en faire partie (« TJ NANCY le 15 octobre »).
_BOUNDARY_WORDS = _STRONG_NOISE_WORDS | frozenset(
    {"le", "la", "les", "a", "au", "aux", "pour", "dans", "et", "ref", "n", "no", "numero"}
)


def _fold(value: object) -> str:
    text = unicodedata.normalize("NFKD", str(value or ""))
    text = "".join(char for char in text if not unicodedata.combining(char))
    return re.sub(r"[^a-z0-9]+", " ", text.lower()).strip()


def _court_words(label: object) -> list[str]:
    """Mots du libellé une fois retirés les préfixes « TJ », « Tribunal judiciaire de » (même répétés)."""
    text = _fold(label)
    while True:
        stripped = _LEADING_COURT_WORDS.sub("", text, count=1)
        if stripped == text:
            break
        text = stripped
    return text.split()


def court_name_candidates(label: object) -> list[str]:
    """Noms de tribunal possibles dans ``label``, du plus long au plus court.

    Un préfixe plus court n'est proposé que s'il est suivi d'un mot qui borne un nom
    (« nancy » dans « nancy le », « beziers » dans « beziers suite a des poursuites »), jamais au
    milieu d'un nom composé (« saint denis » dans « saint denis de la reunion »).
    """
    words = _court_words(label)[:_MAX_COURT_NAME_WORDS]
    candidates: list[str] = []
    for size in range(len(words), 0, -1):
        if size < len(words) and words[size] not in _BOUNDARY_WORDS and not words[size].isdigit():
            continue
        candidates.append(" ".join(words[:size]))
    return candidates


_NOTARIAL_VENUE_LABEL = re.compile(r"\ben l etude\b|\bnotaires?\b|\bnotarial|\boffice notarial\b")
# « Tribunal judiciaire de En l'étude du Notaire » : l'en-tête Vench d'une vente chez le notaire.
NOTARIAL_VENUE_PHRASE = re.compile(r"\btribunal\s+judiciaire\s+de\s+(?=en\s+l['’]\s*[ée]tude\b)", re.I)


def tribunal_label_is_notarial_venue(label: object) -> bool:
    """Vrai si le « tribunal » d'une annonce est en réalité le lieu de vente chez un notaire.

    « TJ En L'Étude Du Notaire » désigne une vente notariale : la procédure est notariale et aucun
    tribunal n'est compétent ; le libellé ne doit donc ni se rattacher à un tribunal ni être inventé.
    """
    return bool(_NOTARIAL_VENUE_LABEL.search(_fold(label)))


def tribunal_label_is_polluted(label: object) -> bool:
    """Vrai si le libellé contient du texte d'annonce (« Suite À Des Poursuites… », « … le »)."""
    raw = str(label or "")
    if "…" in raw or "..." in raw or re.search(r"\d", raw):
        return True
    words = _fold(raw).split()
    leading = 0
    text = _fold(raw)
    while True:
        stripped = _LEADING_COURT_WORDS.sub("", text, count=1)
        if stripped == text:
            break
        text = stripped
        leading += 1
    if leading > 1:
        return True
    return any(word in _STRONG_NOISE_WORDS for word in words)


def trim_court_city(city: str) -> str:
    """Coupe, dans un nom de ville de tribunal, au premier mot de texte d'annonce certain."""
    kept: list[str] = []
    for word in city.split():
        if _fold(word) in _STRONG_NOISE_WORDS:
            break
        kept.append(word)
    return " ".join(kept) if kept else city


# --- villes -----------------------------------------------------------------------------------

_PROPERTY_DESCRIPTOR_WORDS = frozenset(
    {
        "usage",
        "habitation",
        "habitations",
        "maison",
        "appartement",
        "appartements",
        "immeuble",
        "immeubles",
        "immobilier",
        "immobiliere",
        "terrain",
        "terrains",
        "parcelle",
        "parcelles",
        "local",
        "locaux",
        "commercial",
        "commerce",
        "bureau",
        "bureaux",
        "batiment",
        "batiments",
        "garage",
        "parking",
        "cave",
        "studio",
        "villa",
        "pavillon",
        "ensemble",
        "lot",
        "lots",
        "bien",
        "biens",
        "vente",
        "ventes",
        "mise",
        "prix",
        "dependance",
        "dependances",
        "entrepot",
        "hangar",
        "atelier",
        "exploitation",
        "agricole",
        "professionnel",
        "mixte",
    }
)
_CITY_FILLER_WORDS = frozenset({"de", "d", "du", "des", "la", "le", "les", "et", "a", "en"})
_CITY_AFTER_A = re.compile(r"^(?P<prefix>.+?)\s+[àÀ]\s+(?P<city>\S.*)$")


def clean_city_label(value: str | None) -> str | None:
    """Ville sans le texte d'annonce qui la précède (« USAGE D'HABITATION à Chanteheux » -> « Chanteheux »).

    On ne coupe avant « à » que si le préfixe est un descriptif de bien (usage, habitation, maison,
    terrain…) et non un nom de commune. Une valeur qui ne contient qu'un descriptif n'est pas une
    ville : elle reste absente.
    """
    if not value:
        return value
    text = " ".join(str(value).split())
    match = _CITY_AFTER_A.match(text)
    if match and _is_property_descriptor(match.group("prefix")):
        city = match.group("city").strip(" ,;.-")
        return clean_city_label(city) if city else None
    words = _fold(text).split()
    if words and all(word in _PROPERTY_DESCRIPTOR_WORDS | _CITY_FILLER_WORDS for word in words) and any(
        word in _PROPERTY_DESCRIPTOR_WORDS for word in words
    ):
        return None
    return text


def _is_property_descriptor(text: str) -> bool:
    words = _fold(text).split()
    return bool(words) and any(word in _PROPERTY_DESCRIPTOR_WORDS for word in words)
