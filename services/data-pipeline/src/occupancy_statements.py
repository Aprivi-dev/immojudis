"""Une seule lecture des phrases d'occupation (libre / occupé / loué), pour les pages sources et les pièces.

Audit du 03/11/2026 : chaque source avait sa liste de mots-clés, lue sur tout le texte avec un ordre de
priorité. « tenant son audience » (Lorient) devenait « loué », « Habitation à Loyer Modéré » ou la clause type
« Si l'immeuble est loué, par la perception des loyers » d'un cahier des conditions de vente aussi, « occupés
par la partie saisie » restait « occupé », « Le locataire a quitté les lieux » restait « loué », « le bien semble
inoccupé » s'affichait libre, et une page « libre » dont le PV dit « occupé » s'affichait libre.

Ici, chaque phrase est lue isolément :

* une clause type (« Si l'immeuble est loué… », « lorsque le bien fait l'objet d'un bail… », information
  acquéreur-locataire, obligations du bailleur…) n'est pas une déclaration sur le bien ;
* une phrase ne compte que par une tournure explicite (« le bien est libre », « occupés par la partie saisie »,
  « 4 appartements F2 loués »…), jamais par un mot isolé (« locataire », « bail », « vide ») ;
* une tournure prudente (« semble inoccupé », « paraissant inoccupée », « a priori libre ») est gardée comme
  preuve mais n'est pas un statut certain ;
* une phrase qui dit deux choses (« libre » et « loué », « partiellement occupé ») est mixte.

Puis :func:`resolve_occupancy` réunit les phrases : statuts compatibles (« occupé » + « occupé par le
propriétaire ») -> le plus précis ; contradiction, mixte ou seulement prudent -> ``unknown`` avec les preuves.
La contrainte SQL n'a pas de valeur « mixte » : ``unknown`` (« À confirmer ») la porte, preuves à l'appui.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

from src.text_folding import to_ascii

VACANT = "vacant"
OCCUPIED = "occupied"
OWNER_OCCUPIED = "owner_occupied"
RENTED = "rented"
SQUATTED = "squatted"
UNKNOWN = "unknown"
MIXED = "mixed"
OCCUPIED_FAMILY = frozenset({OCCUPIED, OWNER_OCCUPIED, RENTED, SQUATTED})
CERTAIN_STATUSES = OCCUPIED_FAMILY | {VACANT}


def fold(value: object) -> str:
    """Texte sans accents, en minuscules, apostrophes droites, « le(s) propriétaire(s) » -> « le propriétaire »."""
    text = re.sub(r"[\u2010-\u2015\u2212]", "-", str(value or ""))
    text = to_ascii(re.sub(r"[’`´]", "'", text)).lower()
    text = re.sub(r"\((?:s|e|es|x)\)", "", text)
    return re.sub(r"\s+", " ", text).strip()


# Clauses types d'un cahier des conditions de vente, d'une notice ou d'un état des risques : elles parlent de
# tout bien, jamais de celui-ci.
_TEMPLATE = re.compile(
    r"\bsi\s+(?:l'|le\s+|la\s+|les\s+)?(?:immeubles?|biens?|lots?|ventes?|locaux|local|logements?)\b[^.]{0,80}"
    r"\b(?:libres?|loue\w*|occupe\w*|bail|location)\b"
    r"|\blorsque\s+(?:le|l'|les)\s*(?:biens?|immeubles?|logements?|locaux)\b[^.]{0,40}\b(?:bail|loue\w*|location)"
    r"|\b(?:en\s+cas|s'il\s+existe|le\s+cas\s+echeant)\b[^.]{0,60}"
    r"\b(?:bail|baux|location|occupation|occupants?|occupe\w*|locataires?)\b|lorsqu'(?:il|ils|elle|elles)\s+exist"
    r"|devant\s+(?:etre\s+)?(?:\w+\s*,?\s+){0,5}(?:delivre\w*|libres?)\b|s'oblige\s+a\s+delivrer"
    r"|doi(?:t|vent)\s+etre\s+(?:delivre\w*|libres?)\b"
    r"|anteriorite\s+du\s+bail|entree\s+en\s+jouissance|vendeur\s+ou\s+(?:le\s+)?bailleur|bail\s+a\s+construction"
    r"|preemption|fera\s+son\s+affaire|(?:locataires?|occupants?)\s+(?:eventuels?|a\s+quelque\s+titre)"
    r"|surfaces?\s+occupees?\s+par|batiments?\s+occupes?\s+ou\s+frequentes?|niveaux\s+les\s+plus\s+bas\s+occupes"
    r"|loyers?\s+moderes?|habitations?\s+a\s+loyer"
    r"|acquereurs?\s*(?:et|ou|-|/)?\s*(?:des\s+)?locataires?|information\s+(?:des\s+)?acquereurs?"
    r"|aux\s+differents\s+locataires|contre\s+son\s+locataire|a\s+l'occasion\s+de\s+locations"
    r"|consentir\s+(?:un\s+)?bail|conferer\s+des\s+droits|\ble\s+bailleur\s+(?:est|doit|devra|s'oblige)"
    r"|(?:remettre|delivrer)\s+au\s+locataire|le\s+locataire\s+(?:executera|peut|doit|devra|a\s+le\s+choix)"
    r"|chose\s+louee|reparations?\s+locatives?|autres\s+que\s+locatives|acquerir\s+ou\s+louer"
    r"|successions?\s+vacantes?|vacants?\s+et\s+sans\s+maitre"
    r"|\bparcelles?\b[^.]{0,60}\b(?:donnee|consentie)s?\s+a\s+bail"
    r"|\bloi\s+(?:du|n)\s*\d|\barticles?\s+(?:[lrd]\.?\s*)?\d+[\w.-]*\s+(?:du|de\s+la|des)\s+(?:code|loi|decret)"
    r"|\barticle\s+[lrd]\.?\s*\d",
)
# Une tournure prudente juste avant le mot d'état : « semble inoccupé », « paraissant inoccupée », « seraient occupés ».
_HEDGE = re.compile(
    r"\b(?:semble\w*|parai\w*|serai(?:t|ent)|apparemment|a\s+priori|vraisemblablement|probablement|presum\w*)\b"
    r"[^.]{0,40}?\b(?:in)?(?:occupe|libre|vide|loue|vacant|habite|squatt)"
)
_STATE_WORD = r"(?:occupe|inoccupe|loue|libre|vide|habite|inhabite)\w*"
_PARTIAL = re.compile(
    rf"\b(?:partiellement|en\s+partie|pour\s+partie)\s+{_STATE_WORD}|\b{_STATE_WORD}\s+(?:\w+\s+)?"
    r"(?:partiellement|en\s+partie|pour\s+partie)\b|\bquasi[- ]totalite\b|\bcertain(?:e)?s\b[^.]{0,80}\bd'autres\b"
)
_PROPERTY = (
    r"(?:biens?|immeubles?|appartements?|maisons?|local|locaux|logements?|lieux|terrains?|studios?|proprietes?"
    r"|pavillons?|villas?|lots?|site|ensemble\s+immobilier|bureaux|batiments?|parcelles?|habitations?|chalets?"
    r"|boxe?s?|garages?|parkings?|f\d|t\d)"
)
_NOT_OCCUPANCY_FREE = (
    r"(?!\s+(?:de\s+(?:droits?|tout(?:e|es)?\s+(?:constructions?|servitudes?|charges?|hypotheques?|inscriptions?"
    r"|privileges?|dettes?|encombrants?|meubles?|mobiliers?|gages?)|tout\s+(?:meuble|mobilier|encombrant)s?)"
    r"|acces|choix|service|passage|parcours|a\s+la\s+visite|d'acces|sanitaire|ordures|grenier|par\b))"
)

_VACANT_PATTERNS = (
    r"\blibres?\s+(?:de\s+tout(?:e|es)?\s+(?:occupations?|locations?|occupants?|baux?|habitants?)"
    r"|d'occupation|de\s+location|d'occupant|de\s+toute\s+location)",
    rf"\b{_PROPERTY}(?:\s+(?:immobiliers?|mis\s+en\s+vente|vendus?|dont\s+s'agit|objet\s+de\s+la\s+vente))?\s+"
    r"(?:(?:est|sont|sera|seront|etait|etaient|a\s+ete|ont\s+ete|se\s+trouvent?|reste|restent|demeure|demeurent)\s+)?"
    r"(?:actuellement\s+|totalement\s+|entierement\s+|en\s+l'etat\s+|donc\s+|aujourd'hui\s+)?"
    r"(?:constate(?:e|s|es)?\s+|cede(?:e|s|es)?\s+|vendu(?:e|s|es)?\s+|livre(?:e|s|es)?\s+)?"
    rf"(?:libres?|vides?|inoccupe(?:e|s|es)?|inhabite(?:e|s|es)?|vacant(?:e|s|es)?){_NOT_OCCUPANCY_FREE}\b",
    r"\bvides?\s+(?:de\s+tout(?:e|es)?\s+(?:occupants?|occupations?|habitants?)|et\s+inoccupe|depuis)\b",
    r"\binoccupe(?:e|s|es)?\b(?!\s+par\b)",
    r"\binhabite(?:e|s|es)?\b",
    r"\bvacant(?:e|s|es)?\b",
    r"\b(?:libres?|vides?|inoccupe(?:e|s|es)?)\s+(?:mise\s+a\s+prix|cadastre|au\s+\d|a\s+la\s+date|et\s+en\s+travaux)\b",
    r"\(\s*(?:libres?|vides?)\s*\)",
    r"(?:^|\s[-|]|:)\s*libres?(?:\s+de\s+toute\s+occupation)?\s*(?:$|[-,;)]|\s+et\s)",
)
_DEPARTURE_PATTERNS = (
    r"\b(?:locataires?|occupants?)\s+(?:a|ont|avait|avaient)\s+quitte\s+les\s+lieux",
    r"\blieux\s+(?:ont\s+ete\s+|sont\s+)liberes\b",
)
_AT_SALE_PATTERNS = (
    r"\b(?:cede(?:e|s|es)?|vendu(?:e|s|es)?|livre(?:e|s|es)?)\s+libres?\b" + _NOT_OCCUPANCY_FREE,
    r"\bdelivrer\s+(?:un|le|les)\s+(?:biens?|immeubles?|terrains?)\s+libres?\b",
    r"\b(?:sera|seront)\s+libres?\b[^.]{0,60}\b(?:au\s+jour\s+de|lors\s+de|a\s+la\s+date\s+de|avant)\s+"
    r"(?:l'adjudication|la\s+vente|la\s+signature|l'acte)",
    r"\b(?:au\s+jour\s+de|lors\s+de|a\s+la\s+date\s+de)\s+(?:l'adjudication|la\s+vente|la\s+signature|l'acte)\b"
    r"[^.]{0,120}\b(?:sera|seront)\s+libres?\b",
)
_RENTED_PATTERNS = (
    r"\b(?:est|sont|actuellement|integralement|entierement|egalement)\s+(?:[^.]{0,25}?\s)?loue(?:e|s|es)?\b",
    r"\bloue(?:e|s|es)?\s+et\s+occupe",
    rf"\b{_PROPERTY}\s+(?:\w+\s+)?loue(?:e|s|es)?\b",
    r"^(?:bien\s+)?loue(?:e|s|es)?$|(?:occupation|situation\s+locative)\s*:?\s*loue",
    r"\bloue(?:e|s|es)?\s+(?:a|au|aux|par|selon|suivant|moyennant|en\s+vertu|depuis|meuble)\b",
    r"\bconcede(?:e|s|es)?\s+(?:a\s+la|en)\s+location|\bdonne(?:e|s|es)?\s+(?:a\s+bail|en\s+location)"
    r"|\bmis(?:e|es)?\s+en\s+location",
    r"\b(?:occupe|habite|exploite)\w*\s+(?:\w+\s+){0,2}?par\s+(?:un|une|des|le|la|les|son|sa|ses)\s+(?:\w+\s+)?locataires?\b",
    r"\boccupe(?:e|s|es)?\s+(?:suivant|selon|en\s+vertu\s+d'|aux\s+termes\s+d')\s*(?:un\s+)?(?:contrat\s+de\s+location|bail)",
    r"\b(?:fait|faisant|faisait)\s+l'objet\s+d'un\s+(?:bail|contrat\s+de\s+location)",
    r"\bmoyennant\s+(?:un\s+)?loyer|\bloyer\s+(?:mensuel|annuel|trimestriel|de\s+\d|d'un\s+montant|hors\s+charges)",
    r"\bbail\s+(?:d'habitation|commercial|professionnel|rural|meuble|mixte|en\s+cours|verbal)\b",
    r"(?:occupation|situation)[^:]{0,40}:\s*par\s+(?:un|une|des)\s+locataires?|,\s*locataires?\s+d(?:u|e\s+la|es)\s",
    r"\blocataires?\s+(?:en\s+place|actuels?|dans\s+les\s+lieux)",
    r"\b(?:rented|leased|tenanted|tenant[- ]occupied)\b",
    r"\bloue(?:e|s|es)?\s+(?:mise\s+a\s+prix|cadastre|au\s+\d|a\s+la\s+date)\b|\(\s*loue(?:e|s|es)?\s*\)"
    r"|\boccupe(?:e|s|es)?\s+\(\s*location\s*\)",
)
_RENTED_NEGATION = re.compile(
    r"\b(?:non|pas|plus|jamais|aucun(?:e)?|sans|ni|interdiction\s+de)\s+(?:\w+\s+){0,2}(?:loue\w*|bail|baux|loyers?|location|locataires?)\b"
)
_OWNER_WHO = (
    r"(?:le|la|les|l'un\s+des|l'une\s+des|un\s+des|une\s+des|leurs?|son|sa|ses)?\s*(?:actuel(?:le)?s?\s+)?"
    r"(?:co-?)?(?:proprietaires?|indivisaires?|coindivisaires?|partie\s+saisie|parties\s+saisies|saisie?s?"
    r"|debiteurs?|debitrices?|emprunteurs?|personnes?\s+saisies?|vendeurs?)\b"
)
_OWNER_PATTERNS = (
    r"\bproprietaires?\s+occupants?\b",
    rf"\boccupe(?:e|s|es|nt)?\s+(?:\w+\s+){{0,2}}?par\s+{_OWNER_WHO}",
    rf"(?:occupation|situation)[^:]{{0,40}}:\s*par\s+{_OWNER_WHO}",
    r"\b(?:proprietaires?|debiteurs?|partie\s+saisie)\s+(?:\w+\s+){0,2}?(?:y\s+)?(?:vit|vivent|habite|habitent|reside"
    r"|resident|occupe|occupent)\b",
)
_SQUATTED_PATTERNS = (
    r"\bsans\s+droit\s+ni\s+titre\b",
    r"(?<!anti-)(?<!anti )\bsquatt?(?:e|es|ee|ees|s)?\b|\boccupe\w*\s+par\s+(?:des|un|une|les)\s+squatt?eurs?\b",
)
_OCCUPIED_PATTERNS = (
    r"\b(?:est|sont|etait|etaient|actuellement|encore|reste|restent|demeure|demeurent|integralement|entierement"
    r"|aujourd'hui|egalement|toujours)\s+(?:[^.]{0,30}?\s)?occupe(?:e|s|es)?\b",
    r"\boccupe(?:e|s|es)?\s+(?:\w+\s+){0,2}?par\b|\b(?:partiellement|en\s+partie)\s+occupe",
    r"\boccupe(?:e|s|es)?\s+(?:mise\s+a\s+prix|cadastre|au\s+\d|a\s+la\s+date|a\s+titre\s+gratuit)\b"
    r"|\(\s*occupe(?:e|s|es)?\s*\)",
    r"^(?:bien\s+)?occupe(?:e|s|es)?$|(?:occupation|situation\s+locative)\s*:?\s*occupe",
    rf"\b{_PROPERTY}\s+(?:\w+\s+)?occupe(?:e|s|es)?\b(?!\s+ou\b)",
    r"(?:occupation|situation)[^:]{0,40}:\s*par\s+(?:le|la|les|l'|un|une|des|m\.|mme|monsieur|madame)",
    r"\boccupent\s+(?:le|la|les|l')|\b(?:qu'il|qu'elle|qu'ils|qu'elles|il|elle|ils|elles)\s+(?:l'|les\s+)?occupe(?:nt)?\b"
    r"(?!\s+(?:une|la|un|le)\s+(?:surface|superficie|emprise|parcelle|terrain|position|place|angle|partie))",
    r"\b(?:vit|vivent|vivre|habite|habitent|reside|resident)\s+(?:dans\s+)?(?:les\s+lieux|le\s+bien|la\s+maison"
    r"|l'appartement|le\s+logement|sur\s+place)",
)
# « Terrain occupé (présence d'une construction à démolir) » est une nature de terrain, « chambre occupée par du
# mobilier » un encombrement : ni l'un ni l'autre ne dit qui occupe le bien.
_NEGATED_OCCUPANCY = re.compile(r"\b(?:non|pas|plus|jamais)\s+(?:\w+\s+)?(?:occupe|habite)(?:e|s|es)?\b")
_NOT_AN_OCCUPANT = re.compile(
    r"\boccupe(?:e|s|es)?\s*\(\s*presence|\boccupe(?:e|s|es)?\s+(?:par\s+)?(?:du|de\s+la|des)\s+"
    r"(?:mobilier|meubles?|encombrants?|affaires|vegetation|gravats|vehicules?|dechets|objets)"
)


def _compiled(patterns: tuple[str, ...]) -> tuple[re.Pattern[str], ...]:
    return tuple(re.compile(pattern) for pattern in patterns)


_STATUS_PATTERNS: tuple[tuple[str, tuple[re.Pattern[str], ...]], ...] = (
    (VACANT, _compiled(_VACANT_PATTERNS)),
    (RENTED, _compiled(_RENTED_PATTERNS)),
    (OWNER_OCCUPIED, _compiled(_OWNER_PATTERNS)),
    (SQUATTED, _compiled(_SQUATTED_PATTERNS)),
    (OCCUPIED, _compiled(_OCCUPIED_PATTERNS)),
)
_DEPARTURE = _compiled(_DEPARTURE_PATTERNS)
_AT_SALE = _compiled(_AT_SALE_PATTERNS)


@dataclass(frozen=True)
class OccupancyReading:
    """Ce que dit une phrase : un statut, ou ``mixed`` ; ``hedged`` quand la tournure est prudente."""

    status: str
    evidence: str
    hedged: bool = False
    departure: bool = False
    at_sale: bool = False

    @property
    def certain(self) -> bool:
        return self.status in CERTAIN_STATUSES and not self.hedged


@dataclass(frozen=True)
class OccupancyDecision:
    status: str | None
    reason: str  # agreed | conflict | mixed | hedged | none
    evidence: list[str] = field(default_factory=list)


def is_template_clause(text: str) -> bool:
    return bool(_TEMPLATE.search(fold(text)))


def _hits(text: str, patterns: tuple[re.Pattern[str], ...]) -> list[re.Match[str]]:
    return [match for pattern in patterns for match in pattern.finditer(text)]


def read_occupancy_statement(sentence: str) -> OccupancyReading | None:
    """Statut déclaré par une phrase (ou un libellé court), ``None`` si elle ne parle pas d'occupation du bien."""
    text = _without_template_clauses(fold(sentence).rstrip(" .;:!?"))
    if not text:
        return None
    text = _NEGATED_OCCUPANCY.sub(" inoccupe ", _NOT_AN_OCCUPANT.sub(" ", text))
    found: dict[str, list[re.Match[str]]] = {}
    for status, patterns in _STATUS_PATTERNS:
        hits = _hits(text, patterns)
        if status == RENTED and _RENTED_NEGATION.search(text):
            hits = []  # « aucun bail », « interdiction de mise en location »
        if hits:
            found[status] = hits
    first_match = min((match.start() for hits in found.values() for match in hits), default=0)
    departure = bool(_hits(text, _DEPARTURE))
    at_sale = bool(_hits(text, _AT_SALE))
    if departure or at_sale:
        found.setdefault(VACANT, [])
        # « Le locataire a quitté les lieux » clôt la location ; « sera libre au jour de l'adjudication » clôt
        # l'occupation en cours (pas un bail, qui reste une contradiction).
        found.pop(RENTED if departure else OCCUPIED, None)
    if not found:
        return None
    if RENTED not in found and OCCUPIED in found and re.search(r"occupe\w*\b[^.]{0,150}\bresidence\s+principale", text):
        # « occupée par son compagnon et ses enfants, à titre de résidence principale » : pas un bail.
        found[OWNER_OCCUPIED] = found.pop(OCCUPIED)
    hedged = bool(_HEDGE.search(text))
    evidence = clean_evidence(sentence, near=first_match / max(len(text), 1))
    status = _merge_family(set(found))
    if status is None or _PARTIAL.search(text):
        return OccupancyReading(MIXED, evidence, hedged=hedged)
    return OccupancyReading(status, evidence, hedged=hedged, departure=departure, at_sale=at_sale)


def _without_template_clauses(text: str) -> str:
    """Une phrase courte qui contient une clause type est écartée ; dans une page aplatie (une seule « phrase »
    de plusieurs milliers de caractères), seule la clause est effacée."""
    if not _TEMPLATE.search(text):
        return text
    if len(text) <= 400:
        return ""
    for match in reversed(list(_TEMPLATE.finditer(text))):
        start, end = max(0, match.start() - 100), min(len(text), match.end() + 100)
        text = f"{text[:start]} . {text[end:]}"
    return text


def clean_evidence(text: str, near: float | None = None) -> str:
    """La phrase, ou pour une phrase longue (page aplatie) la fenêtre autour de la tournure lue."""
    text = re.sub(r"\s+", " ", str(text or "")).strip()
    if len(text) <= 300 or near is None:
        return text[:300]
    start = max(0, min(int(near * len(text)) - 150, len(text) - 300))
    return text[start: start + 300]


_SENTENCE_SPLIT = re.compile(r"(?<=[.;!?])\s+|\n+|\s+[•·]\s+|\s+-\s+(?=[A-ZÉÈÀ])")


def split_sentences(text: str) -> list[str]:
    return [part.strip() for part in _SENTENCE_SPLIT.split(str(text or "")) if part and part.strip()]


def read_occupancy_statements(*texts: object) -> list[OccupancyReading]:
    readings: list[OccupancyReading] = []
    for text in texts:
        for sentence in split_sentences(str(text or "")):
            reading = read_occupancy_statement(sentence)
            if reading is not None:
                readings.append(reading)
    return readings


def _merge_family(statuses: set[str]) -> str | None:
    """« occupé » + « occupé par le propriétaire » -> le plus précis ; deux précisions différentes -> None."""
    if statuses == {VACANT}:
        return VACANT
    if VACANT in statuses:
        return None
    specific = statuses - {OCCUPIED}
    if len(specific) > 1:
        return None
    return next(iter(specific)) if specific else OCCUPIED


def resolve_occupancy(readings: list[OccupancyReading]) -> OccupancyDecision:
    if not readings:
        return OccupancyDecision(None, "none")
    if any(item.at_sale and item.certain for item in readings):
        # « sera libre au jour de l'adjudication » clôt une occupation en cours (convention, services de l'État),
        # pas un bail ni une occupation par le saisi : ceux-là restent une contradiction.
        readings = [item for item in readings if item.status != OCCUPIED]
    if any(item.departure and item.certain for item in readings):
        readings = [item for item in readings if item.status != RENTED]
    certain = [item for item in readings if item.certain]
    mixed = [item for item in readings if item.status == MIXED]
    evidence = [item.evidence for item in readings]
    if mixed:
        return OccupancyDecision(UNKNOWN, "mixed", evidence)
    if not certain:
        return OccupancyDecision(UNKNOWN, "hedged", evidence)
    merged = _merge_family({item.status for item in certain})
    if merged is None:
        return OccupancyDecision(UNKNOWN, "conflict", evidence)
    return OccupancyDecision(merged, "agreed", [item.evidence for item in certain])


def occupancy_from_text(*texts: object) -> OccupancyDecision:
    return resolve_occupancy(read_occupancy_statements(*texts))


def occupancy_status_from_text(*texts: object) -> str | None:
    """Statut de la vente d'après ses phrases : certain, ``unknown`` (contradictoire, mixte, prudent) ou ``None``."""
    return occupancy_from_text(*texts).status


OCCUPANCY_ENUM = CERTAIN_STATUSES | {UNKNOWN}
_PDF_TEXT_MARKER = "--- PDF TEXT ENRICHMENT ---"


def page_text(text: object) -> str:
    """Le texte de la page source, sans les pièces recopiées à sa suite (elles ont leur propre lecture, classée)."""
    return str(text or "").split(_PDF_TEXT_MARKER, 1)[0]


def reconcile_occupancy(declared: str | None, decision: OccupancyDecision) -> str | None:
    """Le statut déclaré par un champ de la source, confronté aux phrases de la même page.

    Un champ « Libre » dont le texte dit « occupés par leur propriétaire actuelle » (Enchères Publiques, Rouen,
    03/11/2026) n'est pas un statut certain : ``unknown``. Un champ « Occupé » que le texte précise (« par la
    partie saisie ») prend la précision. Un texte seulement prudent ne retire pas un champ déclaré.
    """
    if decision.status is None:
        return declared
    if declared not in CERTAIN_STATUSES:
        return decision.status if declared is None or decision.status != UNKNOWN else declared
    if decision.status == UNKNOWN:
        return UNKNOWN if decision.reason in {"mixed", "conflict"} else declared
    return _merge_family({declared, decision.status}) or UNKNOWN


# Sources dont le statut ne vient que d'un libellé publié (Immo-Interactif « situationLocative », critère
# d'occupation d'Enchères Publiques) : sans ce libellé ni phrase, un « vacant » repris d'une ancienne ligne n'a
# pas de preuve (14 ventes Notaires et 1 Enchères Publiques affichées « libre » le 03/11/2026).
_LABEL_ONLY_SOURCES = frozenset({"notaires", "encheres_publiques"})
_OCCUPANCY_LABEL_KEYS = ("occupation", "critere_occupation_du_bien", "situationLocative", "situation_locative")


def vacancy_lacks_evidence(raw_sale: dict[str, object], status: str | None, decision: OccupancyDecision | None) -> bool:
    """« vacant » sans libellé publié ni phrase qui le dise, pour une source qui ne le tient que d'un libellé."""
    if status != VACANT or str(raw_sale.get("source_name") or "") not in _LABEL_ONLY_SOURCES:
        return False
    if decision is not None and decision.status == VACANT:
        return False
    if fold(raw_sale.get("occupancy_status")) not in {"", VACANT}:
        return False  # the source's own label (« LIBRE », « Libre de toute occupation »)
    snapshot = raw_sale.get("source_factual_snapshot")
    if isinstance(snapshot, dict) and fold(snapshot.get("occupancy_status")) not in {"", VACANT}:
        return False
    blocks = raw_sale.get("source_blocks")
    blocks = blocks if isinstance(blocks, dict) else {}
    return not any(fold(blocks.get(key)) not in {"", VACANT} for key in _OCCUPANCY_LABEL_KEYS)
