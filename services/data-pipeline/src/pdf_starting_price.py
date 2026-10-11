"""Starting price (« mise à prix ») read from a sale notice or a conditions-of-sale PDF."""

from __future__ import annotations

import re
from decimal import Decimal

from src.normalize import clean_text, parse_price, strip_accents


def _extract_starting_price_with_evidence(text: str) -> dict[str, object] | None:
    if not clean_text(text):
        return None
    # Thousands groups may be split by a space, a dot or (OCR, English layout)
    # a comma: « 188,933 € » is 188 933 €, never the tail « 933 ».
    value_pattern = (
        r"(?<![0-9.,])(?P<price>[0-9]{1,3}(?:[\s.,\u00a0][0-9]{3})+(?:,[0-9]{1,2})?"
        r"|[0-9]+(?:,[0-9]{1,2})?)"
    )
    patterns = (
        rf"\bmise\s+[àa]\s+prix\s*[:\-]\s*{value_pattern}\s*(?:€|euros?)(?=\s|[).,;:]|$)",
        rf"\bmise\s+[àa]\s+prix\b.{{0,260}}?"
        rf"(?:ci[\s-]*apr[eè]s\s+indiqu[eé]e?s?|adjudication\s+aura\s+lieu|en\s+un\s+seul\s+lot)"
        rf".{{0,140}}?{value_pattern}\s*(?:€|euros?)(?=\s|[).,;:]|$)",
        rf"\badjudication\b.{{0,180}}?\bsur\s+la\s+mise\s+[àa]\s+prix\b"
        rf".{{0,180}}?{value_pattern}\s*(?:€|euros?)(?=\s|[).,;:]|$)",
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
            return {"value": value, "evidence": context}
    return None


def _parse_grouped_price(token: str) -> Decimal | None:
    grouped = re.fullmatch(r"([0-9]{1,3}(?:[\s.,\u00a0][0-9]{3})+)(,[0-9]{1,2})?", token.strip())
    if grouped:
        token = re.sub(r"[\s.,\u00a0]", "", grouped.group(1)) + (grouped.group(2) or "")
    return parse_price(token)
