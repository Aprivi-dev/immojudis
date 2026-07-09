from decimal import Decimal

from src.normalize import normalize_sale
from src.quality import (
    build_extraction_gap_report,
    build_quality_report,
    build_source_quality_report,
    format_extraction_gap_report,
    sale_extraction_gaps,
)


def test_build_quality_report_computes_percentages() -> None:
    sale = normalize_sale(
        {
            "source_name": "avoventes",
            "source_url": "https://avoventes.fr/enchere/quality",
            "tribunal": "TJ Bordeaux",
            "surface_m2": "80 m2",
            "rooms_count": 3,
            "bedrooms_count": 2,
            "visit_dates": ["Visite le 1 janvier"],
            "documents": [{"label": "Affiche", "url": "https://example.test/doc.pdf", "type": "pdf"}],
            "source_blocks": {"dpe": "F", "ges": "C"},
        }
    )
    sale.latitude = Decimal("44.84")
    sale.longitude = Decimal("-0.57")

    report = build_quality_report([sale])

    assert report["with_tribunal_pct"] == 100.0
    assert report["with_gps_pct"] == 100.0
    assert report["with_surface_pct"] == 100.0
    assert report["with_app_surface_pct"] == 0.0
    assert report["with_rooms_count_pct"] == 100.0
    assert report["with_bedrooms_count_pct"] == 100.0
    assert report["with_occupancy_status_pct"] == 0.0
    assert report["with_energy_diagnostics_pct"] == 100.0
    assert report["with_raw_text_enriched_pct"] == 0.0
    assert report["with_documents_pct"] == 100.0
    assert report["with_visit_dates_pct"] == 100.0


def test_build_source_quality_report_groups_coverage_by_source() -> None:
    avoventes_sale = normalize_sale(
        {
            "source_name": "avoventes",
            "source_url": "https://avoventes.fr/enchere/quality-source",
            "tribunal": "TJ Bordeaux",
            "surface_m2": "80 m2",
            "starting_price_eur": "100 000 euros",
            "sale_date": "10 septembre 2026 à 10h00",
            "lawyer_contact": "05 00 00 00 00",
            "documents": [{"label": "Affiche", "url": "https://example.test/doc.pdf", "type": "pdf"}],
            "source_blocks": {"mise_a_prix": "100 000 euros", "dpe": "F", "ges": "C"},
        }
    )
    licitor_sale = normalize_sale(
        {
            "source_name": "licitor",
            "source_url": "https://www.licitor.com/annonce/test/100.html",
            "title": "Maison",
        }
    )

    report = build_source_quality_report([avoventes_sale, licitor_sale])

    assert report["avoventes"]["total"] == 1
    assert report["avoventes"]["with_surface_pct"] == 100.0
    assert report["avoventes"]["with_starting_price_pct"] == 100.0
    assert report["avoventes"]["with_source_blocks_pct"] == 100.0
    assert report["avoventes"]["with_energy_diagnostics_pct"] == 100.0
    assert report["licitor"]["total"] == 1
    assert report["licitor"]["with_surface_pct"] == 0.0
    assert report["licitor"]["with_source_blocks_pct"] == 0.0
    assert report["licitor"]["with_energy_diagnostics_pct"] == 0.0


def test_sale_extraction_gaps_reports_required_and_recommended_missing_fields() -> None:
    sale = normalize_sale(
        {
            "source_name": "cabinet_generic",
            "source_url": "https://example.test/annonce/test/100.html",
            "title": "Maison",
            "raw_text": "Maison sans prix ni surface.",
        }
    )

    gaps = sale_extraction_gaps(sale)

    assert gaps["source_name"] == "cabinet_generic"
    assert gaps["required_missing"] == [
        "location",
        "surface",
        "starting_price",
        "sale_date",
        "source_blocks",
    ]
    assert "documents" in gaps["recommended_missing"]
    assert "tribunal" in gaps["recommended_missing"]


def test_sale_extraction_gaps_uses_licitor_recommended_profile() -> None:
    sale = normalize_sale(
        {
            "source_name": "licitor",
            "source_url": "https://www.licitor.com/annonce/test/100.html",
            "title": "Appartement",
            "address": "12 rue Test 75019 Paris",
            "surface_m2": "31,60 m2",
            "starting_price_eur": "100 000 euros",
            "sale_date": "9 juillet 2026 à 14h00",
            "raw_text": "Appartement de 31,60 m2 comprenant une pièce principale.",
            "source_blocks": {"description": "Appartement de 31,60 m2."},
        }
    )

    gaps = sale_extraction_gaps(sale)

    assert "documents" not in gaps["recommended_missing"]
    assert "images" not in gaps["recommended_missing"]
    assert "tribunal" in gaps["recommended_missing"]

    missing_surface_sale = normalize_sale(
        {
            "source_name": "licitor",
            "source_url": "https://www.licitor.com/annonce/test/101.html",
            "title": "Appartement",
            "address": "12 rue Test 75016 Paris",
            "starting_price_eur": "283 000 euros",
            "sale_date": "9 juillet 2026 à 14h00",
            "raw_text": "Appartement sans surface publiée.",
            "source_blocks": {"description": "Appartement sans surface publiée."},
        }
    )

    missing_surface_gaps = sale_extraction_gaps(missing_surface_sale)

    assert "surface" not in missing_surface_gaps["required_missing"]
    assert "surface" in missing_surface_gaps["recommended_missing"]


def test_sale_extraction_gaps_uses_petites_affiches_profile_for_public_surface_gaps() -> None:
    sale = normalize_sale(
        {
            "source_name": "petites_affiches",
            "source_url": "https://www.petitesaffiches.fr/encheres-immobilieres/vente/magasin-test.html",
            "title": "UN MAGASIN à La Trinité",
            "property_type": "Magasin",
            "city": "La Trinité",
            "address": "La Trinité",
            "starting_price_eur": "40 000 euros",
            "sale_date": "09/07/2026",
            "tribunal": "TJ DE NICE",
            "lawyer_name": "Maître Test",
            "raw_text": "UN MAGASIN à La Trinité. Mise à prix : 40 000 euros.",
            "source_blocks": {"titre": "UN MAGASIN à La Trinité", "mise_a_prix": "40 000"},
        }
    )

    gaps = sale_extraction_gaps(sale)

    assert gaps["required_missing"] == []
    assert "surface" in gaps["recommended_missing"]
    assert "rooms_count" not in gaps["recommended_missing"]


def test_sale_extraction_gaps_uses_info_encheres_profile_for_public_surface_gaps() -> None:
    sale = normalize_sale(
        {
            "source_name": "info_encheres",
            "source_url": "https://www.info-encheres.com/108241-d-vente-encheres-immobilieres-appartement-t3.html",
            "title": "Appartement T3 avec garage en sous-sol à ANNEMASSE (74)",
            "property_type": "Appartement",
            "address": "74100 Annemasse",
            "starting_price_eur": "80 000 euros",
            "sale_date": "09/07/2026",
            "raw_text": "Appartement T3 avec garage en sous-sol à ANNEMASSE (74)",
            "source_blocks": {"titre": "Appartement T3 avec garage en sous-sol"},
        }
    )

    gaps = sale_extraction_gaps(sale)

    assert gaps["required_missing"] == []
    assert "surface" in gaps["recommended_missing"]


def test_sale_extraction_gaps_uses_encheres_publiques_profile() -> None:
    sale = normalize_sale(
        {
            "source_name": "encheres_publiques",
            "source_url": "https://www.encheres-publiques.com/encheres/immobilier/maisons/sevran-93/test_129701",
            "title": "Une maison d'habitation située avenue des Primevères à Sevran",
            "property_type": "maisons",
            "city": "Sevran",
            "department": "93",
            "starting_price_eur": 77000,
            "sale_date": "2026-07-07T12:00:00+00:00",
            "tribunal": "Tribunal Judiciaire de BOBIGNY",
            "raw_text": "Une maison d'habitation située avenue des Primevères à Sevran. Mise a prix: 77 000.",
            "source_blocks": {"titre": "Une maison d'habitation située avenue des Primevères à Sevran"},
        }
    )

    gaps = sale_extraction_gaps(sale)

    assert "surface" not in gaps["required_missing"]
    assert "surface" in gaps["recommended_missing"]
    assert "documents" not in gaps["recommended_missing"]
    assert "images" not in gaps["recommended_missing"]
    assert "lawyer_contact" not in gaps["recommended_missing"]


def test_sale_extraction_gaps_uses_vench_profile_for_public_subscription_limits() -> None:
    sale = normalize_sale(
        {
            "source_name": "vench",
            "source_url": "https://www.vench.fr/vente-165184-une-maison-ondres.html",
            "title": "UNE MAISON DE 80 m² - Ondres",
            "property_type": "Maison",
            "city": "Ondres",
            "postal_code": "40440",
            "surface_m2": "80 m²",
            "starting_price_eur": "106 000 €",
            "sale_date": "11/06/2026 à 10:00",
            "tribunal": "Tribunal judiciaire de DAX",
            "visit_dates": ["04/06/2026 de 10h à 11h"],
            "occupancy_status": "Libre de toute occupation",
            "raw_text": "Maison de 80 m² libre de toute occupation.",
            "source_blocks": {"titre": "UNE MAISON DE 80 m²", "mise_a_prix": "106 000 €"},
            "source_images": ["https://www.vench.fr/images/vente-165184.jpg"],
        }
    )

    gaps = sale_extraction_gaps(sale)

    assert gaps["required_missing"] == []
    assert "documents" not in gaps["recommended_missing"]
    assert "lawyer_contact" not in gaps["recommended_missing"]
    assert "images" not in gaps["recommended_missing"]
    assert "gps" in gaps["recommended_missing"]
    assert "rooms_count" in gaps["recommended_missing"]


def test_sale_extraction_gaps_uses_cessions_etat_profile_for_unpublished_price_and_date() -> None:
    sale = normalize_sale(
        {
            "source_name": "cessions_etat",
            "source_url": "https://cessions.immobilier-etat.gouv.fr/biens/terrain-luzech",
            "title": "Terrain à vendre à Luzech",
            "property_type": "Foncier",
            "city": "Luzech",
            "department": "46",
            "surface_m2": "33 587 m2",
            "land_surface_m2": "33 587 m2",
            "raw_text": "Terrain à vendre à Luzech. Fini dans 55 jours.",
            "source_blocks": {"titre": "Terrain à vendre à Luzech", "surface": "33587"},
        }
    )

    gaps = sale_extraction_gaps(sale)

    assert gaps["required_missing"] == []
    assert "starting_price" in gaps["recommended_missing"]
    assert "sale_date" in gaps["recommended_missing"]


def test_sale_extraction_gaps_does_not_require_rooms_for_non_residential_assets() -> None:
    sale = normalize_sale(
        {
            "source_name": "avoventes",
            "source_url": "https://avoventes.fr/enchere/batiment-agricole",
            "title": "Bâtiment d'exploitation agricole et parcelles de terrain",
            "property_type": "Autres",
            "address": "01260 Haut-Valromey",
            "surface_m2": "2 464,70 m2",
            "starting_price_eur": "35 000 euros",
            "sale_date": "30 juin 2026 à 14h00",
            "raw_text": "Bâtiment agricole avec terrain, libre de toute occupation.",
            "source_blocks": {"description": "Bâtiment agricole avec terrain."},
        }
    )

    gaps = sale_extraction_gaps(sale)

    assert sale.property_type == "mixed"
    assert "tribunal" not in gaps["recommended_missing"]
    assert "rooms_count" not in gaps["recommended_missing"]

    building_sale = normalize_sale(
        {
            "source_name": "info_encheres",
            "source_url": "https://www.info-encheres.com/immeuble-test.html",
            "title": "Immeuble à usage d'hôtel",
            "property_type": "Immeuble",
            "address": "65100 Lourdes",
            "surface_m2": "698,55 m2",
            "starting_price_eur": "330 000 euros",
            "sale_date": "02/07/2026",
            "raw_text": "Immeuble à usage d'hôtel",
            "source_blocks": {"titre": "Immeuble à usage d'hôtel"},
        }
    )

    building_gaps = sale_extraction_gaps(building_sale)

    assert building_sale.property_type == "building"
    assert "rooms_count" not in building_gaps["recommended_missing"]


def test_build_extraction_gap_report_aggregates_missing_fields_by_source() -> None:
    complete_sale = normalize_sale(
        {
            "source_name": "avoventes",
            "source_url": "https://avoventes.fr/enchere/complete",
            "title": "Maison",
            "property_type": "Maison",
            "address": "12 rue Test 33000 Bordeaux",
            "surface_m2": "80 m2",
            "starting_price_eur": "100 000 euros",
            "sale_date": "10 septembre 2026 à 10h00",
            "raw_text": "Maison de 80 m2. Mise à prix : 100 000 euros.",
            "source_blocks": {"description": "Maison de 80 m2."},
        }
    )
    incomplete_sale = normalize_sale(
        {
            "source_name": "avoventes",
            "source_url": "https://avoventes.fr/enchere/incomplete",
            "title": "Maison",
            "property_type": "Maison",
            "raw_text": "Maison sans détails.",
        }
    )

    report = build_extraction_gap_report([complete_sale, incomplete_sale])

    assert report["total"] == 2
    assert report["required_gap_sales"] == 1
    assert report["sources"]["avoventes"]["required_gap_sales"] == 1
    assert report["sources"]["avoventes"]["required_missing"]["surface"] == 1
    assert report["sources"]["avoventes"]["required_missing"]["starting_price"] == 1
    lines = format_extraction_gap_report(report)
    assert any("extraction_source_avoventes_required_missing" in line for line in lines)
    assert any("https://avoventes.fr/enchere/incomplete" in line for line in lines)
