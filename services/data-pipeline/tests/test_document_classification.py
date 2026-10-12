from __future__ import annotations

import pytest

from src.pdf_document_types import (
    classify_document_content,
    classify_document_type,
    document_type_with_content,
    with_content_document_types,
)

CESSIONS = "https://cessions.immobilier-etat.gouv.fr/sites/default/files/"
LICITOR = "https://www.licitor.com/annonce/10/91/47/vente-aux-encheres/un-appartement/paris/109147.html"

# Labels seen in production on 12/10/2026, all stored as "Document PDF" or as
# the wrong family before.
PRODUCTION_LABELS = [
    (
        "8_Certificat_durbanisme_240550005.pdf PDF – 353.47 Ko",
        CESSIONS + "8_Certificat_durbanisme_240550005.pdf",
        "cadastre",
    ),
    ("5_Zone_UD_du_PLU_de_BonnieressurSeine_220780010.pdf PDF – 1.2 Mo", None, "cadastre"),
    ("CERTIFICAT URBANISME.pdf", None, "cadastre"),
    ("Extrait cadastral.pdf", None, "cadastre"),
    ("ADDITIF CU 300626.pdf", None, "cadastre"),
    ("13_Attestation_de_surfaces_240340008.pdf PDF – 302.09 Ko", None, "diagnostics_techniques"),
    ("24R1690 Mesurage (2024).pdf", None, "diagnostics_techniques"),
    ("2026-06-29---2025289 Certificat Carrez.pdf", None, "diagnostics_techniques"),
    ("DDT_-_.pdf", None, "diagnostics_techniques"),
    ("Dossier technique immobilier.pdf", None, "diagnostics_techniques"),
    ("DIAGS bat sur rue - boutique DIAGS SCI LA STEPHANIE.pdf", None, "diagnostics_techniques"),
    ("carte argiles.pdf", None, "diagnostics_techniques"),
    ("DIRE ADDITIF_1.pdf", None, "cahier_conditions_vente"),
    ("20260803 DIRE OCCUPATION.pdf", None, "cahier_conditions_vente"),
    ("MODALITES DE VENTE - AGORASTORE", None, "conditions_vente"),
    ("6_Modele_doffre_candidat_250460000.pdf PDF – 72.33 Ko", None, "conditions_vente"),
    ("18_Clause_d_interessementdeprix_230280005.pdf PDF – 58.29 Ko", None, "conditions_vente"),
    ("Texte complet", "https://encheresimmobilieres.fr/documents/9415/texte_complet.pdf", "annonce_vente"),
    ("PUB SIMPLE VENTE 06.11.2026.pdf", None, "annonce_vente"),
    ("6_reglement_de_copropriete_250380014.pdf PDF – 1.13 Mo", None, "copropriete"),
    ("• Renseignements du Syndic", "https://www.info-encheres.com/upload/hnJksyndicok.pdf", "copropriete"),
    ("Etat daté.pdf", None, "copropriete"),
    ("Titre de propriété.pdf", None, "titre_propriete"),
    ("• Actes de la procédure", "https://www.info-encheres.com/upload/NOGRprocedure.pdf", "procedure_saisie"),
]


@pytest.mark.parametrize(("label", "url", "expected"), PRODUCTION_LABELS)
def test_file_names_with_underscores_and_abbreviations_are_recognised(
    label: str, url: str | None, expected: str
) -> None:
    assert classify_document_type(label, url) == expected


def test_minutes_of_a_general_meeting_are_not_a_pv_descriptif() -> None:
    assert classify_document_type("PV AG 2024.pdf") == "copropriete"
    assert classify_document_type("21_PV_AGS____29_11_2023___signe_140130012.pdf") == "copropriete"
    assert classify_document_type("22_PV_de_la_copropriete35du03052023AG60V2D_140130012.pdf") == "copropriete"
    # A real procès-verbal descriptif keeps its family.
    assert classify_document_type("20250417_PV DE DESCRIPTION_SI 25 01 1280_271709.pdf") == "pv_huissier"
    assert classify_document_type("PV descriptif lot de copropriété.pdf") == "pv_huissier"
    assert classify_document_type("PVD et dossier technique immobilier") == "pv_huissier"
    assert classify_document_type("Descriptif et urbanisme - Revel (maison)") == "pv_huissier"


def test_short_abbreviations_are_trusted_in_the_label_only() -> None:
    assert classify_document_type("Titre de propriété", LICITOR) == "titre_propriete"
    assert classify_document_type("Pièce", "https://example.test/pub/ddt/cu/dire/file.pdf") == "pdf"


CCV_PAGE = (
    "TRIBUNAL JUDICIAIRE DE NICE. CAHIER DES CONDITIONS DE VENTE. Saisie immobilière. "
    "Vente aux enchères publiques à l'audience du juge de l'exécution. Diagnostic de performance énergétique annexé."
)
NOTICE_PAGE = (
    "HAUTECOEUR - DUCRAY - SELARL D'AVOCATS. VENTE AUX ENCHERES PUBLIQUES - EN UN SEUL LOT. "
    "Le cahier des conditions de vente peut être consulté au greffe. Mise à prix : 400 000 €"
)


def test_the_earliest_title_of_the_first_page_gives_the_type() -> None:
    assert classify_document_content(CCV_PAGE) == "cahier_conditions_vente"
    assert classify_document_content(NOTICE_PAGE) == "annonce_vente"
    assert classify_document_content("DOSSIER DE DIAGNOSTIC TECHNIQUE. Vente. Appartement.") == "diagnostics_techniques"
    assert classify_document_content("Procès-verbal descriptif. Commissaire de justice.") == "pv_huissier"
    assert classify_document_content("RÉPUBLIQUE FRANÇAISE. Certificat d'urbanisme d'information.") == "cadastre"
    assert classify_document_content("Lettre de transmission sans titre.") is None
    assert classify_document_content(None) is None


def test_a_generic_document_is_typed_from_its_text_but_a_named_one_keeps_its_label() -> None:
    generic = {
        "label": "Document",
        "url": "https://avoventes.fr/public/uploads/cabinet/54/documents/6aba60b1ebe04ttt.pdf",
        "type": "pdf",
        "document_type": "pdf",
        # A scanned cover page with a few words only: the next page is read too.
        "pages": [{"page": 1, "text": "©AVOVENTES.FR"}, {"page": 2, "text": CCV_PAGE + " " * 200}],
    }
    named = {
        "label": "PV descriptif.pdf",
        "url": "https://example.test/pv.pdf",
        "type": "pdf",
        "pages": [{"page": 1, "text": CCV_PAGE}],
    }

    with_content_document_types([generic, named, "legacy text"])  # type: ignore[list-item]

    assert generic["document_type"] == "cahier_conditions_vente"
    assert named["document_type"] == "pv_huissier"
    assert document_type_with_content("Document", generic["url"], generic) == "cahier_conditions_vente"
    assert document_type_with_content("Document", generic["url"], {}) == "pdf"


def test_a_type_given_by_the_source_is_kept() -> None:
    operator = {"label": "Annexe 3", "url": "https://example.test/a3.pdf", "type": "pdf", "document_type": "bail"}

    with_content_document_types([operator])

    assert operator["document_type"] == "bail"
