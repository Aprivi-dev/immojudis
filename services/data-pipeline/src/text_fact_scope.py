"""À qui le texte d'une annonce attribue-t-il un fait ? Étage du lot et équipements privatifs.

« C'est une logique de compréhension des textes à appliquer partout » : un fait lu dans le texte ne vaut que si
(a) la phrase parle du bien vendu lui-même, pas d'un lot voisin, d'une annexe, d'une cave ou de l'immeuble autour ;
(b) la valeur veut dire ce que le champ veut dire ; (c) le champ a un sens pour ce type de bien. Dans le doute, la
case reste vide : mieux vaut une case vide qu'une valeur fausse.

Audit du 03/11/2026 (864 ventes en ligne) : « Étage : sous-sol » sur un immeuble entier (f91d4624, « élevé en R+2
sur un niveau de sous-sol (cave) »), 144 maisons « au rez-de-chaussée » lues dans leur distribution
(« au rez-de-chaussée : entrée, cuisine… »), des appartements en conflit avec la cave ou le parking « au sous-sol »,
le greffe « au rez-de-chaussée du bâtiment Marcel Proust », une piscine ou un jardin de la copropriété, la « rue du
Jardin » ou le « Jardin des plantes ».
"""

from __future__ import annotations

import re
import unicodedata
from collections.abc import Iterable
from dataclasses import dataclass

# (c) Un étage lu dans le texte situe un lot dans un immeuble : un appartement, un local, un parking. Une maison,
# un immeuble entier, un ensemble mixte ou un terrain n'ont pas « un étage » : leurs niveaux sont une distribution.
FLOOR_PROPERTY_TYPES = frozenset({"apartment", "commercial", "parking", "other", "unknown", ""})

_ORDINAL = (
    r"(?:\b\d{1,2}\s?(?:er|ere|nd|nde|eme|em|e|°)"
    r"|\b(?:premier|premiere|deuxieme|second|seconde|troisieme|quatrieme|cinquieme|sixieme|septieme|huitieme"
    r"|neuvieme|dixieme))"
)
_FLOOR_RE = re.compile(
    rf"(?P<etage>(?P<ord>{_ORDINAL})\s*etage(?!s))"
    r"|(?P<rdc>\brez[\s-]*de[\s-]*chaussee\b|\brdc\b)"
    r"|(?P<rdj>\brez[\s-]*de[\s-]*jardin\b)"
    rf"|(?P<ss>(?:{_ORDINAL}\s*)?\bsous[\s-]*sol\b)"
    r"|(?P<combles>\bcombles\b)"
)
# « Étage : 3 » dans une fiche de caractéristiques : un champ, pas une phrase.
_FLOOR_LABEL_RE = re.compile(r"\betage\s*:\s*(?P<value>\d{1,2}\b|rdc\b|rez[\s-]*de[\s-]*chaussee\b)")
_ORDINAL_WORDS = {
    "premier": 1,
    "premiere": 1,
    "deuxieme": 2,
    "second": 2,
    "seconde": 2,
    "troisieme": 3,
    "quatrieme": 4,
    "cinquieme": 5,
    "sixieme": 6,
    "septieme": 7,
    "huitieme": 8,
    "neuvieme": 9,
    "dixieme": 10,
}
# Ce qui précède une mention qui situe le lot : « au 3e étage », « situé en rez-de-chaussée », « bâtiment C,
# 3ème étage ». Toute autre amorce (« élevé sur sous-sol », « d'un rez-de-chaussée et de deux étages », « combles
# aménagés », « R+2 sur un niveau de sous-sol ») décrit la structure, pas l'emplacement du lot.
_LOCATING_PREFIX_RE = re.compile(
    r"(?:\b(?:au|aux|en|a)\s+(?:niveau\s+(?:du\s+)?)?"
    r"|\b(?:situee?s?|sise?s?|placee?s?|localisee?s?)\s+(?:au\s+|en\s+|a\s+)?)$"
)
_LIST_PREFIX_RE = re.compile(r"(?:^|[,(\-–•|]|\n)\s*$")
_ATTIC_PREFIX_RE = re.compile(r"\b(?:dans|sous)\s+les\s+$")
# « Au rez-de-chaussée : entrée, cuisine » ou « Au 1er étage porte gauche : un appartement » : un intitulé de
# distribution (maison, immeuble, duplex), pas l'étage du lot vendu.
_HEADING_AFTER_RE = re.compile(
    r"^\s*(?:(?:droite|gauche|porte|haut|bas|sureleve|surelevee|partie|cote|sur\s+rue|sur\s+cour)\b[^,;:.()\n\d]{0,14})?:"
)
# « au sous-sol et rez-de-chaussée », « aux rez-de-chaussée et 1er étage » : un lot sur plusieurs niveaux.
_OTHER_LEVEL_AFTER_RE = re.compile(
    r"^\s*(?:et|/|-|&)\s*(?:au\s+|aux\s+|en\s+|le\s+)?(?:\d|rez|rdc|sous[\s-]*sol|premier|deuxieme|second|troisieme"
    r"|combles)"
)

_UNIT_NOUNS = {
    "apartment": (
        r"appartements?|studios?|studettes?|logements?|duplex|triplex|souplex|pieces?\s+uniques?"
        r"|\b[tf]\s?\d\b|\b\d\s?p\b|biens?"
    ),
    "commercial": r"locals?|locaux|boutiques?|commerces?|magasins?|bureaux|plateaux?|cellules?|murs|biens?",
    "parking": r"parkings?|emplacements?|stationnements?|box|boxes|garages?|places?|biens?",
}
_ANNEX_NOUNS = (
    r"caves?|celliers?|greniers?|galetas|remises?|debarras|sechoirs?|buanderies?|locals?|locaux|chaufferies?"
    r"|parkings?|emplacements?|stationnements?|box|boxes|garages?|places?"
    r"|chambres?\s+de\s+service|appentis|dependances?|ateliers?"
)
_BUILDING_NOUNS = (
    r"immeubles?|maisons?|villas?|pavillons?|residences?|tours?|constructions?|proprietes?|chalets?|hotels?"
    r"|ensembles?\s+immobiliers?|coproprietes?"
)
# Le greffe, le cabinet de l'avocat ou du commissaire de justice, la salle d'audience : jamais le bien.
_OFFICE_NOUNS = (
    r"greffes?|tribunal|juges?|palais\s+de\s+justice|cabinet|avocats?|barreau|etude|notaires?|salles?|accueil"
    r"|audiences?|commissaires?"
    r"|huissiers?|maitre|selarl|scp|bureau\s+[a-z]?\d"
)
_ROOM_NOUNS = (
    r"entree|sejour|salon|cuisine|chambres?(?!\s+de\s+service)|salles?\s+(?:d'eau|de\s+bains?|a\s+manger)|wc|degagement|couloir"
    r"|dressing|placards?"
)
_NOUN_RE = re.compile(
    rf"\b(?:(?P<room>{_ROOM_NOUNS})|(?P<office>{_OFFICE_NOUNS})|(?P<building>{_BUILDING_NOUNS})"
    rf"|(?P<annex>{_ANNEX_NOUNS})|(?P<unit>{'|'.join(dict.fromkeys(_UNIT_NOUNS.values()))}))\b"
)
# « au 7e étage d'un immeuble », « dans une résidence » : l'immeuble contient le lot, il ne le remplace pas.
_CONTAINER_BEFORE_RE = re.compile(r"(?:\bdans|\bd'|\bde|\bdu|\bau\s+sein\s+d')\s*(?:un|une|le|la|l'|cet|cette)?\s*$")
# Une distribution intérieure : « appartement comprenant au rez-de-chaussée… », « distribué sur plusieurs niveaux
# dont un en sous-sol ».
_LAYOUT_BETWEEN_RE = re.compile(
    r"\b(?:comprenant|compose|composee|se\s+compose|distribuee?|repartie?s?|dont|elevee?s?|edifiee?s?)\b"
)
# « immeuble 11, au 9ème étage », « résidence B » : un repère dans l'ensemble, pas l'objet de la phrase.
_LOCATOR_AFTER_RE = re.compile(r"^\s+(?:n°\s*|no\s*)?(?:[a-z]?\d{1,3}[a-z]?|[a-z])\b")
# « au sous-sol de locaux d'entreprises », « dans le couloir » : le lieu qui contient le lot.
_FORWARD_CONTAINER_BEFORE_RE = re.compile(r"\b(?:de|du|des|d'|dans)\s*(?:un|une|le|la|l'|les)?\s*$")
# Fin de segment, lue sur le texte d'origine (la majuscule après un point) : « Un appartement. de 56 m² » (titre
# Licitor répété) ne coupe pas, « (hors terrasses). Au 4ème étage » coupe ; « Lot n° 35 : » ouvre un autre lot.
_SEGMENT_BREAK_RE = re.compile(r"[;:\n|]|\.\s+(?=[A-ZÀ-Ý])|(?i:\blot\s+(?:n|num[ée]ro|no)\b|\blots?\s+\d)")
# Ce qui suit l'étage et décrit le contenu du lot : on n'y cherche plus le nom du lot.
_FORWARD_STOP_RE = re.compile(r":|\b(?:comprenant|compose|composee|avec|offrant|dispose|disposant)\b")
# Licitor colle ses lignes : « au 1er étage Quatre greniers », « au sous-sol Les biens sont occupés » ; un mot à
# majuscule sans ponctuation devant ouvre un autre élément.
_FORWARD_ITEM_RE = re.compile(r"(?<=[a-zà-ÿ0-9²)])\s+(?=[A-ZÀ-Ý][a-zà-ÿ])")
_BACK_WINDOW = 160
_FORWARD_WINDOW = 70


def fold_aligned(text: str) -> str:
    """Minuscules sans accents, caractère pour caractère : un indice du texte replié vaut dans l'original."""

    folded: list[str] = []
    for char in text:
        if char in "‐‑‒–—":
            folded.append("-")
            continue
        if char in "’ʼ´`":
            folded.append("'")
            continue
        decomposed = unicodedata.normalize("NFKD", char)
        base = "".join(part for part in decomposed if not unicodedata.combining(part)).lower()
        folded.append(base[0] if len(base) >= 1 else " ")
    return "".join(folded)


@dataclass(frozen=True)
class FloorClaim:
    value: int | str
    label: str
    quote: str
    anchored: bool


def _floor_value(match: re.Match[str]) -> int | str | None:
    if match.group("etage"):
        ordinal = match.group("ord")
        digits = re.match(r"\d{1,2}", ordinal)
        if digits:
            return int(digits.group(0))
        return _ORDINAL_WORDS.get(ordinal.strip())
    if match.group("rdc"):
        return 0
    if match.group("rdj"):
        return "rez-de-jardin"
    if match.group("ss"):
        return "sous-sol"
    return "combles"


def _segment_start(text: str, position: int) -> int:
    start = max(0, position - _BACK_WINDOW)
    breaks = list(_SEGMENT_BREAK_RE.finditer(text, start, position))
    return breaks[-1].start() if breaks else start


def _segment_end(text: str, folded: str, position: int) -> int:
    end = min(len(text), position + _FORWARD_WINDOW)
    found = (
        _SEGMENT_BREAK_RE.search(text, position, end),
        _FORWARD_ITEM_RE.search(text, position, end),
        _FORWARD_STOP_RE.search(folded, position, end),
    )
    return min((item.start() for item in found if item), default=end)


def _noun_kind(folded: str, match: re.Match[str], allowed_units: str) -> str:
    kind = match.lastgroup or ""
    if kind == "building" and (
        _CONTAINER_BEFORE_RE.search(folded[max(0, match.start() - 20) : match.start()])
        or _LOCATOR_AFTER_RE.match(folded[match.end() : match.end() + 10])
    ):
        return "container"
    noun = match.group(0)
    if re.fullmatch(allowed_units, noun):
        return "unit"
    if kind == "unit":
        # Le nom d'un autre type de lot (« un parking au sous-sol » pour un appartement) : une annexe.
        return "annex"
    return kind


def _head_noun(text: str, folded: str, start: int, end: int, allowed_units: str) -> tuple[str, int] | None:
    """Le nom auquel la mention d'étage se rattache : le plus proche avant ou juste après, dans le même segment."""

    segment_start = _segment_start(text, start)
    back: tuple[str, int] | None = None
    for noun in _NOUN_RE.finditer(folded, segment_start, start):
        kind = _noun_kind(folded, noun, allowed_units)
        if kind == "container":
            continue
        back = (kind, noun.end())
    forward: tuple[str, int] | None = None
    for noun in _NOUN_RE.finditer(folded, end, _segment_end(text, folded, end)):
        kind = _noun_kind(folded, noun, allowed_units)
        # « au sous-sol. Les biens sont occupés » : « les biens » désigne toute la vente, pas ce qui est au sous-sol.
        if kind == "container" or noun.group(0).startswith("bien"):
            continue
        if _FORWARD_CONTAINER_BEFORE_RE.search(folded[max(0, noun.start() - 12) : noun.start()]):
            continue
        forward = (kind, noun.start())
        break
    if back and _LAYOUT_BETWEEN_RE.search(folded, back[1], start):
        return ("layout", back[1])
    if back and forward:
        # « Un local commercial de 59 m², en rez-de-chaussée, Cave » : le lot nommé avant garde sa mention ; ce qui
        # suit une virgule est l'élément suivant de la liste.
        if back[0] == "unit" and "," in folded[end : forward[1]]:
            return back
        return back if start - back[1] <= forward[1] - end else forward
    return back or forward


def _allowed_units(property_type: str) -> str:
    patterns = [_UNIT_NOUNS[property_type]] if property_type in _UNIT_NOUNS else list(_UNIT_NOUNS.values())
    return "|".join(f"(?:{pattern})" for pattern in patterns)


def _quote(text: str, start: int, end: int, radius: int = 100) -> str:
    return re.sub(r"\s+", " ", text[max(0, start - radius) : min(len(text), end + radius)]).strip()


def unit_floor_claims(text: str, property_type: str | None) -> list[FloorClaim]:
    """Mentions d'étage qui situent le lot vendu lui-même (vide pour une maison, un immeuble, un terrain)."""

    kind = (property_type or "").strip().lower()
    if kind not in FLOOR_PROPERTY_TYPES or not text:
        return []
    folded = fold_aligned(text)
    allowed_units = _allowed_units(kind)
    claims: list[FloorClaim] = []
    for match in _FLOOR_RE.finditer(folded):
        value = _floor_value(match)
        if value is None:
            continue
        prefix = folded[max(0, match.start() - 40) : match.start()]
        locating = bool(_LOCATING_PREFIX_RE.search(prefix))
        if match.group("combles"):
            locating = locating or bool(_ATTIC_PREFIX_RE.search(prefix))
        elif not locating:
            # « bâtiment C, 3ème étage, comprenant » ; « Appartement - 2e étage » ou « Appartement T4 rez-de-jardin »
            # dans un titre : l'étage suit le nom du lot.
            listed = match.group("etage", "rdc") != (None, None) and bool(_LIST_PREFIX_RE.search(prefix))
            locating = listed or bool(re.search(rf"\b(?:{allowed_units})[^,;:.()\n]{{0,12}}$", prefix))
        after = folded[match.end() : match.end() + 40]
        if not locating or _HEADING_AFTER_RE.match(after) or _OTHER_LEVEL_AFTER_RE.match(after):
            continue
        if re.search(r"(?:etage|chaussee|sol|rdc|jardin)\s+(?:et|/|&)\s+(?:au\s+|aux\s+|en\s+)?$", prefix):
            continue
        head = _head_noun(text, folded, match.start(), match.end(), allowed_units)
        if head is not None and head[0] != "unit":
            continue
        # Sans nom de lot, seul un étage chiffré d'un appartement se lit encore comme le sien.
        if head is None and not (kind == "apartment" and isinstance(value, int) and value > 0):
            continue
        claims.append(
            FloorClaim(value, text[match.start() : match.end()], _quote(text, match.start(), match.end()), head is not None)
        )
    for match in _FLOOR_LABEL_RE.finditer(folded):
        raw = match.group("value")
        value = int(raw) if raw.isdigit() else 0
        claims.append(FloorClaim(value, text[match.start() : match.end()], _quote(text, match.start(), match.end()), True))
    return claims


def select_unit_floor(claims: Iterable[FloorClaim]) -> FloorClaim | None:
    """Une seule valeur : la plus explicite. Deux étages différents pour le lot (plusieurs lots, duplex) : vide."""

    items = list(claims)
    anchored = [claim for claim in items if claim.anchored]
    pool = anchored or items
    values = {claim.value for claim in pool}
    if len(values) != 1:
        return None
    return pool[0]


# --- Équipements privatifs -------------------------------------------------------------------------------------

_AMENITY_RE = {
    "garden": re.compile(r"\bjardins?\b"),
    "pool": re.compile(r"\bpiscines?\b"),
}
# « piscine commune », « jardin de la copropriété », « terrasse collective » : un équipement de l'immeuble.
_COMMON_AFTER_RE = re.compile(
    r"^\s*(?:\([^)]{0,30}\)\s*)?(?:communes?|collectifs?|collectives?|partagee?s?|centrale?|municipale?s?|publique?s?"
    r"|olympique|de\s+(?:la|l')\s*(?:residence|copropriete|ensemble|immeuble|lotissement|domaine|commune|ville)"
    r"|du\s+(?:lotissement|domaine|syndicat|square|parc|quartier)|des\s+(?:coproprietaires|residents)"
    r"|d'(?:agrement\s+)?(?:la\s+)?(?:residence|copropriete|ensemble))\b"
)
_COMMON_BEFORE_RE = re.compile(
    r"(?:\bparties\s+communes\b|\b(?:ensemble\s+immobilier|residence|copropriete|lotissement|immeuble|domaine)\b"
    r"[^.;:,]{0,40}\b(?:dispose|disposant|beneficie|beneficiant|dote|dotee|equipee?|offre|avec)\b)[^.;]{0,80}$"
)
# Un lieu nommé (« rue du Jardin », « le Jardin des plantes ») ou une vue (« sur jardin », « côté jardin »).
_PLACE_BEFORE_RE = re.compile(
    r"(?:\b(?:rue|avenue|av|allee|impasse|chemin|place|square|boulevard|bd|quai|cours|passage|villa|lotissement"
    r"|residence|domaine|clos|parc|hameau|lieudit|lieu-dit)\s+(?:du|des|de\s+la|de\s+l'|d')?\s*"
    r"|\b(?:sur|cote|vue\s+sur|donnant\s+sur|ouvrant\s+sur|face\s+au)\s+(?:le\s+|un\s+|les\s+)?)$"
)
_NAMED_AFTER_RE = re.compile(r"^\s*(?:du|des|de\s+la|de\s+l'|de|d')\s*[a-z]")
_PRIVATE_RE = re.compile(r"\b(?:privati[fv]e?s?|privee?s?|exclusi[fv]e?s?|jouissance)\b")


def _mention_is_private(text: str, folded: str, match: re.Match[str]) -> bool:
    before = folded[max(0, match.start() - 160) : match.start()]
    after = folded[match.end() : match.end() + 60]
    clause_after = re.split(r"[.;,]", after, maxsplit=1)[0]
    if _PRIVATE_RE.search(clause_after) or _PRIVATE_RE.search(before[-40:]):
        return True
    if _COMMON_AFTER_RE.match(after) or _COMMON_BEFORE_RE.search(before) or _PLACE_BEFORE_RE.search(before):
        return False
    # « Jardin du Pharo », « Jardin des Plantes » au milieu d'une phrase : un nom de lieu.
    original = text[match.start() : match.end()]
    sentence_start = not before.strip() or before.rstrip()[-1:] in ".:;!?-•(\n"
    return not (original[:1].isupper() and not sentence_start and _NAMED_AFTER_RE.match(after))


def private_amenity_mentioned(text: str | None, feature: str) -> bool | None:
    """True si le texte nomme l'équipement du bien lui-même, False s'il ne nomme que celui de l'immeuble ou un lieu,
    None s'il n'en parle pas."""

    pattern = _AMENITY_RE.get(feature)
    if pattern is None or not text:
        return None
    folded = fold_aligned(text)
    if feature == "garden":
        folded = re.sub(r"\brez[\s-]+de[\s-]+jardin\b", lambda found: " " * len(found.group(0)), folded)
    mentions = list(pattern.finditer(folded))
    if not mentions:
        return None
    return any(_mention_is_private(text, folded, match) for match in mentions)


def shared_amenity_mentioned(text: str | None, feature: str) -> bool:
    """True si le texte nomme l'équipement de la copropriété ou de l'ensemble (« jardin commun », « jardin de la
    copropriété », « jardin partagé ») et jamais celui du bien. Une vue « sur jardin » ou un lieu (« rue du Jardin »)
    ne compte pas. Décision du 05/11/2026 : afficher « Jardin : commun » plutôt que rien ou un jardin privatif."""

    pattern = _AMENITY_RE.get(feature)
    if pattern is None or not text:
        return False
    folded = fold_aligned(text)
    if feature == "garden":
        folded = re.sub(r"\brez[\s-]+de[\s-]+jardin\b", lambda found: " " * len(found.group(0)), folded)
    shared = False
    for match in pattern.finditer(folded):
        if _mention_is_private(text, folded, match):
            return False
        before = folded[max(0, match.start() - 160) : match.start()]
        after = folded[match.end() : match.end() + 60]
        if _COMMON_AFTER_RE.match(after) or _COMMON_BEFORE_RE.search(before):
            shared = True
    return shared


__all__ = [
    "FLOOR_PROPERTY_TYPES",
    "FloorClaim",
    "fold_aligned",
    "private_amenity_mentioned",
    "shared_amenity_mentioned",
    "select_unit_floor",
    "unit_floor_claims",
]
