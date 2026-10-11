import pytest

from src.court_competence import (
    COURT_LABEL_ASSIGNMENT_METHOD,
    CompetentCourtAssignment,
    OfficialCourt,
    OfficialCourtLabelIndex,
    tribunal_reference_rows,
)
from src.normalize import normalize_sale
from src.tribunal import fill_tribunal


def _court(code: str, city: str, department: str, srj: str) -> OfficialCourt:
    return OfficialCourt(
        court_code=code,
        court_name=f"TJ {city}",
        official_court_name=f"Tribunal judiciaire de {city}",
        court_origin_code="1",
        court_srj_code=srj,
        court_department=department,
        court_city=city,
    )


# A small, explicit slice of the national registry. The real index is built
# from the Justice open-data files by CourtCompetenceReference.
NATIONAL_COURTS = OfficialCourtLabelIndex(
    [
        _court("bordeaux", "Bordeaux", "33", "1"),
        _court("justice_tj_1_200", "Paris", "75", "200"),
        _court("justice_tj_1_190", "Nice", "06", "190"),
        _court("justice_tj_1_150", "Lyon", "69", "150"),
        _court("justice_tj_1_210", "Marseille", "13", "210"),
        _court("justice_tj_1_212", "Évry-Courcouronnes", "91", "212"),
        _court("justice_tj_1_39", "Bourg-en-Bresse", "01", "39"),
    ]
)


@pytest.fixture(autouse=True)
def national_court_registry(monkeypatch):
    monkeypatch.setattr("src.tribunal.resolve_court_by_label", NATIONAL_COURTS.resolve)


def test_fill_tribunal_from_city_mapping() -> None:
    sale = normalize_sale(
        {
            "source_name": "avoventes",
            "source_url": "https://avoventes.fr/enchere/biganos",
            "city": "Biganos",
            "department": "33",
        }
    )
    fill_tribunal(sale)

    assert sale.tribunal == "TJ Bordeaux"
    assert sale.tribunal_code == "bordeaux"
    assert "tribunal_competence_unverified" in sale.quality_flags


def test_fill_tribunal_prefers_verified_insee_competence(
    monkeypatch,
) -> None:
    sale = normalize_sale(
        {
            "source_name": "avoventes",
            "source_url": "https://example.test/haut-valromey",
            "department": "01",
            "city": "Haut-Valromey",
            "tribunal": "TJ Saintes",
            "raw_payload": {
                "geocode": {
                    "provider": "ban_geoplateforme",
                    "accepted": True,
                    "citycode": "01187",
                }
            },
        }
    )
    sale.raw_payload["geocode"] = {
        "provider": "ban_geoplateforme",
        "accepted": True,
        "citycode": "01187",
    }
    assignment = CompetentCourtAssignment(
        insee_code="01187",
        commune_name="HAUT VALROMEY",
        court_code="justice_tj_1_39",
        court_name="TJ Bourg-en-Bresse",
        official_court_name="Tribunal judiciaire de Bourg-en-Bresse",
        court_origin_code="1",
        court_srj_code="39",
        court_department="01",
        court_city="Bourg-en-Bresse",
        reference_sha256="b" * 64,
    )
    monkeypatch.setattr("src.tribunal.resolve_competent_court", lambda _sale: assignment)

    fill_tribunal(sale)

    assert sale.tribunal == "TJ Bourg-en-Bresse"
    assert sale.tribunal_code == "justice_tj_1_39"
    assert sale.raw_payload["tribunal_assignment"] == assignment.evidence()
    assert "tribunal_competence_unverified" not in sale.quality_flags


def test_fill_tribunal_does_not_guess_when_verified_insee_is_unresolved(
    monkeypatch,
) -> None:
    sale = normalize_sale(
        {
            "source_name": "avoventes",
            "source_url": "https://example.test/bordeaux",
            "department": "33",
            "city": "Bordeaux",
            "tribunal": "TJ Bordeaux",
            "raw_payload": {
                "geocode": {
                    "provider": "ban_geoplateforme",
                    "accepted": True,
                    "citycode": "33063",
                }
            },
        }
    )
    sale.raw_payload["geocode"] = {
        "provider": "ban_geoplateforme",
        "accepted": True,
        "citycode": "33063",
    }
    monkeypatch.setattr("src.tribunal.resolve_competent_court", lambda _sale: None)

    fill_tribunal(sale)

    assert sale.tribunal is None
    assert sale.tribunal_code is None
    assert "tribunal_competence_unresolved" in sale.quality_flags


def test_fill_tribunal_prefers_explicit_raw_text() -> None:
    sale = normalize_sale(
        {
            "source_name": "licitor",
            "source_url": "https://www.licitor.com/annonce/1.html",
            "city": "Ondres",
            "department": "40",
            "raw_text": "Tribunal Judiciaire de Bayonne",
        }
    )

    assert fill_tribunal(sale).tribunal == "TJ Bayonne"


def test_fill_tribunal_rejects_out_of_department_known_tribunal() -> None:
    sale = normalize_sale(
        {
            "source_name": "avoventes",
            "source_url": "https://example.test/tribunal-lyon",
            "department": "33",
            "city": "Bordeaux",
            "tribunal": "TJ Lyon",
            "raw_text": "Annonce sans mention explicite de Lyon.",
        }
    )

    fill_tribunal(sale)

    # The explicit label names a real national court, so its code is kept for
    # traceability, but the department contradiction stays flagged.
    assert sale.tribunal == "TJ Lyon"
    assert sale.tribunal_code == "justice_tj_1_150"
    assert "tribunal_inconsistent" in sale.quality_flags
    assert "tribunal_competence_unverified" in sale.quality_flags


def test_fill_tribunal_keeps_explicit_national_tribunal() -> None:
    sale = normalize_sale(
        {
            "source_name": "encheres_publiques",
            "source_url": "https://example.test/tribunal-paris",
            "department": "75",
            "city": "Paris",
            "tribunal": "Tribunal Judiciaire de PARIS",
        }
    )

    fill_tribunal(sale)

    assert sale.tribunal == "TJ Paris"
    assert sale.tribunal_code == "justice_tj_1_200"
    assert "tribunal_inconsistent" not in sale.quality_flags
    assert "tribunal_competence_unverified" in sale.quality_flags
    evidence = sale.raw_payload["tribunal_label_assignment"]
    assert evidence["mapping_method"] == COURT_LABEL_ASSIGNMENT_METHOD
    assert evidence["source_label"] == "Tribunal Judiciaire de PARIS"
    assert evidence["label_key"] == "paris"


def test_fill_tribunal_canonicalizes_generic_tj_de_text() -> None:
    sale = normalize_sale(
        {
            "source_name": "petites_affiches",
            "source_url": "https://example.test/tribunal-nice",
            "department": "06",
            "city": "Nice",
            "tribunal": "TJ DE NICE",
        }
    )

    fill_tribunal(sale)

    assert sale.tribunal == "TJ Nice"
    assert sale.tribunal_code == "justice_tj_1_190"
    assert "tribunal_inconsistent" not in sale.quality_flags


def test_fill_tribunal_canonicalizes_noisy_tribunal_text() -> None:
    sale = normalize_sale(
        {
            "source_name": "avoventes",
            "source_url": "https://example.test/noisy-tribunal",
            "department": "33",
            "city": "Floirac",
            "tribunal": "TJ BORDEAUX CAHIER DES CHARGES ET CONDITIONS DE VENTE",
        }
    )

    fill_tribunal(sale)

    assert sale.tribunal == "TJ Bordeaux"
    assert sale.tribunal_code == "bordeaux"
    assert "tribunal_inconsistent" not in sale.quality_flags


def test_fill_tribunal_does_not_infer_tj_for_voluntary_notarial_sale() -> None:
    sale = normalize_sale(
        {
            "source_name": "encheres_publiques",
            "source_url": "https://example.test/vente-volontaire",
            "department": "33",
            "city": "Bordeaux",
            "raw_text": (
                "Type de vente: En ligne - Vente volontaire. "
                "OFFICE NOTARIAL DU JEU DE PAUME. En ligne sur immo-interactif.fr."
            ),
        }
    )

    fill_tribunal(sale)

    assert sale.tribunal is None
    assert sale.tribunal_code is None
    assert "non_judicial_sale_context" in sale.quality_flags


def test_fill_tribunal_keeps_explicit_judicial_context_even_with_notaire_word() -> None:
    sale = normalize_sale(
        {
            "source_name": "avoventes",
            "source_url": "https://example.test/judicial-explicit",
            "department": "33",
            "city": "Bordeaux",
            "raw_text": "Tribunal Judiciaire de Bordeaux. Vente sur saisie immobilière. Notaire indiqué pour formalités.",
        }
    )

    fill_tribunal(sale)

    assert sale.tribunal == "TJ Bordeaux"
    assert sale.tribunal_code == "bordeaux"


def test_fill_tribunal_resolves_national_label_without_accents_or_hyphens() -> None:
    sale = normalize_sale(
        {
            "source_name": "petites_affiches",
            "source_url": "https://example.test/tribunal-evry",
            "department": "91",
            "city": "Evry",
            "tribunal": "TJ Evry Courcouronnes",
        }
    )

    fill_tribunal(sale)

    assert sale.tribunal == "TJ Évry-Courcouronnes"
    assert sale.tribunal_code == "justice_tj_1_212"
    # The FK target is upserted from the label evidence, like a verified assignment.
    assert tribunal_reference_rows([sale]) == [
        {
            "code": "justice_tj_1_212",
            "canonical_name": "TJ Évry-Courcouronnes",
            "department": "91",
            "city": "Évry-Courcouronnes",
            "aliases": ["Tribunal judiciaire de Évry-Courcouronnes", "TJ Évry-Courcouronnes"],
        }
    ]
    sale.tribunal_code = "autre"
    assert tribunal_reference_rows([sale]) == []


def test_fill_tribunal_resolves_explicit_court_from_source_text() -> None:
    sale = normalize_sale(
        {
            "source_name": "licitor",
            "source_url": "https://example.test/texte-marseille",
            "department": "13",
            "city": "Marseille",
            "raw_text": "Vente aux enchères publiques au Tribunal Judiciaire de Marseille.",
        }
    )

    fill_tribunal(sale)

    assert sale.tribunal == "TJ Marseille"
    assert sale.tribunal_code == "justice_tj_1_210"
    assert "tribunal_competence_unverified" in sale.quality_flags


def test_fill_tribunal_never_guesses_a_court_from_an_unknown_label() -> None:
    sale = normalize_sale(
        {
            "source_name": "vench",
            "source_url": "https://example.test/tribunal-inconnu",
            "department": "13",
            "city": "Marseille",
            "tribunal": "TJ Inconnu-sur-Mer",
        }
    )

    fill_tribunal(sale)

    assert sale.tribunal_code is None
    assert "tribunal_label_assignment" not in sale.raw_payload
    # No department or city default either.
    assert sale.tribunal != "TJ Marseille"


def test_fill_tribunal_keeps_verified_insee_court_over_a_conflicting_label(monkeypatch) -> None:
    sale = normalize_sale(
        {
            "source_name": "licitor",
            "source_url": "https://example.test/conflit",
            "department": "01",
            "city": "Haut-Valromey",
            "tribunal": "TJ Lyon",
        }
    )
    sale.raw_payload["geocode"] = {"provider": "ban_geoplateforme", "accepted": True, "citycode": "01187"}
    sale.raw_payload["tribunal_label_assignment"] = {"court_code": "stale"}
    assignment = CompetentCourtAssignment(
        insee_code="01187",
        commune_name="HAUT VALROMEY",
        court_code="justice_tj_1_39",
        court_name="TJ Bourg-en-Bresse",
        official_court_name="Tribunal judiciaire de Bourg-en-Bresse",
        court_origin_code="1",
        court_srj_code="39",
        court_department="01",
        court_city="Bourg-en-Bresse",
        reference_sha256="b" * 64,
    )
    monkeypatch.setattr("src.tribunal.resolve_competent_court", lambda _sale: assignment)

    fill_tribunal(sale)

    assert sale.tribunal_code == "justice_tj_1_39"
    assert "tribunal_label_assignment" not in sale.raw_payload
    assert "tribunal_competence_unverified" not in sale.quality_flags


def test_fill_tribunal_keeps_legacy_behaviour_when_registry_is_unavailable(monkeypatch) -> None:
    monkeypatch.setattr("src.tribunal.resolve_court_by_label", lambda _label: None)
    sale = normalize_sale(
        {
            "source_name": "petites_affiches",
            "source_url": "https://example.test/sans-referentiel",
            "department": "13",
            "city": "Marseille",
            "tribunal": "TJ Marseille",
        }
    )

    fill_tribunal(sale)

    assert sale.tribunal == "TJ Marseille"
    assert sale.tribunal_code is None
    assert "tribunal_competence_unverified" in sale.quality_flags
