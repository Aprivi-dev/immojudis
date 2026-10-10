"""Lecture de l'adresse d'un bien dans le texte d'une annonce (fonctions pures).

Les sources ne publient pas l'adresse au même endroit :

* ``encheres_immobilieres`` : bloc « Adresse du bien » de la page détail, où
  les libellés sont rendus *avant* les valeurs (« Mise à prix / Adresse du
  bien / 30 000 € / 12 rue X / , / 06000 / NICE ») ;
* ``avoventes`` : début de la description (« À COMMUNE (CP) - 21 rue X ... ») ;
* ``cessions_etat`` : jamais d'adresse postale, seulement la commune, la
  référence cadastrale et parfois une voie dans le titre ou la description ;
* ``vench`` et ``petites_affiches`` : la commune seule.

Ce module ne fait AUCUN accès réseau ni base. Il ne renvoie qu'une valeur lue
dans le texte : en l'absence de preuve il renvoie ``None`` (aucune valeur
inventée). Il ne lit jamais les blocs « Lieu de vente » (adresse du tribunal)
ni « Avocat poursuivant » (cabinet), qui contiennent eux aussi des rues.
"""

from __future__ import annotations

import re
import unicodedata

# Types de voie reconnus dans une adresse déjà extraite (colonne ``address``).
_STREET_TYPES = (
    r"rue|avenue|av\.?|boulevard|bd\.?|chemin|route|rte|impasse|all[ée]es?|place|quai|cours|faubourg|passage|"
    r"square|voie|lotissement|hameau|r[ée]sidence|chauss[ée]e|esplanade|sentier|ruelle|traverse|rond-point|"
    r"parvis|clos|cit[ée]|villa|domaine|za|zi|zac"
)
_LIEU_DIT = r"lieu[\s-]?dit|lieudit|quartier|hameau|ferme|moulin|mas|ch[âa]teau"
_PARTICLE = r"(?:de\s+la|de\s+l['’]|du|des|de|d['’]|la|le|les|l['’])"
_STOPWORDS = (
    r"Sur|Dans|Un|Une|Et|Au|Aux|Le|La|Les|Du|Des|Pour|Avec|En|Cadastr[\wé]*|Section|Lieu|Lot|Occup[\wé]*|Libre|Comprenant"
)
_CAPITAL_TOKEN = rf"(?!(?:{_STOPWORDS})\b)[A-ZÀ-ÝŒ][\wÀ-ÿŒœ'’-]*"
# Types de voie et particules insensibles à la casse, noms propres sensibles à la casse.
_T = f"(?i:{_STREET_TYPES})"
_P = f"(?i:{_PARTICLE})"

_STREET_RE = re.compile(rf"\b(?:{_STREET_TYPES})(?=[\s,.;:]|$)", re.I)
_NUMBERED_RE = re.compile(r"^\s*\d{1,4}\s*(?:bis|ter|quater)?\s*[,\s]\s*[A-Za-zÀ-ÿ]", re.I)
_LIEU_DIT_RE = re.compile(rf"\b(?:{_LIEU_DIT})\b", re.I)
_PARCEL_RE = re.compile(
    r"\b(?i:sections?)\s+[A-Z]{1,2}\b\s*(?:(?i:n)[°ºo]?\s*)?\d+"
    r"|\b(?i:cadastr[ée]e?s?)\b[^.\n]{0,60}\b[A-Z]{1,2}\s?\d{1,4}\b|^\s*[A-Z]{1,2}\s?\d{1,4}\b",
)

_MONEY_RE = re.compile(r"(?:€|\beuros?\b)", re.I)
_POSTAL_LINE_RE = re.compile(r"^\s*(\d{5})\s*$")

# Fin du bloc « Adresse du bien » : les libellés suivants appartiennent à
# d'autres champs (date, adresse de la vente = tribunal, descriptif).
_BLOCK_END_LABELS = ("date de mise en vente", "adresse de la vente", "descriptif du bien")


def _fold(value: str) -> str:
    return unicodedata.normalize("NFKD", value).encode("ascii", "ignore").decode("ascii").lower().strip()


def _clean(value: str | None) -> str:
    return re.sub(r"\s+", " ", (value or "").replace("\xa0", " ")).strip()


def classify_address(text: str | None) -> str | None:
    """Niveau de précision d'un libellé d'adresse.

    ``street`` : une voie (avec ou sans numéro) ; ``lieu_dit`` ; ``parcel`` :
    référence cadastrale ; ``commune`` : seulement une commune et/ou un code
    postal ; ``None`` : texte vide. Une valeur monétaire n'est pas une adresse.
    """
    value = _clean(text)
    if not value or _MONEY_RE.search(value) and not _STREET_RE.search(value):
        return None
    if re.fullmatch(r"(?:lots?\s+multiples?|non\s+communiqu[ée]e?|n/?c|inconnue?)", value, re.I):
        return None
    if _STREET_RE.search(value) or _NUMBERED_RE.match(value):
        return "street"
    if _LIEU_DIT_RE.search(value):
        return "lieu_dit"
    if _PARCEL_RE.search(value):
        return "parcel"
    return "commune"


def _looks_like_street_line(line: str) -> bool:
    value = _clean(line)
    if not value or _MONEY_RE.search(value) or _POSTAL_LINE_RE.match(value):
        return False
    return classify_address(value) in {"street", "lieu_dit"}


def extract_adresse_du_bien(lines: list[str]) -> str | None:
    """Adresse du bien d'une page détail ``encheres_immobilieres``.

    La page rend ``Adresse du bien`` suivi, dans l'ordre, du prix, d'éventuelles
    mentions de procédure (« Sur / licitation », « avec faculté de baisse »),
    de la voie, d'une ligne ``,``, du code postal puis de la commune. La valeur
    n'est donc PAS la ligne qui suit le libellé : on ancre sur la ligne ``,`` et
    on ne garde la ligne précédente que si elle ressemble à une voie.
    Renvoie ``"<voie>, <code postal> <commune>"`` ou ``None``.
    """
    start = next((i for i, line in enumerate(lines) if _fold(line).startswith("adresse du bien")), None)
    if start is None:
        return None
    segment: list[str] = []
    for line in lines[start + 1 : start + 16]:
        if any(_fold(line).startswith(label) for label in _BLOCK_END_LABELS):
            break
        segment.append(line)
    for index in range(1, len(segment) - 2):
        if _clean(segment[index]) != ",":
            continue
        postal = _POSTAL_LINE_RE.match(segment[index + 1])
        city = _clean(segment[index + 2])
        if not postal or not city or _MONEY_RE.search(city):
            continue
        street = _clean(segment[index - 1])
        if not _looks_like_street_line(street):
            return None
        return f"{street}, {postal.group(1)} {city}"
    # Gabarit plus ancien : la valeur tient sur la ligne qui suit le libellé.
    for line in segment:
        if _looks_like_street_line(line):
            return _clean(line)
    return None


_PROPERTY_STREET_PATTERNS = (
    # avoventes : « À CHAVENAY (78450) - 21 rue Haute Sur un terrain cadastré ... »
    re.compile(
        rf"\b[àÀ]\s+[A-ZÀ-Ý][\wÀ-ÿ'’ -]{{1,40}}\(\s*\d{{5}}\s*\)\s*[-–:,]\s*"
        rf"(?P<street>\d{{1,4}}\s*(?:bis|ter|quater)?\s*,?\s*{_T}\s+"
        rf"(?:{_P}\s*)*{_CAPITAL_TOKEN}(?:\s+(?:{_P}\s*)?{_CAPITAL_TOKEN}){{0,3}})",
    ),
    # « situé / sis au 12 rue Pierre ... », « situé après le n°17, avenue X »
    re.compile(
        rf"\b(?i:sis(?:e|es)?|situ[ée]e?s?)\s+(?:(?i:apr[èe]s|devant|face\s+au?|au|à|a|sur|dans)\s+)?"
        rf"(?:(?i:le)\s+)?(?:(?i:n)[°ºo]?\s*)?(?P<street>\d{{1,4}}\s*(?:bis|ter|quater)?\s*,?\s*{_T}\s+"
        rf"(?:{_P}\s*)*{_CAPITAL_TOKEN}(?:\s+(?:{_P}\s*)?{_CAPITAL_TOKEN}){{0,3}})",
    ),
)
_PROPERTY_STREET_SAFE = re.compile(
    rf"^\d{{1,4}}\s*(?:bis|ter|quater)?\s*,?\s*(?:{_STREET_TYPES})\s+", re.I
)


def extract_property_street(text: str | None) -> str | None:
    """Rue d'un bien citée dans sa description, avec un marqueur explicite.

    Volontairement strict : il faut un numéro, un type de voie et un nom propre,
    précédés de « À COMMUNE (CP) - » ou de « situé / sis ». Ne pas utiliser sur
    un texte qui contient le bloc de l'avocat ou le lieu de vente.
    """
    value = _clean(text)
    if not value:
        return None
    for pattern in _PROPERTY_STREET_PATTERNS:
        match = pattern.search(value)
        if match:
            street = _clean(match.group("street")).strip(" ,-")
            if _PROPERTY_STREET_SAFE.match(street):
                return street
    return None


_DESIGNATION_STREET_RE = re.compile(
    rf"(?:\b\d{{1,4}}\s*(?:bis|ter|quater)?\s*,?\s*)?\b{_T}\s+(?:{_P}\s*)*{_CAPITAL_TOKEN}"
)


def extract_designation(text: str | None) -> str | None:
    """Niveau de désignation d'un bien dans un texte descriptif.

    Renvoie ``street`` (voie nommée), ``lieu_dit``, ``parcel`` ou ``None``.
    Plus souple que :func:`extract_property_street` (pas de numéro exigé) : ne
    sert qu'à décider si une annonce *désigne* un lieu précis, jamais à
    renseigner la colonne ``address``.
    """
    value = _clean(text)
    if not value:
        return None
    if extract_property_street(value) or _DESIGNATION_STREET_RE.search(value):
        return "street"
    if re.search(r"\b(?:lieu[\s-]?dit|lieudit)\b", value, re.I):
        return "lieu_dit"
    if re.search(
        r"\b(?i:sections?)\s+[A-Z]{1,2}\b\s*(?:(?i:n)[°ºo]?\s*)?\d+|\b(?i:cadastr[ée]e?s?)\b[^.\n]{0,60}\b[A-Z]{1,2}\s?\d{1,4}\b",
        value,
    ):
        return "parcel"
    return None


def reject_monetary_address(raw_sale: dict, address: str | None) -> tuple[dict, str | None]:
    """Une valeur monétaire (« 30 000 € ») lue dans le champ adresse n'est pas une adresse."""
    if address and re.fullmatch(r"[\d\s.,]+\s*(?:€|euros?|EUR)", address, re.I):
        raw_sale = dict(raw_sale)
        raw_sale["invalid_address_evidence"] = {"value": address, "reason": "monetary_value_is_not_address"}
        raw_sale["quality_flags"] = [*(raw_sale.get("quality_flags") or []), "address_unverified"]
        raw_sale["latitude"] = raw_sale["longitude"] = None
        return raw_sale, None
    return raw_sale, address


def recover_listing_address(raw_sale: dict, address: str | None) -> str | None:
    """Adresse lue ailleurs dans la payload quand le champ adresse est absent ou seulement communal.

    Ne touche jamais une adresse déjà précise (voie ou lieu-dit). Source par source :
    ``encheres_immobilieres`` (bloc « Adresse du bien » de ``page_text``) et
    ``avoventes`` (adresse numérotée de la description, que la carte de liste
    — « CP Commune » — masquait). Aucune autre source : sans preuve, la valeur
    reste vide.
    """
    if classify_address(address) in {"street", "lieu_dit"}:
        return address
    source = _fold(str(raw_sale.get("source_name") or ""))
    blocks = raw_sale.get("source_blocks") if isinstance(raw_sale.get("source_blocks"), dict) else {}
    if source == "encheres_immobilieres":
        return extract_adresse_du_bien(str(blocks.get("page_text") or "").splitlines()) or address
    if source == "avoventes":
        from src.sources.avoventes import _extract_property_location

        description = blocks.get("description") or raw_sale.get("description")
        found = _extract_property_location(str(description or ""), str(blocks.get("titre_detail") or "")) or {}
        street = found.get("address")
        if street and classify_address(street) == "street":
            postal = found.get("postal_code") or raw_sale.get("postal_code")
            city = found.get("city") or raw_sale.get("city")
            commune = " ".join(part for part in (str(postal or ""), str(city or "")) if part)
            return f"{street}, {commune}" if commune else street
    return address
