"""Version des règles qui tirent les faits des pièces jointes (``raw_payload.document_facts_version``).

Module feuille : la lecture des pièces, leur sélection, l'extraction des faits et les files qui décident d'une
relecture la comparent sans dépendre les unes des autres.
"""

# Deterministic PDF facts include page/document candidates and multi-lot
# decisions; bump this marker when projection semantics change.
# v5 (03/11/2026) : règles de l'audit qualité (surfaces, pièces, occupation, dates et prix des appels d'offres,
# tribunal) ; toutes les ventes à pièces sont relues avec elles.
DOCUMENT_FACTS_VERSION = "document_facts_v5_quality_audit"
