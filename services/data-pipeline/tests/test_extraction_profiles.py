import json
from pathlib import Path

from src.extraction_profiles import (
    attach_source_property_features,
    build_procedure_profile,
)


def test_judicial_profile_keeps_technical_evidence_and_occupancy_scopes() -> None:
    sale = attach_source_property_features(
        {
            "source_name": "info_encheres",
            "source_url": "https://example.test/judicial/6051",
            "title": "Appartement T4 rez-de-jardin",
            "description": (
                "Tribunal judiciaire de Bordeaux. 3 chambres, 1 salle de bains, "
                "chauffage individuel au gaz par radiateurs. DPE : D, GES : B. "
                "Occupé par un locataire mais libre juridiquement. "
                "Consignation par chèque de banque 10%. Orientation sud. "
                "Charges de copropriété 120 € par mois."
            ),
            "tribunal": "Tribunal Judiciaire de Bordeaux",
            "lawyer_name": "SELARL Exemple",
            "sale_date": "03/12/2026",
            "documents": [{"label": "Cahier des conditions de vente"}],
        }
    )

    features = sale["source_property_features"]
    assert features["floor"]["value"] == "rez-de-jardin"
    assert features["floor"]["subject_scope"] == "asset"
    assert features["heating"]["value"] == {
        "mode": "individual",
        "energy": "gas",
        "distribution": "radiators",
    }
    assert features["rooms_count"]["value"] == 4
    assert features["rooms_count"]["provenance"] == "explicit"
    assert features["bedrooms_count"]["value"] == 3
    assert features["occupancy_physical"]["value"] == "tenant_occupied"
    assert features["legal_possession"]["value"] == "free"
    assert features["coownership_charges"]["value"]["period"] == "par mois"
    assert features["dpe_class"]["value"] == "D"
    assert features["ges_class"]["value"] == "B"

    profile = sale["source_procedure_profile"]
    assert profile["family"] == "judicial"
    assert profile["verification_status"] == "explicit_text"
    assert profile["fields"]["tribunal"]["value"] == "Tribunal Judiciaire de Bordeaux"
    assert profile["fields"]["eligible_lawyer"]["value"]["name"] == "SELARL Exemple"
    assert profile["fields"]["consignation"]["value"]["rate_pct"] == 10
    assert profile["fields"]["conditions_documents"]["state"] == "present"

    observation = sale["source_field_observations"]["heating_mode"]
    assert observation["state"] == "observed"
    assert observation["value"] == "individual"
    assert observation["evidence"][0]["source_url"] == "https://example.test/judicial/6051"
    assert observation["evidence"][0]["grade"] == "A"
    assert sale["source_field_observations"]["heating_energy"]["value"] == "gas"
    assert sale["source_field_observations"]["heating_distribution"]["value"] == "radiators"
    audience_observation = sale["source_field_observations"]["sale_date"]
    assert audience_observation["evidence"][0]["grade"] == "B"


def test_plural_occupancy_and_legal_vacancy_keep_separate_states() -> None:
    sale = attach_source_property_features(
        {
            "source_url": "https://example.test/judicial/occupancy",
            "description": "Les biens sont occupés par le propriétaire et sa famille, mais libres juridiquement de toute occupation.",
        }
    )

    assert sale["source_property_features"]["occupancy_physical"]["value"] == "owner_occupied"
    assert sale["source_property_features"]["legal_possession"]["value"] == "free"


def test_conflicting_physical_occupancy_phrases_are_not_collapsed() -> None:
    sale = attach_source_property_features(
        {
            "source_url": "https://example.test/avoventes/occupancy",
            "description": "Le procès-verbal indique que les lieux ne sont pas occupés. La fiche indique actuellement occupée.",
        }
    )

    claim = sale["source_property_features"]["occupancy_physical"]
    assert claim["state"] == "conflict"
    assert claim["values"] == ["vacant", "occupied"]


def test_inferred_parser_room_count_retains_provenance() -> None:
    sale = attach_source_property_features(
        {
            "source_url": "https://example.test/rooms",
            "title": "Appartement avec séjour",
            "description": "Résidence proche des commerces.",
            "rooms_count": 5,
        }
    )

    claim = sale["source_property_features"]["rooms_count"]
    assert claim["value"] == 5
    assert claim["state"] == "inferred"
    assert claim["provenance"] == "inferred"
    observation = sale["source_field_observations"]["rooms_count"]
    assert observation["evidence"][0]["grade"] == "C"
    assert observation["inference"] == {
        "method": "parser_field_without_explicit_source_text",
        "input_fields": ["rooms_count"],
        "confidence": 0.6,
    }


def test_verified_procedure_decides_family_over_source_name() -> None:
    profile = build_procedure_profile(
        {
            "source_name": "info_encheres",
            "source_url": "https://example.test/notarial/1",
            "title": "Vente immobilière",
            "sale_procedure": {
                "venue_type": "notary",
                "verification_status": "verified",
            },
        }
    )

    assert profile["family"] == "notarial"
    assert profile["verification_status"] == "verified_metadata"
    assert profile["source_hint"] == "info_encheres"
    assert profile["priorities"] == ["notary_study", "sale_window", "bid", "visits", "coownership"]


def test_verified_state_framework_keeps_notarial_venue_as_complement() -> None:
    profile = build_procedure_profile(
        {
            "source_name": "cessions_etat",
            "source_url": "https://example.test/state/13c",
            "sale_procedure": {
                "venue_type": "notary",
                "legal_framework": "state_sale",
                "verification": {"status": "verified"},
            },
        }
    )

    assert profile["family"] == "state"
    assert profile["complementary_families"] == ["notarial"]
    assert profile["fields"]["notarial_modality"]["value"] == {"venue_type": "notary"}
    assert profile["priorities"][0] == "sale_method"


def test_source_name_alone_does_not_create_a_procedure() -> None:
    profile = build_procedure_profile(
        {
            "source_name": "cessions_etat",
            "source_url": "https://example.test/unknown/1",
            "title": "Terrain à vendre",
            "description": "Surface cadastrale à confirmer.",
        }
    )

    assert profile["family"] == "unknown"
    assert profile["verification_status"] == "pending_verification"
    assert profile["priorities"] == []


def test_diagnostic_document_does_not_satisfy_judicial_sale_conditions() -> None:
    sale = attach_source_property_features(
        {
            "source_url": "https://example.test/judicial/diagnostic-only",
            "description": "Tribunal judiciaire de Bordeaux. Diagnostic énergétique annexé.",
            "documents": [{"label": "Diagnostic de performance énergétique.pdf"}],
        }
    )

    profile = sale["source_procedure_profile"]
    assert profile["family"] == "judicial"
    assert profile["fields"]["conditions_documents"]["state"] == "unknown"
    assert sale["source_field_observations"]["conditions_sale"]["state"] == "unknown"


def test_recompute_reads_preserved_nested_raw_payload() -> None:
    sale = attach_source_property_features(
        {
            "raw_payload": {
                "source_url": "https://example.test/raw/1",
                "description": "Appartement T2, chauffage collectif au gaz, DPE C.",
                "source_blocks": {"tribunal": "Tribunal Judiciaire de Lille"},
                "tribunal": "Tribunal Judiciaire de Lille",
            }
        }
    )

    assert sale["source_property_features"]["heating"]["value"]["mode"] == "collective"
    assert sale["source_property_features"]["dpe_class"]["value"] == "C"
    assert sale["source_procedure_profile"]["family"] == "judicial"


def test_existing_typed_feature_tree_is_preserved_and_projected() -> None:
    sale = attach_source_property_features(
        {
            "source_url": "https://example.test/notaires/1",
            "description": "Appartement API",
            "source_property_features": {
                "floor": 4,
                "building_floors_count": 6,
                "energy": {
                    "dpe": {"class": "C", "value": 146, "unit": "kWh/m²/an"},
                    "ges": {"class": "A", "value": 5, "unit": "kgCO2/m²/an"},
                },
                "property_tax": {"amount_eur": 2941},
                "coownership": {"annual_charges_eur": 3956, "is_coownership": True},
                "surfaces": {
                    "aggregate_carrez_m2": 117.58,
                    "assets": [{"asset_id": "lot_1", "carrez_surface_m2": 117.58}],
                },
                "annexes": {"garage": True, "terrace": True},
                "media": {"images": ["https://example.test/photo.jpg"], "document_count": 3},
            },
            "source_evidence": {
                "dpe": {"source": "notaires_detail_api", "field": "consommation"},
            },
        }
    )

    features = sale["source_property_features"]
    observations = sale["source_field_observations"]
    assert features["floor"] == 4
    assert features["energy"]["dpe"]["value"] == 146
    assert observations["floor_number"]["value"] == 4
    assert observations["building_floor_count"]["value"] == 6
    assert observations["dpe_class"]["value"] == "C"
    assert observations["energy_consumption_kwh_m2_year"]["value"] == 146
    assert observations["emissions_kg_co2_m2_year"]["value"] == 5
    assert observations["property_tax_eur"]["value"] == 2941
    assert observations["coownership_charges_eur"]["value"] == 3956
    assert observations["surface_carrez_m2"]["value"] == 117.58
    assert observations["garage"]["value"] is True
    assert observations["terrace"]["value"] is True
    block = sale["source_blocks"]["listing_completeness"]
    assert "media" not in block["source_property_features"]
    assert "energy_consumption_kwh_m2_year" in block["source_field_observations"]

    catalogue_ids = {
        field["id"]
        for field in json.loads(
            (Path(__file__).resolve().parents[3] / "src/lib/listing-completeness-runtime.json").read_text()
        )["fields"]
    }
    assert set(observations).issubset(catalogue_ids)


def test_conflicting_structured_feature_values_are_retained_without_hashing() -> None:
    sale = attach_source_property_features(
        {
            "source_url": "https://example.test/notaires/bordeaux",
            "description": "Appartement avec chauffage individuel au gaz par radiateurs.",
            "source_property_features": {
                "technical": {"heating": "pompe à chaleur"},
            },
        }
    )

    observation = sale["source_field_observations"]["heating_energy"]
    assert observation["state"] == "conflict"
    assert "heat_pump" in observation["values"]
    assert "gas" in observation["values"]
    assert len(observation["conflicts"]) >= 2
    assert all(
        {"source_url", "excerpt", "captured_at", "value"}.issubset(row)
        for row in observation["conflicts"]
    )


def test_text_evidence_is_projected_when_typed_feature_has_same_value() -> None:
    sale = attach_source_property_features(
        {
            "source_url": "https://example.test/notaires/floor",
            "description": "Appartement situé au 4e étage.",
            "source_property_features": {"floor": 4},
        }
    )

    observation = sale["source_field_observations"]["floor_number"]
    assert observation["value"] == 4
    assert any(item["grade"] == "A" for item in observation["evidence"])


def test_annex_rdc_does_not_override_asset_floor() -> None:
    sale = attach_source_property_features(
        {
            "source_url": "https://example.test/notaires/annex-floor",
            "description": "Celliers au RDC. Appartement situé au 4ème étage.",
            "source_property_features": {"floor": 4},
        }
    )

    observation = sale["source_field_observations"]["floor_number"]
    assert observation["state"] == "observed"
    assert observation["value"] == 4
    assert "values" not in observation


def test_previous_profile_claims_do_not_replace_missing_source_text() -> None:
    sale = attach_source_property_features(
        {
            "source_url": "https://example.test/recompute/without-text",
            "description": "Appartement T3, 2 chambres. DPE C.",
        }
    )
    sale.pop("description")
    sale.pop("raw_text", None)
    sale.pop("title", None)

    attach_source_property_features(sale)

    assert "bedrooms_count" not in sale["source_property_features"]
    assert "dpe_class" not in sale["source_property_features"]
    assert "bedrooms_count" not in sale["source_field_observations"]
    assert "dpe_class" not in sale["source_field_observations"]


def test_non_mapping_source_blocks_are_preserved() -> None:
    sale = attach_source_property_features(
        {
            "source_url": "https://example.test/source-blocks",
            "source_blocks": ["retained raw block"],
            "description": "Maison.",
        }
    )

    assert sale["source_blocks"] == ["retained raw block"]


def test_attach_is_idempotent_and_does_not_reextract_its_projection() -> None:
    sale = attach_source_property_features(
        {
            "source_url": "https://example.test/idempotent",
            "title": "Appartement T2",
            "description": "DPE C. 2 pièces.",
        }
    )
    first = {
        key: sale[key]
        for key in (
            "source_property_features",
            "source_property_feature_evidence",
            "source_field_observations",
            "source_procedure_profile",
            "source_blocks",
        )
    }
    attach_source_property_features(sale)
    second = {key: sale[key] for key in first}
    assert second == first


def test_state_profile_only_uses_explicit_state_facts() -> None:
    profile = build_procedure_profile(
        {
            "source_name": "unrelated_aggregator",
            "source_url": "https://example.test/state/1",
            "title": "Cession de l'État - parcelle",
            "description": (
                "Appel d'offres de l'État. Service des domaines. "
                "Section AB parcelle 42. PLU zone N. Date limite : 12/11/2026."
            ),
            "documents": [{"label": "Cahier des conditions de cession"}],
            "source_blocks": {"cadastre": "Section AB parcelle 42", "urbanisme": "PLU zone N"},
        }
    )

    assert profile["family"] == "state"
    assert profile["fields"]["sale_method"]["state"] == "present"
    assert profile["fields"]["manager"]["value"] == "Service des domaines"
    assert profile["fields"]["cadastre"]["state"] == "present"
    assert profile["fields"]["urbanism"]["state"] == "present"
    assert profile["fields"]["deadline"]["state"] == "present"
    assert profile["fields"]["conditions"]["state"] == "present"
