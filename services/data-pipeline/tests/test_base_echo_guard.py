"""Garde d'écho de la collecte (``src.base_reads``) : table de vérité.

Règle : un groupe de colonnes que la collecte n'a fait que relire en base n'est pas réécrit si la base a bougé
depuis. ``lue`` est ce que le passage a lu avant d'écrire, ``verrouillée`` la ligne lue sous le verrou de
publication, ``sortante`` la vente que la collecte s'apprête à écrire.
"""

from __future__ import annotations

from decimal import Decimal
from pathlib import Path

import pytest

from src import base_reads
from src.models import AuctionSale

SALE_ID = "99900000-1000-4000-8000-000000000001"
URL = "https://example.test/vente-echo"

LISTING = {
    "surface_m2": 50,
    "app_surface_m2": 50,
    "app_surface_kind": "habitable",
    "surface_source": "listing_text",
    "surface_confidence": 0.7,
    "land_surface_m2": None,
    "rooms_count": 2,
    "occupancy_status": "occupied",
    "visit_dates": [],
}
# Valeurs posées en base par un autre écrivain que la collecte, avec ses propres libellés.
POSED = {
    "surface_m2": 54,
    "app_surface_m2": 54,
    "app_surface_kind": "declared",
    "surface_source": "declared",
    "surface_confidence": 0.9,
    "land_surface_m2": 800,
    "rooms_count": 3,
    "occupancy_status": "rented",
    "visit_dates": [],
}
SURFACE = ("surface_m2", "app_surface_m2", "app_surface_kind", "surface_source", "surface_confidence")


@pytest.fixture(autouse=True)
def _fresh_reads():
    base_reads.reset()
    yield
    base_reads.reset()


def row(**values) -> dict:
    """Ligne telle que la base la rend (JSON) : toutes les colonnes des groupes, plus les surfaces voisines."""
    base = {"id": SALE_ID, "source_url": URL, "habitable_surface_m2": None, "carrez_surface_m2": None, **LISTING}
    return {**base, **values}


def sale(**values) -> AuctionSale:
    fields = {key: value for key, value in {**LISTING, **values}.items() if value is not None}
    return AuctionSale(id=SALE_ID, source_name="licitor", source_url=URL, **fields)


def surface(model: AuctionSale) -> tuple:
    return tuple(getattr(model, column) for column in SURFACE)


def test_withdrawal_during_the_run_does_not_come_back() -> None:
    """Retrait : la base tenait 54 m², 3 pièces, « loué », 800 m² de terrain ; elle est revenue à l'annonce."""
    base_reads.note(row(**POSED))
    base_reads.note(row())  # ligne verrouillée, après le retrait
    existing = sale()
    # La collecte a recopié les valeurs lues et recalculé les libellés de la surface.
    outgoing = sale(**{**POSED, "app_surface_kind": "built", "surface_source": "listing_text"})

    result = base_reads.suppress_echo(existing, outgoing)

    assert surface(result) == surface(existing)
    assert result.rooms_count == 2
    assert result.occupancy_status == "occupied"
    assert result.land_surface_m2 is None
    assert base_reads.suppressed_count() == 4
    # La vente de l'appelant n'est pas modifiée.
    assert outgoing.rooms_count == 3 and outgoing.app_surface_m2 == 54 and outgoing.land_surface_m2 == 800


def test_replacement_during_the_run_keeps_the_new_value() -> None:
    base_reads.note(row(rooms_count=3))
    base_reads.note(row(rooms_count=4))

    result = base_reads.suppress_echo(sale(rooms_count=4), sale(rooms_count=3))

    assert result.rooms_count == 4
    assert base_reads.suppressed_count() == 1


def test_first_posing_during_the_run_is_not_overwritten_by_the_stale_listing_value() -> None:
    base_reads.note(row())
    base_reads.note(row(**POSED))
    existing = sale(**POSED)

    result = base_reads.suppress_echo(existing, sale())

    assert surface(result) == surface(existing)
    assert (result.rooms_count, result.occupancy_status) == (3, "rented")
    # L'annonce ne donnait pas de terrain : une valeur sortante vide n'est jamais remplacée.
    assert result.land_surface_m2 is None


def test_steady_state_writes_exactly_what_the_collection_computed() -> None:
    """Régime permanent : la base n'a pas bougé, même quand ses valeurs viennent d'un autre écrivain."""
    base_reads.note(row(**POSED))
    base_reads.note(row(**POSED))
    outgoing = sale(**{**POSED, "app_surface_kind": "built", "surface_source": "listing_text"})

    result = base_reads.suppress_echo(sale(**POSED), outgoing)

    assert result is outgoing
    assert base_reads.suppressed_count() == 0


def test_a_normalisation_rule_change_goes_through_when_the_base_did_not_move() -> None:
    base_reads.note(row())
    base_reads.note(row())
    outgoing = sale(app_surface_kind="built", surface_confidence=0.8)

    result = base_reads.suppress_echo(sale(), outgoing)

    assert result is outgoing
    assert result.app_surface_kind == "built"


def test_an_empty_outgoing_value_is_never_replaced() -> None:
    """Un garde-fou de normalisation doit pouvoir vider une valeur, même si la base a bougé."""
    base_reads.note(row(**POSED))
    base_reads.note(row())
    outgoing = sale(
        surface_m2=None, app_surface_m2=None, app_surface_kind=None, surface_source=None, surface_confidence=None,
        rooms_count=None, occupancy_status=None,
    )

    result = base_reads.suppress_echo(sale(), outgoing)

    assert result is outgoing
    assert result.rooms_count is None and result.app_surface_m2 is None and result.occupancy_status is None
    assert base_reads.suppressed_count() == 0


def test_a_value_the_base_never_returned_is_never_replaced() -> None:
    """Une vraie nouvelle valeur de la source passe, même si la base a bougé."""
    base_reads.note(row(**POSED))
    base_reads.note(row())
    outgoing = sale(surface_m2=61, app_surface_m2=61, rooms_count=5, occupancy_status="vacant", land_surface_m2=420)

    result = base_reads.suppress_echo(sale(), outgoing)

    assert result is outgoing
    assert base_reads.suppressed_count() == 0


def test_surface_derived_from_the_habitable_surface_read_in_base_is_an_echo() -> None:
    """La surface affichée recalculée depuis l'habitable relue n'est pas une valeur nouvelle."""
    empty = dict.fromkeys(SURFACE)
    base_reads.note(row(**empty, habitable_surface_m2=50.0))
    posed = {key: POSED[key] for key in SURFACE}
    base_reads.note(row(**posed, habitable_surface_m2=50.0))
    existing = sale(**posed)
    outgoing = sale(surface_m2=None, app_surface_m2=50, app_surface_kind="habitable", surface_source=None,
                    surface_confidence=None)

    result = base_reads.suppress_echo(existing, outgoing)

    assert surface(result) == surface(existing)


def test_surface_group_is_taken_whole_with_its_three_labels() -> None:
    base_reads.note(row(**POSED))
    base_reads.note(row())
    existing = sale()
    outgoing = sale(surface_m2=None, app_surface_m2=54, app_surface_kind="built", surface_source="document",
                    surface_confidence=0.95)

    result = base_reads.suppress_echo(existing, outgoing)

    assert surface(result) == (50, 50, "habitable", "listing_text", Decimal("0.7"))


def test_land_surface_read_then_removed_from_the_base_does_not_come_back() -> None:
    base_reads.note(row(land_surface_m2=800))
    base_reads.note(row(land_surface_m2=None))

    result = base_reads.suppress_echo(sale(), sale(land_surface_m2=800))

    assert result.land_surface_m2 is None
    assert base_reads.suppressed_count() == 1


def test_a_group_that_did_not_move_is_left_alone_when_another_one_moved() -> None:
    """Le terrain a bougé, pas la surface : la surface recalculée par la collecte passe telle quelle."""
    base_reads.note(row(land_surface_m2=800, app_surface_m2=800, surface_m2=None, app_surface_kind="land"))
    base_reads.note(row(land_surface_m2=None, app_surface_m2=800, surface_m2=None, app_surface_kind="land"))
    existing = sale(surface_m2=None, app_surface_m2=800, app_surface_kind="land")
    outgoing = sale(surface_m2=None, app_surface_m2=800, app_surface_kind="terrain", land_surface_m2=800)

    result = base_reads.suppress_echo(existing, outgoing)

    assert result.land_surface_m2 is None
    assert result.app_surface_kind == "terrain"


def test_visit_dates_read_then_emptied_do_not_come_back() -> None:
    visits = ["2026-12-01 à 10h", "2026-12-08 à 14h"]
    base_reads.note(row(visit_dates=visits))
    base_reads.note(row(visit_dates=[]))
    existing = sale()

    # L'ordre des dates n'en fait pas une valeur nouvelle.
    result = base_reads.suppress_echo(existing, sale(visit_dates=list(reversed(visits))))

    assert result.visit_dates == []
    assert result.visit_dates is not existing.visit_dates
    assert base_reads.suppressed_count() == 1


def test_a_row_never_read_during_the_run_is_written_as_is() -> None:
    outgoing = sale(**POSED)

    assert base_reads.suppress_echo(sale(), outgoing) is outgoing

    # Lue une seule fois, sous le verrou : rien ne dit qu'elle a bougé.
    base_reads.note(row())
    assert base_reads.suppress_echo(sale(), outgoing) is outgoing
    assert base_reads.suppressed_count() == 0


def test_a_sale_without_identifier_is_written_as_is() -> None:
    base_reads.note(row(rooms_count=3))
    base_reads.note(row(rooms_count=4))
    new_sale = AuctionSale(source_name="licitor", source_url=URL, rooms_count=4)
    outgoing = sale(rooms_count=3)

    assert base_reads.suppress_echo(new_sale, outgoing) is outgoing


def test_two_successive_reads_that_differ_mark_the_base_as_moved() -> None:
    """Première lecture 3 (index du passage), seconde 4 (hydratation) : la valeur 3 recopiée ne revient pas."""
    base_reads.note(row(rooms_count=3))
    base_reads.note(row(rooms_count=4))
    base_reads.note(row(rooms_count=4))  # ligne verrouillée, égale à la dernière lecture

    result = base_reads.suppress_echo(sale(rooms_count=4), sale(rooms_count=3))

    assert result.rooms_count == 4


def test_two_successive_reads_that_agree_change_nothing() -> None:
    for _ in range(3):
        base_reads.note(row(rooms_count=3))
    outgoing = sale(rooms_count=3)

    assert base_reads.suppress_echo(sale(rooms_count=3), outgoing) is outgoing


def test_decimal_and_float_are_the_same_value() -> None:
    """La base rend 54.0 (JSON), le modèle porte ``Decimal('54.00')`` : même état, même valeur."""
    base_reads.note(row(surface_m2=54.0, app_surface_m2=54.0, surface_confidence=0.70))
    base_reads.note(row(surface_m2=54, app_surface_m2=54, surface_confidence=0.7))
    outgoing = sale(surface_m2=Decimal("54.00"), app_surface_m2=Decimal("54.0"))
    assert base_reads.suppress_echo(sale(surface_m2=54, app_surface_m2=54), outgoing) is outgoing

    base_reads.note(row(surface_m2=50, app_surface_m2=50))
    result = base_reads.suppress_echo(sale(), sale(surface_m2=Decimal("54.00"), app_surface_m2=Decimal("54.0")))

    assert (result.surface_m2, result.app_surface_m2) == (50, 50)


def test_the_process_own_write_is_not_a_move_of_the_base() -> None:
    """Publication anticipée puis finale : la seconde lecture rend ce que ce processus a écrit."""
    base_reads.note(row())
    base_reads.note(row())
    written = row(app_surface_kind="built", surface_confidence=0.8)
    base_reads.note_written(SALE_ID, written)
    base_reads.note(written)  # ligne verrouillée de la publication finale
    # Entre les deux publications, la lecture d'un document a confirmé la surface : seuls les libellés changent.
    outgoing = sale(app_surface_kind="built", surface_source="pdf", surface_confidence=0.95)

    result = base_reads.suppress_echo(sale(app_surface_kind="built", surface_confidence=0.8), outgoing)

    assert result is outgoing


def test_a_move_after_the_process_own_write_is_still_seen() -> None:
    base_reads.note(row(rooms_count=3))
    base_reads.note(row(rooms_count=3))
    base_reads.note_written(SALE_ID, row(rooms_count=3))
    base_reads.note(row(rooms_count=2))

    result = base_reads.suppress_echo(sale(rooms_count=2), sale(rooms_count=3))

    assert result.rooms_count == 2


def test_a_move_stays_known_for_the_rest_of_the_run() -> None:
    """La vente brute garde la valeur lue : renormalisée plus tard dans le passage, elle ne revient pas non plus."""
    base_reads.note(row(rooms_count=3))
    base_reads.note(row(rooms_count=4))
    first = base_reads.suppress_echo(sale(rooms_count=4), sale(rooms_count=3))
    base_reads.note_written(SALE_ID, row(rooms_count=first.rooms_count))
    base_reads.note(row(rooms_count=4))

    second = base_reads.suppress_echo(sale(rooms_count=4), sale(rooms_count=3))

    assert second.rooms_count == 4
    # Un même écho retenu plusieurs fois dans le passage compte une fois.
    assert base_reads.suppressed_count() == 1


def test_a_write_to_a_row_never_read_leaves_no_trace() -> None:
    base_reads.note_written(SALE_ID, row(rooms_count=3))
    base_reads.note(row(rooms_count=2))
    outgoing = sale(rooms_count=3)

    assert base_reads.suppress_echo(sale(rooms_count=2), outgoing) is outgoing


def test_the_merge_target_gives_the_values_when_it_is_no_longer_the_locked_row() -> None:
    """Deux ventes du même lot fusionnent dans la même ligne : la seconde reprend le résultat de la première."""
    base_reads.note(row(rooms_count=3))
    base_reads.note(row(rooms_count=4))
    merged_with_first = sale(rooms_count=5)  # la première vente apportait une vraie valeur

    result = base_reads.suppress_echo(merged_with_first, sale(rooms_count=3))

    assert result.rooms_count == 5


def test_labels_alone_are_taken_from_the_base_without_counting_an_echo() -> None:
    base_reads.note(row(**{**LISTING, "app_surface_kind": "habitable"}))
    base_reads.note(row(**{**LISTING, "app_surface_kind": "declared"}))
    existing = sale(app_surface_kind="declared")

    result = base_reads.suppress_echo(existing, sale(app_surface_kind="built"))

    assert result.app_surface_kind == "declared"
    assert base_reads.suppressed_count() == 0


def test_a_partial_row_gives_values_but_no_state() -> None:
    """Une ligne lue sans toutes les colonnes d'un groupe ne dit pas si ce groupe a bougé."""
    base_reads.note({"id": SALE_ID, "rooms_count": 3})
    base_reads.note({"id": SALE_ID, "surface_m2": 54})  # ni les pièces, ni les quatre autres colonnes de surface
    base_reads.note({"source_url": URL, "rooms_count": 9})  # sans identifiant : ignorée
    outgoing = sale(rooms_count=3)
    assert base_reads.suppress_echo(sale(rooms_count=3), outgoing) is outgoing

    base_reads.note({"id": SALE_ID, "rooms_count": 4})

    assert base_reads.suppress_echo(sale(rooms_count=4), sale(rooms_count=3)).rooms_count == 4


def test_reset_forgets_reads_and_counter() -> None:
    base_reads.note(row(rooms_count=3))
    base_reads.note(row(rooms_count=4))
    base_reads.suppress_echo(sale(rooms_count=4), sale(rooms_count=3))
    assert base_reads.suppressed_count() == 1

    base_reads.reset()

    outgoing = sale(rooms_count=3)
    assert base_reads.suppressed_count() == 0
    assert base_reads.suppress_echo(sale(rooms_count=4), outgoing) is outgoing


def test_groups_cover_the_five_fields_and_nothing_else() -> None:
    assert {group.name: group.columns for group in base_reads.GROUPS} == {
        "surface": SURFACE,
        "land": ("land_surface_m2",),
        "rooms": ("rooms_count",),
        "occupancy": ("occupancy_status",),
        "visits": ("visit_dates",),
    }
    assert all(set(group.value_columns) <= set(group.columns) for group in base_reads.GROUPS)
    assert all(column in AuctionSale.model_fields for group in base_reads.GROUPS for column in group.family)


def test_the_guard_names_no_registry_object() -> None:
    """La garde compare des colonnes ; elle ne sait rien de ce qui a fait bouger la base."""
    source = Path(base_reads.__file__).read_text(encoding="utf-8").casefold()

    for word in ("held", "claim", "fact_", "decision", "project_sale", "registre"):
        assert word not in source, word
