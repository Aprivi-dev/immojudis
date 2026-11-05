"""Contenances cadastrales : audit du 03/11/2026 (textes réels, ventes citées par leur préfixe d'id)."""

from decimal import Decimal

from src.land_parcels import read_parcel_land_surface

_20CB5DBC_PAGE = (
    "cadastrés dite commune sous les références suivantes : - section Q n° 1160 d'une contenance de 00ha 01a "
    "12ca - section Q n° 1162 d'une contenance de 00ha 00a 17ca - section Q n° 672 d'une contenance de 01ha 24a "
    "08ca - section Q n° 673 d'une contenance de 00ha 02a 80ca Total 01ha 28a 17ca Le bien est actuellement occupé."
)
_20CB5DBC_PDF = (
    "-Parcelle Section Q N° 1160, d’une contenance de 00ha01a12ca -Parcelle Section Q N° 1162, d’une contenance "
    "de 00ha00a17ca -Parcelle Section Q N° 672, d’une contenance de 01ha24a08ca -Parcelle Section Q N° 673, "
    "d’une contenance de 00ha02a80ca."
)


def _value(text: str) -> Decimal | None:
    reading = read_parcel_land_surface(text)
    return None if reading is None else reading.value


def test_20cb5dbc_written_total_wins_over_the_first_parcel() -> None:
    assert _value(_20CB5DBC_PAGE) == Decimal("12817")


def test_20cb5dbc_complete_parcel_list_without_total_is_summed() -> None:
    assert _value(_20CB5DBC_PDF) == Decimal("12817")


def test_ff075a99_complete_list_of_the_sold_lot_is_summed() -> None:
    text = (
        "LOT N° 1 de la vente : Les parcelles de terre cadastrées sur la commune de GENSAC section B lieudit CAMP "
        "GRAND N° 264 pour une contenance de 29 a 52 ca, N° 266 pour une contenance de 28 a 47 ca, N° 267 pour une "
        "contenance de 27 a 60 ca, N° 272 pour une contenance de 70 a 97 ca Ces parcelles sont exploitées par l’EARL"
    )
    assert _value(text) == Decimal("15656")


def test_1859704f_parcel_without_contenance_withholds_the_land() -> None:
    text = (
        "LOT N° 2 de la vente : Les parcelles de terre situées sur la commune de LAFITOLE cadastrés section D "
        "lieudit BEDATS N° 365 pour une contenance de 24 a 00 ca, N° 366 lieudit BEDATS Ces parcelles sont exploitées"
    )
    reading = read_parcel_land_surface(text)
    assert reading is not None
    assert reading.value is None


def test_d0880e3d_centiares_alone_are_read() -> None:
    text = (
        "édifiée sur une parcelle cadastrée anciennement Section E, Numéro 717, et actuellement Section AA, Numéro "
        "120, pour une contenance de 25 centiares, composée : - Rez de chaussée : buanderie (17,63m²), wc (1,11m²)"
    )
    assert _value(text) == Decimal("25")


def test_ebafd1c4_ares_et_centiares_are_read() -> None:
    text = (
        "Le tout représente une surface bâtie de 259,86 m² et cadastré : Section AD n°168 « 14 rue de la "
        "République » 04 a et 69 ca L’immeuble est inoccupé"
    )
    assert _value(text) == Decimal("469")


def test_51f54ff5_residence_contenance_is_not_the_land_of_a_coproperty_lot() -> None:
    text = (
        "dans un ensemble immobilier dénommé « LES IFS », cadastré section AR n° 388, 412, 414, 624, 625 et 626, "
        "pour une conte- nance totale de 10ha 18a 23ca, LOT N° 1001 : Une unité d’hébergement située au 2ème étage "
        "du bâtiment, comprenant une entrée. Et les 154/10.000èmes des parties communes générales"
    )
    reading = read_parcel_land_surface(text)
    assert reading is not None
    assert reading.value is None


def test_repeated_identical_lists_agree() -> None:
    assert _value(f"{_20CB5DBC_PAGE}\n{'x' * 400}\n{_20CB5DBC_PDF}") == Decimal("12817")


def test_text_without_cadastral_units_gives_nothing() -> None:
    assert read_parcel_land_surface("Il y a 3 a été vendu ; maison de 90 m²") is None
