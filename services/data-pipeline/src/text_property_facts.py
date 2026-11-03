"""Faits techniques lus dans le texte d'une annonce : chauffage, revêtement, année, orientation, copropriété, pièces.

Chaque lecture rend la valeur et l'extrait qui la prouve, ou rien. Mêmes règles que ``src.text_fact_scope`` :
la phrase doit parler du bien, la valeur doit vouloir dire ce que dit le champ, le champ doit avoir un sens pour ce
type de bien. Audit du 03/11/2026 sur les 864 ventes en ligne :

- revêtement de sol : 40 valeurs sur 52 étaient la distribution du sous-sol (« Au sous-sol : garage, cave » lu
  « sol : garage, cave ») ou « la propriété du sol : indéterminée » ;
- année de construction : « construit entre 2013 et 2021 », « avant 1949 », « dans les années 1930 », « 2001-2005 »
  et un bateau « construit en 1991 » donnés pour une année ;
- chauffage : « Chauffage : Électrique … Gaz à effet de serre : C » lu « gaz », « réseau de chaleur … eau chaude
  sanitaire électrique » lu « électrique », « pac » trouvé dans « espace » ;
- orientation : « Est Informations complémentaires : Bel appartement » gardé comme valeur ;
- copropriété : « non soumis au statut de la copropriété », « Pas de copropriété » lus comme une copropriété ;
- pièces et chambres : « Surface en m² 30 Pièces jointes » lu 30 pièces, « Au 1er étage : 3 chambres » lu comme
  toutes les chambres de la maison.
"""

from __future__ import annotations

import re

from src.text_fact_scope import fold_aligned

# Pièces, chambres, chauffage, DPE et revêtement n'ont pas de sens pour un terrain nu ou une place de parking.
NO_DWELLING_FACTS_TYPES = frozenset({"land", "parking"})

# Le paragraphe du chauffage s'arrête au champ suivant d'une fiche.
_HEATING_END_RE = re.compile(
    r"[.;\n]|\b(?:diagnostic|dpe|ges|gaz\s+a\s+effet|classe|taxe|charges?|terrasse|garage|cave|jardin|balcon|annee"
    r"|superficie|ascenseur|climatisation|parking|pieces\s+jointes|informations|orientation|type\s+de|visite)\b"
)
_HEATING_SHARED_WATER_RE = re.compile(r"^chauffage(?:\s*\([^)]*\))?\s+et\s+(?:la\s+production\s+d'\s*)?eau\s+chaude")
_HEATING_FACETS = (
    ("mode", (("collective", r"\bcollecti(?:f|ve)s?\b"), ("individual", r"\b(?:individuel(?:le)?s?|privati(?:f|ve)s?)\b"))),
    (
        "energy",
        (
            ("gas", r"\bgaz\b"),
            ("electricity", r"\belectri(?:que|ques|cite)\b"),
            ("fuel_oil", r"\b(?:fioul|fuel)\b"),
            ("wood", r"\b(?:bois|granules?|pellets?)\b"),
            ("heat_pump", r"\b(?:pompes?\s+a\s+chaleur|pac)\b"),
            ("solar", r"\bsolaires?\b"),
        ),
    ),
    (
        "distribution",
        (
            ("radiators", r"\bradiateurs?\b"),
            ("boiler", r"\bchaudieres?\b"),
            ("convectors", r"\bconvecteurs?\b"),
            ("underfloor", r"\bplanchers?\s+chauffants?\b"),
        ),
    ),
)
# Un revêtement de sol est une matière.
_FLOORING_RE = re.compile(
    r"\b(parquets?(?:\s+(?:massif|flottant|stratifie|en\s+chene|ancien))?|carrelages?|moquettes?|tom+ettes?"
    r"|lino(?:leum)?|beton\s+cire|stratifies?|sols?\s+(?:vinyle|pvc|souple)|jonc\s+de\s+mer)\b"
)
_YEAR_BUILT_RE = re.compile(
    r"\b(?:construite?s?|constructions?|annee\s+de\s+construction|edifiee?s?|batie?s?)\b[^0-9]{0,24}?"
    r"\b((?:1[6-9]|20)\d{2})\b"
)
_YEAR_APPROXIMATE_RE = re.compile(r"\b(?:avant|apres|vers|entre|annees|environ|circa|fin|debut|milieu|depuis)\b")
_YEAR_RANGE_AFTER_RE = re.compile(r"^\s*(?:-|/|et|a|e|au)\s*(?:1[6-9]|20)\d{2}\b")
_OTHER_OBJECT_BEFORE_RE = re.compile(r"\b(?:bateau|navire|yacht|vedette|voilier|peniche|vehicule)\b[^.;]{0,120}$")
_CARDINAL = r"(?:nord|sud)(?:[\s-]*(?:est|ouest))?|est|ouest"
_ORIENTATION_RE = re.compile(
    rf"\b(?:orientation\s*:?\s*|(?:expose?e?s?|oriente?e?s?)\s+)(?:plein\s+|au\s+|a\s+l'|en\s+)?"
    rf"((?:{_CARDINAL})(?:\s*(?:et|/|,)\s*(?:{_CARDINAL}))*)\b"
)
_COOWNERSHIP_NEGATED_RE = re.compile(
    r"(?:\b(?:non|pas)\s+(?:soumise?s?\s+|place\w*\s+sous\s+)?(?:au|a\s+la|en|de|du)?\s*"
    r"(?:regime\s+|statut\s+)?(?:de\s+la\s+)?|\bsans\s+(?:mise\s+en\s+)?|\bhors\s+)copropriete"
)
_ROOM_PATTERNS = (
    ("rooms_count", r"\b(\d{1,2})\s*pieces?\b(?!\s+jointes)"),
    ("rooms_count", r"\b(?:type|t|f)\s*([1-9]\d?)(?:[a-z])?\b(?!\s*/)"),
    ("bedrooms_count", r"\b(\d{1,2})\s*chambres?\b(?!\s+froides?)"),
    ("bathrooms_count", r"\b(\d{1,2})\s*salles?\s*de\s*bains?\b"),
    ("showers_count", r"\b(\d{1,2})\s*salles?\s*d'?\s?eau\b"),
    ("wc_count", r"\b(\d{1,2})\s*(?:wc|w\.c\.)"),
)
# « 2/3 pièces », « type 4/5 », « deux appartements T4 », « Au 1er étage : 3 chambres » : un compte qui n'est pas
# celui du bien entier.
_ROOM_COUNT_OTHER_SCOPE_RE = re.compile(
    r"(?:\d\s*/\s*|\bou\s+|\b(?:appartements|logements|studios|lots|maisons)\b[^.;:]{0,20}"
    r"|\b(?:etage|chaussee|niveau|sous-sol|combles?|rdc)\s*:[^.;]{0,60})$"
)
# « occupé » adjectif (pas « il occupe une surface de plancher ») ; « loué » mot entier (pas « Alouettes »,
# « Plouénan » ni « à louer ») ; « terrain occupé (présence d'une construction) » n'est pas une occupation.
OCCUPIED_RE = r"\boccup(?:ée?s?|ees?)\b(?!\s*(?:\(\s*)?(?:par\s+)?(?:la\s+|une\s+)?pr[ée]sence\b)"
TENANT_RE = r"\boccup[ée]e?s?\s+par\s+(?:un|des|ses|le|les)\s+locataires?|\blou[ée]e?s?\b|\blocataires?\s+en\s+place\b"

Span = tuple[int, int]


def heating_facts(text: str) -> tuple[dict[str, str], Span] | None:
    """Mode, énergie et distribution du premier paragraphe « chauffage » qui en dit quelque chose."""

    folded = fold_aligned(text)
    for match in re.finditer(r"\bchauffage\b", folded):
        start = match.start()
        window = folded[start : start + 160]
        end_match = _HEATING_END_RE.search(window, len("chauffage") + 3)
        clause = window[: end_match.start()] if end_match else window[:140]
        water = re.search(r"\beau\s+chaude\b", clause)
        if water and not _HEATING_SHARED_WATER_RE.match(clause):
            # « chauffage par réseau de chaleur et eau chaude sanitaire électrique » : l'énergie est celle de l'eau.
            clause = clause[: water.start()]
        value: dict[str, str] = {}
        for facet, candidates in _HEATING_FACETS:
            hits = [(found.start(), name) for name, pattern in candidates if (found := re.search(pattern, clause))]
            if hits:
                value[facet] = min(hits)[1]
        if value:
            return value, (start, start + len(clause.rstrip()))
    return None


def flooring_fact(text: str) -> tuple[str, Span] | None:
    match = _FLOORING_RE.search(fold_aligned(text))
    return (text[match.start(1) : match.end(1)], match.span()) if match else None


def year_built_fact(text: str) -> tuple[int, Span] | None:
    folded = fold_aligned(text)
    for match in _YEAR_BUILT_RE.finditer(folded):
        if _YEAR_APPROXIMATE_RE.search(folded[match.start() : match.start(1)]):
            continue
        if _YEAR_RANGE_AFTER_RE.match(folded[match.end(1) : match.end(1) + 12]):
            continue
        if _OTHER_OBJECT_BEFORE_RE.search(folded[max(0, match.start() - 160) : match.start()]):
            continue
        return int(match.group(1)), match.span()
    return None


def orientation_fact(text: str) -> tuple[str, Span] | None:
    match = _ORIENTATION_RE.search(fold_aligned(text))
    if not match:
        return None
    parts = re.split(r"\s*(?:et|/|,)\s*", match.group(1).strip())
    value = " et ".join("-".join(word.capitalize() for word in re.split(r"[\s-]+", part)) for part in parts if part)
    return value, match.span()


def coownership_fact(text: str) -> tuple[bool, Span] | None:
    """True pour un bien en copropriété, False quand le texte dit le contraire, None s'il n'en dit rien."""

    folded = fold_aligned(text)
    # « Type de copropriété : » est un libellé de fiche, pas une mention.
    mentions = [match for match in re.finditer(r"\bcopropriete\b", folded) if not folded[: match.start()].endswith("type de ")]
    negated = [match for match in mentions if _COOWNERSHIP_NEGATED_RE.search(folded[max(0, match.start() - 50) : match.end()])]
    positive = [match for match in mentions if match not in negated]
    if positive:
        return True, positive[0].span()
    if negated:
        return False, negated[0].span()
    return None


def room_count_facts(text: str, property_type: str) -> dict[str, tuple[int, Span]]:
    """Un compte écrit par champ ; deux comptes différents (par niveau, par logement) laissent la case vide."""

    if property_type in NO_DWELLING_FACTS_TYPES:
        return {}
    folded = fold_aligned(text)
    found: dict[str, list[tuple[int, Span]]] = {}
    for field, pattern in _ROOM_PATTERNS:
        for match in re.finditer(pattern, folded):
            if _ROOM_COUNT_OTHER_SCOPE_RE.search(folded[max(0, match.start() - 80) : match.start()]):
                continue
            found.setdefault(field, []).append((int(match.group(1)), match.span()))
    return {field: matches[0] for field, matches in found.items() if len({value for value, _ in matches}) == 1}


def energy_class_match(text: str, patterns: tuple[str, ...]) -> re.Match[str] | None:
    """La classe lue après « DPE » ou « GES » : une lettre isolée en minuscule (« le DPE a été réalisé ») n'en est pas une."""

    for pattern in patterns:
        for match in re.finditer(pattern, text, re.IGNORECASE):
            explicit = ":" in match.group(0) or "class" in match.group(0).casefold()
            if explicit or match.group(1).isupper():
                return match
    return None
