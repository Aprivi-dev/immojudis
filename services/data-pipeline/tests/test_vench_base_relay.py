"""Vench, page restreinte ou pauvre : ce que le collecteur reprend de la ligne stockée n'est pas un fait de la source.

Le collecteur recopie depuis la base les champs que la page ne donne pas (``_backfill_from_known_detail``). Ces
champs restent dans la vente pour ne pas appauvrir la fiche, mais ils n'entrent ni dans l'instantané de la fiche
(``source_factual_snapshot``), ni dans l'empreinte de fraîcheur, ni dans une observation attribuée à Vench.
"""

from __future__ import annotations

from copy import deepcopy
from decimal import Decimal
from pathlib import Path

from src import main as pipeline
from src.base_reads import RELAYED_FIELDS_KEY, mark_relayed, relayed_fields, snapshot_relayed_fields
from src.fact_claims import build_fact_claim_candidates
from src.freshness import record_source_checks
from src.models import AuctionSale
from src.normalize import normalize_sale
from src.personal_data import redact_storage_row
from src.sources.vench import _filter_catalog_sales, parse_vench_detail_html

URL = "https://www.vench.fr/vente-165999-une-maison-alphaville.html"
PAYWALL = "Pour consulter l'intégralité des informations disponibles, vous devez être abonné."
FIXTURES = Path(__file__).parent / "fixtures"


def restricted_page(**values) -> dict:
    """Ce que la page restreinte publie : un titre, une ville, la mise à prix et la date."""
    return {
        "source_name": "vench",
        "source_url": URL,
        "source_detail_status": "restricted",
        "title": "UNE MAISON D'HABITATION",
        "city": "Alphaville",
        "starting_price_eur": "90 000 €",
        "sale_date": "15/12/2026",
        "raw_text": PAYWALL,
        **values,
    }


def stored(**values) -> dict:
    """La ligne déjà en base, enrichie par d'autres voies que la page Vench."""
    return {
        "source_url": URL,
        "address": "12 rue des Lilas 33000 Alphaville",
        "postal_code": "33000",
        "description": "Maison de 54 m² avec jardin.",
        "surface_m2": 54,
        "app_surface_m2": 54,
        "app_surface_kind": "declared",
        "surface_source": "declared",
        "surface_confidence": 0.9,
        "land_surface_m2": 800,
        "rooms_count": 3,
        "bedrooms_count": 2,
        "occupancy_status": "rented",
        "documents": [{"url": "https://example.test/ccv.pdf", "label": "Cahier des conditions de vente"}],
        "raw_payload": {},
        **values,
    }


def collect(known_row: dict, previous_payload: dict | None = None, **page) -> dict:
    """Une lecture de la page restreinte, comme la collecte la traite jusqu'à l'empreinte."""
    raw = restricted_page(**page)
    known = {URL: {**known_row, "raw_payload": previous_payload or {}}}
    _filter_catalog_sales([raw], known)
    pipeline._preserve_known_enrichment_payloads([raw], known)
    record_source_checks([raw], known)
    return raw


def test_the_collector_notes_exactly_the_fields_it_took_from_the_stored_row() -> None:
    raw = restricted_page()

    _filter_catalog_sales([raw], {URL: stored()})

    assert raw["surface_m2"] == 54 and raw["occupancy_status"] == "rented"  # la fiche reste aussi riche qu'avant
    assert relayed_fields(raw) == {
        "address", "postal_code", "description", "surface_m2", "app_surface_m2", "app_surface_kind",
        "surface_source", "surface_confidence", "land_surface_m2", "rooms_count", "bedrooms_count",
        "occupancy_status", "documents",
    }
    # Ce que la page donnait elle-même n'est pas noté.
    assert not relayed_fields(raw) & {"title", "city", "raw_text", "starting_price_eur", "sale_date"}


def test_a_page_that_needs_nothing_from_the_stored_row_is_not_marked() -> None:
    raw = restricted_page(
        raw_text="UNE MAISON • 82,45m² • Alphaville", address="1 rue Haute", postal_code="33000",
        description="Une maison de 82,45 m².", surface_m2="82,45",
    )

    _filter_catalog_sales([raw], {URL: stored()})

    assert RELAYED_FIELDS_KEY not in raw
    assert relayed_fields(raw) == frozenset()


def test_fields_taken_from_the_stored_row_stay_out_of_the_source_snapshot() -> None:
    raw = collect(stored())

    snapshot = raw["source_factual_snapshot"]
    taken = ("surface_m2", "app_surface_m2", "app_surface_kind", "surface_source", "surface_confidence",
             "land_surface_m2", "rooms_count", "bedrooms_count", "occupancy_status", "description")
    # Leur clé est absente (« inconnu de la source », et non « vide à la source ») et l'instantané en garde la liste.
    assert not set(taken) & set(snapshot)
    assert snapshot["fields_from_stored_row"] == sorted(taken)
    assert snapshot_relayed_fields(snapshot) == set(taken)
    # Ce que la page a publié y est.
    assert snapshot["starting_price_eur"] == "90 000 €"
    assert snapshot["sale_date"] == "15/12/2026"
    assert snapshot["raw_text"] == PAYWALL


def test_a_page_that_takes_nothing_has_a_plain_snapshot() -> None:
    raw = collect(stored(), surface_m2="82,45", raw_text="UNE MAISON • 82,45m² • Alphaville", address="1 rue Haute",
                  postal_code="33000", description="Une maison de 82,45 m².")

    assert "fields_from_stored_row" not in raw["source_factual_snapshot"]
    assert raw["source_factual_snapshot"]["surface_m2"] == "82,45"


def _document_reader_sale(snapshot: dict) -> AuctionSale:
    """La vente telle que la lecture des pièces la relit : surface de 48,5 m² établie par un document."""
    document = "https://example.test/ccv.pdf"
    return AuctionSale(
        source_name="vench",
        source_url=URL,
        surface_m2=48.5,
        carrez_surface_m2=48.5,
        surface_source="pdf",
        surface_confidence=0.9,
        surface_evidence="superficie loi Carrez de 48,50 m²",
        rooms_count=3,
        documents=[{"url": document, "label": "Cahier des conditions de vente", "sha256": "b" * 64}],
        raw_payload={
            "source_detail_status": "restricted",
            "source_factual_snapshot": snapshot,
            "document_analysis": {"profiles": [{"url": document, "sha256": "a" * 64}]},
            "surface_extraction": {"source": "pdf", "value_m2": 48.5, "document_url": document},
            "pdf_fact_provenance": {
                field: {"value": value, "source": "pdf", "payload_keys": ["surface_extraction"]}
                for field, value in (("surface_m2", 48.5), ("carrez_surface_m2", 48.5), ("surface_source", "pdf"))
            },
        },
    )


def test_a_changed_document_does_not_empty_a_surface_the_restricted_page_never_gave() -> None:
    """Page restreinte, surface établie par un document, pièce modifiée, relecture en échec.

    La pièce a changé : sa projection est défaite et la valeur « de la source » est remise. Pour un champ que la
    page ne donnait pas, cette valeur est inconnue : la surface n'est pas remise à vide (la vente perdrait sa
    surface sans qu'aucune source n'ait dit qu'elle n'en a pas).
    """
    from src.pdf_enrichment import _invalidate_replaced_document_facts

    raw = collect(stored(surface_m2=48.5, app_surface_m2=48.5, surface_source="pdf", carrez_surface_m2=48.5,
                         surface_evidence="superficie loi Carrez de 48,50 m²"))
    sale = _document_reader_sale(raw["source_factual_snapshot"])
    unknown = snapshot_relayed_fields(sale.raw_payload["source_factual_snapshot"])
    assert {"surface_m2", "surface_confidence", "surface_evidence"} <= unknown

    _invalidate_replaced_document_facts(sale, sale.documents)  # la relecture échoue ensuite : rien n'est reprojeté

    assert (sale.surface_m2, sale.carrez_surface_m2, sale.surface_source) == (Decimal("48.5"), Decimal("48.5"), "pdf")
    # Les champs sans trace de pièce que la page ne donnait pas non plus restent ce qu'ils étaient.
    assert sale.surface_confidence == Decimal("0.9")
    assert sale.surface_evidence == "superficie loi Carrez de 48,50 m²"
    assert sale.raw_payload["source_content_changed"] is True  # l'analyse est bien invalidée


def test_a_changed_document_still_restores_what_a_fully_read_page_published() -> None:
    """Témoin : quand la page a été lue en entier, son instantané dit ce que vaut le champ, y compris « rien »."""
    from src.pdf_enrichment import _invalidate_replaced_document_facts

    snapshot = {"source_name": "vench", "source_url": URL, "surface_m2": None, "carrez_surface_m2": None,
                "surface_source": None, "rooms_count": 3}
    sale = _document_reader_sale(snapshot)

    _invalidate_replaced_document_facts(sale, sale.documents)

    assert (sale.surface_m2, sale.carrez_surface_m2, sale.surface_source) == (None, None, None)


def test_the_freshness_fingerprint_ignores_what_the_stored_row_provided() -> None:
    """La base change entre deux lectures de la même page : ce n'est pas un changement de la source."""
    first = collect(stored())
    check = first["source_checks"][URL]

    # Entre-temps une valeur de la base est retirée, une autre remplacée, un document ajouté.
    moved = stored(
        surface_m2=None, app_surface_m2=None, rooms_count=4, occupancy_status="occupied",
        documents=[{"url": "https://example.test/pv.pdf", "label": "Procès-verbal descriptif"}],
    )
    second = collect(moved, previous_payload={"source_checks": first["source_checks"]})

    assert second["source_checks"][URL]["fingerprint"] == check["fingerprint"]
    assert second["source_checks"][URL]["evidence_fingerprint"] == check["evidence_fingerprint"]
    assert second["source_checks"][URL]["capture_fingerprints"] == check["capture_fingerprints"]
    assert "source_content_changed" not in second


def test_without_the_mark_the_same_base_change_looked_like_a_source_change() -> None:
    """Témoin : c'est la note des champs repris, et rien d'autre, qui tient l'empreinte hors de la base."""

    def collect_unmarked(known_row: dict, previous_payload: dict | None = None) -> dict:
        raw = restricted_page()
        known = {URL: {**known_row, "raw_payload": previous_payload or {}}}
        _filter_catalog_sales([raw], known)
        raw.pop(RELAYED_FIELDS_KEY)
        pipeline._preserve_known_enrichment_payloads([raw], known)
        record_source_checks([raw], known)
        return raw

    first = collect_unmarked(stored())
    second = collect_unmarked(stored(rooms_count=4), previous_payload={"source_checks": first["source_checks"]})

    assert second["source_checks"][URL]["fingerprint"] != first["source_checks"][URL]["fingerprint"]
    assert second["source_content_changed"] is True


def test_a_real_change_of_the_page_still_changes_the_fingerprint() -> None:
    first = collect(stored())

    second = collect(
        stored(), previous_payload={"source_checks": first["source_checks"]},
        raw_text=PAYWALL + " Vente reportée au 12/01/2027.",
    )

    assert second["source_checks"][URL]["fingerprint"] != first["source_checks"][URL]["fingerprint"]
    assert second["source_content_changed"] is True


def test_no_claim_is_attributed_to_vench_for_a_field_taken_from_the_stored_row() -> None:
    raw = collect(stored())
    sale = normalize_sale(raw)
    assert sale.surface_m2 == 54 and sale.occupancy_status == "rented"  # la vente garde les valeurs de la base

    candidates = build_fact_claim_candidates(sale)

    by_field = {candidate["field_key"]: candidate for candidate in candidates}
    assert "property.surface_m2" not in by_field
    assert "property.land_surface_m2" not in by_field
    assert "property.occupancy_status" not in by_field
    # La mise à prix et la date, publiées par la page, font une observation.
    assert by_field["sale.starting_price_eur"]["value_jsonb"] == 90000.0
    assert by_field["sale.starting_price_eur"]["evidence_locator"]["kind"] == "source_field"
    assert "sale.sale_date" in by_field


def test_the_mark_is_never_written_to_the_database() -> None:
    raw = collect(stored())
    sale = normalize_sale(raw)
    assert RELAYED_FIELDS_KEY in sale.raw_payload

    row = redact_storage_row({"raw_payload": deepcopy(sale.raw_payload), "observations": [
        {"source_url": URL, "raw_payload": deepcopy(sale.raw_payload)},
    ]})

    assert RELAYED_FIELDS_KEY not in row["raw_payload"]
    assert RELAYED_FIELDS_KEY not in row["observations"][0]["raw_payload"]


def test_a_mark_is_a_sorted_list_and_an_empty_mark_writes_nothing() -> None:
    raw: dict = {}
    mark_relayed(raw, [])
    assert RELAYED_FIELDS_KEY not in raw

    mark_relayed(raw, ["surface_m2", "rooms_count", "surface_m2"])

    assert raw[RELAYED_FIELDS_KEY] == ["rooms_count", "surface_m2"]
    assert relayed_fields({RELAYED_FIELDS_KEY: "surface_m2"}) == frozenset()


def test_the_restricted_page_fixture_takes_its_surface_from_the_stored_row() -> None:
    """La fiche réservée aux abonnés des fixtures : aucune surface publiée, tout vient de la ligne stockée."""
    html = (FIXTURES / "vench_fiche_abonnes.html").read_text(encoding="utf-8")
    raw = {"source_name": "vench", "source_url": URL, "source_detail_status": "restricted"}
    raw.update({key: value for key, value in parse_vench_detail_html(html, URL).items() if value not in (None, "", [])})
    known = {URL: stored()}

    _filter_catalog_sales([raw], known)
    pipeline._preserve_known_enrichment_payloads([raw], known)

    assert {"surface_m2", "rooms_count", "occupancy_status"} <= relayed_fields(raw)
    assert "surface_m2" not in raw["source_factual_snapshot"]
    assert raw["surface_m2"] == 54
