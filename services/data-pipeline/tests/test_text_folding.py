"""Sorties figées des replis de texte (accents, casse, ponctuation) du pipeline.

Chaque module garde sa règle de repli (accents seuls, passage en ASCII, ponctuation remplacée…) et
s'appuie sur ``src/text_folding.py``. L'instantané ``fixtures/text_folding_outputs.json`` a été
calculé avec les copies d'origine, avant leur regroupement : il prouve qu'aucune sortie n'a changé.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Callable
from pathlib import Path
from types import SimpleNamespace

import httpx

from src import (
    cadastre_references,
    catalogue_readiness,
    comparison,
    court_competence,
    dedupe,
    department_names,
    display_invalidation,
    extraction_profiles,
    fact_claims,
    justice_activity_pipeline,
    listing_location,
    lot_scope,
    occupancy_statements,
    pdf_address,
    pdf_document_types,
    personal_data,
    position_quality,
    real_extraction_review,
    text_fact_scope,
    text_folding,
    tribunal,
    tribunal_labels,
    urban_planning,
)
from src.enrichment import display_facts, surface_text_rules
from src.official_sources import encheres_publiques_open_data, justice_activity, justice_open_data
from src.outcome_ingestion import dvf_adjudication
from src.reference_data import names
from src.sources import (
    agrasc_extraction,
    cessions_etat_labels,
    licitor_extraction,
    licitor_history,
    listing_characteristics,
    notaires,
    petites_affiches_extraction,
    professional_contact,
)

SNAPSHOT = Path(__file__).parent / "fixtures" / "text_folding_outputs.json"

INPUTS: tuple[str, ...] = (
    "",
    "   ",
    "Élodie Côté",
    "ÉCOLE ÂGÉE À L'ÎLE",
    "été décomposé",
    "cœur Œuvre sœur",
    "Lætitia ÆSOP",
    "l’immeuble d'en face",
    "L‘arbre ‘cité’ ʼokina",
    "`accent grave´ aigu",
    "VAL-D’OISE",
    "Saint-Étienne",
    "St-Étienne",
    "ST ETIENNE",
    "ste foy-lès-lyon",
    "Tribunal judiciaire — Aix–en–Provence",
    "a‐b‑c‒d−e",
    "Prix : 120 000 €.",
    "  : Libellé - .",
    "N° 12, rue de l'Église (bis), FRANCE Cedex 9",
    "numero 4 bd St Michel",
    "  plusieurs   espaces\t\net insécables ici  ",
    "« guillemets » …",
    "Москва Ελλάδα 東京",
    "Straße STRASSE ẞ",
    "ﬁnance ²³ № ½ ㎡",
    "İstanbul ı",
    "Ñandú Ça ÿ",
    "Ø ø ł Đ đ",
    "ǅ ǈ",
    "x١٢٣ 🏠 maison",
    "le(s) propriétaire(s) occupé(e)s",
    "Cessions-État",
    "DOMAINES",
    "Vente Notariale – reste 3 jours 4 h",
    "Greffe du Tribunal de Grande Instance de Saint-Denis",
    "TJ d'Évry-Courcouronnes",
    "Numéro de page demandé (3) supérieur au nombre de pages",
    "a" * 30 + " passage répété de 120 m²",
    "\x1c contrôle\x1f",
)


def _real_review_city_classes() -> list[list[bool]]:
    """``folded_city`` est local à ``_ai_values_equal`` : on fige l'égalité qu'il décide entre entrées."""
    return [[real_extraction_review._ai_values_equal("city", left, right) for right in INPUTS] for left in INPUTS]


def _state_sale(value: str) -> bool:
    sale = SimpleNamespace(source_name=value, primary_source=None, sale_venue_type=None, sale_legal_framework=None)
    return catalogue_readiness._is_state_sale(sale)  # type: ignore[arg-type]


def _page_out_of_range(value: str) -> bool:
    request = httpx.Request("GET", "https://example.invalid/")
    response = httpx.Response(400, text=value, request=request)
    return notaires._is_page_out_of_range_error(httpx.HTTPStatusError("400", request=request, response=response), 2)


FOLDS: dict[str, Callable[[str], object]] = {
    "extraction_profiles._fold": extraction_profiles._fold,
    "listing_location._fold": listing_location._fold,
    "lot_scope._commune_key": lot_scope._commune_key,
    "tribunal_labels._fold": tribunal_labels._fold,
    "position_quality._fold": position_quality._fold,
    "cadastre_references._fold_city": cadastre_references._fold_city,
    "dedupe._normalize_street_text": dedupe._normalize_street_text,
    "comparison._fingerprint_text": comparison._fingerprint_text,
    "fact_claims._normalize_key": fact_claims._normalize_key,
    "court_competence._fingerprint": court_competence._fingerprint,
    "department_names.department_slug": department_names.department_slug,
    "display_invalidation.normalize_display_text": display_invalidation.normalize_display_text,
    "catalogue_readiness._is_state_sale": _state_sale,
    "justice_activity_pipeline.normalize_court_name": justice_activity_pipeline.normalize_court_name,
    "enrichment.display_facts._fold": display_facts._fold,
    "enrichment.surface_text_rules.passage_key": lambda text: surface_text_rules.passage_key(text, len(text), 1),
    "urban_planning._normalize_text": urban_planning._normalize_text,
    "occupancy_statements.fold": occupancy_statements.fold,
    "normalize.strip_accents": text_folding.strip_accents,
    "pdf_document_types.normalize_document_classifier_text": pdf_document_types.normalize_document_classifier_text,
    "pdf_address._key": pdf_address._key,
    "tribunal._fingerprint": tribunal._fingerprint,
    "text_fact_scope.fold_aligned": text_fact_scope.fold_aligned,
    "reference_data.names.normalize_commune_name": names.normalize_commune_name,
    "official_sources.justice_open_data._field_token": justice_open_data._field_token,
    "official_sources.justice_open_data._court_fingerprint": justice_open_data._court_fingerprint,
    "official_sources.encheres_publiques_open_data._header_token": encheres_publiques_open_data._header_token,
    "official_sources.justice_activity._normalize_label": justice_activity._normalize_label,
    "outcome_ingestion.dvf_adjudication._normalized_text": dvf_adjudication._normalized_text,
    "sources.professional_contact.fold": professional_contact.fold,
    "sources.licitor_extraction._fold": licitor_extraction._fold,
    "sources.cessions_etat_labels.fold": cessions_etat_labels.fold,
    "sources.listing_characteristics.fold": listing_characteristics.fold,
    "sources.petites_affiches_extraction.fold": petites_affiches_extraction.fold,
    "sources.agrasc_extraction.fold": agrasc_extraction.fold,
    "sources.licitor_history._fragment": licitor_history._fragment,
    "sources.notaires._is_page_out_of_range_error": _page_out_of_range,
}


def snapshot() -> dict[str, object]:
    first_names = "\n".join(sorted(personal_data._first_name_form_set()))
    return {
        "inputs": list(INPUTS),
        "folds": {label: [fold(value) for value in INPUTS] for label, fold in FOLDS.items()},
        "real_extraction_review.folded_city": _real_review_city_classes(),
        "personal_data._first_name_form_set": hashlib.sha256(first_names.encode()).hexdigest(),
    }


def test_every_fold_keeps_its_frozen_outputs() -> None:
    expected = json.loads(SNAPSHOT.read_text(encoding="utf-8"))
    actual = json.loads(json.dumps(snapshot(), ensure_ascii=False))

    assert actual["inputs"] == expected["inputs"]
    for label in expected["folds"]:
        assert actual["folds"][label] == expected["folds"][label], label
    assert actual["folds"].keys() == expected["folds"].keys()
    assert actual["real_extraction_review.folded_city"] == expected["real_extraction_review.folded_city"]
    assert actual["personal_data._first_name_form_set"] == expected["personal_data._first_name_form_set"]
