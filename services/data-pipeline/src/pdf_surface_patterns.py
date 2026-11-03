"""Motifs de surface (bâtie et terrain) lus dans le texte d'un document joint.

Extrait de ``pdf_fact_extraction`` (plafond de taille des fichiers) ; ce module en ré-exporte les
fonctions.
"""

from __future__ import annotations

import re
from decimal import Decimal

from src.enrichment.surface_text_rules import room_measurement_before, value_is_ground_area
from src.land_parcels import EXCLUSIVE_USE_BASIS, read_parcel_land_surface
from src.normalize import SURFACE_VALUE_PATTERN, clean_text, parse_surface
from src.pdf_enrichment import _normalize_document_classifier_text


def _extract_surface(text: str) -> Decimal | None:
    result = _extract_surface_with_evidence(text)
    return result["value"] if result else None

def _extract_surface_with_evidence(text: str) -> dict[str, Decimal | str] | None:
    candidates = _extract_surface_candidates_with_evidence(text)
    return candidates[0] if candidates else None

def _extract_surface_candidates_with_evidence(text: str) -> list[dict[str, Decimal | str]]:
    patterns = (
        rf"(?:surface|superficie)\s+de\s+r[ée]f[ée]rence\s*:?\s*(?:de\s+)?{SURFACE_VALUE_PATTERN}\s*m\s*(?:2|²)",
        rf"surface\s+(?:privative\s+)?(?:loi\s+)?carrez(?:\s+totale)?\s*:?\s*(?:de\s+)?(?:environ\s+)?{SURFACE_VALUE_PATTERN}\s*m\s*(?:2|²)",
        rf"(?:surface\s*(?:habitable|privative|utile|totale|carrez)?|superficie(?:\s+(?:carrez|habitable|privative))?)\s*:?\s*(?:de\s+)?(?:environ\s+)?{SURFACE_VALUE_PATTERN}\s*m\s*(?:2|²)",
        rf"(?:surface\s+(?:habitable|privative|utile|totale|carrez)?|superficie(?:\s+carrez)?).{{0,80}}?\b(?:soit|est\s+de|de)\s+{SURFACE_VALUE_PATTERN}\s*m\s*(?:2|²)",
        rf"(?:mesurage\s+(?:loi\s+)?carrez|loi\s+carrez|surface\s+(?:privative\s+)?(?:loi\s+)?carrez|superficie\s+(?:privative\s+)?(?:loi\s+)?carrez)\s*:?\s*(?:de\s+)?(?:environ\s+)?{SURFACE_VALUE_PATTERN}\s*m\s*(?:2|²)",
        rf"\b(?:appartement|maison|villa|logement|immeuble)\b[^.;:\n]{{0,30}}?(?:d['’]une\s+surface\s+de|de|d['’]environ|environ)\s+{SURFACE_VALUE_PATTERN}\s*m\s*(?:2|²)",
        rf"\b(?:d['’]\s*)?environ\s+{SURFACE_VALUE_PATTERN}\s*m\s*(?:2|²)\b",
        rf"(?:surface|superficie)\s+(?:de\s+la|du|de\s+l['’])\s*(?:maison|appartement|logement|villa|habitation)\s*:?\s*(?:de\s+)?{SURFACE_VALUE_PATTERN}\s*m\s*(?:2|²)",
        rf"{SURFACE_VALUE_PATTERN}\s*m\s*(?:2|²|\*)\s+(?:habitables?|de\s+surface|loi\s+carrez)",
        rf"\btotal\s*:?\s*{SURFACE_VALUE_PATTERN}\s*m\s*(?:2|²|\*)",
        rf"superficie\s*approximative\s*habitable\s*totale\s*:?\s*{SURFACE_VALUE_PATTERN}\s*m\s*(?:2|²|\?)",
    )
    candidates: list[dict[str, Decimal | str]] = []
    seen: set[tuple[Decimal, str]] = set()
    for pattern in patterns:
        for match in re.finditer(pattern, text, re.I | re.S):
            if _is_surface_false_positive(text, match.start(), match.end()):
                continue
            matched = text[match.start() : match.end()]
            # « 158,82 m² de surface au sol totale », « (77,56 m² surface au sol) » : ni habitable ni Carrez ;
            # « CHAMBRE ANGLE NORD-EST Surface: 10,5m2 » : la surface d'une pièce.
            if value_is_ground_area(text[match.end(1) :]) or room_measurement_before(text, match.start(), matched):
                continue
            if _PERMIT_SURFACE_RE.search(text[max(0, match.start(1) - 90) : match.start(1)]):
                # « Permis de construire … en vue de transformer un garage en surface habitable …, créant une surface
                # de plancher de 77.63 m2 » (2f7dc9f0) : surface d'un projet, pas celle du bien.
                continue
            value = parse_surface(match.group(1))
            if value is None:
                continue
            evidence = clean_text(text[max(0, match.start() - 120) : min(len(text), match.end() + 160)]) or ""
            key = (value, _normalize_document_classifier_text(evidence))
            if key in seen:
                continue
            seen.add(key)
            candidates.append({"value": value, "evidence": evidence, "match_text": clean_text(matched) or ""})
    return candidates

_PERMIT_SURFACE_RE = re.compile(
    r"permis\s+de\s+construire|d[ée]claration\s+pr[ée]alable|surface\s+de\s+plancher|\bcr[ée]ant\b|\bà\s+cr[ée]er\b"
    r"|\bsurfaces?\s+cr[ée]{1,2}e?s?\b",
    re.I,
)


def _extract_land_surface_with_evidence(text: str) -> dict[str, Decimal | str] | None:
    candidates = _extract_land_surface_candidates_with_evidence(text)
    return candidates[0] if candidates else None

def _extract_land_surface_candidates_with_evidence(text: str) -> list[dict[str, Decimal | str]]:
    m2_patterns = (
        rf"\b(?:surface|superficie)\s+(?:du\s+|de\s+la\s+)?(?:terrain|parcelle|jardin|cadastrale)\s*:?\s*(?:de\s+)?{SURFACE_VALUE_PATTERN}\s*m\s*(?:2|²)\b",
        rf"\b(?:terrain|parcelles?|jardin)\b.{{0,140}}?\b(?:surface|superficie|contenance)\b.{{0,60}}?{SURFACE_VALUE_PATTERN}\s*m\s*(?:2|²)\b",
        rf"\bcontenance(?:\s+(?:totale|cadastrale))?\b.{{0,100}}?{SURFACE_VALUE_PATTERN}\s*m\s*(?:2|²)\b",
        rf"\b{SURFACE_VALUE_PATTERN}\s*m\s*(?:2|²)\b.{{0,80}}\b(?:de\s+terrain|terrain|parcelles?|jardin)\b",
    )
    candidates: list[dict[str, Decimal | str]] = []
    seen: set[tuple[Decimal, str]] = set()
    for pattern in m2_patterns:
        for match in re.finditer(pattern, text, re.I | re.S):
            if not _has_land_surface_context(text, match.start(), match.end()):
                continue
            if _land_surface_match_is_built(text, match) or _land_match_crosses_another_measure(match):
                continue
            value = parse_surface(match.group(1))
            if value is None:
                continue
            evidence = clean_text(text[max(0, match.start() - 120) : min(len(text), match.end() + 160)]) or ""
            key = (value, _normalize_document_classifier_text(evidence))
            if key in seen:
                continue
            seen.add(key)
            candidates.append({"value": value, "evidence": evidence})

    # Contenances cadastrales (ha / a / ca) : total écrit, liste complète additionnée, sinon rien ; jamais la
    # première parcelle d'une liste ni la contenance de la résidence d'un lot de copropriété.
    parcels = read_parcel_land_surface(text)
    if parcels is not None and parcels.basis == "coproperty_lot_land_is_the_building_plot":
        return []
    if parcels is not None and parcels.basis == EXCLUSIVE_USE_BASIS:
        # Lotissement : la parcelle en jouissance exclusive (« de 3 ares environ ») est le terrain du bien.
        return candidates + [
            item
            for item in _ranked_unit_candidates(text)
            if (item["value"], _normalize_document_classifier_text(str(item["evidence"]))) not in seen
        ]
    if parcels is not None and parcels.value is not None:
        evidence = clean_text(parcels.evidence) or ""
        key = (parcels.value, _normalize_document_classifier_text(evidence))
        if key not in seen:
            seen.add(key)
            candidates.append({"value": parcels.value, "evidence": evidence})
    return candidates

def _ranked_unit_candidates(text: str) -> list[dict[str, Decimal | str]]:
    """Contenances en ares classées par leur contexte (parcelle, jouissance exclusive avant les lignes du cadastre)."""
    unit_patterns = (
        r"\b(?P<ha>\d{1,5})\s*(?:ha|hectares?)\s*(?:(?P<a>\d{1,5})\s*(?:a|ares?))?\s*(?:(?P<ca>\d{1,2})\s*(?:ca|centiares?))?\b",
        r"\b(?P<a>\d{1,5})\s*(?:a|ares?)\s*(?:(?P<ca>\d{1,2})\s*(?:ca|centiares?))?\b",
    )
    ranked: list[tuple[int, dict[str, Decimal | str]]] = []
    for pattern in unit_patterns:
        for match in re.finditer(pattern, text, re.I):
            if not _has_land_surface_context(text, match.start(), match.end()):
                continue
            value = _cadastral_units_to_square_meters(match)
            if value is None:
                continue
            evidence = clean_text(text[max(0, match.start() - 120) : min(len(text), match.end() + 160)]) or ""
            item: dict[str, Decimal | str] = {
                "value": value, "evidence": evidence, "key": _normalize_document_classifier_text(evidence),
            }
            ranked.append((_land_unit_candidate_rank(text, match.start(), match.end()), item))
    ranked.sort(key=lambda entry: entry[0], reverse=True)
    if not ranked or (len(ranked) > 1 and ranked[0][0] < 40):
        return []
    unique: dict[tuple[Decimal | str, Decimal | str], dict[str, Decimal | str]] = {}
    for _, item in ranked:
        unique.setdefault((item["value"], item["key"]), item)
    return [{"value": item["value"], "evidence": item["evidence"]} for item in unique.values()]


def _land_surface_match_is_built(text: str, match: re.Match[str]) -> bool:
    """Le qualificatif le plus proche avant la valeur décide : « Jardin derrière. Le tout représente une
    surface bâtie de 259,86 m² » est une surface bâtie, pas un terrain."""
    value_start = match.start(1)
    before_value = text[max(0, value_start - 100) : value_start]
    built = list(
        re.finditer(
            r"\b(?:habitable|carrez|privative|utile|b[âa]tie|surface\s+de\s+r[ée]f[ée]rence)\b",
            before_value,
            re.I,
        )
    )
    if not built:
        return False
    land = list(re.finditer(r"\b(?:terrain|parcelle|jardin|cadastrale)\b", before_value, re.I))
    return not land or built[-1].start() > land[-1].start()


_OTHER_MEASURE_RE = re.compile(
    r"\d\s*(?:m\s*(?:2|²)|centiares?|ares?|ca|ha)(?![a-zà-ÿ])"
    r"|\b(?:buanderie|cuisine|s[ée]jour|chambres?|salon|wc|garage|cave|entr[ée]e|salle|[ée]tage|compos[ée]e?|comprenant)\b",
    re.I,
)


def _land_match_crosses_another_measure(match: re.Match[str]) -> bool:
    """« contenance de 25 centiares, composée : - Rez de chaussée : buanderie (17,63m²) » : la pièce n'est pas
    le terrain."""
    whole = match.group(0)
    value_start, value_end = match.start(1) - match.start(), match.end(1) - match.start()
    unit_end = re.match(r"\s*m\s*(?:2|²)", whole[value_end:])
    outside = whole[:value_start] + " " + whole[value_end + (unit_end.end() if unit_end else 0) :]
    return bool(_OTHER_MEASURE_RE.search(outside))

def _land_unit_candidate_rank(text: str, start: int, end: int) -> int:
    before = _normalize_document_classifier_text(text[max(0, start - 120) : start])
    after = _normalize_document_classifier_text(text[end : min(len(text), end + 100)])
    context = f"{before} {after}"
    rank = 0
    if re.search(r"\b(?:parcelle|terrain|jardin)\b", before[-90:]):
        rank += 60
    if re.search(r"\b(?:parcelle|terrain|jardin)\b", after[:70]):
        rank += 40
    if re.search(r"\b(?:contenance|total|totale)\b", context):
        rank += 45
    if re.search(r"\bjouissance\s+(?:exclusive|privative)\b", before):
        rank += 20
    if re.search(r"\b(?:section|cadastre|cadastree|tableau)\b", context):
        rank -= 15
    return rank

def _cadastral_units_to_square_meters(match: re.Match[str]) -> Decimal | None:
    groups = match.groupdict()
    hectares = int(groups.get("ha") or 0)
    ares = int(groups.get("a") or 0)
    centiares = int(groups.get("ca") or 0)
    total = hectares * 10000 + ares * 100 + centiares
    return Decimal(total) if total > 0 else None

def _has_land_surface_context(text: str, start: int, end: int) -> bool:
    context = _normalize_document_classifier_text(text[max(0, start - 180) : min(len(text), end + 180)])
    return bool(
        re.search(
            r"\b(?:terrain|parcelles?|cadastr(?:e|ee|al|ale)|contenance|surface\s+cadastrale|superficie\s+cadastrale|jardin)\b",
            context,
        )
    )

def _is_land_surface_evidence(evidence: str) -> bool:
    text = _normalize_document_classifier_text(evidence)
    if re.search(
        r"\b(?:habitable|habitables|carrez|loi\s+carrez|surface\s+privative|surface\s+de\s+reference|batie|bati)\b",
        text,
    ):
        return False
    return bool(
        re.search(
            r"\b(?:surface|superficie)\s+(?:du\s+|de\s+la\s+)?(?:terrain|parcelle|jardin|cadastrale)\b|"
            r"\b(?:terrain|parcelles?|jardin)\b.{0,100}\b(?:surface|superficie|contenance)\b|"
            r"\bcontenance(?:\s+(?:totale|cadastrale))?\b.{0,100}\b(?:m\s*(?:2|²)|ha|ares?|centiares?)\b",
            text,
        )
    )

def _is_surface_false_positive(text: str, start: int, end: int) -> bool:
    context = text[max(0, start - 160) : min(len(text), end + 60)]
    matched = text[start:end]
    if re.search(r"\b(?:habitable|carrez|privative|surface\s+de\s+r[ée]f[ée]rence)\b", matched, re.I):
        return False
    if re.search(r"\b(?:appartement|maison|villa|logement|immeuble)\b", matched, re.I):
        return False
    if re.search(r"\b(?:surface|superficie)\s+de\s+r[ée]f[ée]rence\b", context, re.I):
        return False
    # Energy figures often appear in the same diagnostic page as the asset
    # surface.  Only reject a surface when the energy marker is local to the
    # matched measurement; a distant DPE annex must not erase it.
    energy_context = text[max(0, start - 40) : min(len(text), end + 40)]
    if re.search(r"\bkwh\b|kg\s*co2|\bges\b|performance\s+[ée]nerg[ée]tique", energy_context, re.I):
        return True
    prefix = text[max(0, start - 120) : start]
    return bool(
        re.search(
            r"\b(?:mur|paroi|plafond|toiture|fa[çc]ade|isolant|isolation|plancher|baie|fen[eê]tre|porte|garage|cave|parking)\b",
            prefix,
            re.I,
        )
    )

def _surface_measurement_scope(text: str, evidence: str) -> str:
    context = _normalize_document_classifier_text(f"{evidence} {text}")
    if re.search(
        r"\b(?:mesurage|calcul\s+de\s+superficie).{0,80}\b(?:incomplet|partiel|pas\s+pu|n(?:'|’)ont\s+pu)\b|"
        r"\bn(?:'|’)ont\s+pu\s+[eê]tre\s+r[ée]alis[ée]s?\s+dans\s+leur\s+int[ée]gralit[ée]\b|"
        r"\bpi[eè]ces?\s+(?:non\s+)?(?:mesur[ée]es?|accessibles?)\b",
        context,
    ):
        return "partial"
    evidence_text = _normalize_document_classifier_text(evidence)
    if "carrez" in evidence_text and len(re.findall(r"\bencombrement\s+trop\s+important\b", context)) >= 2:
        return "partial"
    return "total"

