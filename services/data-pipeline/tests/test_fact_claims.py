from __future__ import annotations

from types import SimpleNamespace

from src.fact_claims import build_fact_claim_candidates, materialize_fact_claim_rows
from src.models import AuctionSale
from src.normalize import normalize_sale
from src.storage import supabase_client


def test_source_fields_and_blocks_create_candidates_without_accepting_them() -> None:
    sale = normalize_sale(
        {
            "source_name": "info_encheres",
            "source_url": "https://source.example/sale-1",
            "source_blocks": {
                "date_vente": "10 septembre 2026 à 14h00",
                "mise_a_prix": "100 000 euros",
                "surface": "Maison de 80 m²",
                "occupation": "Libre de toute occupation",
            },
        }
    )

    candidates = build_fact_claim_candidates(sale)
    by_field = {candidate["field_key"]: candidate for candidate in candidates}

    assert set(by_field) == {
        "sale.sale_date",
        "sale.starting_price_eur",
        "property.surface_m2",
        "property.occupancy_status",
    }
    assert by_field["sale.starting_price_eur"]["value_jsonb"] == 100000.0
    assert by_field["property.surface_m2"]["value_jsonb"] == 80.0
    assert by_field["property.occupancy_status"]["value_jsonb"] == "vacant"
    assert by_field["property.occupancy_status"]["evidence_locator"]["kind"] == "source_block"


def test_pdf_extraction_provenance_is_field_typed() -> None:
    sale = AuctionSale(
        source_name="licitor",
        source_url="https://source.example/sale-2",
        habitable_surface_m2=90,
        carrez_surface_m2=88,
        land_surface_m2=420,
        raw_payload={
            "surface_extraction": {
                "value_m2": 90,
                "evidence": "Surface habitable : 90 m²",
                "page_number": 4,
            },
            "land_surface_extraction": {
                "value_m2": 420,
                "evidence": "Terrain cadastré de 420 m²",
                "page_number": 4,
            },
        },
    )

    candidates = build_fact_claim_candidates(sale)
    by_field = {candidate["field_key"]: candidate for candidate in candidates}

    assert "property.habitable_surface_m2" in by_field
    assert "property.land_surface_m2" in by_field
    assert "property.surface_m2" not in by_field
    assert "property.carrez_surface_m2" not in by_field
    assert by_field["property.habitable_surface_m2"]["evidence_kind"] == "source_document"
    assert by_field["property.land_surface_m2"]["evidence_locator"]["page_number"] == 4


def test_missing_field_provenance_does_not_create_a_claim() -> None:
    sale = AuctionSale(
        source_name="avoventes",
        source_url="https://source.example/sale-3",
        sale_date="2026-09-10T12:00:00+00:00",
        starting_price_eur=100000,
        surface_m2=80,
        occupancy_status="vacant",
    )

    assert build_fact_claim_candidates(sale) == []


def test_surface_excerpt_only_claims_the_surface_kind_named_by_the_excerpt() -> None:
    sale = AuctionSale(
        source_name="licitor",
        source_url="https://source.example/surface-evidence",
        surface_m2=80,
        habitable_surface_m2=80,
        land_surface_m2=420,
        raw_payload={"surface_evidence": "Surface habitable : 90 m²"},
    )

    candidates = build_fact_claim_candidates(sale)

    assert [candidate["field_key"] for candidate in candidates] == [
        "property.habitable_surface_m2"
    ]
    assert candidates[0]["value_jsonb"] == 90.0


def test_document_evidence_without_a_scalar_does_not_reuse_the_canonical_value() -> None:
    sale = AuctionSale(
        source_name="licitor",
        source_url="https://source.example/document-without-value",
        habitable_surface_m2=80,
        raw_payload={
            "surface_extraction": {
                "evidence": "Surface habitable à confirmer",
                "document_url": "https://source.example/document.pdf",
            }
        },
    )

    assert build_fact_claim_candidates(sale) == []


def test_occupancy_text_claim_uses_the_status_in_its_quote() -> None:
    sale = AuctionSale(
        source_name="licitor",
        source_url="https://source.example/occupancy-evidence",
        occupancy_status="rented",
        raw_payload={"raw_text": "Maison libre de toute occupation."},
    )

    candidates = build_fact_claim_candidates(sale)

    occupancy = [candidate for candidate in candidates if candidate["field_key"] == "property.occupancy_status"]
    assert len(occupancy) == 1
    assert occupancy[0]["value_jsonb"] == "vacant"
    assert occupancy[0]["evidence_locator"]["kind"] == "text_evidence"


def test_observations_keep_source_specific_candidates_and_versions_are_stable() -> None:
    sale = normalize_sale(
        {
            "source_name": "avoventes",
            "source_url": "https://source.example/primary",
            "starting_price_eur": "100 000 euros",
            "source_blocks": {"mise_a_prix": "100 000 euros"},
        }
    )
    sale.observations.append(
        {
            "source_name": "licitor",
            "source_url": "https://source.example/secondary",
            "starting_price_eur": "105 000 euros",
            "raw_payload": {"starting_price_eur": "105 000 euros"},
        }
    )

    first = materialize_fact_claim_rows(sale, "00000000-0000-4000-8000-000000000001")
    second = materialize_fact_claim_rows(sale, "00000000-0000-4000-8000-000000000001")

    price_rows = [row for row in first if row["field_key"] == "sale.starting_price_eur"]
    assert {row["source_url"] for row in price_rows} == {
        "https://source.example/primary",
        "https://source.example/secondary",
    }
    assert [row["id"] for row in first] == [row["id"] for row in second]
    assert all(row["claim_status"] == "candidate" for row in first)

    sale.observations[-1]["starting_price_eur"] = "106 000 euros"
    changed = materialize_fact_claim_rows(sale, "00000000-0000-4000-8000-000000000001")
    old_secondary = next(row for row in price_rows if row["source_url"].endswith("secondary"))
    new_secondary = next(row for row in changed if row["source_url"].endswith("secondary"))
    assert new_secondary["id"] != old_secondary["id"]

    other_sale = materialize_fact_claim_rows(sale, "00000000-0000-4000-8000-000000000099")
    assert [row["id"] for row in other_sale] != [row["id"] for row in first]


def test_postgres_writer_inserts_candidates_without_updating_existing_claims() -> None:
    sale = normalize_sale(
        {
            "source_name": "avoventes",
            "source_url": "https://source.example/postgres",
            "starting_price_eur": "100 000 euros",
            "source_blocks": {"mise_a_prix": "100 000 euros"},
        }
    )
    sale.id = "00000000-0000-4000-8000-000000000002"
    statements: list[str] = []

    class Connection:
        def execute(self, statement, params=None):
            statements.append(str(statement))
            if "to_regclass" in str(statement):
                return SimpleNamespace(fetchone=lambda: ("public.auction_fact_claims",))
            if "select id::text, source_url" in str(statement):
                return SimpleNamespace(fetchall=lambda: [("00000000-0000-4000-8000-000000000099", sale.source_url)])
            return SimpleNamespace(fetchall=lambda: [])

    written = supabase_client._write_fact_claims_postgres([sale], Connection())

    assert written == 1
    assert any("on conflict (id) do nothing" in statement for statement in statements)


def test_rest_writer_uses_ignore_duplicates_and_keeps_candidate_status(monkeypatch) -> None:
    sale = normalize_sale(
        {
            "source_name": "info_encheres",
            "source_url": "https://source.example/rest",
            "source_blocks": {"occupation": "Libre de toute occupation"},
        }
    )
    sale.id = "00000000-0000-4000-8000-000000000003"
    calls: list[dict[str, object]] = []

    def fake_request(method, endpoint, table, **kwargs):
        calls.append({"method": method, "endpoint": endpoint, "table": table, **kwargs})
        if method == "GET":
            return SimpleNamespace(
                is_error=False,
                status_code=200,
                text="",
                request=None,
                json=lambda: [
                    {
                        "id": "00000000-0000-4000-8000-000000000099",
                        "source_url": sale.source_url,
                    }
                ],
            )
        return SimpleNamespace(is_error=False, status_code=201, text="", request=None)

    monkeypatch.setattr(supabase_client, "_postgrest_request_with_retries", fake_request)

    written = supabase_client._write_fact_claims_rest(
        "https://supabase.example", "service-role-test", [sale]
    )

    assert written == 1
    assert calls[0]["method"] == "GET"
    assert calls[1]["method"] == "POST"
    assert calls[1]["params"] == {"on_conflict": "id"}
    assert "resolution=ignore-duplicates" in calls[1]["headers"]["Prefer"]
    assert calls[1]["json"][0]["claim_status"] == "candidate"
    assert calls[1]["json"][0]["auction_sale_id"] == "00000000-0000-4000-8000-000000000099"
