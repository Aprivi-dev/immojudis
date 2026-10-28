"""Requête envoyée au géocodeur (BAN) pour l'adresse d'une vente.

Fonctions pures (aucun réseau). L'adresse d'une annonce porte parfois du texte qui n'est pas l'adresse et qui fait
chercher la BAN au mauvais endroit :

* un second code postal : « 6 rue des Templiers, 69002 LYON 69003 » ou, ajouté à la requête, le code postal de la
  vente quand l'adresse en porte déjà un autre (« 43 Boulevard Henri Maulini, 13014 MARSEILLE » + 13006). Le
  paramètre ``postcode`` de la BAN filtre alors sur le mauvais code ;
* la date et l'heure de l'audience collées à l'adresse (« 56100 LORIENT LE LUNDI 23 NOVEMBRE 2026 à 14 H 00 56440
  LANGUIDIC ») : tout ce qui suit le premier repère d'audience est écarté ;
* un « France » final ;
* des mentions de bâtiment, d'escalier, d'étage ou de lot, séparées de l'adresse par une virgule ou un tiret.

Une adresse sans texte parasite est envoyée telle quelle : la requête ne change que quand il y a quelque chose à
retirer (le cache négatif de ``src.geocode`` compare la requête construite à celle de la tentative précédente).
"""

from __future__ import annotations

import re

from src.models import AuctionSale
from src.normalize import clean_text
from src.position_quality import street_name_tokens

_POSTAL_CODE = re.compile(r"(?<!\d)\d{5}(?!\d)")
_MONTHS = (
    "janvier|f[ée]vrier|mars|avril|mai|juin|juillet|ao[uû]t|septembre|octobre|novembre|d[ée]cembre"
)
# Premier repère d'audience : jour de la semaine suivi d'un quantième, date écrite avec une année 20xx (« rue du
# 8 mai 1945 » n'en est pas une), date numérique complète ou heure (« à 14 H 00 », « 14h30 »).
_HEARING_MARKER = re.compile(
    rf"""(?:\b(?:le|du|[àa])\s+)?\b(?:
        (?:lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche)\s+\d{{1,2}}
        |\d{{1,2}}(?:er)?\s+(?:{_MONTHS})\s+20\d{{2}}
        |\d{{1,2}}[/.]\d{{1,2}}[/.](?:20)?\d{{2}}
        |[àa]\s+\d{{1,2}}\s*[hH]\s*\d{{0,2}}
        |\d{{1,2}}\s*[hH]\s*\d{{2}}
    )\b""",
    re.IGNORECASE | re.VERBOSE,
)
_SEGMENT_SEPARATOR = re.compile(r"(\s+[-–—]\s+|\s*[,;]\s*)")
_UNIT_SEGMENT = re.compile(
    r"^\s*(?:b[âa]t(?:iment)?|escalier|esc|[ée]tage|appartement|appt?|porte|lots?)\b", re.IGNORECASE
)
_TRAILING_FRANCE = re.compile(r"(?:\s+|(?<=[,;]))france\s*$", re.IGNORECASE)
_BEFORE_FRANCE_PREPOSITION = re.compile(r"\b(?:de|du|des|la|le|l'|d')\s*$", re.IGNORECASE)
_SEPARATOR_AT_END = re.compile(r"[\s,;\-–—]+$")
_PLACE_SEGMENT = re.compile(
    r"^\s*(?:(?:n[°o]\s*)?\d+\s*(?:bis|ter|quater)?[\s,]+)?(?:lieu[\s-]*dit|hameau|lotissement|domaine|ferme)\b",
    re.IGNORECASE,
)


def address_postal_codes(address: str | None) -> list[str]:
    """Les codes postaux à 5 chiffres de l'adresse, dans l'ordre, sans doublon."""
    return list(dict.fromkeys(_POSTAL_CODE.findall(address or "")))


def clean_address_for_geocoding(address: str | None) -> str:
    """L'adresse sans date d'audience, sans « France » final, sans mention de bâtiment ni second code postal."""
    text = clean_text(address) or ""
    if not text:
        return ""
    marker = _HEARING_MARKER.search(text)
    if marker is not None:
        text = text[: marker.start()]
    text = _drop_unit_segments(text)
    text = _SEPARATOR_AT_END.sub("", text)
    text = _drop_trailing_france(text)
    text = _drop_second_postal_code(text)
    return _SEPARATOR_AT_END.sub("", text).strip()


def _drop_unit_segments(text: str) -> str:
    parts = _SEGMENT_SEPARATOR.split(text)
    if len(parts) < 3:
        return text
    kept = [parts[0]]
    for separator, segment in zip(parts[1::2], parts[2::2], strict=True):
        if _UNIT_SEGMENT.match(segment):
            continue
        kept.extend((separator, segment))
    return "".join(kept)


def _drop_trailing_france(text: str) -> str:
    match = _TRAILING_FRANCE.search(text)
    if match is None:
        return text
    before = text[: match.start()]
    if re.search(r"[,;\-–—]\s*$", before):
        return before
    # « 75006 PARIS France » : un code postal précède, et « France » n'est pas la fin d'un nom de voie.
    if _POSTAL_CODE.search(before) and not _BEFORE_FRANCE_PREPOSITION.search(before):
        return before
    return text


def _drop_second_postal_code(text: str) -> str:
    """« 69002 LYON 69003 » : le premier code postal est celui de l'adresse, ce qui suit le second est écarté."""
    matches = list(_POSTAL_CODE.finditer(text))
    if not matches or matches[0].start() == 0:
        return text
    for match in matches[1:]:
        if match.group() != matches[0].group():
            return text[: match.start()]
    return text


def has_street_or_place(address: str | None) -> bool:
    """L'adresse nomme une voie (« 12 rue Foch ») ou un lieu-dit ; une ville seule n'est pas une adresse."""
    cleaned = clean_address_for_geocoding(address)
    if not cleaned:
        return False
    for segment in _SEGMENT_SEPARATOR.split(cleaned)[::2]:
        if street_name_tokens(segment, require_street_type=True) is not None or _PLACE_SEGMENT.match(segment):
            return True
    return False


def build_geocode_query(sale: AuctionSale) -> str | None:
    """Adresse nettoyée, complétée du code postal de la vente (si l'adresse n'en a aucun) et de sa ville."""
    address = clean_address_for_geocoding(sale.address)
    parts = [address]
    if sale.postal_code and not address_postal_codes(address):
        parts.append(sale.postal_code)
    if sale.city and sale.city.lower() not in address.lower():
        parts.append(sale.city)
    return clean_text(" ".join(part for part in parts if part))


def geocode_postcode(sale: AuctionSale) -> str | None:
    """Filtre ``postcode`` de la BAN : le code postal de l'adresse s'il y en a un, sinon celui de la vente."""
    codes = address_postal_codes(clean_address_for_geocoding(sale.address))
    return codes[0] if codes else sale.postal_code
