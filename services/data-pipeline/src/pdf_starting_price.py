"""Starting price (« mise à prix ») read from a sale notice or a conditions-of-sale PDF.

Calls for offers (Cessions de l'État, AGRASC, notarial tenders) announce their price in other words: « prix
de départ », « prix minimum net vendeur », « prix d'appel », « montant minimum de l'offre », often written out
in letters with the figure in parentheses. ``price_kind`` keeps which announcement was read.
"""

from __future__ import annotations

import re
from decimal import Decimal

from src.normalize import clean_text, parse_price
from src.text_folding import strip_accents

# Thousands groups may be split by a space, a dot or (OCR, English layout)
# a comma: « 188,933 € » is 188 933 €, never the tail « 933 ».
_VALUE = (
    r"(?<![0-9.,])(?P<price>[0-9]{1,3}(?:[\s., ][0-9]{3})+(?:,[0-9]{1,2})?"
    r"|[0-9]+(?:,[0-9]{1,2})?)"
)
_CURRENCY = r"\s*(?:€|eur\b|euros?\b)"
# Between the announcement and its figure: the amount in letters, never another number nor the end of the
# sentence. « … DEUX MILLIONS QUATRE-VINGT-SEIZE MILLE EUROS (2 096 000,00 EUR) ».
# An empty « ( ) » ends it: « Le PRIX DE DEPART est fixé à QUATRE CENT … MILLE EUROS ( ) » has no figure.
_GAP = r"[^.;\d)]{0,140}?\(?\s*"
_E = "[eéEÉ]"
TENDER_PRICE_PATTERNS = (
    # « La MISE A PRIX est fixée à : QUATRE CENT CINQUANTE MILLE EUROS (450 000,00 EUR) » ; « La mise à prix
    # minimum pour cette cession est fixée à ONZE MILLE TROIS CENT EUROS (11 300€) » ; « La mise à prix de ce bien
    # a été fixée à soixante-quinze mille euros (75 000 €) ».
    ("mise_a_prix", rf"\bmise\s+[àa]\s+prix(?:\s+minimum)?(?:\s+pour\s+cette\s+cession|\s+de\s+ce\s+bien)?"
                    rf"\s+(?:est|a\s+{_E}t{_E})\s+fix{_E}e\s+[àa]\s*:?"),
    # « prix de départ FAI indiqué sur le site de DEUX MILLIONS … (2 096 000,00 EUR) ».
    ("prix_de_depart", rf"\bprix\s+de\s+d{_E}part(?:\s+FAI)?(?:\s+indiqu{_E}\s+sur\s+le\s+site)?\s+(?:de|est\s+(?:fix{_E}\s+)?[àa]|:)"),
    # « prix minimum net vendeur d'un montant de 43.000,00 euros ».
    ("prix_minimum", r"\bprix\s+minimum(?:\s+net\s+vendeur)?\s+(?:d['’]un\s+montant\s+de|de|est\s+(?:fix[ée]\s+)?[àa]|:)"),
    # « montant minimum de l'offre devra être de CENT SOIXANTE-DEUX EUROS (162,00 €) ».
    ("prix_minimum", r"\bmontant\s+minimum\s+de\s+l['’]\s*offre\s+(?:devra\s+[êe]tre|est\s+fix[ée])\s+(?:de|[àa])"),
    # « Prix d'appel : Le bien est mis à prix à hauteur de 95 000 €, frais d'agence inclus ».
    ("prix_d_appel", r"\bprix\s+d['’]\s*appel\s*:?"),
)
# An amount of the guarantee or the deposit is never the price, even when it quotes it: « dépôt de garantie de
# 10 % du prix minimum », « consignation de la mise à prix ». Fees only count between the announcement and its
# figure: « Ces frais sont inclus dans le prix de départ FAI indiqué sur le site de … (2 096 000,00 EUR) » is the price.
_FOREIGN_LEAD = re.compile(
    r"\b(?:garantie|caution|consignation|indemnit[eé]|acompte|s[eé]questre)\b",
    re.I,
)
_FOREIGN_GAP = re.compile(r"\b(?:frais|honoraires|commission|garantie|caution|consignation)\b", re.I)


def _extract_starting_price_with_evidence(text: str, *, tender: bool = False) -> dict[str, object] | None:
    """Court « mise à prix » first; the announcements of a call for offers only when ``tender``."""
    if not clean_text(text):
        return None
    patterns = (
        rf"\bmise\s+[àa]\s+prix\s*[:\-]\s*{_VALUE}\s*(?:€|euros?)(?=\s|[).,;:]|$)",
        rf"\bmise\s+[àa]\s+prix\b.{{0,260}}?"
        rf"(?:ci[\s-]*apr[eè]s\s+indiqu[eé]e?s?|adjudication\s+aura\s+lieu|en\s+un\s+seul\s+lot)"
        rf".{{0,140}}?{_VALUE}\s*(?:€|euros?)(?=\s|[).,;:]|$)",
        rf"\badjudication\b.{{0,180}}?\bsur\s+la\s+mise\s+[àa]\s+prix\b"
        rf".{{0,180}}?{_VALUE}\s*(?:€|euros?)(?=\s|[).,;:]|$)",
    )
    for pattern in patterns:
        for match in re.finditer(pattern, text, re.I | re.S):
            context = clean_text(text[max(0, match.start() - 180) : min(len(text), match.end() + 220)]) or ""
            normalized_context = strip_accents(context).lower()
            if re.search(
                r"\b(?:caution|cheque\s+de\s+banque|minimum\s+de)\b|"
                r"\b10\s*%\s+du\s+montant\s+de\s+la\s+mise\s+a\s+prix\b",
                normalized_context,
            ) and not re.search(
                r"\b(?:adjudication\s+aura\s+lieu|en\s+un\s+seul\s+lot|ci[\s-]*apres\s+indique)\b",
                normalized_context,
            ):
                continue
            value = _parse_grouped_price(match.group("price"))
            if value is None or value <= 0:
                continue
            return {"value": value, "evidence": context, "price_kind": "mise_a_prix"}
    return _extract_tender_price_with_evidence(text) if tender else None


def _extract_tender_price_with_evidence(text: str) -> dict[str, object] | None:
    """Price announced by a call for offers; the figure (in parentheses when also written in letters) is read."""

    value_text = clean_text(text) or ""
    for kind, announcement in TENDER_PRICE_PATTERNS:
        for match in re.finditer(rf"{announcement}{_GAP}{_VALUE}{_CURRENCY}", value_text, re.I):
            # Same sentence only: the lead of the announcement and the words before its figure.
            lead = re.split(r"[.;]", value_text[max(0, match.start() - 80) : match.start()])[-1]
            if _FOREIGN_LEAD.search(lead) or _FOREIGN_GAP.search(match.group(0)[: match.start("price") - match.start()]):
                continue
            value = _parse_grouped_price(match.group("price"))
            if value is None or value <= 0:
                continue
            evidence = value_text[max(0, match.start() - 60) : min(len(value_text), match.end() + 60)]
            return {"value": value, "evidence": clean_text(evidence) or "", "price_kind": kind}
    return None


def _parse_grouped_price(token: str) -> Decimal | None:
    grouped = re.fullmatch(r"([0-9]{1,3}(?:[\s., ][0-9]{3})+)(,[0-9]{1,2})?", token.strip())
    if grouped:
        token = re.sub(r"[\s., ]", "", grouped.group(1)) + (grouped.group(2) or "")
    return parse_price(token)
