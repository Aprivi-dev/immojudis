from __future__ import annotations

from types import SimpleNamespace

import pytest

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
        documents=[
            {"url": "https://source.example/pv.pdf", "label": "PV"},
            {"url": "https://source.example/cadastre.pdf", "label": "Cadastre"},
        ],
        raw_payload={
            "surface_extraction": {
                "value_m2": 90,
                "evidence": "Surface habitable : 90 m²",
                "document_url": "https://source.example/pv.pdf",
                "page_number": 4,
            },
            "land_surface_extraction": {
                "value_m2": 420,
                "evidence": "Terrain cadastré de 420 m²",
                "document_url": "https://source.example/cadastre.pdf",
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
    assert by_field["property.habitable_surface_m2"]["source_url"] == "https://source.example/pv.pdf"
    assert (
        by_field["property.habitable_surface_m2"]["evidence_locator"]["listing_source_url"]
        == "https://source.example/sale-2"
    )
    assert by_field["property.land_surface_m2"]["evidence_locator"]["page_number"] == 4
    assert by_field["property.land_surface_m2"]["source_url"] == "https://source.example/cadastre.pdf"


def test_document_evidence_must_match_a_current_attachment() -> None:
    sale = AuctionSale(
        source_name="licitor",
        source_url="https://source.example/listing-with-foreign-pdf",
        documents=[{"url": "https://source.example/current.pdf", "label": "PV actuel"}],
        raw_payload={
            "starting_price_extraction": {
                "value_eur": 100000,
                "evidence": "Mise à prix : 100 000 €",
                "document_url": "https://other.example/foreign.pdf",
                "page_number": 2,
            }
        },
    )

    assert build_fact_claim_candidates(sale) == []


def test_document_evidence_hash_must_match_attachment_or_cache_proof() -> None:
    document_url = "https://source.example/current.pdf"
    attachment_hash = "a" * 64
    proof_hash = "b" * 64
    sale = AuctionSale(
        source_name="licitor",
        source_url="https://source.example/listing-with-hashed-pdf",
        documents=[{"url": document_url, "label": "PV actuel", "sha256": attachment_hash}],
        raw_payload={
            "starting_price_extraction": {
                "value_eur": 100000,
                "evidence": "Mise à prix : 100 000 €",
                "document_url": document_url,
                "document_sha256": attachment_hash,
                "page_number": 2,
            }
        },
    )

    matching = build_fact_claim_candidates(sale)
    assert len(matching) == 1
    assert matching[0]["evidence_locator"]["hash_verified"] is True
    assert matching[0]["evidence_locator"]["document_sha256"] == attachment_hash

    sale.raw_payload["starting_price_extraction"]["document_sha256"] = proof_hash
    assert build_fact_claim_candidates(sale) == []

    # A reconstructed sale may carry the hash only in the persisted cache
    # proof; that proof is still sufficient when the URL is a current attach.
    sale.documents = [{"url": document_url, "label": "PV actuel"}]
    sale.raw_payload["document_analysis"] = {
        "cache_proof": {"documents": [{"url": document_url, "sha256": proof_hash}]}
    }
    matching_from_proof = build_fact_claim_candidates(sale)
    assert len(matching_from_proof) == 1
    assert matching_from_proof[0]["evidence_locator"]["hash_verified"] is True


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


@pytest.mark.parametrize("include_source", [False, True])
def test_generated_completeness_projection_is_not_independent_source_evidence(include_source: bool) -> None:
    blocks = {
        "listing_completeness": {
            "source_property_features": {"surface": "Maison de 999 m²", "occupation": "Libre"},
            "source_field_observations": {
                "occupancy_status": {"value": "vacant", "state": "inferred", "excerpt": "Libre"},
            },
        },
    }
    if include_source:
        blocks["surface"] = "Maison de 55 m²"
    sale = AuctionSale(
        source_name="info_encheres",
        source_url="https://source.example/completeness-projection",
        raw_payload={"source_blocks": blocks},
    )

    candidates = build_fact_claim_candidates(sale)

    assert [(candidate["field_key"], candidate["value_jsonb"]) for candidate in candidates] == (
        [("property.surface_m2", 55.0)] if include_source else []
    )


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


def test_document_evidence_without_exact_document_url_is_not_attributed_to_listing() -> None:
    sale = AuctionSale(
        source_name="licitor",
        source_url="https://source.example/listing-with-unlocated-pdf",
        starting_price_eur=100000,
        raw_payload={
            "starting_price_extraction": {
                "value_eur": 100000,
                "evidence": "Mise à prix : 100 000 €",
                "document_label": "Cahier des conditions de vente",
                "page_number": 7,
            }
        },
    )

    assert build_fact_claim_candidates(sale) == []


def test_document_evidence_rejects_non_https_document_url() -> None:
    sale = AuctionSale(
        source_name="licitor",
        source_url="https://source.example/listing-with-insecure-pdf",
        starting_price_eur=100000,
        raw_payload={
            "starting_price_extraction": {
                "value_eur": 100000,
                "evidence": "Mise à prix : 100 000 €",
                "document_url": "http://source.example/cahier.pdf",
                "page_number": 7,
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


def test_rest_writer_queues_one_deterministic_replay_after_claim_failure(monkeypatch) -> None:
    sale = normalize_sale(
        {
            "source_name": "info_encheres",
            "source_url": "https://source.example/rest-retry",
            "source_blocks": {"occupation": "Libre de toute occupation"},
        }
    )
    calls: list[dict[str, object]] = []
    queued: list[dict[str, object]] = []

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
        return SimpleNamespace(
            is_error=True,
            status_code=503,
            text="temporarily unavailable",
            request=None,
        )

    def fake_post(endpoint, **kwargs):
        queued.append({"endpoint": endpoint, **kwargs})
        return SimpleNamespace(is_error=False, status_code=201, text="")

    monkeypatch.setattr(supabase_client, "_postgrest_request_with_retries", fake_request)
    monkeypatch.setattr(supabase_client.httpx, "post", fake_post)

    assert supabase_client._write_fact_claims_rest(
        "https://supabase.example", "service-role-test", [sale]
    ) == 0
    assert calls[0]["method"] == "GET"
    assert calls[1]["method"] == "POST"
    assert len(queued) == 1
    job = queued[0]["json"][0]
    assert job["source_url"] == sale.source_url
    assert job["job_type"] == "fact_claims"
    assert str(job["input_hash"]).startswith("fact_claims_rest_v2:")
    assert job["fact_claims_snapshot"]
    assert job["fact_claims_snapshot"][0]["field_key"] == "property.occupancy_status"
    assert queued[0]["params"] == {"on_conflict": "source_url,job_type,input_hash"}


def test_fact_claim_replay_surfaces_failure_to_the_bounded_worker(monkeypatch) -> None:
    sale = normalize_sale(
        {
            "source_name": "info_encheres",
            "source_url": "https://source.example/rest-retry-fails",
            "source_blocks": {"occupation": "Libre de toute occupation"},
        }
    )
    monkeypatch.setattr(
        supabase_client,
        "load_settings",
        lambda: {
            "supabase_url": "https://supabase.example",
            "supabase_service_role_key": "service-role-test",
        },
    )
    monkeypatch.setattr(
        supabase_client,
        "_write_fact_claims_rest",
        lambda *args, **kwargs: (_ for _ in ()).throw(RuntimeError("temporary outage")),
    )

    with pytest.raises(RuntimeError, match="temporary outage"):
        supabase_client.retry_fact_claims_to_supabase(sale)


def test_fact_claim_replay_rekeys_snapshot_to_current_canonical_sale(monkeypatch) -> None:
    sale = normalize_sale(
        {
            "source_name": "info_encheres",
            "source_url": "https://source.example/rest-snapshot",
            "source_blocks": {"occupation": "Libre de toute occupation"},
        }
    )
    old_sale_id = "00000000-0000-4000-8000-000000000010"
    current_sale_id = "00000000-0000-4000-8000-000000000011"
    snapshot = materialize_fact_claim_rows(sale, old_sale_id)
    posted: list[dict[str, object]] = []

    monkeypatch.setattr(
        supabase_client,
        "load_settings",
        lambda: {
            "supabase_url": "https://supabase.example",
            "supabase_service_role_key": "service-role-test",
        },
    )
    monkeypatch.setattr(
        supabase_client,
        "_sale_ids_for_rest",
        lambda *args, **kwargs: {sale.source_url: current_sale_id},
    )

    def fake_request(method, endpoint, table, **kwargs):
        if method == "POST":
            posted.extend(kwargs["json"])
        return SimpleNamespace(is_error=False, status_code=201, text="", request=None)

    monkeypatch.setattr(supabase_client, "_postgrest_request_with_retries", fake_request)

    assert supabase_client.retry_fact_claims_to_supabase(sale, snapshot=snapshot) == len(snapshot)
    assert posted
    assert {row["auction_sale_id"] for row in posted} == {current_sale_id}
    assert {row["id"] for row in posted} != {row["id"] for row in snapshot}
    assert {row["value_jsonb"] for row in posted} == {row["value_jsonb"] for row in snapshot}


@pytest.mark.parametrize(
    "snapshot",
    [[], {}, [{"field_key": "property.surface_m2"}]],
)
def test_fact_claim_replay_rejects_empty_or_malformed_snapshot(monkeypatch, snapshot) -> None:
    sale = normalize_sale(
        {
            "source_name": "info_encheres",
            "source_url": "https://source.example/rest-invalid-snapshot",
        }
    )
    monkeypatch.setattr(
        supabase_client,
        "load_settings",
        lambda: {
            "supabase_url": "https://supabase.example",
            "supabase_service_role_key": "service-role-test",
        },
    )
    monkeypatch.setattr(
        supabase_client,
        "_sale_ids_for_rest",
        lambda *args, **kwargs: {sale.source_url: "00000000-0000-4000-8000-000000000012"},
    )

    with pytest.raises(RuntimeError, match="snapshot"):
        supabase_client.retry_fact_claims_to_supabase(sale, snapshot=snapshot)


def test_fact_claim_replay_rejects_mixed_snapshot_without_partial_write(monkeypatch) -> None:
    sale = normalize_sale(
        {
            "source_name": "info_encheres",
            "source_url": "https://source.example/rest-mixed-snapshot",
        }
    )
    snapshot = [
        {
            "field_key": "property.surface_m2",
            "value_jsonb": 80.0,
            "source_url": sale.source_url,
            "evidence_locator": {"field": "surface"},
            "evidence_kind": "source_listing",
        },
        {"field_key": "property.occupancy_status"},
    ]
    posted: list[dict[str, object]] = []
    monkeypatch.setattr(
        supabase_client,
        "load_settings",
        lambda: {
            "supabase_url": "https://supabase.example",
            "supabase_service_role_key": "service-role-test",
        },
    )
    monkeypatch.setattr(
        supabase_client,
        "_sale_ids_for_rest",
        lambda *args, **kwargs: {sale.source_url: "00000000-0000-4000-8000-000000000014"},
    )
    monkeypatch.setattr(
        supabase_client,
        "_postgrest_request_with_retries",
        lambda method, endpoint, table, **kwargs: posted.append(kwargs["json"])
        or SimpleNamespace(is_error=False, status_code=201, text="", request=None),
    )

    with pytest.raises(RuntimeError, match="missing"):
        supabase_client.retry_fact_claims_to_supabase(sale, snapshot=snapshot)
    assert posted == []


def test_rest_writer_queues_only_sales_missing_from_an_incomplete_target_lookup(monkeypatch) -> None:
    sales = [
        normalize_sale(
            {
                "source_name": "info_encheres",
                "source_url": "https://source.example/rest-partial-1",
                "source_blocks": {"occupation": "Libre de toute occupation"},
            }
        ),
        normalize_sale(
            {
                "source_name": "info_encheres",
                "source_url": "https://source.example/rest-partial-2",
                "source_blocks": {"occupation": "Libre de toute occupation"},
            }
        ),
    ]
    sales[0].observations.append(
        {
            "source_name": "licitor",
            "source_url": "https://source.example/shared-observation",
            "starting_price_eur": "100 000 euros",
            "raw_payload": {"starting_price_eur": "100 000 euros"},
        }
    )
    sales[1].observations.append(
        {
            "source_name": "licitor",
            "source_url": "https://source.example/shared-observation",
            "starting_price_eur": "200 000 euros",
            "raw_payload": {"starting_price_eur": "200 000 euros"},
        }
    )
    calls: list[dict[str, object]] = []
    queued: list[dict[str, object]] = []

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
                        "id": "00000000-0000-4000-8000-000000000013",
                        "source_url": sales[0].source_url,
                    }
                ],
            )
        return SimpleNamespace(is_error=False, status_code=201, text="", request=None)

    monkeypatch.setattr(supabase_client, "_postgrest_request_with_retries", fake_request)
    monkeypatch.setattr(
        supabase_client.httpx,
        "post",
        lambda endpoint, **kwargs: queued.append({"endpoint": endpoint, **kwargs})
        or SimpleNamespace(is_error=False, status_code=201, text=""),
    )

    assert supabase_client._write_fact_claims_rest(
        "https://supabase.example", "service-role-test", sales
    ) == 2
    assert [call["method"] for call in calls] == ["GET", "POST"]
    assert len(queued) == 1
    queued_snapshot = queued[0]["json"][0]["fact_claims_snapshot"]
    assert {row["source_url"] for row in queued_snapshot} == {
        sales[1].source_url,
        "https://source.example/shared-observation",
    }
    assert {row["value_jsonb"] for row in queued_snapshot if row["field_key"] == "sale.starting_price_eur"} == {
        200000.0,
    }


def test_rest_writer_surfaces_missing_retry_queue_as_an_explicit_failure(monkeypatch) -> None:
    sale = normalize_sale(
        {
            "source_name": "info_encheres",
            "source_url": "https://source.example/rest-queue-unavailable",
            "source_blocks": {"occupation": "Libre de toute occupation"},
        }
    )
    monkeypatch.setattr(
        supabase_client,
        "_postgrest_request_with_retries",
        lambda *args, **kwargs: (_ for _ in ()).throw(RuntimeError("target lookup unavailable")),
    )
    monkeypatch.setattr(
        supabase_client.httpx,
        "post",
        lambda endpoint, **kwargs: SimpleNamespace(is_error=True, status_code=503, text="offline"),
    )

    with pytest.raises(RuntimeError, match="retry queue"):
        supabase_client._write_fact_claims_rest(
            "https://supabase.example", "service-role-test", [sale]
        )


def test_rest_writer_queues_when_canonical_sale_lookup_fails(monkeypatch) -> None:
    sale = normalize_sale(
        {
            "source_name": "info_encheres",
            "source_url": "https://source.example/rest-target-fails",
            "source_blocks": {"occupation": "Libre de toute occupation"},
        }
    )
    queued: list[dict[str, object]] = []

    def fail_target_lookup(*args, **kwargs):
        raise RuntimeError("target lookup unavailable")

    monkeypatch.setattr(supabase_client, "_postgrest_request_with_retries", fail_target_lookup)
    monkeypatch.setattr(
        supabase_client.httpx,
        "post",
        lambda endpoint, **kwargs: queued.append({"endpoint": endpoint, **kwargs})
        or SimpleNamespace(is_error=False, status_code=201, text=""),
    )

    assert supabase_client._write_fact_claims_rest(
        "https://supabase.example", "service-role-test", [sale]
    ) == 0
    assert len(queued) == 1
    assert queued[0]["json"][0]["job_type"] == "fact_claims"
