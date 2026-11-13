"""Adresse du bien lue dans les pièces jointes (diagnostics, état des risques, cahier des conditions).

Une page source ne donne parfois que la commune (« 01630 Challex ») alors que les diagnostics écrivent
« Adresse du bien : 1368 route de la Plaine 01630 CHALLEX ». Seuls les champs étiquetés comme l'adresse du
bien ou de l'immeuble sont lus : jamais celle du propriétaire, du donneur d'ordre ou du diagnostiqueur, qui
ont leur propre étiquette. Une adresse n'est retenue que si :

* le texte entre l'étiquette et le code postal nomme une voie ou un lieu-dit (``has_street_or_place``) et ne
  contient ni autre étiquette (« Nom : », « Parcelle(s) : »), ni coordonnées ;
* son code postal est celui de la vente, ou sa commune celle de la vente ;
* les pièces ne donnent pas deux voies différentes (vente en plusieurs lots, annexe d'un autre bien) ;
  deux libellés du même lieu, dont l'un plus complet, s'accordent et le plus complet est gardé.

Elle ne remplace que l'adresse d'une vente qui n'a ni voie ni lieu-dit : une adresse de la page n'est jamais
écrasée. La commune et le code postal restent ceux de la vente ; la position est recalculée ensuite par la
passe des positions (``src.address_positions``). Les candidats lus sont gardés dans
``raw_payload.pdf_address_candidates`` pour contrôle.
"""

from __future__ import annotations

import re
from typing import Any

from src.geocode_query import has_street_or_place
from src.normalize import clean_text
from src.pdf_fact_scope import pdf_record_fact_projection
from src.text_folding import ascii_alnum_words, to_ascii

PDF_ADDRESS_EXTRACTION_KEY = "pdf_address_extraction"
PDF_ADDRESS_CANDIDATES_KEY = "pdf_address_candidates"

_LABEL = re.compile(
    r"(?:adresse\s+(?:du\s+bien|des\s+biens|de\s+l['’]\s*immeuble|du\s+local|de\s+la\s+propri[ée]t[ée])"
    r"|localisation\s+du\s+bien|situation\s+du\s+bien)(?:\s*\(s\))?",
    re.IGNORECASE,
)
# Ce que l'état des risques (ERP) imprime entre l'étiquette et l'adresse.
_FORM_NOISE = re.compile(
    r"(?:\s*(?::|-|–|adresse\s+du\s+bien|adresse\s+de\s+l['’]\s*immeuble|code\s+postal\s+ou\s+insee\s+commune))+",
    re.IGNORECASE,
)
_POSTAL_AND_CITY = re.compile(r"\b(\d{5})\s+([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ'’\- ]{1,60})")
_FORBIDDEN = re.compile(
    r":|@|\b(?:t[ée]l|nom|propri[ée]taire|donneur|commanditaire|mandataire|cabinet|diagnostiqueur|op[ée]rateur"
    r"|parcelle|cadastr|r[ée]f[ée]rence|non\s+communiqu)",
    re.IGNORECASE,
)
_MAX_STREET_CHARS = 90


def extract_pdf_address_candidates(pdf_texts: list[dict[str, object]] | list[str]) -> list[dict[str, object]]:
    """Every labelled property address of the attachments, with its document."""
    candidates: list[dict[str, object]] = []
    for item in pdf_texts:
        text = str(item.get("text") or "") if isinstance(item, dict) else str(item or "")
        url = str(item.get("url") or "") if isinstance(item, dict) else ""
        read_up_to = 0
        for label in _LABEL.finditer(text):
            if label.start() < read_up_to:
                # « Adresse du bien Adresse du bien … » : the repeated label belongs to the field just read.
                continue
            candidate = _candidate_after(text, label.end())
            if candidate is not None:
                read_up_to = int(candidate.pop("end"))
                candidates.append({**candidate, "document_url": url, "label": label.group(0)})
    return candidates


def apply_pdf_address(sale: Any, pdf_texts: list[dict[str, object]] | list[str]) -> None:
    """Fill the street of a sale whose source gives none, from one consistent labelled PDF address."""
    raw_payload = sale.raw_payload
    raw_payload.pop(PDF_ADDRESS_CANDIDATES_KEY, None)
    candidates = [item for item in extract_pdf_address_candidates(pdf_texts) if _same_place(sale, item)]
    if not candidates:
        return
    raw_payload[PDF_ADDRESS_CANDIDATES_KEY] = candidates[:10]
    chosen = _consistent_candidate(candidates)
    if chosen is None or "multi_lot_sale" in (sale.quality_flags or []) or has_street_or_place(sale.address):
        return
    city = clean_text(sale.city) or str(chosen["city"])
    postal_code = clean_text(sale.postal_code) or str(chosen["postal_code"])
    previous = sale.address
    sale.address = f"{chosen['street']}, {postal_code} {city}"
    raw_payload[PDF_ADDRESS_EXTRACTION_KEY] = {
        "value": sale.address,
        "evidence": chosen["evidence"],
        "document_url": chosen["document_url"],
        "occurrences": len(candidates),
    }
    pdf_record_fact_projection(
        sale,
        ["address"],
        evidence=str(chosen["evidence"]),
        document_url=str(chosen["document_url"]),
        payload_keys=(PDF_ADDRESS_EXTRACTION_KEY,),
        previous_value=previous,
    )


def _candidate_after(text: str, start: int) -> dict[str, object] | None:
    noise = _FORM_NOISE.match(text, start)
    start = noise.end() if noise else start
    window = text[start:start + _MAX_STREET_CHARS + 80]
    match = _POSTAL_AND_CITY.search(window)
    if match is None:
        return None
    street = clean_text(window[:match.start()].strip(" ,;-–")) or ""
    if not street or len(street) > _MAX_STREET_CHARS or _FORBIDDEN.search(street):
        return None
    if not has_street_or_place(street):
        return None
    return {
        "street": street,
        "postal_code": match.group(1),
        "city": clean_text(match.group(2)) or "",
        "evidence": clean_text(text[max(0, start - 40):start + match.end()]) or "",
        "end": start + match.end(),
    }


def _consistent_candidate(candidates: list[dict[str, object]]) -> dict[str, object] | None:
    """The fullest wording when every candidate names the same place, otherwise ``None``.

    « 1368 route de la Plaine » and « Lieu dit La Pièce 1368 route de la Plaine » agree; two streets do not.
    """
    fullest = max(candidates, key=lambda item: len(_key(str(item["street"]))))
    longest = _key(str(fullest["street"]))
    if all(_key(str(item["street"])) in longest for item in candidates):
        return fullest
    return None


def _same_place(sale: Any, candidate: dict[str, object]) -> bool:
    if sale.postal_code and str(candidate["postal_code"]) == str(sale.postal_code):
        return True
    city = _key(sale.city or "")
    return bool(city) and _key(str(candidate["city"])).startswith(city)


def _key(value: str) -> str:
    return ascii_alnum_words(to_ascii(value).lower())
