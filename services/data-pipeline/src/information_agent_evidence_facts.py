"""Faits tirés par des règles du texte d'une page d'une pièce reçue par l'agent d'information.

Sorti de ``information_agent_evidence`` (limite de taille des sources) : le fait (``EvidenceFact``, sa forme
enregistrée dans ``extracted_facts`` et sa relecture), les règles par page et le dédoublonnage des faits d'une pièce.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, replace
from datetime import datetime

from src.normalize import clean_text


@dataclass(frozen=True)
class EvidenceFact:
    fact_key: str
    value: str | int | float
    display_value: str
    evidence_excerpt: str
    confidence: float
    source_page: int
    unit: str | None = None
    extraction_method: str = "document_ocr_v1"
    # Motifs de relecture posés par la lecture sémantique (`SEMANTIC_REVIEW_REASONS`).
    review_reasons: tuple[str, ...] = ()

    def as_json(self) -> dict[str, object]:
        proposed_value: dict[str, object] = {"value": self.value}
        if self.unit:
            proposed_value["unit"] = self.unit
        payload: dict[str, object] = {
            "fact_key": self.fact_key,
            "proposed_value": proposed_value,
            "display_value": self.display_value,
            "evidence_excerpt": self.evidence_excerpt,
            "confidence": self.confidence,
            "source_page": self.source_page,
            "extraction_method": self.extraction_method,
        }
        if self.review_reasons:
            payload["review_reasons"] = list(self.review_reasons)
        return payload

    @classmethod
    def from_json(cls, payload: object) -> EvidenceFact:
        """Fait relu de ``extracted_facts`` (lecture reprise d'un passage précédent) ; une entrée mal formée lève."""
        if not isinstance(payload, dict) or not isinstance(payload.get("proposed_value"), dict):
            raise ValueError("Invalid stored evidence fact")
        proposed = payload["proposed_value"]
        value = proposed.get("value")
        unit = proposed.get("unit")
        confidence = payload.get("confidence")
        source_page = payload.get("source_page")
        reasons = payload.get("review_reasons", [])
        text_fields = ("fact_key", "display_value", "evidence_excerpt", "extraction_method")
        if (
            isinstance(value, bool)
            or not isinstance(value, (str, int, float))
            or not (unit is None or isinstance(unit, str))
            or isinstance(confidence, bool)
            or not isinstance(confidence, (int, float))
            or isinstance(source_page, bool)
            or not isinstance(source_page, int)
            or not all(isinstance(payload.get(field), str) for field in text_fields)
            or not isinstance(reasons, list)
            or not all(isinstance(reason, str) for reason in reasons)
        ):
            raise ValueError("Invalid stored evidence fact")
        return cls(
            fact_key=payload["fact_key"],
            value=value,
            display_value=payload["display_value"],
            evidence_excerpt=payload["evidence_excerpt"],
            confidence=float(confidence),
            source_page=source_page,
            unit=unit,
            extraction_method=payload["extraction_method"],
            review_reasons=tuple(reasons),
        )


def extract_evidence_facts(pages: list[dict[str, object]]) -> list[EvidenceFact]:
    facts: list[EvidenceFact] = []
    for page in pages:
        page_number = int(page.get("page") or 1)
        text = clean_text(page.get("text")) or ""
        if not text:
            continue
        facts.extend(_surface_facts(text, page_number))
        facts.extend(_sale_date_facts(text, page_number))
        facts.extend(_property_type_facts(text, page_number))
        facts.extend(_address_facts(text, page_number))
        facts.extend(_rooms_facts(text, page_number))
        facts.extend(_occupancy_facts(text, page_number))
        facts.extend(_starting_price_facts(text, page_number))
        facts.extend(_diagnostic_facts(text, page_number))
        facts.extend(_visit_facts(text, page_number))
    return deduplicate_facts(facts)


def _surface_facts(text: str, page: int) -> list[EvidenceFact]:
    facts: list[EvidenceFact] = []
    patterns = (
        ("land_surface_m2", r"(?:terrain|parcelle|contenance)[^\d]{0,45}(\d{1,8}(?:[.,]\d{1,2})?)\s*m(?:²|2)\b", 0.88),
        ("surface_m2", r"(?:surface(?:\s+(?:habitable|carrez|privative|utile))?)[^\d]{0,45}(\d{1,6}(?:[.,]\d{1,2})?)\s*m(?:²|2)\b", 0.9),
    )
    for fact_key, pattern, confidence in patterns:
        for match in re.finditer(pattern, text, re.IGNORECASE):
            value = float(match.group(1).replace(",", "."))
            if value <= 0:
                continue
            facts.append(
                EvidenceFact(
                    fact_key=fact_key,
                    value=value,
                    display_value=f"{value:g} m²",
                    evidence_excerpt=_excerpt(text, match.start()),
                    confidence=confidence,
                    source_page=page,
                    unit="m2",
                )
            )
    return facts


def _sale_date_facts(text: str, page: int) -> list[EvidenceFact]:
    pattern = (
        r"(?:date\s+(?:de\s+)?(?:la\s+)?vente|audience\s+d['’]adjudication|date\s+d['’]adjudication)"
        r"[^\d]{0,35}(\d{1,2})[./-](\d{1,2})[./-](\d{4})\b"
    )
    facts: list[EvidenceFact] = []
    for match in re.finditer(pattern, text, re.IGNORECASE):
        day, month, year = (int(value) for value in match.groups())
        try:
            sale_date = datetime(year, month, day).date().isoformat()
        except ValueError:
            continue
        facts.append(
            EvidenceFact(
                "sale_date",
                sale_date,
                sale_date,
                _excerpt(text, match.start()),
                0.9,
                page,
            )
        )
    return facts


def _property_type_facts(text: str, page: int) -> list[EvidenceFact]:
    patterns = (
        ("commercial", r"\b(?:local|fonds? de commerce|commerce|boutique)\b"),
        ("apartment", r"\b(?:appartement|studio|duplex|triplex|T[1-5])\b"),
        ("house", r"\b(?:maison|villa|pavillon)\b"),
        ("building", r"\b(?:immeuble|bâtiment|batiment)\b"),
        ("land", r"\b(?:terrain|parcelle)\b"),
        ("parking", r"\b(?:parking|stationnement|garage)\b"),
    )
    facts: list[EvidenceFact] = []
    for value, pattern in patterns:
        for match in re.finditer(pattern, text, re.IGNORECASE):
            facts.append(
                EvidenceFact(
                    "property_type",
                    value,
                    value,
                    _excerpt(text, match.start()),
                    0.78,
                    page,
                )
            )
    return facts


def _address_facts(text: str, page: int) -> list[EvidenceFact]:
    pattern = (
        r"(?:adresse|situé(?:e)?|sis(?:e)?)\s*[:\-]?\s*"
        r"(\d{1,5}(?:\s*(?:bis|ter|quater))?\s+(?:rue|avenue|av\.?|boulevard|bd\.?|chemin|route|impasse|allée|allee|place|quai|cours|faubourg|passage|square|voie)\b[^\n;|]{2,160}?)"
        r"(?=\.\s+(?:date|surface|mise|diagnostic|dpe|visite)\b|$)"
    )
    facts: list[EvidenceFact] = []
    for match in re.finditer(pattern, text, re.IGNORECASE):
        value = clean_text(match.group(1))
        if value:
            facts.append(EvidenceFact("address", value, value, _excerpt(text, match.start()), 0.72, page))
    return facts


def _rooms_facts(text: str, page: int) -> list[EvidenceFact]:
    facts: list[EvidenceFact] = []
    for match in re.finditer(r"(?<!\d)(\d{1,2})(?!\d)\s+pi[eè]ces?\b", text, re.IGNORECASE):
        value = int(match.group(1))
        if 1 <= value <= 100:
            facts.append(EvidenceFact("rooms_count", value, f"{value} pièce(s)", _excerpt(text, match.start()), 0.86, page))
    return facts


def _occupancy_facts(text: str, page: int) -> list[EvidenceFact]:
    # Qui occupe et pourquoi ne s'affichent jamais (la fiche dit libre, occupé ou loué) : « occupé par le
    # propriétaire » et « squatté » se lisent « occupé ».
    owner_pattern = r"\boccup[eé]\s+par\s+(?:le|la|les)\s+propri[eé]taire"
    plain_occupied_pattern = r"\boccup[eé]\b"
    patterns = (
        ("vacant", r"\b(?:libre de toute occupation|libre|vacant|inoccup[eé])\b"),
        ("rented", r"\b(?:lou[eé]|location|bail en cours|locataire)\b"),
        ("occupied", owner_pattern),
        ("occupied", r"\b(?:squat|occupant sans droit ni titre)\b"),
        ("occupied", plain_occupied_pattern),
    )
    labels = {
        "vacant": "Libre / vacant",
        "rented": "Loué",
        "occupied": "Occupé",
    }
    owner_spans = [match.span() for match in re.finditer(owner_pattern, text, re.IGNORECASE)]
    facts: list[EvidenceFact] = []
    for value, pattern in patterns:
        for match in re.finditer(pattern, text, re.IGNORECASE):
            if pattern == plain_occupied_pattern and any(
                start <= match.start() < end or start < match.end() <= end
                for start, end in owner_spans
            ):
                continue
            facts.append(
                EvidenceFact(
                    "occupancy_status",
                    value,
                    labels[value],
                    _excerpt(text, match.start()),
                    0.82,
                    page,
                )
            )
    return facts


def _starting_price_facts(text: str, page: int) -> list[EvidenceFact]:
    pattern = r"mise\s+[àa]\s+prix[^\d]{0,30}(\d{1,3}(?:[ .\u202f]\d{3})*(?:[.,]\d{1,2})?)\s*(?:€|euros?)"
    facts: list[EvidenceFact] = []
    for match in re.finditer(pattern, text, re.IGNORECASE):
        raw = re.sub(r"[ .\u202f]", "", match.group(1)).replace(",", ".")
        value = float(raw)
        if value <= 0 or value > 1_000_000_000:
            continue
        facts.append(
            EvidenceFact(
                "starting_price_eur",
                value,
                f"{value:,.0f} €".replace(",", " "),
                _excerpt(text, match.start()),
                0.94,
                page,
                "EUR",
            )
        )
    return facts


def _diagnostic_facts(text: str, page: int) -> list[EvidenceFact]:
    facts: list[EvidenceFact] = []
    pattern = r"(?:DPE|diagnostic de performance [ée]nerg[ée]tique)[^A-G]{0,30}([A-G])\b"
    for match in re.finditer(pattern, text, re.IGNORECASE):
        value = match.group(1).upper()
        facts.append(EvidenceFact("energy_diagnostics", value, f"DPE {value}", _excerpt(text, match.start()), 0.88, page))
    return facts


def _visit_facts(text: str, page: int) -> list[EvidenceFact]:
    facts: list[EvidenceFact] = []
    for match in re.finditer(r"\bvisite(?:s)?\b.{0,180}", text, re.IGNORECASE):
        excerpt = _excerpt(text, match.start(), radius=220)
        facts.append(EvidenceFact("visit_information", excerpt, excerpt[:500], excerpt, 0.72, page))
    return facts


def deduplicate_facts(facts: list[EvidenceFact]) -> list[EvidenceFact]:
    unique: dict[tuple[str, str], EvidenceFact] = {}
    for fact in facts:
        key = (fact.fact_key, str(fact.value).strip().lower())
        current = unique.get(key)
        # La lecture par l'IA l'emporte sur les règles pour la même valeur (elle porte le contrôle de la
        # phrase) ; sinon, la confiance la plus haute.
        if current is None or (
            fact.extraction_method.startswith("semantic") != current.extraction_method.startswith("semantic")
            and fact.extraction_method.startswith("semantic")
        ):
            kept = fact
        elif current.extraction_method.startswith("semantic") and not fact.extraction_method.startswith("semantic"):
            kept = current
        elif fact.confidence > current.confidence:
            kept = fact
        else:
            kept = current
        # Un motif de relecture posé sur l'une des occurrences reste sur le fait gardé : la même valeur
        # trouvée ailleurs ne la rend pas nette.
        reasons = tuple(dict.fromkeys([*(current.review_reasons if current else ()), *fact.review_reasons]))
        unique[key] = replace(kept, review_reasons=reasons) if reasons != kept.review_reasons else kept
    return list(unique.values())[:30]


def _excerpt(text: str, position: int, *, radius: int = 160) -> str:
    start = max(0, position - radius)
    end = min(len(text), position + radius)
    return (clean_text(text[start:end]) or "")[:1000]
