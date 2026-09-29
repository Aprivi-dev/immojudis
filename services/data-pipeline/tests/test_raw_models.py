from src.raw_models import validate_raw_sales


def test_validate_raw_sales_keeps_valid_source_payload() -> None:
    errors: list[str] = []

    valid = validate_raw_sales(
        "licitor",
        [
            {
                "source_name": "licitor",
                "source_url": "https://www.licitor.com/annonce/test/123.html",
                "title": "Appartement",
                "raw_text": "Mise à prix : 100 000 €",
            }
        ],
        errors,
    )

    assert len(valid) == 1
    assert errors == []


def test_validate_raw_sales_reports_missing_source_url_at_source_boundary() -> None:
    errors: list[str] = []

    valid = validate_raw_sales(
        "vench",
        [{"source_name": "vench", "title": "Maison"}],
        errors,
    )

    assert valid == []
    assert "source_url" in errors[0]


def test_validate_raw_sales_rejects_cross_source_url() -> None:
    errors: list[str] = []

    valid = validate_raw_sales(
        "avoventes",
        [
            {
                "source_name": "avoventes",
                "source_url": "https://www.licitor.com/annonce/123.html",
                "title": "Tentative de remplacement",
            }
        ],
        errors,
    )

    assert valid == []
    assert "source_url does not belong to source avoventes" in errors[0]


def test_agrasc_accepts_linked_operators_but_not_lookalike_origins():
    for host, accepted in [
        ("www.agorastore-immo.fr", True),
        ("agorastore-immo.fr", True),
        ("www.immo-interactif.fr", True),
        ("lesnotairesdutrocadero.fr", True),
        ("www.agorastore.fr", True),
        ("www.agorastore-immo.fr.evil.test", False),
    ]:
        errors = []
        path = {
            "www.agorastore-immo.fr": "/vente-occasion/maison-430647.aspx",
            "agorastore-immo.fr": "/vente-occasion/maison-430647.aspx",
            "www.immo-interactif.fr": "/encheres-en-ligne/maison/test/42",
            "lesnotairesdutrocadero.fr": "/appel_d_offre/domaine-dexception-antibes/",
            "www.agorastore.fr": "/ventes-occasions/vendeur/agrascimmo",
        }.get(host, "/vente")
        rows = validate_raw_sales(
            "agrasc", [dict(source_name="agrasc", source_url=f"https://{host}{path}", title="Maison")], errors
        )
        assert bool(rows) is accepted
        assert bool(errors) is not accepted

    errors = []
    rows = validate_raw_sales(
        "agrasc",
        [{"source_name": "agrasc", "source_url": "https://agrasc.gouv.fr/vente", "title": "Maison"}],
        errors,
    )
    assert len(rows) == 1
    assert errors == []


def test_agrasc_new_operator_hosts_are_restricted_to_public_listing_paths():
    for url in [
        "https://www.agorastore-immo.fr/vente",
        "https://www.immo-interactif.fr/vente",
        "https://lesnotairesdutrocadero.fr/contact",
        "https://www.agorastore.fr/ventes-occasions/vendeur/other-seller",
    ]:
        errors = []
        rows = validate_raw_sales(
            "agrasc", [dict(source_name="agrasc", source_url=url, title="Maison")], errors
        )
        assert rows == []
        assert "supported AGRASC public endpoint" in errors[0]
