"""Valeur remise depuis l'instantané de la source quand une projection des pièces est effacée (lot R6, correctif A).

Règle vérifiée ici : restaurer ne fait jamais apparaître une valeur que la collecte n'aurait pas écrite pour la
vente. L'instantané ``source_factual_snapshot`` garde la valeur brute de la page ; remise telle quelle, elle a
produit le 11/11/2026 deux violations de ``auction_sales_occupancy_status_check`` (« libre », cessions_etat) et
deux erreurs « '>' not supported between 'str' and 'int' » (« 85,5 », encheres_immobilieres). Relue sans le
contexte de la collecte, elle donnait à un lot Licitor la mise à prix, la surface ou les pièces d'un autre lot.

Les instantanés de ces tests sont posés par le vrai code de la collecte (``known_enrichment.preserve_known_enrichment_payloads``)
sur des ventes brutes : celles des parseurs de chaque source, la fiche Licitor réelle à deux lots et les lignes
Licitor réelles à lots numérotés. La valeur attendue est celle de ``normalize_sale(vente brute)``.
"""

from __future__ import annotations

import copy
import json
import logging
from datetime import UTC, datetime
from decimal import Decimal
from pathlib import Path
from typing import Any

import pytest
import time_machine

from src import known_enrichment, main, pdf_fact_scope
from src.models import AuctionSale
from src.normalize import OCCUPANCY_ENUM, normalize_sale
from src.pdf_enrichment import _invalidate_replaced_document_facts
from src.pdf_fact_extraction import enrich_sale_from_pdf_text
from src.pdf_fact_scope import _clear_pdf_fact_projections, pdf_record_fact_projection
from src.recompute_scoring import _recomputed_sale_from_storage_row
from src.sources import licitor_lots
from src.sources.licitor import parse_licitor_detail_html
from tests.test_licitor_multi_lot_selection import CANNES, CARDS, LE_CANNET
from tests.test_licitor_multi_lot_selection import FIXTURE as TWO_LOT_PAGE
from tests.test_source_parser_matrix import CASES as PARSER_CASES

DOCUMENT_URL = "https://example.test/restored/cahier.pdf"
# Valeurs admises par la contrainte CHECK de auction_sales.property_type (migration 20260520202829).
PROPERTY_TYPES = {"apartment", "house", "building", "land", "commercial", "parking", "mixed", "other", "unknown"}
RESTORABLE = tuple(
    field for field in known_enrichment.KNOWN_SOURCE_FACT_SNAPSHOT_FIELDS if field not in {"source_name", "source_url", "raw_text"}
)
STORED_ROWS = json.loads(
    (Path(__file__).parent / "fixtures" / "licitor_lignes_stockees_lots_numerotes.json").read_text(encoding="utf-8")
)
# Lignes stockées réelles, par page et commune : parcelle de jardin (lot 4), studio (lot 2), dépendances (lot 2
# d'une page dont le lot 1 est une maison de 141,37 m²), parcelles dont le lot est incertain (lot 1 à 6 000 €).
GARDEN, STUDIO, OUTBUILDINGS, UNCERTAIN = "lamarque", "bordeaux", "mazeray", "saint-pargoire"
# Le recalcul des lignes stockées date du 03/11/2026 (tests/test_licitor_multi_lot_recompute_rows.py).
RECOMPUTE_DAY = time_machine.travel(datetime(2026, 11, 3, 13, 10, tzinfo=UTC), tick=False)


def _stored_raw(place: str) -> dict[str, Any]:
    """La vente brute d'une ligne Licitor stockée, relue lot par lot (ce que la collecte publie aujourd'hui)."""
    row = copy.deepcopy(next(item for item in STORED_ROWS["rows"] if f"/{place}/" in item["source_url"]))
    page_text = STORED_ROWS["pages"][row.pop("page")]
    row["raw_text"] = page_text
    row["raw_payload"].update(raw_text=page_text, source_blocks={"page_text": page_text})
    raw = copy.deepcopy(_recomputed_sale_from_storage_row(row).raw_payload)
    raw.pop("source_factual_snapshot", None)
    return raw


def _two_lot_raw(url: str) -> dict[str, Any]:
    cards = [{"title": "Un appartement", "raw_text": CARDS[url]}]
    return parse_licitor_detail_html(TWO_LOT_PAGE.read_text(encoding="utf-8"), url, cards)


LICITOR_LOT_RAWS = {
    "fiche-deux-lots-cannes": lambda: _two_lot_raw(CANNES),
    "fiche-deux-lots-le-cannet": lambda: _two_lot_raw(LE_CANNET),
    **{f"ligne-stockee-{place}": (lambda place=place: _stored_raw(place)) for place in (GARDEN, STUDIO, OUTBUILDINGS, UNCERTAIN)},
}
RAW_SALES = {**{case.name: case.parse for case in PARSER_CASES}, **LICITOR_LOT_RAWS}


def _published(raw: dict[str, Any]) -> tuple[AuctionSale, AuctionSale]:
    """La vente publiée par la collecte après lecture de sa fiche, et la lecture de référence de la vente brute."""
    reference = normalize_sale(copy.deepcopy(raw))
    published = copy.deepcopy(raw)
    known_enrichment.preserve_known_enrichment_payloads([published], {})
    assert set(published["source_factual_snapshot"]) == set(known_enrichment.KNOWN_SOURCE_FACT_SNAPSHOT_FIELDS)
    return normalize_sale(published), reference


def _piece_value(sale: AuctionSale, field: str) -> object:
    """Une valeur « lue dans une pièce », du type du champ et différente de celle de la source."""
    annotation = str(AuctionSale.model_fields[field].annotation)
    if "Decimal" in annotation:
        return Decimal("987654.32")
    if "datetime" in annotation:
        return datetime(2099, 1, 2, 9, 0, tzinfo=UTC)
    if "int" in annotation:
        return 97
    if "list" in annotation:
        return ["Visite lue dans une pièce"]
    return {"occupancy_status": "squatted", "property_type": "parking", "status": "postponed"}.get(field, "lu dans une pièce")


def _restore_everything(sale: AuctionSale) -> None:
    """Chaque champ restaurable reçoit une valeur de pièce tracée, puis toutes les projections sont effacées."""
    for field in RESTORABLE:
        setattr(sale, field, _piece_value(sale, field))
    pdf_record_fact_projection(sale, RESTORABLE, evidence="pièce", document_url=DOCUMENT_URL)
    assert _clear_pdf_fact_projections(sale)["cleared"] == set(RESTORABLE)


def _restore(sale: AuctionSale, field: str) -> object:
    setattr(sale, field, _piece_value(sale, field))
    pdf_record_fact_projection(sale, [field], evidence="pièce", document_url=DOCUMENT_URL)
    assert _clear_pdf_fact_projections(sale)["cleared"] == {field}
    return getattr(sale, field)


def _empty(value: object) -> bool:
    return value is None or value == [] or value == ""


def _same(restored: object, collected: object) -> bool:
    return restored == collected or (_empty(restored) and _empty(collected))


def _piece(text: str) -> dict[str, object]:
    return {
        "url": DOCUMENT_URL,
        "label": "Cahier des conditions de vente",
        "type": "pdf",
        "document_type": "cahier_conditions_vente",
        "text": text,
        "complete": True,
        "extraction_status": "extracted" if text else "empty",
    }


# --- La règle : la valeur remise est celle de la collecte, pour toutes les ventes brutes du dépôt


@pytest.mark.parametrize("name", sorted(RAW_SALES))
def test_every_restored_field_is_the_value_the_collection_wrote(name: str) -> None:
    with RECOMPUTE_DAY:
        sale, reference = _published(RAW_SALES[name]())

        _restore_everything(sale)

        differences = {
            field: (getattr(sale, field), getattr(reference, field))
            for field in RESTORABLE
            if not _same(getattr(sale, field), getattr(reference, field))
        }
        assert differences == {}


@pytest.mark.parametrize("name", sorted(LICITOR_LOT_RAWS))
def test_a_licitor_lot_that_is_no_longer_designated_never_gets_a_value_of_the_page(name: str) -> None:
    # Quand la collecte republie une vente sans relire sa fiche, ``source_lot_selection`` n'est pas repris
    # (il n'est ni dans la projection des ventes connues ni dans les champs reportés) : le texte du lot manque.
    with RECOMPUTE_DAY:
        sale, reference = _published(LICITOR_LOT_RAWS[name]())
        sale.raw_payload.pop("source_lot_selection")
        assert "multi_lot_sale" in sale.quality_flags

        _restore_everything(sale)

        for field in RESTORABLE:
            restored, collected = getattr(sale, field), getattr(reference, field)
            # Vide plutôt que la valeur de la collecte : acceptable. Une autre valeur : jamais, sauf le type de
            # bien « other », qui dit seulement que le libellé ne se lit pas sans le texte du lot.
            assert _same(restored, collected) or _empty(restored) or (field, restored) == ("property_type", "other"), field


@pytest.mark.parametrize("designated", [True, False])
def test_the_three_measured_inventions_are_gone(designated: bool) -> None:
    with RECOMPUTE_DAY:
        restored = {}
        for place, field in ((UNCERTAIN, "starting_price_eur"), (OUTBUILDINGS, "surface_m2"), (GARDEN, "rooms_count")):
            sale, reference = _published(_stored_raw(place))
            assert getattr(reference, field) is None  # la collecte n'a rien écrit pour ce lot
            if not designated:
                sale.raw_payload.pop("source_lot_selection")
            restored[place] = _restore(sale, field)

        # Ni les 6 000 € du premier lot, ni les 141,37 m² de la maison voisine, ni la pièce du studio voisin.
        assert restored == {UNCERTAIN: None, OUTBUILDINGS: None, GARDEN: None}


@pytest.mark.parametrize("designated", [True, False])
def test_the_price_read_in_a_document_survives_the_second_and_third_readings(designated: bool) -> None:
    # Lot incertain : la collecte n'a pas de mise à prix, la pièce dit 12 000 €. À la relecture complète,
    # l'instantané relu sans le lot remettait 6 000 € (premier lot), la pièce ne le remplaçait plus, et la valeur
    # passait pour celle de la source.
    with RECOMPUTE_DAY:
        sale, _ = _published(_stored_raw(UNCERTAIN))
        if not designated:
            sale.raw_payload.pop("source_lot_selection")
        sale.documents = [{"label": "Cahier des conditions de vente", "url": DOCUMENT_URL}]
        text = "Cahier des conditions de vente. Diverses parcelles de terre sises à Saint-Pargoire. Mise à prix : 12 000 euros."

        prices = []
        for _reading in range(3):
            enrich_sale_from_pdf_text(sale, [_piece(text)])
            prices.append(sale.starting_price_eur)

        assert prices == [Decimal("12000")] * 3
        assert "starting_price_eur" in sale.raw_payload["pdf_fact_provenance"]  # toujours une valeur de pièce


@pytest.mark.parametrize("second_reading", ["Cahier des conditions de vente. Mise à prix : 4 500 euros.", ""])
def test_a_surface_that_the_document_no_longer_gives_is_left_empty(second_reading: str) -> None:
    with RECOMPUTE_DAY:
        sale, reference = _published(_stored_raw(OUTBUILDINGS))
        assert reference.surface_m2 is None
        sale.documents = [{"label": "Cahier des conditions de vente", "url": DOCUMENT_URL}]
        first = (
            "Cahier des conditions de vente. Désignation : un ensemble immobilier à usage de dépendances, "
            "d'une superficie totale de 58,20 m². Mise à prix : 4 500 euros."
        )

        enrich_sale_from_pdf_text(sale, [_piece(first)])
        assert sale.surface_m2 == Decimal("58.20")
        enrich_sale_from_pdf_text(sale, [_piece(second_reading)])

        assert sale.surface_m2 is None  # pas les 141,37 m² de la maison du lot voisin


def test_a_replaced_document_restores_through_the_same_reading() -> None:
    # Même défaut, dormant, dans ``_invalidate_replaced_document_facts`` (octets de la pièce changés).
    with RECOMPUTE_DAY:
        sale, _ = _published(_stored_raw(UNCERTAIN))
        sale.documents = [{"label": "Cahier des conditions de vente", "url": DOCUMENT_URL}]
        enrich_sale_from_pdf_text(
            sale, [_piece("Cahier des conditions de vente. Diverses parcelles de terre. Mise à prix : 12 000 euros.")]
        )
        assert sale.starting_price_eur == Decimal("12000")
        sale.raw_payload["document_analysis"] = {"profiles": [{"url": DOCUMENT_URL, "sha256": "ancien"}]}

        _invalidate_replaced_document_facts(sale, [{"url": DOCUMENT_URL, "sha256": "nouveau"}])

        assert sale.starting_price_eur is None


def test_a_replaced_document_restores_untraced_values_through_the_same_reading() -> None:
    # Valeurs de pièce écrites avant la trace par champ : seule la boucle de ``_invalidate_replaced_document_facts``
    # les remet. Elle relisait l'instantané sans le lot : 141,37 m² et 6 000 € des lots voisins.
    with RECOMPUTE_DAY:
        restored = {}
        for place, field in ((OUTBUILDINGS, "surface_m2"), (UNCERTAIN, "starting_price_eur")):
            sale, reference = _published(_stored_raw(place))
            assert getattr(reference, field) is None
            sale.documents = [{"label": "Cahier des conditions de vente", "url": DOCUMENT_URL}]
            sale.surface_m2, sale.surface_source = Decimal("58.20"), "pdf"
            sale.starting_price_eur = Decimal("12000")
            sale.raw_payload["starting_price_extraction"] = {"source": "pdf"}
            sale.raw_payload["document_analysis"] = {"profiles": [{"url": DOCUMENT_URL, "sha256": "ancien"}]}

            _invalidate_replaced_document_facts(sale, [{"url": DOCUMENT_URL, "sha256": "nouveau"}])

            restored[place] = getattr(sale, field)

        assert restored == {OUTBUILDINGS: None, UNCERTAIN: None}


def test_a_value_left_by_an_older_whole_page_reading_is_not_restored_without_the_lot() -> None:
    # ``surface_evidence`` fait partie des colonnes que la collecte reporte sur une vente republiée sans relecture
    # (main.KNOWN_UNCHANGED_BACKFILL_FIELDS) : une ligne lue avant la lecture lot par lot y porte le justificatif
    # du premier lot. Avec le lot désigné, la collecte recalcule le sien ; sans lui, rien ne dit de quel lot il est.
    assert "surface_evidence" in main.KNOWN_UNCHANGED_BACKFILL_FIELDS
    with RECOMPUTE_DAY:
        raw = _two_lot_raw(LE_CANNET)
        raw["surface_evidence"] = "de 63,05 m², au 1er étage, de trois pièces"  # le lot de Cannes
        sale, reference = _published(raw)
        assert "70,78" in reference.surface_evidence

        assert _restore(sale.model_copy(deep=True), "surface_evidence") == reference.surface_evidence
        sale.raw_payload.pop("source_lot_selection")
        assert _restore(sale, "surface_evidence") is None


def test_the_page_text_is_never_read_again_once_the_lot_is_no_longer_designated(monkeypatch) -> None:
    with RECOMPUTE_DAY:
        sale, _ = _published(_stored_raw(OUTBUILDINGS))
        sale.raw_payload.pop("source_lot_selection")
        readings: list[set[str]] = []

        def recorded(raw: dict[str, object]) -> AuctionSale:
            readings.append(set(raw))
            return normalize_sale(raw)

        monkeypatch.setattr(pdf_fact_scope, "normalize_sale", recorded)
        _restore_everything(sale)

    # La première lecture, avec tout l'instantané, ne sert qu'à constater que le lot manque. Ensuite chaque champ
    # est lu seul : ni le texte de la page ni un autre champ ne peuvent lui donner une valeur.
    assert "raw_text" in readings[0]
    assert len(readings) > 1
    for keys in readings[1:]:
        assert len(keys - {"source_name", "source_url"}) == 1 and "raw_text" not in keys


def test_the_title_of_the_sale_is_used_when_the_stored_payload_has_none() -> None:
    raw = _source_sale("avoventes", title="Maison de 4 pièces avec jardin")
    sale, reference = _published(raw)
    assert (reference.property_type, reference.rooms_count) == ("house", 4)
    del sale.raw_payload["title"]
    assert sale.title == "Maison de 4 pièces avec jardin"

    assert (_restore(sale, "property_type"), _restore(sale, "rooms_count")) == ("house", 4)


def test_the_fields_trusted_without_a_lot_are_those_the_lot_reading_writes() -> None:
    lot_fields = set(licitor_lots._LOT_FIELDS) & set(known_enrichment.KNOWN_SOURCE_FACT_SNAPSHOT_FIELDS)

    assert pdf_fact_scope._LOT_WRITTEN_SNAPSHOT_FIELDS == lot_fields | {"visit_dates", "sale_date", "status"}


# --- La valeur brute de la page est lue comme la collecte la lit


def _source_sale(source: str, **fields: object) -> dict[str, Any]:
    """Une vente brute telle qu'un collecteur la rend : libellés et nombres comme sur la page."""
    return {"source_name": source, "source_url": f"https://example.test/restored/{source}", **fields}


@pytest.mark.parametrize(
    ("source", "field", "raw", "expected"),
    [
        ("cessions_etat", "occupancy_status", "libre", "vacant"),
        ("cessions_etat", "occupancy_status", "Occupé par le propriétaire", "owner_occupied"),
        ("cessions_etat", "occupancy_status", "voir le dossier", None),
        ("encheres_immobilieres", "surface_m2", "85,5", Decimal("85.5")),
        ("encheres_immobilieres", "habitable_surface_m2", "42,10", Decimal("42.10")),
        ("avoventes", "starting_price_eur", "125 000 €", Decimal("125000")),
        # Le point sépare les milliers sur une page (Vench) : ``Decimal`` lisait 45 euros et 1,25 m².
        ("vench", "starting_price_eur", "45.000", Decimal("45000")),
        ("vench", "land_surface_m2", "1.250", Decimal("1250")),
        # Sous 100 euros ce n'est pas un prix : vide, quelle que soit l'écriture.
        ("avoventes", "starting_price_eur", "85,5", None),
        ("avoventes", "starting_price_eur", "85.5", None),
        ("avoventes", "starting_price_eur", "prix sur demande", None),
        ("avoventes", "surface_m2", "non communiquée", None),
        ("avoventes", "rooms_count", "3 pièces", 3),
        ("avoventes", "rooms_count", "T3", 3),
        ("avoventes", "bedrooms_count", "2", 2),
        # Même panne que « libre » : le libellé brut remis tel quel sort de la contrainte CHECK de property_type.
        ("agrasc", "property_type", "Lot 12", "other"),
        ("agrasc", "property_type", "Maison", "house"),
    ],
)
def test_a_raw_source_value_is_restored_as_the_collection_reads_it(
    source: str, field: str, raw: object, expected: object
) -> None:
    sale, reference = _published(_source_sale(source, **{field: raw}))

    restored = _restore(sale, field)

    assert restored == expected == getattr(reference, field)
    assert type(restored) is type(expected)
    if field == "occupancy_status":
        assert restored is None or restored in OCCUPANCY_ENUM
    if field == "property_type":
        assert restored in PROPERTY_TYPES


def test_a_field_left_empty_by_the_source_is_read_in_its_page_text_like_the_collection() -> None:
    # Le contexte est celui de la collecte (vente à un seul bien, texte de sa page) : la surface que la collecte
    # a lue dans le texte est la valeur de la source, à remettre telle quelle.
    raw = _source_sale("avoventes", title="Maison", raw_text="Maison de 4 pièces de 92 m2, vendue aux enchères.")
    sale, reference = _published(raw)
    assert reference.surface_m2 == Decimal("92")

    assert _restore(sale, "surface_m2") == Decimal("92")


def test_reading_the_snapshot_leaves_it_and_the_sale_payload_untouched() -> None:
    sale, _ = _published(_source_sale("cessions_etat", sale_date="12/03/2027", occupancy_status="libre"))
    snapshot_before = copy.deepcopy(sale.raw_payload["source_factual_snapshot"])
    payload_keys_before = set(sale.raw_payload)

    _restore(sale, "occupancy_status")

    # ``normalize_sale`` écrit dans son entrée (« documents », « date_precision ») : elle reçoit une copie.
    assert sale.raw_payload["source_factual_snapshot"] == snapshot_before
    assert set(sale.raw_payload) == payload_keys_before


def test_the_legacy_candidate_path_restores_through_the_same_reading() -> None:
    # Lignes écrites avant la trace par champ : une seule liste de candidats, pas de « pdf_fact_provenance ».
    sale, _ = _published(_source_sale("cessions_etat", occupancy_status="libre", rooms_count="3 pièces"))
    sale.occupancy_status, sale.rooms_count = "occupied", 4
    sale.raw_payload["pdf_occupancy_candidates"] = [{"value": "occupied"}]
    sale.raw_payload["pdf_rooms_candidates"] = [{"value": 4}]

    assert _clear_pdf_fact_projections(sale)["cleared"] == {"occupancy_status", "rooms_count"}

    assert (sale.occupancy_status, sale.rooms_count) == ("vacant", 3)


def test_a_complete_reread_leaves_collection_values_on_the_sale() -> None:
    # Le chemin de production : chaque relecture complète efface d'abord les projections des pièces
    # (enrich_sale_from_pdf_text), donc remet la valeur de la source avant de relire.
    raw = _source_sale(
        "cessions_etat", occupancy_status="libre", surface_m2="85,5", property_type="Lot 12", rooms_count="3 pièces"
    )
    sale, _ = _published(raw)
    sale.documents = [{"label": "Cahier des charges", "url": DOCUMENT_URL}]
    sale.occupancy_status, sale.surface_m2, sale.property_type, sale.rooms_count = "occupied", Decimal("90"), "house", 5
    pdf_record_fact_projection(
        sale,
        ["occupancy_status", "surface_m2", "property_type", "rooms_count"],
        evidence="ancienne lecture",
        document_url=DOCUMENT_URL,
    )

    enrich_sale_from_pdf_text(
        sale, [_piece("Cahier des charges de la cession. Les offres sont remises sous pli cacheté.")]
    )

    stored = sale.to_storage_dict(exclude_none=False)  # la ligne écrite en base
    assert stored["occupancy_status"] == "vacant"
    assert stored["surface_m2"] == 85.5
    assert stored["property_type"] in PROPERTY_TYPES
    assert stored["rooms_count"] == 3


# --- Sans instantané, ou instantané illisible


def _bare_sale(**fields: object) -> AuctionSale:
    return AuctionSale(source_name="avoventes", source_url="https://example.test/restored/sans-instantane", **fields)


def test_a_trace_baseline_is_restored_as_the_serialized_value_it_is() -> None:
    # Sans instantané, la ligne de base de la trace est remise : un décimal sérialisé, pas un texte de page.
    # « 45000.00 » y vaut 45 000, et n'est pas relu comme un nombre à séparateur de milliers.
    sale = _bare_sale(starting_price_eur=Decimal("52000"), rooms_count=5)
    pdf_record_fact_projection(
        sale, ["starting_price_eur"], evidence="pièce", document_url=DOCUMENT_URL, baseline=Decimal("45000.00")
    )
    pdf_record_fact_projection(sale, ["rooms_count"], evidence="pièce", document_url=DOCUMENT_URL, baseline=3)

    assert _clear_pdf_fact_projections(sale)["cleared"] == {"starting_price_eur", "rooms_count"}

    assert sale.starting_price_eur == Decimal("45000.00")
    assert sale.rooms_count == 3


def test_an_unreadable_trace_baseline_is_restored_empty() -> None:
    sale = _bare_sale(starting_price_eur=Decimal("52000"), rooms_count=5)
    pdf_record_fact_projection(
        sale, ["starting_price_eur"], evidence="pièce", document_url=DOCUMENT_URL, baseline="prix sur demande"
    )
    pdf_record_fact_projection(sale, ["rooms_count"], evidence="pièce", document_url=DOCUMENT_URL, baseline="T3")

    _clear_pdf_fact_projections(sale)

    assert sale.starting_price_eur is None
    assert sale.rooms_count is None


def test_a_snapshot_that_cannot_be_read_restores_empty_and_lets_the_pass_go_on(monkeypatch, caplog) -> None:
    with RECOMPUTE_DAY:
        sale, reference = _published(
            _source_sale("avoventes", surface_m2="85,5", occupancy_status="libre", sale_date="12/03/2027")
        )
        assert (reference.surface_m2, reference.occupancy_status, reference.status) == (Decimal("85.5"), "vacant", "upcoming")
        sale.surface_m2, sale.occupancy_status, sale.status = Decimal("90"), "occupied", "postponed"
        pdf_record_fact_projection(
            sale, ["surface_m2", "occupancy_status", "status"], evidence="pièce", document_url=DOCUMENT_URL
        )

        def unreadable(_raw: dict[str, object]) -> AuctionSale:
            raise ValueError("instantané ancien : 85,5 illisible")

        monkeypatch.setattr(pdf_fact_scope, "normalize_sale", unreadable)
        with caplog.at_level(logging.WARNING, logger="src.pdf_fact_scope"):
            cleared = _clear_pdf_fact_projections(sale)["cleared"]

    assert cleared == {"surface_m2", "occupancy_status", "status"}
    assert (sale.surface_m2, sale.occupancy_status) == (None, None)
    assert sale.status == "upcoming"  # jamais vide : donné par la date de la vente
    messages = [record.getMessage() for record in caplog.records]
    assert len(messages) == 3
    for field in ("surface_m2", "occupancy_status", "status"):
        assert any(sale.source_url in message and f"field {field} " in message for message in messages)
    # L'identifiant de la vente et le champ, jamais la valeur.
    assert not any("85,5" in message or "libre" in message for message in messages)
