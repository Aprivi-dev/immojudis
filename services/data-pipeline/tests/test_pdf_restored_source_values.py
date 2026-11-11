"""Valeur remise depuis l'instantané de la source quand une projection des pièces est effacée (lot R6, correctif A).

L'instantané ``source_factual_snapshot`` garde la valeur brute de la page, avant normalisation. Remise telle quelle
à chaque relecture complète, elle a produit le 11/11/2026 deux violations de ``auction_sales_occupancy_status_check``
(« libre », cessions_etat) et deux erreurs « '>' not supported between 'str' and 'int' » (« 85,5 »,
encheres_immobilieres).

La valeur de l'instantané est remise comme la collecte la lit (``normalize_sale``), sans seconde règle : un type
de bien hors liste, un prix écrit « 45.000 » ou un nombre de pièces écrit « T3 » suivent le même chemin. La ligne
de base d'une trace, elle, est une valeur de la vente déjà typée et sérialisée.
"""

from __future__ import annotations

from decimal import Decimal

import pytest

from src.models import AuctionSale
from src.normalize import OCCUPANCY_ENUM
from src.pdf_enrichment import enrich_sale_from_pdf_text
from src.pdf_fact_scope import _clear_pdf_fact_projections, _pdf_record_fact_projection

DOCUMENT_URL = "https://example.test/restored/cahier.pdf"
# Valeurs admises par la contrainte CHECK de auction_sales.property_type (migration 20260520202829).
PROPERTY_TYPES = {"apartment", "house", "building", "land", "commercial", "parking", "mixed", "other", "unknown"}


def _sale(source: str, snapshot: dict[str, object], **fields: object) -> AuctionSale:
    sale = AuctionSale(source_name=source, source_url=f"https://example.test/restored/{source}", **fields)
    sale.raw_payload["source_factual_snapshot"] = snapshot
    return sale


def _restore(sale: AuctionSale, field: str) -> object:
    """Efface la projection des pièces de ``field`` : la valeur de la source est remise à sa place."""
    _pdf_record_fact_projection(sale, [field], evidence="pièce", document_url=DOCUMENT_URL)
    assert _clear_pdf_fact_projections(sale)["cleared"] == {field}
    return getattr(sale, field)


def test_a_raw_occupancy_label_of_the_source_is_restored_as_a_status_of_the_list() -> None:
    sale = _sale("cessions_etat", {"occupancy_status": "libre"}, occupancy_status="unknown")

    restored = _restore(sale, "occupancy_status")

    assert restored == "vacant"
    assert restored in OCCUPANCY_ENUM  # auction_sales_occupancy_status_check


@pytest.mark.parametrize(
    ("label", "expected"),
    [("Libre de toute occupation", "vacant"), ("Occupé par le propriétaire", "owner_occupied"), ("vacant", "vacant")],
)
def test_other_source_occupancy_labels_are_read_like_a_collection_reads_them(label: str, expected: str) -> None:
    sale = _sale("cessions_etat", {"occupancy_status": label}, occupancy_status="unknown")

    assert _restore(sale, "occupancy_status") == expected


def test_an_occupancy_label_that_reads_as_nothing_is_restored_empty() -> None:
    sale = _sale("cessions_etat", {"occupancy_status": "voir le dossier"}, occupancy_status="occupied")

    assert _restore(sale, "occupancy_status") is None


def test_the_legacy_candidate_path_normalizes_the_restored_occupancy_too() -> None:
    # Lignes écrites avant la trace par champ : une seule liste de candidats, pas de « pdf_fact_provenance ».
    sale = _sale("cessions_etat", {"occupancy_status": "libre"}, occupancy_status="occupied")
    sale.raw_payload["pdf_occupancy_candidates"] = [{"value": "occupied"}]

    assert _clear_pdf_fact_projections(sale)["cleared"] == {"occupancy_status"}

    assert sale.occupancy_status == "vacant"


def test_a_surface_written_with_a_decimal_comma_is_restored_as_a_decimal() -> None:
    sale = _sale("encheres_immobilieres", {"surface_m2": "85,5"}, surface_m2=Decimal("86.20"))

    restored = _restore(sale, "surface_m2")

    assert restored == Decimal("85.5")
    assert isinstance(restored, Decimal)
    assert restored > 0  # la comparaison qui levait « '>' not supported between 'str' and 'int' »


@pytest.mark.parametrize(
    ("field", "raw", "expected"),
    [
        ("surface_m2", "85,5 m²", Decimal("85.5")),
        ("habitable_surface_m2", "42,10", Decimal("42.10")),
        ("land_surface_m2", "1 250 m²", Decimal("1250")),
        ("starting_price_eur", "125 000 €", Decimal("125000")),
        ("surface_m2", "86.20", Decimal("86.20")),
        ("starting_price_eur", 50000, Decimal("50000")),
        # Le point sépare les milliers sur une page (Vench) : ``Decimal`` lisait 45 euros et 1,25 m².
        ("starting_price_eur", "45.000", Decimal("45000")),
        ("land_surface_m2", "1.250", Decimal("1250")),
    ],
)
def test_decimal_fields_are_restored_with_the_parser_of_their_kind(field: str, raw: object, expected: Decimal) -> None:
    sale = _sale("encheres_immobilieres", {field: raw}, **{field: Decimal("999999")})

    restored = _restore(sale, field)

    assert restored == expected
    assert isinstance(restored, Decimal)


@pytest.mark.parametrize(
    ("field", "raw"),
    [
        ("surface_m2", "non communiquée"),
        ("starting_price_eur", "prix sur demande"),
        # Sous 100 euros ce n'est pas un prix (parse_price) : vide, pas la chaîne, quelle que soit l'écriture.
        ("starting_price_eur", "85,5"),
        ("starting_price_eur", "85.5"),
    ],
)
def test_an_unreadable_decimal_is_restored_empty_never_as_a_string(field: str, raw: str) -> None:
    sale = _sale("encheres_immobilieres", {field: raw}, **{field: Decimal("999999")})

    assert _restore(sale, field) is None


@pytest.mark.parametrize(
    ("label", "expected"),
    [("Lot 12", "other"), ("Appartement 3 pièces à Lyon", "apartment"), ("Maison", "house")],
)
def test_a_raw_property_type_of_the_source_is_restored_as_a_type_of_the_list(label: str, expected: str) -> None:
    # Même panne que « libre » : le libellé brut remis tel quel sort de la contrainte CHECK de property_type.
    sale = _sale("agrasc", {"property_type": label}, property_type="commercial")

    restored = _restore(sale, "property_type")

    assert restored == expected
    assert restored in PROPERTY_TYPES


@pytest.mark.parametrize(
    ("field", "raw", "expected"),
    [("rooms_count", "3 pièces", 3), ("rooms_count", "T3", 3), ("rooms_count", "4.0", 4), ("bedrooms_count", "2", 2)],
)
def test_a_count_written_as_text_is_restored_as_an_integer(field: str, raw: str, expected: int) -> None:
    sale = _sale("avoventes", {field: raw}, **{field: 9})

    restored = _restore(sale, field)

    assert restored == expected
    assert type(restored) is int


def test_the_legacy_candidate_path_reads_a_count_like_the_collection_too() -> None:
    sale = _sale("avoventes", {"rooms_count": "3 pièces"}, rooms_count=4)
    sale.raw_payload["pdf_rooms_candidates"] = [{"value": 4}]

    assert _clear_pdf_fact_projections(sale)["cleared"] == {"rooms_count"}

    assert sale.rooms_count == 3


def test_a_field_left_empty_by_the_snapshot_is_read_in_the_page_text_as_a_collection_does() -> None:
    # La collecte lit la surface dans le texte de l'annonce quand le champ structuré est vide : c'est la valeur
    # de la source avant toute pièce, donc celle à remettre (et non « vide » jusqu'à la collecte suivante).
    snapshot = {"surface_m2": None, "raw_text": "Maison de 4 pièces de 92 m2, vendue aux enchères."}
    sale = _sale("avoventes", snapshot, surface_m2=Decimal("95.40"))

    assert _restore(sale, "surface_m2") == Decimal("92")


def test_reading_the_snapshot_leaves_it_untouched() -> None:
    snapshot = {"sale_date": "12/03/2099", "occupancy_status": "libre"}
    sale = _sale("cessions_etat", snapshot, occupancy_status="occupied")

    _restore(sale, "occupancy_status")

    # ``normalize_sale`` écrit dans son entrée (« documents », « date_precision ») : elle reçoit une copie.
    assert sale.raw_payload["source_factual_snapshot"] == {"sale_date": "12/03/2099", "occupancy_status": "libre"}


def test_a_trace_baseline_is_restored_as_the_serialized_value_it_is() -> None:
    # Sans valeur dans l'instantané, la ligne de base de la trace est remise : un décimal sérialisé, pas un
    # texte de page. « 45000.00 » y vaut 45 000, et n'est pas relu comme un nombre à séparateur de milliers.
    sale = _sale("avoventes", {}, starting_price_eur=Decimal("52000"), rooms_count=5)
    _pdf_record_fact_projection(
        sale, ["starting_price_eur"], evidence="pièce", document_url=DOCUMENT_URL, baseline=Decimal("45000.00")
    )
    _pdf_record_fact_projection(sale, ["rooms_count"], evidence="pièce", document_url=DOCUMENT_URL, baseline=3)

    assert _clear_pdf_fact_projections(sale)["cleared"] == {"starting_price_eur", "rooms_count"}

    assert sale.starting_price_eur == Decimal("45000.00")
    assert sale.rooms_count == 3


def test_an_unreadable_trace_baseline_is_restored_empty() -> None:
    sale = _sale("avoventes", {}, starting_price_eur=Decimal("52000"), rooms_count=5)
    _pdf_record_fact_projection(
        sale, ["starting_price_eur"], evidence="pièce", document_url=DOCUMENT_URL, baseline="prix sur demande"
    )
    _pdf_record_fact_projection(sale, ["rooms_count"], evidence="pièce", document_url=DOCUMENT_URL, baseline="T3")

    _clear_pdf_fact_projections(sale)

    assert sale.starting_price_eur is None
    assert sale.rooms_count is None


def test_a_complete_reread_leaves_normalized_source_values_on_the_sale() -> None:
    # Le chemin de production : chaque relecture complète efface d'abord les projections des pièces
    # (enrich_sale_from_pdf_text), donc remet la valeur de la source avant de relire.
    sale = _sale(
        "cessions_etat",
        {"occupancy_status": "libre", "surface_m2": "85,5", "property_type": "Lot 12", "rooms_count": "3 pièces"},
        occupancy_status="occupied",
        surface_m2=Decimal("90"),
        property_type="house",
        rooms_count=5,
        documents=[{"label": "Cahier des charges", "url": DOCUMENT_URL}],
    )
    _pdf_record_fact_projection(
        sale,
        ["occupancy_status", "surface_m2", "property_type", "rooms_count"],
        evidence="ancienne lecture",
        document_url=DOCUMENT_URL,
    )
    reread = {
        "url": DOCUMENT_URL,
        "text": "Cahier des charges de la cession. Les offres sont remises sous pli cacheté.",
        "complete": True,
        "extraction_status": "extracted",
    }

    enrich_sale_from_pdf_text(sale, [reread])

    assert sale.occupancy_status == "vacant"
    assert sale.surface_m2 == Decimal("85.5")
    stored = sale.to_storage_dict(exclude_none=False)  # la ligne écrite en base
    assert stored["occupancy_status"] in OCCUPANCY_ENUM
    assert stored["surface_m2"] == 85.5
    assert stored["property_type"] in PROPERTY_TYPES
    assert stored["rooms_count"] == 3
