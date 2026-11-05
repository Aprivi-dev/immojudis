"""Prix et échéance d'une annonce de notaires lus dans sa description quand le JSON ne les donne pas.

Exemples réels (audit du 03/11/2026) :

* « 1ère offre possible : à partir de 887 250,00 euros (honoraires de négociation inclus) » ;
* « Réception des offres du 08/09/2026 17:00 au 09/09/2026 17:00 » : l'échéance d'une vente interactive est la
  fin de la réception des offres ;
* « La réception des offres débutera le mercredi 26 août 2026 à 13h00 et se terminera le jeudi 27 août 2026 à
  13h00 » ;
* « Mercredi 28 octobre 2026 à 14H30 (Dépôt de consignation à 14H00) » : séance d'une vente aux enchères.

Ces lectures ne remplacent jamais une valeur du JSON : elles comblent seulement un champ vide.
"""

from __future__ import annotations

import re
from datetime import datetime
from typing import Any

from src.normalize import parse_french_datetime
from src.sources.notaires_price_nature import FIRST_OFFER_NATURE, starting_price_nature

_AMOUNT = r"(\d{1,3}(?:[ \u00a0\u202f.]\d{3})+|\d{4,})(?:,\d{2})?\s*(?:€|euros?\b)"
_FIRST_OFFER = re.compile(
    rf"\b(?:1\s*(?:[èe]re|re|er)|premi[èe]re)\s+offre\s+possible\s*:?\s*(?:[àa]\s+partir\s+de\s*)?{_AMOUNT}",
    re.I,
)
_STARTING_PRICE = re.compile(rf"\bmise\s+[àa]\s+prix\s*:?\s*(?:de\s+)?{_AMOUNT}", re.I)
_SLASH_DATE = r"(\d{1,2}\s*/\s*\d{1,2}\s*/\s*\d{4})(?:\s*(?:[àa]\s*)?(\d{1,2}\s*[:hH]\s*\d{2}))?"
_OFFER_WINDOW = re.compile(rf"r[ée]ception\s+des\s+offres\s*:?\s*du\s+{_SLASH_DATE}\s+au\s+{_SLASH_DATE}", re.I)
_MONTHS = r"janvier|f[ée]vrier|mars|avril|mai|juin|juillet|ao[uû]t|septembre|octobre|novembre|d[ée]cembre"
_WEEKDAYS = r"lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche"
_WORD_DATE = rf"(?:(?:{_WEEKDAYS})\s+)?\d{{1,2}}(?:er)?\s+(?:{_MONTHS})\s+\d{{4}}(?:\s+[àa]\s+\d{{1,2}}\s*[hH:]\s*\d{{0,2}})?"
_OFFERS_END = re.compile(rf"r[ée]ception\s+des\s+offres[^.]{{0,120}}?se\s+terminera\s+le\s+({_WORD_DATE})", re.I)
_OFFERS_START_END = re.compile(
    rf"r[ée]ception\s+des\s+offres\s+d[ée]butera\s+le\s+({_WORD_DATE})\s+et\s+se\s+terminera\s+le\s+({_WORD_DATE})",
    re.I,
)
_SESSION = re.compile(rf"({_WORD_DATE})\s*\(\s*d[ée]p[ôo]t\s+de\s+consignation", re.I)


def text_starting_price(*texts: object) -> tuple[str, str] | None:
    """« Mise à prix : 560 000 euros », sinon « 1ère offre possible : (à partir de) 887 250,00 euros ».

    Renvoie ``(montant, nature)`` avec la nature de ``notaires_price_nature``.
    """
    for pattern, nature in ((_STARTING_PRICE, "mise_a_prix"), (_FIRST_OFFER, FIRST_OFFER_NATURE)):
        for text in texts:
            match = pattern.search(str(text or ""))
            if match:
                return re.sub(r"[ \u00a0\u202f.]", "", match.group(1)), nature
    return None


def notaires_price_fields(transaction: dict[str, Any], description_text: str | None) -> dict[str, Any]:
    """Prix de départ du JSON (mise à prix, première offre, prix minimum), à défaut celui de la description."""
    mise_a_prix, first_offer, minimum = (transaction.get(key) for key in ("miseAPrix", "premierPrix", "prixMin"))
    price = mise_a_prix or first_offer or minimum
    if price:
        return {"starting_price_eur": price, **starting_price_nature(mise_a_prix, first_offer, minimum)}
    from_text = text_starting_price(description_text)
    if from_text is None:
        return {"starting_price_eur": None}
    return {"starting_price_eur": from_text[0], "starting_price_nature": from_text[1]}


def text_offer_window(*texts: object) -> tuple[datetime, datetime] | None:
    """(ouverture, clôture) de la réception des offres d'une vente interactive, lue dans la description."""
    for text in (str(value or "") for value in texts):
        window = _OFFER_WINDOW.search(text)
        bounds = (
            (_slash_datetime(window.group(1), window.group(2)), _slash_datetime(window.group(3), window.group(4)))
            if window else None
        )
        if bounds is None:
            match = _OFFERS_START_END.search(text)
            bounds = (parse_french_datetime(match.group(1)), parse_french_datetime(match.group(2))) if match else None
        if bounds and bounds[0] is not None and bounds[1] is not None:
            # « du 26 /08/2026 11:00 au 27/06/2026 11:00 » : une clôture avant l'ouverture est une coquille,
            # les offres ne se ferment jamais avant de s'ouvrir ; l'échéance est la plus tardive des deux.
            opens, closes = sorted(bounds)
            if opens < closes:
                return opens, closes
    return None


def text_sale_date(*texts: object) -> str | None:
    """Clôture de la réception des offres, ou séance suivie du dépôt de consignation ; sinon ``None``."""
    window = text_offer_window(*texts)
    if window is not None:
        return window[1].isoformat()
    for text in (str(value or "") for value in texts):
        for pattern in (_OFFERS_END, _SESSION):
            match = pattern.search(text)
            if match and parse_french_datetime(match.group(1)) is not None:
                return re.sub(r"\s+", " ", match.group(1)).strip()
    return None


def text_offer_schedule(schedule: dict[str, Any] | None, *texts: object) -> dict[str, Any] | None:
    """Calendrier de la source, complété par la fenêtre d'offres de la description quand il n'a pas de bornes.

    Sans bornes, la rétention (``src.admission.retention_deadline``) ne peut jamais clore la vente.
    """
    if schedule and schedule.get("opens_at") and schedule.get("closes_at"):
        return schedule
    window = text_offer_window(*texts)
    if window is None:
        return schedule
    return {"opens_at": window[0].isoformat(), "closes_at": window[1].isoformat(), "source": "notaires.description"}


def _slash_datetime(day: str, time: str | None) -> datetime | None:
    value = re.sub(r"\s+", "", day)
    if time:
        clock = re.sub(r"[hH]", ":", re.sub(r"\s+", "", time))
        value = f"{value} {clock}"
    return parse_french_datetime(value)
