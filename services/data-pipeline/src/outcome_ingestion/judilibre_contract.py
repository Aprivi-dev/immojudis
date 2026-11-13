"""Contrat d'une décision Judilibre enregistrée : ce que l'ingestion écrit, et que le dépôt et le rapprochement relisent.

``judilibre_ingestion`` et ``judilibre_extraction`` écrivent ces valeurs ; ``repository`` et ``retention`` les
exigent dans leurs requêtes (en paramètres), ``judilibre_matching`` et ``judilibre_match_contract`` les vérifient.
Une valeur qui change ici change pour tous. Module feuille : le dépôt ne peut pas lire l'ingestion, qui l'importe.
"""

from __future__ import annotations

from typing import Literal, get_args

JUDILIBRE_SOURCE_NAME = "judilibre"
# Nature de la ligne (``record_kind``) et type déclaré dans sa projection (``record_type``) : la même valeur.
JUDILIBRE_RECORD_KIND = "judicial_decision_candidate"
JUDILIBRE_EXTRACTOR_NAME = "judilibre_candidate_extraction"
JUDILIBRE_EXTRACTOR_VERSION = "3"
JUDILIBRE_NORMALIZED_SCHEMA = "judilibre_decision_candidate_v3"
JUDILIBRE_EVIDENCE_HASH_VERSION = "judilibre-evidence-sha256-v1"
# Version des règles d'extraction des allégations : écrite dans la projection (``extraction_rule_version``) et
# dans l'empreinte de chaque allégation (``claim_id``).
JUDILIBRE_CLAIM_SCHEMA_VERSION = "judilibre_candidate_claims_v1"
# État de revue d'une décision candidate : grade de preuve C, revue humaine en attente. Tout autre état est refusé.
JUDILIBRE_CANDIDATE_GRADE = "C"
JUDILIBRE_REVIEW_STATUS = "pending"
# Types d'allégation : le type des allégations de l'extraction, et les listes qu'exigent les requêtes du dépôt, le
# rapprochement et le validateur des signaux, qui en dérivent. Une allégation de montant porte la devise ``EUR``.
JudilibreMoneyClaimType = Literal["starting_price_eur", "hammer_price_eur"]
JudilibreClaimType = Literal[JudilibreMoneyClaimType, "procedural_event"]
JUDILIBRE_MONEY_CLAIM_TYPES: tuple[JudilibreMoneyClaimType, ...] = get_args(JudilibreMoneyClaimType)
JUDILIBRE_CLAIM_TYPES: tuple[JudilibreClaimType, ...] = get_args(JudilibreClaimType)
# Valeurs d'une allégation ``procedural_event`` : celles des motifs de l'extraction, que le rapprochement exige.
JudilibreProceduralEvent = Literal[
    "adjudication_pronounced", "held_no_bid", "postponed", "surenchere_filed", "reiteration_requested"
]
JUDILIBRE_PROCEDURAL_EVENTS: tuple[JudilibreProceduralEvent, ...] = get_args(JudilibreProceduralEvent)
# Seul état d'extraction que le dépôt et le rapprochement acceptent : des allégations extraites.
JUDILIBRE_CLAIMS_EXTRACTED_STATUS = "candidate_facts_extracted"
# Le texte de la décision reste dans le stockage privé des pièces brutes, jamais dans la projection.
JUDILIBRE_TEXT_STORAGE = "private_raw_artifact"

# Clés de la projection minimisée v3, et aucune autre : ni texte de la décision, ni identité de personne.
JUDILIBRE_V3_SAFE_PROJECTION_KEYS = (
    "schema_version",
    "record_type",
    "judilibre_id",
    "jurisdiction",
    "location",
    "chamber",
    "formation",
    "number",
    "numbers",
    "ecli",
    "nac",
    "decision_date",
    "update_date",
    "decision_type",
    "solution",
    "solution_alt",
    "publication",
    "themes",
    "partial",
    "to_be_deleted",
    "raw_representation_sha256",
    "candidate_grade",
    "review_status",
    "training_eligible",
    "text_storage",
    "personal_identity_features_allowed",
    "extraction_status",
    "extraction_rule_version",
    "claims",
    "ambiguous_claim_types",
    "text_available",
)
