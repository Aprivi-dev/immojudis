from __future__ import annotations

import json
from decimal import Decimal
from typing import Any

from src.asset_normalization import (
    AXIS_DEFINITIONS,
    PREMIUM_ANALYSIS_VERSION,
    ScoreComponent,
)
from src.asset_normalization_helpers import (
    _axis_reading,
    _classify_document_label,
    _compact_dict,
    _component_axis,
    _diagnostic_question_detail,
    _document_context_label,
    _factor_status,
    _float_or_none,
    _format_decimal,
    _format_eur,
    _json_safe,
    _occupancy_status_label,
    _risk_next_action,
    _risk_to_evidence_ref,
    _sale_type_context,
)
from src.config import ROOT_DIR
from src.models import AuctionSale


def _build_premium_investment_analysis(
    sale: AuctionSale,
    risks: list[dict[str, Any]],
    components: list[ScoreComponent],
    factor_rows: list[dict[str, Any]],
) -> dict[str, Any]:
    facts = _investment_facts(sale, risks)
    contradictions = _analysis_contradictions(sale)
    axes = _axis_summaries(factor_rows, risks, contradictions, sale)
    questions = _investment_questions(sale, risks, contradictions)
    headline = _premium_headline(sale, risks, contradictions)
    evidence_trace = _evidence_trace(sale, risks, factor_rows)
    return _compact_dict(
        {
            "version": PREMIUM_ANALYSIS_VERSION,
            "headline": headline,
            "deal_memo": _deal_memo_payload(sale, risks, contradictions, axes),
            "facts": facts,
            "axes": axes,
            "contradictions": contradictions,
            "questions": questions,
            "evidence_trace": evidence_trace,
            "confidence_gates": _confidence_gates(sale, risks, evidence_trace),
            "analysis_contract": {
                "principle": "Chaque conclusion doit être reliée à un fait, une source et un niveau de confiance.",
                "document_hierarchy": [
                    "diagnostics_techniques",
                    "pv_huissier",
                    "pv_notaire",
                    "cahier_conditions_vente",
                    "annonce_vente",
                    "source_listing",
                ],
                "llm_role": "analyste de contexte et de contradictions, pas source OCR unique",
                "llm_use": [
                    "relire les pages scannées utiles",
                    "classer les faits confirmés/infirmés/incertains",
                    "expliquer le raisonnement avec citation document + page",
                    "signaler les contradictions plutôt que trancher sans preuve",
                ],
            },
            "score_confidence": _float_or_none(sale.score_confidence),
            "score_components": len(components),
        }
    )


def _deal_memo_payload(
    sale: AuctionSale,
    risks: list[dict[str, Any]],
    contradictions: list[dict[str, Any]],
    axes: list[dict[str, Any]],
) -> dict[str, Any]:
    blockers = []
    if not sale.documents:
        blockers.append("Documents officiels absents ou non exploitables.")
    if not sale.occupancy_status or sale.occupancy_status == "unknown":
        blockers.append("Occupation à confirmer avant de calculer le scénario de sortie.")
    blockers.extend(
        f"{risk.get('risk_label')} à vérifier : {_risk_next_action(str(risk.get('risk_label') or ''))}"
        for risk in risks[:3]
    )
    strengths = []
    if sale.starting_price_eur is not None:
        strengths.append(f"Mise à prix connue : {_format_eur(sale.starting_price_eur)}.")
    if sale.app_surface_m2 is not None:
        strengths.append(f"Surface exploitable retenue : {_format_decimal(sale.app_surface_m2)} m2.")
    if sale.city:
        strengths.append(f"Localisation analysable : {sale.city}.")
    if not strengths:
        strengths.append("Aucun atout structurant n'est encore confirmé par les données.")
    price_ceiling_inputs = [
        "mise à prix",
        "frais d'adjudication",
        "travaux et diagnostics",
        "délai d'occupation",
        "marge de sécurité",
    ]
    return {
        "summary": _premium_headline(sale, risks, contradictions),
        "why_consider": strengths[:4],
        "why_be_careful": blockers[:5] or ["Aucun blocage majeur détecté, sous réserve de relire les pièces."],
        "before_bidding": _deal_memo_actions(sale, risks, contradictions),
        "price_ceiling_inputs": price_ceiling_inputs,
        "axis_snapshot": [
            {
                "axis": axis.get("axis"),
                "label": axis.get("label"),
                "status": axis.get("status"),
                "delta": axis.get("delta"),
                "reading": axis.get("reading"),
            }
            for axis in axes[:4]
        ],
    }


def _deal_memo_actions(
    sale: AuctionSale,
    risks: list[dict[str, Any]],
    contradictions: list[dict[str, Any]],
) -> list[str]:
    actions = [
        "Définir un prix plafond tout compris avant l'audience.",
        "Relire les pièces officielles qui justifient les alertes.",
    ]
    if not sale.documents:
        actions.insert(0, "Récupérer le PV descriptif, le cahier de vente et les diagnostics.")
    if not sale.occupancy_status or sale.occupancy_status == "unknown":
        actions.append("Confirmer le statut d'occupation et le délai de jouissance.")
    if any(str(risk.get("risk_label")) == "travaux" for risk in risks):
        actions.append("Chiffrer un budget travaux avant de calculer la marge.")
    if any(str(risk.get("risk_label")) in {"amiante", "plomb", "termites", "DPE"} for risk in risks):
        actions.append("Lire le diagnostic technique concerné et distinguer obligation, information et coût réel.")
    if contradictions:
        actions.append("Lever les contradictions entre annonce, PV, cahier de vente et diagnostics.")
    return actions[:7]


def _evidence_trace(
    sale: AuctionSale,
    risks: list[dict[str, Any]],
    factor_rows: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    trace: list[dict[str, Any]] = []
    if sale.surface_evidence:
        trace.append(
            {
                "kind": "surface",
                "status": "confirmed" if (sale.surface_confidence or Decimal("0")) >= Decimal("0.7") else "uncertain",
                "claim": f"Surface retenue : {_format_decimal(sale.app_surface_m2)} m2."
                if sale.app_surface_m2
                else "Surface à confirmer.",
                "evidence": sale.surface_evidence,
                "confidence": _float_or_none(sale.surface_confidence),
                "decision": "Utilisée pour le prix au mètre carré si la nature de surface est compatible avec le bien.",
            }
        )
    for risk in risks[:8]:
        evidence_json = risk.get("evidence_json") if isinstance(risk.get("evidence_json"), dict) else {}
        trace.append(
            _compact_dict(
                {
                    "kind": "risk",
                    "status": evidence_json.get("risk_status") or "confirmed",
                    "claim": f"Risque retenu : {risk.get('risk_label')}.",
                    "evidence": risk.get("evidence"),
                    "document_label": evidence_json.get("document_label"),
                    "document_type": evidence_json.get("document_type"),
                    "page_number": evidence_json.get("page_number"),
                    "confidence": risk.get("confidence"),
                    "decision": evidence_json.get("reasoning"),
                    "next_action": evidence_json.get("next_action")
                    or _risk_next_action(str(risk.get("risk_label") or "")),
                }
            )
        )
    for row in factor_rows:
        refs = row.get("evidence_refs")
        if not isinstance(refs, list) or not refs:
            continue
        trace.append(
            _compact_dict(
                {
                    "kind": "score_factor",
                    "status": row.get("normalized_value", {}).get("status")
                    if isinstance(row.get("normalized_value"), dict)
                    else None,
                    "claim": f"{row.get('factor_key')} : {row.get('reason')}",
                    "confidence": row.get("confidence"),
                    "decision": row.get("normalized_value", {}).get("decision")
                    if isinstance(row.get("normalized_value"), dict)
                    else None,
                    "evidence_refs": refs[:2],
                }
            )
        )
    return [_compact_dict(_json_safe(item)) for item in trace[:16]]


def _confidence_gates(
    sale: AuctionSale,
    risks: list[dict[str, Any]],
    evidence_trace: list[dict[str, Any]],
) -> dict[str, Any]:
    documents_count = len(sale.documents or [])
    sourced_risks = sum(1 for risk in risks if risk.get("evidence"))
    weak_points = []
    if documents_count == 0:
        weak_points.append("documents_absents")
        weak_points.append("analyse_source_uniquement")
    if sale.app_surface_m2 is None:
        weak_points.append("surface_absente")
    if not sale.occupancy_status or sale.occupancy_status == "unknown":
        weak_points.append("occupation_inconnue")
    if not evidence_trace:
        weak_points.append("preuves_absentes")
    readiness = "prêt à analyser"
    if weak_points:
        readiness = "pré-tri uniquement" if len(weak_points) >= 2 else "analyse à confirmer"
    return {
        "readiness": readiness,
        "documents_count": documents_count,
        "sourced_risks": sourced_risks,
        "evidence_items": len(evidence_trace),
        "weak_points": weak_points,
    }


def _investment_facts(sale: AuctionSale, risks: list[dict[str, Any]]) -> list[dict[str, Any]]:
    facts: list[dict[str, Any]] = []
    sale_context = _sale_type_context(sale)
    if sale_context:
        facts.append(
            _fact(
                "legal",
                "type_de_vente",
                "confirmé" if sale_context.get("status") else "à confirmer",
                str(sale_context.get("statement") or "Type de vente à confirmer."),
                evidence=str(sale_context.get("evidence") or "") or None,
                confidence=float(sale_context.get("confidence") or 0.55),
            )
        )
    if sale.starting_price_eur is not None:
        facts.append(
            _fact(
                "financial",
                "mise_a_prix",
                "confirmé",
                f"Mise à prix : {_format_eur(sale.starting_price_eur)}.",
                confidence=0.88,
            )
        )
    if sale.app_surface_m2 is not None:
        facts.append(
            _fact(
                "asset",
                "surface_exploitable",
                "confirmé" if (sale.surface_confidence or Decimal("0")) >= Decimal("0.7") else "incertain",
                f"Surface retenue : {_format_decimal(sale.app_surface_m2)} m2 ({sale.app_surface_kind or 'nature à confirmer'}).",
                evidence=sale.surface_evidence,
                confidence=float(sale.surface_confidence or Decimal("0.55")),
            )
        )
    else:
        facts.append(
            _fact(
                "asset",
                "surface_exploitable",
                "absent",
                "Aucune surface exploitable fiable n'est retenue pour le calcul.",
                confidence=0.35,
            )
        )
    if sale.occupancy_status:
        facts.append(
            _fact(
                "legal",
                "occupation",
                "incertain" if sale.occupancy_status == "unknown" else "confirmé",
                f"Occupation : {_occupancy_status_label(sale.occupancy_status)}.",
                confidence=0.55 if sale.occupancy_status == "unknown" else 0.82,
            )
        )
    if sale.city or sale.department:
        facts.append(
            _fact(
                "liquidity",
                "localisation",
                "confirmé",
                "Localisation : " + ", ".join(filter(None, [sale.city, sale.department])) + ".",
                confidence=0.75 if sale.latitude is not None and sale.longitude is not None else 0.55,
            )
        )
    document_facts = _document_facts(sale)
    facts.extend(document_facts)
    for risk in risks[:6]:
        facts.append(
            _fact(
                "risk",
                f"risque_{risk.get('risk_label')}",
                "confirmé" if float(risk.get("confidence") or 0) >= 0.8 else "probable",
                f"Risque retenu : {risk.get('risk_label')}.",
                evidence=str(risk.get("evidence") or "") or None,
                confidence=float(risk.get("confidence") or 0.7),
                evidence_refs=[_risk_to_evidence_ref(risk)],
            )
        )
    return [_compact_dict(_json_safe(item)) for item in facts]


def _document_facts(sale: AuctionSale) -> list[dict[str, Any]]:
    if not sale.documents:
        return [
            _fact(
                "evidence",
                "documents",
                "absent",
                "Aucun document source n'est disponible dans le dossier structuré.",
                confidence=0.25,
            )
        ]
    type_counts: dict[str, int] = {}
    for document in sale.documents:
        document_type = _classify_document_label(str(document.get("label") or ""), str(document.get("url") or ""))
        type_counts[document_type] = type_counts.get(document_type, 0) + 1
    labels = ", ".join(f"{_document_context_label(key)} ({count})" for key, count in sorted(type_counts.items()))
    return [
        _fact(
            "evidence",
            "documents",
            "confirmé",
            f"Documents disponibles : {labels}.",
            confidence=0.72,
        )
    ]


def _axis_summaries(
    factor_rows: list[dict[str, Any]],
    risks: list[dict[str, Any]],
    contradictions: list[dict[str, Any]],
    sale: AuctionSale,
) -> list[dict[str, Any]]:
    summaries = []
    for axis, definition in AXIS_DEFINITIONS.items():
        rows = [row for row in factor_rows if _component_axis(str(row.get("factor_key") or "")) == axis]
        if not rows:
            continue
        delta = sum((Decimal(str(row.get("delta") or 0)) for row in rows), Decimal("0"))
        refs = []
        for row in rows:
            evidence_refs = row.get("evidence_refs")
            if isinstance(evidence_refs, list):
                refs.extend(item for item in evidence_refs if isinstance(item, dict))
        summaries.append(
            _compact_dict(
                {
                    "axis": axis,
                    "label": definition["label"],
                    "question": definition["question"],
                    "delta": float(delta),
                    "status": _factor_status(delta),
                    "reading": _axis_reading(axis, delta, risks, contradictions, sale),
                    "top_factors": [
                        {
                            "factor_key": row.get("factor_key"),
                            "reason": row.get("reason"),
                            "delta": row.get("delta"),
                        }
                        for row in sorted(rows, key=lambda item: abs(float(item.get("delta") or 0)), reverse=True)[:3]
                    ],
                    "evidence_refs": [_compact_dict(_json_safe(ref)) for ref in refs[:3]],
                }
            )
        )
    return summaries


def _investment_questions(
    sale: AuctionSale,
    risks: list[dict[str, Any]],
    contradictions: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    return [
        _question(
            "occupation",
            "Qui occupe réellement le bien au jour de l'audience ?",
            "à lever" if not sale.occupancy_status or sale.occupancy_status == "unknown" else "répondu",
            f"Statut actuel : {_occupancy_status_label(sale.occupancy_status)}.",
        ),
        _question(
            "surface",
            "Quelle surface doit servir au prix au m² ?",
            "répondu" if sale.app_surface_m2 is not None else "à lever",
            (
                f"Surface retenue : {_format_decimal(sale.app_surface_m2)} m2."
                if sale.app_surface_m2 is not None
                else "Aucune surface principale fiable."
            ),
        ),
        _question(
            "diagnostics",
            "Les diagnostics créent-ils une obligation, un coût ou seulement une information ?",
            (
                "à vérifier"
                if any(risk.get("risk_label") in {"amiante", "plomb", "termites", "DPE"} for risk in risks)
                else "à récupérer"
                if not sale.documents
                else "sans alerte"
            ),
            _diagnostic_question_detail(sale, risks),
        ),
        _question(
            "travaux",
            "Y a-t-il des travaux réellement rattachés au bien ?",
            (
                "à chiffrer"
                if any(risk.get("risk_label") == "travaux" for risk in risks)
                else "à confirmer"
                if not sale.documents
                else "sans alerte"
            ),
            (
                "Le texte source contient un signal travaux rattaché au bien."
                if any(risk.get("risk_label") == "travaux" for risk in risks)
                else "Les pièces officielles manquent : l'absence de signal travaux ne suffit pas à conclure."
                if not sale.documents
                else "Le moteur retient uniquement les mentions contextualisées, pas les clauses génériques."
            ),
        ),
        _question(
            "contradictions",
            "Des sources se contredisent-elles ?",
            "à lever" if contradictions else "répondu",
            f"{len(contradictions)} contradiction(s) ou incohérence(s) détectée(s)."
            if contradictions
            else "Aucune contradiction structurante détectée.",
        ),
    ]


def _analysis_contradictions(sale: AuctionSale) -> list[dict[str, Any]]:
    contradictions: list[dict[str, Any]] = []
    rules = sale.raw_payload.get("business_rules")
    if isinstance(rules, list):
        for rule in rules:
            if not isinstance(rule, dict):
                continue
            rule_id = str(rule.get("rule_id") or "")
            if rule_id in {"occupation_conflict_requires_confirmation", "property_type_from_specific_asset"}:
                contradictions.append(
                    _compact_dict(
                        {
                            "key": rule_id,
                            "status": "à lever" if "occupation" in rule_id else "résolu",
                            "label": rule.get("decision") or rule_id,
                            "reasoning": rule.get("reasoning"),
                            "impact": rule.get("impact"),
                            "evidence": rule.get("evidence"),
                            "confidence": rule.get("confidence"),
                        }
                    )
                )
    flags = set(sale.quality_flags)
    if "room_count_conflict" in flags:
        contradictions.append(
            {
                "key": "room_count_conflict",
                "status": "résolu_partiellement",
                "label": "Pièces/chambres incohérentes",
                "reasoning": "Le nombre de chambres dépassait le nombre de pièces. Le nombre de pièces a été neutralisé pour éviter un stockage incohérent.",
                "impact": "Le scoring baisse la confiance et demande de relire la composition exacte du bien.",
                "confidence": 0.82,
            }
        )
    if "ambiguous_surface" in flags:
        contradictions.append(
            {
                "key": "ambiguous_surface",
                "status": "à lever",
                "label": "Surface ambiguë",
                "reasoning": "Les surfaces détectées peuvent mélanger surface habitable, annexe, terrain ou surface cadastrale.",
                "impact": "Le prix au m² et la marge de sécurité ne sont pas fiables tant que la surface principale n'est pas confirmée.",
                "evidence": sale.surface_evidence,
                "confidence": float(sale.surface_confidence or Decimal("0.55")),
            }
        )
    return [_compact_dict(_json_safe(item)) for item in contradictions]


def _premium_headline(
    sale: AuctionSale,
    risks: list[dict[str, Any]],
    contradictions: list[dict[str, Any]],
) -> str:
    score = sale.investment_score
    if score is None:
        return "Dossier à structurer avant lecture d'investissement."
    if not sale.documents:
        return "Pré-tri uniquement : pièces officielles absentes, lecture à confirmer."
    if contradictions:
        return "Dossier exploitable, mais des incohérences doivent être levées avant décision."
    if risks and score < Decimal("60"):
        return "Dossier risqué : les alertes documentées peuvent absorber la marge."
    if score >= Decimal("75"):
        return "Dossier potentiellement attractif, sous réserve de confirmer les preuves clés."
    if score >= Decimal("55"):
        return "Dossier intéressant mais dépendant de quelques vérifications structurantes."
    return "Dossier fragile : conserver une marge de sécurité élevée."


def _fact(
    category: str,
    key: str,
    status: str,
    statement: str,
    *,
    evidence: str | None = None,
    confidence: float | None = None,
    evidence_refs: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    return {
        "category": category,
        "key": key,
        "status": status,
        "statement": statement,
        "evidence": evidence,
        "confidence": confidence,
        "evidence_refs": evidence_refs or [],
    }


def _question(key: str, question: str, status: str, answer: str) -> dict[str, str]:
    return {"key": key, "question": question, "status": status, "answer": answer}


def _load_scoring_weights() -> dict[str, int | float | str]:
    path = ROOT_DIR / "config" / "scoring.json"
    defaults: dict[str, int | float | str] = {
        "version": "v1",
        "base_score": 50,
        "occupation": 1,
        "état": 1,
        "type": 1,
        "localisation": 1,
        "surface": 1,
        "prix_m2": 1,
        "atouts": 1,
        "risques": 1,
        "qualité": 1,
    }
    if not path.exists():
        return defaults
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return defaults
    if isinstance(payload, dict):
        defaults.update({key: value for key, value in payload.items() if isinstance(value, (int, float, str))})
    return defaults
