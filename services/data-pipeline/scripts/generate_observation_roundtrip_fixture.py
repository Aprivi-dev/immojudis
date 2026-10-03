"""Generate the small Python -> TypeScript observation contract fixture.

The fixture deliberately contains one inferred value and one conflict.  It is
consumed by ``src/lib/listing-completeness-source-observations.test.ts`` so a
Python recompute cannot silently emit a shape that the TypeScript completeness
engine downgrades to ``unknown``.
"""

from __future__ import annotations

import json
from pathlib import Path

from src.extraction_profiles import attach_source_property_features
from src.sources.notaires import parse_notaires_detail_json

ROOT = Path(__file__).resolve().parents[3]
OUTPUT = ROOT / "src/lib/source-observations-roundtrip.fixture.json"
CAPTURED_AT = "2026-10-02T12:00:00Z"
NOTAIRES_BORDEAUX_URL = "https://www.immo-interactif.fr/encheres-en-ligne/maison/bordeaux-33/2074289"


def _case(case_id: str, raw_sale: dict, field: str, fields: list[str] | None = None) -> dict:
    enriched = attach_source_property_features(raw_sale)
    selected_fields = fields or [field]
    return {
        "id": case_id,
        "source_url": raw_sale["source_url"],
        "field": field,
        "fields": selected_fields,
        "source_field_observations": {
            key: enriched["source_field_observations"][key]
            for key in selected_fields
            if key in enriched["source_field_observations"]
        },
        "excluded_fields": [
            "occupancy_status"
        ] if "occupancy_status" not in enriched["source_field_observations"] else [],
    }


def _real_notaires_bordeaux_probe() -> dict:
    """Replay the captured Notaires API response and add probe wording.

    The response is a checked-in public capture; no live request is made.  The
    extra sentence exercises catalogue projection for facts that are often
    present in a text/PDF evidence layer while the API supplies the remaining
    typed facts.
    """

    response_path = ROOT / "docs/audits/sources-2026-10-02/dynamic/notaires-2074289-bordeaux-response.html"
    raw_sale = parse_notaires_detail_json(
        response_path.read_text(encoding="utf-8"),
        fallback={
            "source_name": "notaires",
            "source_url": NOTAIRES_BORDEAUX_URL,
            "captured_at": CAPTURED_AT,
        },
    )
    raw_sale["source_name"] = "notaires"
    raw_sale["source_url"] = NOTAIRES_BORDEAUX_URL
    raw_sale["captured_at"] = CAPTURED_AT
    probe = (
        " Audit de projection : chauffage collectif au gaz par radiateurs, situé au 5e étage. "
        "DPE C (178 kWh/m²/an), GES B (7 kgCO2/m²/an), réalisé le 30/06/2026. "
        "Taxe foncière : 1 213 €. Surface Carrez : 76,36 m². "
        "Le bien est libre juridiquement ; l'occupation physique reste à confirmer."
    )
    raw_sale["description"] = f"{probe} {raw_sale.get('description') or ''}"
    raw_sale["raw_text"] = f"{probe} {raw_sale.get('raw_text') or ''}"
    # The captured API has no aggregate Carrez value for this listing; the
    # probe sentence supplies one explicit source-text fact for the projection.
    raw_sale["carrez_surface_m2"] = 76.36
    return raw_sale


def main() -> None:
    cases = [
        _case(
            "inferred_rooms_count",
            {
                "source_name": "info_encheres",
                "source_url": "https://source.test/roundtrip/inferred",
                "title": "Appartement avec séjour",
                "description": "Résidence proche des commerces.",
                "rooms_count": 5,
                "captured_at": CAPTURED_AT,
            },
            "rooms_count",
        ),
        _case(
            "conflict_rooms_count",
            {
                "source_name": "info_encheres",
                "source_url": "https://source.test/roundtrip/conflict",
                "title": "Appartement T3",
                "description": "Vente appartement T3.",
                "source_property_features": {"rooms_count": 5},
                "captured_at": CAPTURED_AT,
            },
            "rooms_count",
        ),
        _case(
            "real_notaires_bordeaux",
            _real_notaires_bordeaux_probe(),
            "surface_habitable_m2",
            fields=[
                "surface_habitable_m2",
                "surface_carrez_m2",
                "floor_number",
                "heating_mode",
                "heating_energy",
                "heating_distribution",
                "dpe_class",
                "energy_consumption_kwh_m2_year",
                "ges_class",
                "emissions_kg_co2_m2_year",
                "dpe_established_at",
                "property_tax_eur",
            ],
        ),
    ]
    OUTPUT.write_text(
        json.dumps(
            {
                "schema_version": "source_field_observations.roundtrip.v1",
                "generated_by": str(Path(__file__).relative_to(ROOT)),
                "cases": cases,
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    print(OUTPUT)


if __name__ == "__main__":
    main()
