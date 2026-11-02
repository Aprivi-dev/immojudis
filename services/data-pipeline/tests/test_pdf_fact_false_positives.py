"""Faits tirés des pièces jointes : extraits réels qui donnaient des valeurs fausses (02/11/2026)."""

import src.pdf_enrichment  # noqa: F401  (resolves the pdf_enrichment / pdf_fact_extraction import cycle)
from src.models import AuctionSale
from src.normalize import has_rented_occupancy_signal, normalize_occupancy_status
from src.pdf_fact_extraction import _extract_occupancy_status, enrich_sale_from_pdf_text
from src.pdf_fact_scope import _extract_rooms_count_candidates

CAHIER = "https://example.test/2_Condition_de_vente_-_Cahier_des_charges.pdf"
DIAG = "https://example.test/3_Diagnostic_reglementaire.pdf"


def _rooms(text: str) -> list[int]:
    return [int(item["value"]) for item in _extract_rooms_count_candidates(text)]


def test_technical_codes_of_diagnostics_are_not_room_counts() -> None:
    assert _rooms("Fenêtre intérieure (F1) PVC Non mesurée - NM Absence de revêtement") == []
    assert _rooms("Servitudes aéronautiques de dégagement (civile) (T5) SCHEMA DE COHERENCE") == []
    assert _rooms("PD1 + T1 Côte (m NGF) +330.9 Formations (lithologie)") == []
    assert _rooms("protection « Espace Naturel » au plan F2 du patrimoine bâti") == []
    assert _rooms("[ay] 3 = g => 6 5 1 a 2 3 = pose ve=e = F 7 - 3Q18) SINeUaXe aayAl") == []
    # A numbered heading of the asbestos survey form.
    assert _rooms("l'amiante : hors programme de repérage 14 Pièces ou locaux visités 15 Locaux") == []


def test_dwelling_types_and_stated_room_counts_are_still_read() -> None:
    assert _rooms("Pavillon individuel - T3 Habitation") == [3]
    assert _rooms("Appartement T4 au deuxième étage") == [4]
    assert _rooms("Logement de type F2 avec balcon") == [2]
    assert _rooms("Nombre de pièces principales : 3 Types de pièces principales") == [3]


def test_a_sale_gets_no_room_count_from_unlocated_codes() -> None:
    sale = AuctionSale(source_name="cessions_etat", source_url="https://example.test/bordeaux", title="Immeuble")
    enrich_sale_from_pdf_text(
        sale,
        [
            {"url": DIAG, "text": "Fenêtre intérieure (F1) PVC. Servitude T5. Huisserie F2 bois.", "document_type": "pdf"},
        ],
    )
    assert sale.rooms_count is None


def test_french_tenant_compte_is_not_a_tenant() -> None:
    scoring = (
        "la commission procédera à un classement tenant compte des critères suivants : Prix proposé noté sur 10"
    )
    assert has_rented_occupancy_signal(scoring) is False
    assert _extract_occupancy_status(scoring) is None
    # The English label still means a rented property.
    assert normalize_occupancy_status("Tenant") == "rented"
    assert has_rented_occupancy_signal("locataire en place") is True


def test_a_state_sale_ceded_free_is_vacant() -> None:
    assert _extract_occupancy_status("Le bien est cédé libre et dans l'état dans lequel il sera au jour de la vente") == "vacant"
    assert _extract_occupancy_status("L'immeuble a été libéré il y a environ 3 ans et est actuellement vide de toute occupation") == "vacant"
