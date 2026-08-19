from __future__ import annotations

import re
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from typing import Literal

from src.official_sources.base import canonical_sha256
from src.official_sources.judilibre import JudilibreDecision

JUDILIBRE_CLAIM_SCHEMA_VERSION = "judilibre_candidate_claims_v1"
JUDILIBRE_EVIDENCE_HASH_VERSION = "judilibre-evidence-sha256-v1"

ClaimType = Literal["starting_price_eur", "hammer_price_eur", "procedural_event"]

_MONEY_NUMBER = (
    r"(?:(?:\d{1,3}(?:[\s\u00a0\u202f.]\d{3})+(?:,\d{1,2})?)"
    r"|(?:\d+(?:[,.]\d{1,2})?))"
)
_MONEY_CURRENCY = r"(?:€(?!\w)|euros?\b|EUR\b)"
_MONEY_VALUE = rf"{_MONEY_NUMBER}\s*{_MONEY_CURRENCY}"
_AMOUNT = rf"(?P<amount>{_MONEY_NUMBER})\s*{_MONEY_CURRENCY}"
_STARTING_PRICE_ADJUSTMENT = (
    r"(?:port[ée]e?|ramen[ée]e?|relev[ée]e?|abaiss[ée]e?|r[ée]duite?|augment[ée]e?)"
)
_STARTING_PRICE_PATTERNS = (
    # A change expressed as ``porte la mise à prix de OLD à NEW`` must retain
    # the new amount, never the first amount encountered in the sentence.
    re.compile(
        rf"\b(?:porte|ram[eè]ne|rel[eè]ve|abaisse|r[ée]duit|augmente)\b"
        rf"(?P<context>[^.;\n]{{0,60}}?\bmise\s+[àa]\s+prix\b[^.;\n]{{0,30}}?"
        rf"\bde\s+{_MONEY_VALUE}[^.;\n]{{0,15}}?\b[àa]\s+){_AMOUNT}",
        re.IGNORECASE,
    ),
    # Covers both ``est portée de OLD à NEW`` and ``est portée à NEW``.
    re.compile(
        rf"\bmise\s+[àa]\s+prix\b"
        rf"(?P<context>[^.;\n]{{0,60}}?\b{_STARTING_PRICE_ADJUSTMENT}\b"
        rf"[^.;\n]{{0,60}}?\b[àa]\s+){_AMOUNT}",
        re.IGNORECASE,
    ),
    re.compile(
        rf"\bmise\s+[àa]\s+prix\b"
        rf"(?P<context>[^.;\n]{{0,100}}?\b(?:fix[ée]e?|arr[êe]t[ée]e?|"
        rf"s['’ ]?[ée]l[eè]ve|au\s+montant\s+de|à\s+la\s+somme\s+de)\b[^.;\n]{{0,35}}?){_AMOUNT}",
        re.IGNORECASE,
    ),
    re.compile(
        rf"\bsur\s+la\s+mise\s+[àa]\s+prix\s+de\b(?P<context>[^.;\n]{{0,35}}?){_AMOUNT}",
        re.IGNORECASE,
    ),
    re.compile(
        rf"\bmise\s+[àa]\s+prix\s*:\s*(?P<context>){_AMOUNT}",
        re.IGNORECASE,
    ),
)
_HAMMER_PRICE_PATTERNS = (
    re.compile(
        rf"\badjuge(?:ons)?\b[^.;\n]{{0,100}}?\b(?:bien|immeuble|lot|parcelle|propri[ée]t[ée])\b"
        rf"(?P<context>[^.;\n]{{0,220}}?)"
        rf"\b(?:moyennant(?:\s+le)?\s+prix(?:\s+principal)?|au\s+prix(?:\s+principal)?|"
        rf"pour\s+(?:le\s+prix|la\s+somme))\b[^.;\n]{{0,45}}?{_AMOUNT}",
        re.IGNORECASE,
    ),
    re.compile(
        rf"\b(?:bien|immeuble|lot|parcelle|propri[ée]t[ée])\b[^.;\n]{{0,80}}?\badjug[ée]e?\b"
        rf"(?P<context>[^.;\n]{{0,160}}?)"
        rf"\b(?:moyennant(?:\s+le)?\s+prix(?:\s+principal)?|au\s+prix(?:\s+principal)?|"
        rf"pour\s+(?:le\s+prix|la\s+somme))\b[^.;\n]{{0,45}}?{_AMOUNT}",
        re.IGNORECASE,
    ),
    re.compile(
        rf"\bprix(?:\s+principal)?\s+d['’ ]adjudication\b"
        rf"(?P<context>[^.;\n]{{0,100}}?\b(?:fix[ée]|arr[êe]t[ée]|de|à|au\s+montant\s+de)\b[^.;\n]{{0,35}}?){_AMOUNT}",
        re.IGNORECASE,
    ),
    re.compile(
        rf"\badjudication\s+(?:a\s+[ée]t[ée]\s+)?(?:prononc[ée]e?|constat[ée]e?)\b"
        rf"(?P<context>[^.;\n]{{0,100}}?\b(?:au\s+prix(?:\s+principal)?\s+de|moyennant(?:\s+le)?\s+prix\s+de)\b"
        rf"[^.;\n]{{0,35}}?){_AMOUNT}",
        re.IGNORECASE,
    ),
)
_DISPOSITIVE_MARKER = re.compile(
    r"\bpar\s+ces\s+motifs\b|^[ \t]*(?:le\s+)?dispositif[ \t]*(?::[ \t]*|$)",
    re.IGNORECASE | re.MULTILINE,
)
_NON_ACTUAL_CONTEXT_REJECT = re.compile(
    r"\b(?:devrait|devraient|devra|devront|pourrait|pourraient|pourra|pourront|"
    r"peut|peuvent|sera|seront|serait|seraient|doit|doivent)\b"
    r"|\b(?:va|vont)\s+(?:prochainement\s+)?(?:[êe]tre|se\s+voir)\b"
    r"|\bsusceptible\s+d['’ ]?[êe]tre\b"
    r"|\b(?:prochainement|ult[ée]rieurement|[ée]ventuellement)\b"
    r"|\bsi\b"
    r"|\bsoi(?:t|ent)\b[^.;\n]{0,60}?\b(?:adjug|fix[ée])",
    re.IGNORECASE,
)
_NEGATED_CONTEXT_REJECT = re.compile(
    r"\b(?:n['’]\s*|ne\s+)[^.;\n]{0,120}?\b(?:pas|jamais|aucun(?:e)?|plus)\b",
    re.IGNORECASE,
)
_ATTRIBUTED_OR_REQUESTED_CONTEXT_REJECT = re.compile(
    r"\b(?:selon|d['’ ]apr[eè]s|aux\s+dires\s+de|aux\s+termes\s+des?\s+conclusions)\b"
    r"|\b(?:demande(?:nt)?|sollicite(?:nt)?|propose(?:nt)?|pr[ée]tend(?:ent)?|"
    r"soutient|soutiennent|requiert|affirme(?:nt)?|all[eè]gue(?:nt)?|indique(?:nt)?|"
    r"estime(?:nt)?|conclut|concluent|conteste(?:nt)?)\b"
    r"|\b(?:rejette|refuse|d[ée]boute)\b[^.;\n]{0,160}?"
    r"\b(?:demande|requ[êe]te|pr[ée]tention|prix|adjudication|mise)\b",
    re.IGNORECASE,
)
_STARTING_TRANSITION_SIGNAL = re.compile(
    rf"\b(?:porte|ram[eè]ne|rel[eè]ve|abaisse|r[ée]duit|augmente)\b"
    rf"[^.;\n]{{0,80}}?\bmise\s+[àa]\s+prix\b"
    rf"|\bmise\s+[àa]\s+prix\b[^.;\n]{{0,80}}?\b{_STARTING_PRICE_ADJUSTMENT}\b",
    re.IGNORECASE,
)
_SINGLE_STARTING_TRANSITION = re.compile(
    rf"\bmise\s+[àa]\s+prix\b[^.;\n]{{0,100}}?\bde\s+{_MONEY_VALUE}"
    rf"[^.;\n]{{0,30}}?\b[àa]\s+{_MONEY_VALUE}",
    re.IGNORECASE,
)
_MONEY_VALUE_PATTERN = re.compile(_MONEY_VALUE, re.IGNORECASE)
_STARTING_PRICE_REJECT = re.compile(
    r"\b(?:consignation|caution|ch[eè]que|garantie|minimum|frais|tax[ée]s?|"
    r"cr[ée]ance|indemnit[ée]|d[ée]pens|10\s*%)\b",
    re.IGNORECASE,
)
_HAMMER_PRICE_REJECT = re.compile(
    r"\b(?:mise\s+[àa]\s+prix|frais|tax[ée]s?|consignation|caution|garantie|"
    r"cr[ée]ance|indemnit[ée]|d[ée]pens|sera|aura\s+lieu)\b",
    re.IGNORECASE,
)
_HAMMER_SURROUNDING_REJECT = re.compile(
    r"\b(?:sera|serait|seraient|devrait|pourrait)\s+(?:[ée]t[ée]\s+)?adjug[ée]e?\b"
    r"|\b(?:n['’ ]|ne\s+)[^.;\n]{0,35}?adjuge[^.;\n]{0,20}?\bpas\b"
    r"|\b(?:b[ée]n[ée]fice\s+de\s+ses\s+conclusions|au\s+titre\s+des?\s+d[ée]pens)\b",
    re.IGNORECASE,
)
_STARTING_SURROUNDING_REJECT = re.compile(
    r"\b(?:demande|sollicite|propose|pr[ée]tend|soutient)[^.;\n]{0,80}?mise\s+[àa]\s+prix\b"
    r"|\b(?:ne\s+peut|n['’ ]est\s+pas|sera|serait)[^.;\n]{0,45}?fix[ée]e?\b"
    r"|\b(?:refuse|rejette|d[ée]boute)\b[^.;\n]{0,140}?mise\s+[àa]\s+prix\b"
    r"|\bn['’ ]y\s+avoir\s+lieu\b[^.;\n]{0,140}?mise\s+[àa]\s+prix\b"
    r"|\b(?:annule|infirme|r[ée]form(?:e|ant|[ée]e?)|r[ée]tracte|met\s+[àa]\s+n[ée]ant)"
    r"[^.;\n]{0,120}?mise\s+[àa]\s+prix\b"
    r"|\bmise\s+[àa]\s+prix\b[^.;\n]{0,160}?\b(?:d[ée]sormais\s+)?"
    r"(?:annul[ée]e?|infirm[ée]e?|r[ée]form[ée]e?|r[ée]tract[ée]e?|mise\s+[àa]\s+n[ée]ant)\b",
    re.IGNORECASE,
)
_HAMMER_SURROUNDING_REJECT = re.compile(
    _HAMMER_SURROUNDING_REJECT.pattern
    + r"|\b(?:annule|infirme|r[ée]form(?:e|ant|[ée]e?)|r[ée]tracte|met\s+[àa]\s+n[ée]ant)\b"
    r"[^.;\n]{0,180}?\b(?:adjuge(?:ons)?|adjug[ée]e?|adjudication)\b"
    r"|\b(?:frais|tax[ée]s?|cr[ée]ance|indemnit[ée]|d[ée]pens)\b"
    r"[^.;\n]{0,160}?\b(?:adjuge(?:ons)?|adjug[ée]e?|adjudication)\b"
    r"|\b(?:adjuge(?:ons)?|adjug[ée]e?|adjudication)\b[^.;\n]{0,180}?"
    r"\b(?:annul[ée]e?|infirm[ée]e?|r[ée]form[ée]e?|r[ée]tract[ée]e?|mise\s+[àa]\s+n[ée]ant)\b",
    re.IGNORECASE,
)
_PROCEDURAL_SURROUNDING_REJECT = re.compile(
    r"\b(?:annule|infirme|r[ée]form(?:e|ant|[ée]e?)|r[ée]tracte|met\s+[àa]\s+n[ée]ant)\b"
    r"[^.;\n]{0,140}?\b(?:qui|ayant|en\s+ce\s+qu(?:['’]\s*|\s+)(?:il|elle|ils|elles))\b"
    r"[^.;\n]{0,80}?\b(?:adjuge(?:ons)?|constate|d[ée]clare|ordonne|prononce)\b",
    re.IGNORECASE,
)
_PROCEDURAL_PATTERNS: tuple[tuple[str, float, re.Pattern[str]], ...] = (
    (
        "adjudication_pronounced",
        0.85,
        re.compile(
            r"\badjuge(?:ons)?\b[^.;\n]{0,100}?\b(?:bien|immeuble|lot|parcelle|propri[ée]t[ée])\b",
            re.IGNORECASE,
        ),
    ),
    (
        "held_no_bid",
        0.85,
        re.compile(
            r"\b(?:constate\s+(?:la\s+)?(?:carence|absence)\s+d['’ ]ench[eè]res|"
            r"déclare\s+les\s+ench[eè]res\s+d[ée]sertes)\b",
            re.IGNORECASE,
        ),
    ),
    (
        "postponed",
        0.80,
        re.compile(
            r"\b(?:ordonne|prononce)\s+(?:le\s+)?report\s+(?:de\s+)?(?:l['’ ]audience|la\s+vente|l['’ ]adjudication)\b",
            re.IGNORECASE,
        ),
    ),
    (
        "surenchere_filed",
        0.85,
        re.compile(
            r"\bdéclare\s+recevable[^.;\n]{0,100}?\bsurench[eè]re\b",
            re.IGNORECASE,
        ),
    ),
    (
        "reiteration_requested",
        0.85,
        re.compile(
            r"\bordonne\s+(?:la\s+)?r[ée]it[ée]ration\s+des\s+ench[eè]res\b",
            re.IGNORECASE,
        ),
    ),
)
_INCOMPATIBLE_TERMINAL_EVENTS = frozenset(
    {"adjudication_pronounced", "held_no_bid", "postponed"}
)


@dataclass(frozen=True)
class JudilibreEvidenceAnchor:
    source_pointer: str
    start_utf8: int
    end_utf8: int
    raw_artifact_sha256: str
    evidence_sha256: str
    hash_version: str = JUDILIBRE_EVIDENCE_HASH_VERSION

    def as_dict(self) -> dict[str, object]:
        return {
            "source_pointer": self.source_pointer,
            "start_utf8": self.start_utf8,
            "end_utf8": self.end_utf8,
            "raw_artifact_sha256": self.raw_artifact_sha256,
            "evidence_sha256": self.evidence_sha256,
            "hash_version": self.hash_version,
        }


@dataclass(frozen=True)
class JudilibreCandidateClaim:
    claim_id: str
    claim_type: ClaimType
    normalized_value: str
    confidence: float
    evidence_hash: str
    currency: str | None = None

    def as_dict(self) -> dict[str, object]:
        value: dict[str, object] = {
            "claim_id": self.claim_id,
            "claim_type": self.claim_type,
            "normalized_value": self.normalized_value,
            "confidence": self.confidence,
            "evidence_hash": self.evidence_hash,
        }
        if self.currency is not None:
            value["currency"] = self.currency
        return value


@dataclass(frozen=True)
class JudilibreExtractionResult:
    claims: tuple[JudilibreCandidateClaim, ...]
    anchors: tuple[JudilibreEvidenceAnchor, ...]
    ambiguous_claim_types: tuple[str, ...] = ()
    text_available: bool = True

    @property
    def status(self) -> str:
        if not self.text_available:
            return "not_extracted_missing_text"
        if self.claims:
            return "candidate_facts_extracted"
        if self.ambiguous_claim_types:
            return "ambiguous_candidates_only"
        return "no_candidate_facts"

    def normalized_fields(self) -> dict[str, object]:
        return {
            "extraction_status": self.status,
            "extraction_rule_version": JUDILIBRE_CLAIM_SCHEMA_VERSION,
            "claims": [claim.as_dict() for claim in self.claims],
            "ambiguous_claim_types": list(self.ambiguous_claim_types),
            "text_available": self.text_available,
        }

    def field_provenance(self) -> dict[str, object]:
        return {
            "hash_version": JUDILIBRE_EVIDENCE_HASH_VERSION,
            "claims": {
                claim.claim_id: anchor.as_dict()
                for claim, anchor in zip(self.claims, self.anchors, strict=True)
            },
        }


@dataclass(frozen=True)
class _Candidate:
    claim_type: ClaimType
    normalized_value: str
    confidence: float
    start_char: int
    end_char: int
    currency: str | None = None


def extract_judilibre_candidate_facts(decision: JudilibreDecision) -> JudilibreExtractionResult:
    """Extract review-only sale facts without projecting any judicial prose."""

    text = decision.text or ""
    if not text.strip():
        return JudilibreExtractionResult(claims=(), anchors=(), text_available=False)

    raw_artifact_sha256 = decision.canonical_sha256()
    candidates: list[_Candidate] = []
    candidates.extend(_amount_candidates(text, claim_type="starting_price_eur"))

    for dispositive_offset, dispositive in _dispositive_scopes(decision):
        candidates.extend(
            _amount_candidates(
                dispositive,
                claim_type="hammer_price_eur",
                offset=dispositive_offset,
            )
        )
        candidates.extend(_procedural_candidates(dispositive, offset=dispositive_offset))

    selected, ambiguous = _select_candidates(candidates)
    claims: list[JudilibreCandidateClaim] = []
    anchors: list[JudilibreEvidenceAnchor] = []
    for candidate in selected:
        anchor = _evidence_anchor(
            text=text,
            start_char=candidate.start_char,
            end_char=candidate.end_char,
            raw_artifact_sha256=raw_artifact_sha256,
        )
        claim_id = canonical_sha256(
            {
                "schema_version": JUDILIBRE_CLAIM_SCHEMA_VERSION,
                "claim_type": candidate.claim_type,
                "normalized_value": candidate.normalized_value,
                "currency": candidate.currency,
                "evidence_hash": anchor.evidence_sha256,
            }
        )
        claims.append(
            JudilibreCandidateClaim(
                claim_id=claim_id,
                claim_type=candidate.claim_type,
                normalized_value=candidate.normalized_value,
                confidence=candidate.confidence,
                evidence_hash=anchor.evidence_sha256,
                currency=candidate.currency,
            )
        )
        anchors.append(anchor)
    return JudilibreExtractionResult(
        claims=tuple(claims),
        anchors=tuple(anchors),
        ambiguous_claim_types=tuple(sorted(ambiguous)),
    )


def parse_french_money(value: str) -> Decimal | None:
    compact = re.sub(r"[\s\u00a0\u202f]", "", value.strip())
    if not compact:
        return None
    if re.fullmatch(r"\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?", compact):
        compact = compact.replace(".", "").replace(",", ".")
    elif "," in compact and "." in compact:
        compact = compact.replace(".", "").replace(",", ".")
    elif "," in compact:
        compact = compact.replace(",", ".")
    try:
        amount = Decimal(compact).quantize(Decimal("0.01"))
    except (InvalidOperation, ValueError):
        return None
    if amount <= 0 or amount > Decimal("1000000000"):
        return None
    return amount


def _amount_candidates(
    text: str,
    *,
    claim_type: Literal["starting_price_eur", "hammer_price_eur"],
    offset: int = 0,
) -> list[_Candidate]:
    patterns = _STARTING_PRICE_PATTERNS if claim_type == "starting_price_eur" else _HAMMER_PRICE_PATTERNS
    reject = _STARTING_PRICE_REJECT if claim_type == "starting_price_eur" else _HAMMER_PRICE_REJECT
    confidence = 0.75 if claim_type == "starting_price_eur" else 0.85
    candidates: list[_Candidate] = []
    for pattern in patterns:
        for match in pattern.finditer(text):
            if reject.search(match.group("context") or ""):
                continue
            surrounding = _sentence_containing(text, start=match.start(), end=match.end())
            if (
                _NON_ACTUAL_CONTEXT_REJECT.search(surrounding)
                or _NEGATED_CONTEXT_REJECT.search(surrounding)
                or _ATTRIBUTED_OR_REQUESTED_CONTEXT_REJECT.search(surrounding)
            ):
                continue
            if claim_type == "starting_price_eur" and _has_chained_starting_adjustment(
                surrounding
            ):
                return []
            if claim_type == "starting_price_eur" and _STARTING_SURROUNDING_REJECT.search(surrounding):
                continue
            if claim_type == "hammer_price_eur" and _HAMMER_SURROUNDING_REJECT.search(
                surrounding
            ):
                continue
            amount = parse_french_money(match.group("amount"))
            if amount is None:
                continue
            candidates.append(
                _Candidate(
                    claim_type=claim_type,
                    normalized_value=f"{amount:.2f}",
                    confidence=confidence,
                    start_char=offset + match.start(),
                    end_char=offset + match.end(),
                    currency="EUR",
                )
            )
    return candidates


def _procedural_candidates(text: str, *, offset: int) -> list[_Candidate]:
    candidates: list[_Candidate] = []
    for value, confidence, pattern in _PROCEDURAL_PATTERNS:
        for match in pattern.finditer(text):
            surrounding = _sentence_containing(text, start=match.start(), end=match.end())
            if (
                _NON_ACTUAL_CONTEXT_REJECT.search(surrounding)
                or _NEGATED_CONTEXT_REJECT.search(surrounding)
                or _ATTRIBUTED_OR_REQUESTED_CONTEXT_REJECT.search(surrounding)
                or _PROCEDURAL_SURROUNDING_REJECT.search(surrounding)
            ):
                continue
            if value == "adjudication_pronounced" and _HAMMER_SURROUNDING_REJECT.search(surrounding):
                continue
            candidates.append(
                _Candidate(
                    claim_type="procedural_event",
                    normalized_value=value,
                    confidence=confidence,
                    start_char=offset + match.start(),
                    end_char=offset + match.end(),
                )
            )
    return candidates


def _has_chained_starting_adjustment(sentence: str) -> bool:
    if not _STARTING_TRANSITION_SIGNAL.search(sentence):
        return False
    amounts = list(_MONEY_VALUE_PATTERN.finditer(sentence))
    if len(amounts) <= 1:
        return False
    return len(amounts) != 2 or _SINGLE_STARTING_TRANSITION.search(sentence) is None


def _sentence_containing(text: str, *, start: int, end: int) -> str:
    """Return only the sentence/clause containing a regex match.

    Keeping rejection checks inside these boundaries avoids letting an adjacent
    costs or debt ruling suppress an otherwise explicit adjudication outcome.
    """

    left = start
    while left > 0 and text[left - 1] not in ".;\n":
        left -= 1
    right = end
    while right < len(text) and text[right] not in ".;\n":
        right += 1
    return text[left:right]


def _select_candidates(candidates: list[_Candidate]) -> tuple[list[_Candidate], set[str]]:
    selected: list[_Candidate] = []
    ambiguous: set[str] = set()
    for claim_type in ("starting_price_eur", "hammer_price_eur"):
        typed = [candidate for candidate in candidates if candidate.claim_type == claim_type]
        values = {candidate.normalized_value for candidate in typed}
        if len(values) > 1:
            ambiguous.add(claim_type)
            continue
        if typed:
            selected.append(sorted(typed, key=lambda item: (-item.confidence, item.start_char))[0])

    procedural_values = {
        candidate.normalized_value
        for candidate in candidates
        if candidate.claim_type == "procedural_event"
    }
    if len(procedural_values & _INCOMPATIBLE_TERMINAL_EVENTS) > 1:
        ambiguous.add("procedural_event")
        return selected, ambiguous

    procedural: dict[str, _Candidate] = {}
    for candidate in candidates:
        if candidate.claim_type != "procedural_event":
            continue
        current = procedural.get(candidate.normalized_value)
        if current is None or (-candidate.confidence, candidate.start_char) < (
            -current.confidence,
            current.start_char,
        ):
            procedural[candidate.normalized_value] = candidate
    selected.extend(procedural.values())
    selected.sort(key=lambda item: (item.start_char, item.claim_type, item.normalized_value))
    return selected, ambiguous


def _dispositive_scopes(decision: JudilibreDecision) -> list[tuple[int, str]]:
    text = decision.text or ""
    raw_fragments = decision.zones.get("dispositif") if isinstance(decision.zones, dict) else None
    if raw_fragments is not None:
        if not isinstance(raw_fragments, list):
            return []
        fragments: list[tuple[int, str]] = []
        for fragment in raw_fragments:
            if not isinstance(fragment, dict):
                return []
            start = fragment.get("start")
            end = fragment.get("end")
            if (
                not isinstance(start, int)
                or isinstance(start, bool)
                or not isinstance(end, int)
                or isinstance(end, bool)
                or not 0 <= start < end <= len(text)
            ):
                return []
            fragments.append((start, text[start:end]))
        fragments.sort(key=lambda item: item[0])
        return fragments

    markers = list(_DISPOSITIVE_MARKER.finditer(text))
    if not markers:
        return []
    start = markers[-1].start()
    return [(start, text[start:])]


def _evidence_anchor(
    *,
    text: str,
    start_char: int,
    end_char: int,
    raw_artifact_sha256: str,
) -> JudilibreEvidenceAnchor:
    start_utf8 = len(text[:start_char].encode("utf-8"))
    end_utf8 = len(text[:end_char].encode("utf-8"))
    exact_span = text[start_char:end_char]
    evidence_sha256 = canonical_sha256(
        {
            "domain": "immojudis.judilibre.evidence",
            "hash_version": JUDILIBRE_EVIDENCE_HASH_VERSION,
            "raw_artifact_sha256": raw_artifact_sha256,
            "source_pointer": "/text",
            "start_utf8": start_utf8,
            "end_utf8": end_utf8,
            "exact_span": exact_span,
        }
    )
    return JudilibreEvidenceAnchor(
        source_pointer="/text",
        start_utf8=start_utf8,
        end_utf8=end_utf8,
        raw_artifact_sha256=raw_artifact_sha256,
        evidence_sha256=evidence_sha256,
    )
