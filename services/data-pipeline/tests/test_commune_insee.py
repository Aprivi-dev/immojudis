"""Code commune (INSEE) posé sur la vente : arrondissements ramenés à la commune, repli par code postal et nom."""

from __future__ import annotations

import pytest

from src import commune_insee, geocode, municipality_location
from src.commune_insee import commune_codes, record_sale_commune, resolve_sale_commune
from src.normalize import normalize_sale
from src.reference_data.names import normalize_commune_name

COMMUNES = [
    {"code_insee": "75056", "name_normalized": "paris", "department_code": "75",
     "postal_codes": ["75001", "75008", "75016", "75116"], "latitude": 48.8566, "longitude": 2.3522},
    {"code_insee": "13055", "name_normalized": "marseille", "department_code": "13",
     "postal_codes": ["13001", "13008"], "latitude": 43.2965, "longitude": 5.3698},
    {"code_insee": "69123", "name_normalized": "lyon", "department_code": "69",
     "postal_codes": ["69001", "69003"], "latitude": 45.764, "longitude": 4.8357},
    {"code_insee": "37261", "name_normalized": "tours", "department_code": "37",
     "postal_codes": ["37000", "37100", "37200"], "latitude": 47.3941, "longitude": 0.6848},
    {"code_insee": "27701", "name_normalized": "le vaudreuil", "department_code": "27",
     "postal_codes": ["27100"], "latitude": 49.2656, "longitude": 1.2095},
    {"code_insee": "27691", "name_normalized": "val de reuil", "department_code": "27",
     "postal_codes": ["27100"], "latitude": 49.2689, "longitude": 1.2085},
    {"code_insee": "97411", "name_normalized": "saint denis", "department_code": "974",
     "postal_codes": ["97400"], "latitude": -20.88, "longitude": 55.45},
    {"code_insee": "93066", "name_normalized": "saint denis", "department_code": "93",
     "postal_codes": ["93200"], "latitude": 48.93, "longitude": 2.35},
    {"code_insee": "97105", "name_normalized": "basse terre", "department_code": "971",
     "postal_codes": ["97100"], "latitude": 16.0, "longitude": -61.7},
    {"code_insee": "49007", "name_normalized": "angers", "department_code": "49",
     "postal_codes": ["49000", "49100"], "latitude": 47.47, "longitude": -0.55},
    {"code_insee": "01001", "name_normalized": "homonyme", "department_code": "01",
     "postal_codes": ["01000"], "latitude": 46.2, "longitude": 5.2},
    {"code_insee": "01002", "name_normalized": "homonyme", "department_code": "01",
     "postal_codes": ["01000"], "latitude": 46.3, "longitude": 5.3},
]


@pytest.fixture
def communes(monkeypatch):
    monkeypatch.setattr(municipality_location, "load_communes", lambda: COMMUNES)
    municipality_location.reset_cache()
    yield
    municipality_location.reset_cache()


def _sale(**overrides):
    raw = {
        "source_name": "vench",
        "source_url": "https://www.vench.fr/vente-1-appartement.html",
        "address": "27100 Le Vaudreuil",
        "city": "Le Vaudreuil",
        "postal_code": "27100",
        "property_type": "apartment",
        "starting_price_eur": "20 000 €",
        **overrides,
    }
    return normalize_sale(raw)


def _accepted(sale, *, citycode, provider="ban_geoplateforme"):
    sale.raw_payload["geocode"] = {
        "provider": provider,
        "accepted": True,
        "type": "housenumber",
        "citycode": citycode,
        "latitude": 48.0,
        "longitude": 2.0,
    }
    return sale


class TestCommuneCodes:
    @pytest.mark.parametrize(
        ("code", "expected"),
        [
            ("37261", ("37261", None)),
            ("2A004", ("2A004", None)),
            ("2b033", ("2B033", None)),
            ("97411", ("97411", None)),
            ("75056", ("75056", None)),
            ("75101", ("75056", "75101")),
            ("75108", ("75056", "75108")),
            ("75120", ("75056", "75120")),
            ("13201", ("13055", "13201")),
            ("13216", ("13055", "13216")),
            ("69381", ("69123", "69381")),
            ("69389", ("69123", "69389")),
        ],
    )
    def test_arrondissements_are_brought_back_to_their_commune(self, code, expected):
        assert commune_codes(code) == expected

    @pytest.mark.parametrize("code", ["", None, "3726", "372611", "ABCDE", "7512A"])
    def test_something_that_is_not_a_commune_code_is_refused(self, code):
        assert commune_codes(code) is None

    def test_neighbouring_codes_are_not_arrondissements(self):
        # 69123 (Lyon) et 13055 (Marseille) sont les communes, pas des arrondissements ; un code de forme valide hors
        # des plages d'arrondissements reste un code de commune ordinaire (il n'est jamais ramené à une autre commune).
        assert commune_codes("69123") == ("69123", None)
        assert commune_codes("13055") == ("13055", None)
        for code in ("75100", "75121", "13200", "13217", "69380", "69390"):
            assert commune_codes(code) == (code, None)


class TestResolveSaleCommune:
    def test_the_accepted_geocoding_result_gives_the_commune_and_keeps_the_arrondissement(self, communes):
        sale = _accepted(_sale(city="Paris", postal_code="75008", address="1 rue de Rivoli, 75008 Paris"), citycode="75108")
        assert resolve_sale_commune(sale) == {
            "insee": "75056", "arrondissement_insee": "75108", "source": "geocode",
        }

    def test_an_ordinary_commune_has_no_arrondissement(self, communes):
        sale = _accepted(_sale(city="Tours", postal_code="37000"), citycode="37261")
        assert resolve_sale_commune(sale) == {
            "insee": "37261", "arrondissement_insee": None, "source": "geocode",
        }

    def test_a_commune_centre_placed_without_network_is_marked_as_the_reference_table(self, communes):
        sale = _accepted(_sale(), citycode="27701", provider=municipality_location.PROVIDER)
        assert resolve_sale_commune(sale)["source"] == "reference_communes"

    def test_marseille_and_lyon_arrondissements(self, communes):
        marseille = _accepted(_sale(city="Marseille", postal_code="13008"), citycode="13208")
        lyon = _accepted(_sale(city="Lyon", postal_code="69003"), citycode="69383")
        assert resolve_sale_commune(marseille)["insee"] == "13055"
        assert resolve_sale_commune(marseille)["arrondissement_insee"] == "13208"
        assert resolve_sale_commune(lyon)["insee"] == "69123"
        assert resolve_sale_commune(lyon)["arrondissement_insee"] == "69383"

    def test_a_rejected_geocoding_result_is_never_used(self, communes):
        sale = _sale(city="Tours", postal_code="37000")
        sale.raw_payload["geocode"] = {"provider": "ban_geoplateforme", "accepted": False, "citycode": "99999"}
        # Le repli par code postal et nom donne Tours.
        assert resolve_sale_commune(sale) == {
            "insee": "37261", "arrondissement_insee": None, "source": "reference_communes",
        }

    def test_without_geocoding_the_postal_code_and_name_give_the_commune(self, communes):
        sale = _sale()
        assert resolve_sale_commune(sale) == {
            "insee": "27701", "arrondissement_insee": None, "source": "reference_communes",
        }

    def test_the_fallback_keeps_the_arrondissement_of_the_postal_code(self, communes):
        paris = _sale(city="Paris", postal_code="75016", address="Paris 16e")
        marseille = _sale(city="Marseille", postal_code="13008", address="Marseille 8e")
        lyon = _sale(city="Lyon", postal_code="69003", address="Lyon 3e")
        assert resolve_sale_commune(paris) == {
            "insee": "75056", "arrondissement_insee": "75116", "source": "reference_communes",
        }
        assert resolve_sale_commune(marseille)["arrondissement_insee"] == "13208"
        assert resolve_sale_commune(lyon)["arrondissement_insee"] == "69383"

    def test_an_ambiguous_commune_is_never_guessed(self, communes):
        assert resolve_sale_commune(_sale(city="Homonyme", postal_code="01000")) is None

    def test_an_unknown_commune_gives_nothing(self, communes):
        assert resolve_sale_commune(_sale(city="Nulle-Part", postal_code="99999")) is None

    def test_a_geocoding_result_without_a_valid_code_falls_back_to_the_reference_table(self, communes):
        sale = _accepted(_sale(city="Tours", postal_code="37000"), citycode="???")
        assert resolve_sale_commune(sale)["insee"] == "37261"


class TestDifficultAddresses:
    """Libellés de ville que le repli par nom ne comprenait pas (rapport donnees-geographiques du 27/10/2026)."""

    @pytest.mark.parametrize(
        ("city", "postal", "department", "insee", "arrondissement"),
        [
            ("Paris 8ème", "75008", "75", "75056", "75108"),
            ("Paris 16e", "75116", "75", "75056", "75116"),
            ("Paris XVIème", "75016", "75", "75056", "75116"),
            ("Marseille 8e", "13008", "13", "13055", "13208"),
            ("Lyon 3e arrondissement", "69003", "69", "69123", "69383"),
            ("Lyon 3ème arrondissement", "69003", "69", "69123", "69383"),
            # Code postal générique : l'arrondissement vient du nombre écrit dans la ville.
            ("Marseille 8e", "13000", "13", "13055", "13208"),
            ("Lyon 3e", "69000", "69", "69123", "69383"),
            ("Paris 12e", "75000", "75", "75056", "75112"),
            # Cedex : le code postal n'est pas celui de la commune.
            ("Lyon Cedex 03", "69421", "69", "69123", None),
            ("Lyon Cedex 03", "69421", None, "69123", None),
            ("Saint-Denis La Réunion", "97400", "974", "97411", None),
            ("Saint-Denis (974)", "97400", "974", "97411", None),
            ("Basse-Terre", "97100", "971", "97105", None),
        ],
    )
    def test_the_commune_is_found_whatever_the_label_adds_to_its_name(
        self, communes, city, postal, department, insee, arrondissement
    ):
        sale = _sale(city=city, postal_code=postal, department=department, address=f"{postal} {city}")

        assert resolve_sale_commune(sale) == {
            "insee": insee, "arrondissement_insee": arrondissement, "source": "reference_communes",
        }

    def test_find_commune_cleans_the_name_before_the_search(self, communes):
        assert municipality_location.find_commune("Paris 8ème", "75008", "75")["code_insee"] == "75056"

    def test_homonyms_stay_ambiguous_without_a_department(self, communes):
        assert municipality_location.find_commune("Saint-Denis", None, None) is None
        assert municipality_location.find_commune("Saint-Denis La Réunion", None, "974")["code_insee"] == "97411"

    def test_a_generic_postal_code_does_not_guess_in_another_department(self, communes):
        assert municipality_location.find_commune("Lyon 3e", "69000", "13") is None

    def test_postal_code_75116_gives_the_16th_arrondissement_like_the_web(self, communes):
        sale = _sale(city="Paris", postal_code="75116", address="75116 Paris")
        assert resolve_sale_commune(sale)["arrondissement_insee"] == "75116"
        assert commune_insee._arrondissement_from_postal_code("75056", "75116") == "75116"
        assert commune_insee._arrondissement_from_postal_code("75056", "75016") == "75116"
        assert commune_insee._arrondissement_from_postal_code("75056", "75017") == "75117"


class TestGeocodedCodeCrossCheck:
    def test_a_code_of_another_department_is_discarded_and_flagged(self, communes):
        sale = _accepted(_sale(city="Tours", postal_code="37000", department="37"), citycode="49007")

        assert resolve_sale_commune(sale) == {
            "insee": "37261", "arrondissement_insee": None, "source": "reference_communes", "mismatch": True,
        }

    def test_a_code_of_another_commune_of_the_same_department_is_discarded(self, communes):
        sale = _accepted(_sale(city="Tours", postal_code="37000", department="37"), citycode="37018")

        resolved = resolve_sale_commune(sale)

        assert resolved["insee"] == "37261" and resolved["mismatch"] is True

    def test_a_discarded_code_with_no_fallback_gives_nothing(self, communes):
        sale = _accepted(_sale(city="Nulle-Part", postal_code="99999", department="37"), citycode="49007")

        assert resolve_sale_commune(sale) is None

    def test_a_code_that_agrees_is_kept_without_flag(self, communes):
        sale = _accepted(_sale(city="Tours", postal_code="37000", department="37"), citycode="37261")

        assert resolve_sale_commune(sale) == {
            "insee": "37261", "arrondissement_insee": None, "source": "geocode",
        }

    @pytest.mark.parametrize("department", [None, "", "Indre-et-Loire"])
    def test_an_unknown_department_does_not_discard_a_code(self, communes, department):
        sale = _accepted(_sale(city="Nulle-Part", postal_code="99999"), citycode="49007")
        sale.department = department

        assert resolve_sale_commune(sale)["insee"] == "49007"

    def test_an_unreadable_reference_table_keeps_the_geocoded_code(self, communes, monkeypatch):
        monkeypatch.setattr(municipality_location, "load_communes", lambda: (_ for _ in ()).throw(OSError("down")))
        municipality_location.reset_cache()
        sale = _accepted(_sale(city="Tours", postal_code="37000", department="37"), citycode="37261")

        assert resolve_sale_commune(sale)["insee"] == "37261"

    def test_corsica_old_department_20_accepts_2a_and_2b(self, communes):
        assert commune_insee._same_department("2A004", "20") and commune_insee._same_department("2B033", "20")
        assert not commune_insee._same_department("33063", "20")


class TestRecordSaleCommune:
    def test_it_writes_the_commune_in_the_raw_payload_and_nowhere_else(self, communes):
        sale = _accepted(_sale(city="Paris", postal_code="75008"), citycode="75108")
        before = sale.model_dump(exclude={"raw_payload"})
        assert record_sale_commune(sale) is True
        assert sale.raw_payload["commune"] == {
            "insee": "75056", "arrondissement_insee": "75108", "source": "geocode",
        }
        # Aucune colonne de la vente ne bouge : seul raw_payload porte le code.
        assert sale.model_dump(exclude={"raw_payload"}) == before

    def test_it_is_idempotent(self, communes):
        sale = _accepted(_sale(city="Tours", postal_code="37000"), citycode="37261")
        assert record_sale_commune(sale) is True
        assert record_sale_commune(sale) is False

    def test_a_known_code_is_never_erased_by_an_unreadable_reference_table(self, communes, monkeypatch):
        sale = _sale()
        sale.raw_payload["commune"] = {"insee": "27701", "arrondissement_insee": None, "source": "reference_communes"}
        monkeypatch.setattr(municipality_location, "load_communes", lambda: [])
        municipality_location.reset_cache()
        assert record_sale_commune(sale) is False
        assert sale.raw_payload["commune"]["insee"] == "27701"

    def test_it_never_raises(self, communes, monkeypatch):
        def boom(*_args):
            raise RuntimeError("base illisible")

        monkeypatch.setattr(commune_insee, "find_commune", boom)
        assert record_sale_commune(_sale()) is False


class TestGeocodingPlacesTheCommune:
    def test_geocode_sale_records_the_commune_even_without_network(self, communes, monkeypatch):
        monkeypatch.setenv("GEOCODE_ENABLED", "false")
        sale = geocode.geocode_sale(_sale(city="Tours", postal_code="37000", address="37000 Tours"))
        assert sale.raw_payload["commune"]["insee"] == "37261"

    def test_locate_sale_by_cadastre_records_it_too(self, communes, monkeypatch):
        monkeypatch.setenv("GEOCODE_ENABLED", "false")
        sale = geocode.locate_sale_by_cadastre(_sale())
        assert sale.raw_payload["commune"] == {
            "insee": "27701", "arrondissement_insee": None, "source": "reference_communes",
        }


class TestLookupNameMirroredInSql:
    """`app_private.commune_lookup_name` (migration 20261108120000) reproduit `commune_lookup_name` ; son test pgTAP (780)
    retrouve ces valeurs. La colonne stockée `name_normalized` reste celle de `normalize_commune_name`."""

    @pytest.mark.parametrize(
        ("label", "expected"),
        [
            ("Paris 8ème", "paris"),
            ("Paris 8e", "paris"),
            ("Paris 1er", "paris"),
            ("Paris XVIème", "paris"),
            ("Paris 15", "paris"),
            ("Marseille 8e", "marseille"),
            ("Lyon 3e arrondissement", "lyon"),
            ("Lyon 3ème arrondissement", "lyon"),
            ("Lyon Cedex 03", "lyon"),
            ("Villeurbanne CEDEX", "villeurbanne"),
            ("Saint-Denis La Réunion", "saint denis"),
            ("Saint-Denis (974)", "saint denis"),
            ("Saint-Pierre Martinique", "saint pierre"),
            ("La Réunion", "la reunion"),
            ("Les 2 Alpes", "les 2 alpes"),
            ("Le Mans", "le mans"),
            ("Basse-Terre", "basse terre"),
            ("Cedex", "cedex"),
            ("", ""),
        ],
    )
    def test_the_lookup_name(self, label, expected):
        from src.reference_data.names import commune_lookup_name

        assert commune_lookup_name(label) == expected

    def test_the_stored_name_is_not_touched(self):
        assert normalize_commune_name("Paris 8ème") == "paris 8eme"


class TestNameNormalisationMirroredInSql:
    """`app_private.normalize_commune_name` (migration 20261106100100) reproduit ce normaliseur : on fige ici ce
    que le pipeline produit pour une ligature, que la migration et son test pgTAP (753) doivent retrouver."""

    def test_a_ligature_is_a_separator_not_a_transliteration(self):
        assert normalize_commune_name("Cœuvres-et-Valsery") == "c uvres et valsery"
        assert normalize_commune_name("Æ") == ""

    def test_the_other_rules_the_sql_function_mirrors(self):
        assert normalize_commune_name("Saint-Étienne") == "saint etienne"
        assert normalize_commune_name("ST-QUENTIN") == "saint quentin"
        assert normalize_commune_name("Ste Marie-aux-Mines") == "sainte marie aux mines"
