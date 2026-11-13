"""Contrat d'une décision Judilibre enregistrée : ce que l'ingestion écrit, et que le dépôt et le rapprochement relisent.

``judilibre_ingestion`` et ``judilibre_extraction`` écrivent ces valeurs ; ``repository`` les exige dans ses requêtes
et ``judilibre_matching`` les vérifie. Une version qui change ici change pour tous. Module feuille : le dépôt ne
peut pas lire l'ingestion, qui l'importe.
"""

from __future__ import annotations

JUDILIBRE_SOURCE_NAME = "judilibre"
# Nature de la ligne (``record_kind``) et type déclaré dans sa projection (``record_type``) : la même valeur.
JUDILIBRE_RECORD_KIND = "judicial_decision_candidate"
JUDILIBRE_EXTRACTOR_NAME = "judilibre_candidate_extraction"
JUDILIBRE_EXTRACTOR_VERSION = "3"
JUDILIBRE_NORMALIZED_SCHEMA = "judilibre_decision_candidate_v3"
JUDILIBRE_EVIDENCE_HASH_VERSION = "judilibre-evidence-sha256-v1"

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
