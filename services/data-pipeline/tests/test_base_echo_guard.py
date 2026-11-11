"""Garde d'écho de la collecte (``src.base_reads``) : table de vérité.

Règle : un groupe de colonnes que la collecte n'a fait que relire en base n'est pas réécrit si la base a bougé
depuis. ``read`` est une lecture sans verrou (détails connus du passage), ``locked`` la ligne lue sous le verrou de
publication, ``wrote`` ce que la base a gardé d'une écriture validée de ce processus, ``sortante`` la vente que la
collecte s'apprête à écrire.
"""

from __future__ import annotations

import logging
from copy import deepcopy
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


def read(**values) -> None:
    base_reads.note(row(**values))


def locked(**values) -> None:
    base_reads.note_locked(row(**values))


def wrote(**values) -> None:
    """Une écriture validée de ce processus : ce que la base en a gardé devient l'état de référence."""
    with base_reads.written_scope():
        base_reads.stage_written([row(**values)])


def sale(payload: dict | None = None, **values) -> AuctionSale:
    fields = {key: value for key, value in {**LISTING, **values}.items() if value is not None}
    return AuctionSale(id=SALE_ID, source_name="licitor", source_url=URL, raw_payload=payload or {}, **fields)


def surface(model: AuctionSale) -> tuple:
    return tuple(getattr(model, column) for column in SURFACE)


# --- la règle -------------------------------------------------------------------------------------------------------------


def test_withdrawal_during_the_run_does_not_come_back() -> None:
    """Retrait : la base tenait 54 m², 3 pièces, « loué », 800 m² de terrain ; elle est revenue à l'annonce."""
    read(**POSED)
    locked()  # ligne verrouillée, après le retrait
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
    read(rooms_count=3)
    locked(rooms_count=4)

    result = base_reads.suppress_echo(sale(rooms_count=4), sale(rooms_count=3))

    assert result.rooms_count == 4
    assert base_reads.suppressed_count() == 1


def test_first_posing_during_the_run_is_not_overwritten_by_the_stale_listing_value() -> None:
    read()
    locked(**POSED)
    existing = sale(**POSED)

    result = base_reads.suppress_echo(existing, sale())

    assert surface(result) == surface(existing)
    assert (result.rooms_count, result.occupancy_status) == (3, "rented")
    # L'annonce ne donnait pas de terrain : une valeur sortante vide n'est jamais remplacée.
    assert result.land_surface_m2 is None


def test_steady_state_writes_exactly_what_the_collection_computed() -> None:
    """Régime permanent : la base n'a pas bougé, même quand ses valeurs viennent d'un autre écrivain."""
    read(**POSED)
    locked(**POSED)
    outgoing = sale(**{**POSED, "app_surface_kind": "built", "surface_source": "listing_text"})

    result = base_reads.suppress_echo(sale(**POSED), outgoing)

    assert result is outgoing
    assert base_reads.suppressed_count() == 0
    assert base_reads.moved_groups(SALE_ID) == frozenset()


def test_a_normalisation_rule_change_goes_through_when_the_base_did_not_move() -> None:
    read()
    locked()
    outgoing = sale(app_surface_kind="built", surface_confidence=0.8)

    result = base_reads.suppress_echo(sale(), outgoing)

    assert result is outgoing
    assert result.app_surface_kind == "built"


def test_an_empty_outgoing_value_is_never_replaced() -> None:
    """Un garde-fou de normalisation doit pouvoir vider une valeur, même si la base a bougé."""
    read(**POSED)
    locked()
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
    read(**POSED)
    locked()
    outgoing = sale(surface_m2=61, app_surface_m2=61, rooms_count=5, occupancy_status="vacant", land_surface_m2=420)

    result = base_reads.suppress_echo(sale(), outgoing)

    assert result is outgoing
    assert base_reads.suppressed_count() == 0


def test_surface_derived_from_the_habitable_surface_read_in_base_is_an_echo() -> None:
    """La surface affichée recalculée depuis l'habitable relue n'est pas une valeur nouvelle."""
    empty = dict.fromkeys(SURFACE)
    read(**empty, habitable_surface_m2=50.0)
    posed = {key: POSED[key] for key in SURFACE}
    locked(**posed, habitable_surface_m2=50.0)
    existing = sale(**posed)
    outgoing = sale(surface_m2=None, app_surface_m2=50, app_surface_kind="habitable", surface_source=None,
                    surface_confidence=None)

    result = base_reads.suppress_echo(existing, outgoing)

    assert surface(result) == surface(existing)


def test_surface_group_is_taken_whole_with_its_three_labels() -> None:
    read(**POSED)
    locked()
    existing = sale()
    outgoing = sale(surface_m2=None, app_surface_m2=54, app_surface_kind="built", surface_source="document",
                    surface_confidence=0.95)

    result = base_reads.suppress_echo(existing, outgoing)

    assert surface(result) == (50, 50, "habitable", "listing_text", Decimal("0.7"))


def test_land_surface_read_then_removed_from_the_base_does_not_come_back() -> None:
    read(land_surface_m2=800)
    locked(land_surface_m2=None)

    result = base_reads.suppress_echo(sale(), sale(land_surface_m2=800))

    assert result.land_surface_m2 is None
    assert base_reads.suppressed_count() == 1


def test_a_group_that_did_not_move_is_left_alone_when_another_one_moved() -> None:
    """Le terrain a bougé, pas la surface : la surface recalculée par la collecte passe telle quelle."""
    read(land_surface_m2=800, app_surface_m2=800, surface_m2=None, app_surface_kind="land")
    locked(land_surface_m2=None, app_surface_m2=800, surface_m2=None, app_surface_kind="land")
    existing = sale(surface_m2=None, app_surface_m2=800, app_surface_kind="land")
    outgoing = sale(surface_m2=None, app_surface_m2=800, app_surface_kind="terrain", land_surface_m2=800)

    result = base_reads.suppress_echo(existing, outgoing)

    assert result.land_surface_m2 is None
    assert result.app_surface_kind == "terrain"
    assert base_reads.moved_groups(SALE_ID) == {"land"}


def test_visit_dates_read_then_emptied_do_not_come_back() -> None:
    visits = ["2026-12-01 à 10h", "2026-12-08 à 14h"]
    read(visit_dates=visits)
    locked(visit_dates=[])
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
    locked()
    assert base_reads.suppress_echo(sale(), outgoing) is outgoing
    assert base_reads.suppressed_count() == 0


def test_a_sale_without_identifier_is_written_as_is() -> None:
    read(rooms_count=3)
    locked(rooms_count=4)
    new_sale = AuctionSale(source_name="licitor", source_url=URL, rooms_count=4)
    outgoing = sale(rooms_count=3)

    assert base_reads.suppress_echo(new_sale, outgoing) is outgoing


def test_decimal_and_float_are_the_same_value() -> None:
    """La base rend 54.0 (JSON), le modèle porte ``Decimal('54.00')`` : même état, même valeur."""
    read(surface_m2=54.0, app_surface_m2=54.0, surface_confidence=0.70)
    locked(surface_m2=54, app_surface_m2=54, surface_confidence=Decimal("0.7"))
    outgoing = sale(surface_m2=Decimal("54.00"), app_surface_m2=Decimal("54.0"))
    assert base_reads.moved_groups(SALE_ID) == frozenset()
    assert base_reads.suppress_echo(sale(surface_m2=54, app_surface_m2=54), outgoing) is outgoing

    locked(surface_m2=50, app_surface_m2=50)
    result = base_reads.suppress_echo(sale(), sale(surface_m2=Decimal("54.00"), app_surface_m2=Decimal("54.0")))

    assert (result.surface_m2, result.app_surface_m2) == (50, 50)


def test_the_merge_target_gives_the_values_when_it_is_no_longer_the_locked_row() -> None:
    """Deux ventes du même lot fusionnent dans la même ligne : la seconde reprend le résultat de la première."""
    read(rooms_count=3)
    locked(rooms_count=4)
    merged_with_first = sale(rooms_count=5)  # la première vente apportait une vraie valeur

    result = base_reads.suppress_echo(merged_with_first, sale(rooms_count=3))

    assert result.rooms_count == 5


# --- qui dit que la base a bougé ------------------------------------------------------------------------------------------


def test_only_a_read_under_the_lock_says_that_the_base_moved() -> None:
    read(rooms_count=3)
    read(rooms_count=4)
    assert base_reads.moved_groups(SALE_ID) == frozenset()

    locked(rooms_count=4)

    assert base_reads.moved_groups(SALE_ID) == {"rooms"}


def test_the_first_read_of_the_run_is_the_reference_when_two_reads_differ() -> None:
    """Première lecture 3 (index du passage), seconde 4 (hydratation) : la valeur 3 recopiée ne revient pas."""
    read(rooms_count=3)
    read(rooms_count=4)
    locked(rooms_count=4)  # égale à la dernière lecture, pas à la première

    result = base_reads.suppress_echo(sale(rooms_count=4), sale(rooms_count=3))

    assert result.rooms_count == 4


def test_reads_that_agree_change_nothing() -> None:
    read(rooms_count=3)
    read(rooms_count=3)
    locked(rooms_count=3)
    outgoing = sale(rooms_count=3)

    assert base_reads.suppress_echo(sale(rooms_count=3), outgoing) is outgoing
    assert base_reads.moved_groups(SALE_ID) == frozenset()


def test_the_process_own_write_is_not_a_move_of_the_base() -> None:
    """Publication anticipée puis finale : la seconde lecture rend ce que ce processus a écrit."""
    read()
    locked()
    wrote(app_surface_kind="built", surface_confidence=0.8)
    locked(app_surface_kind="built", surface_confidence=0.8)  # ligne verrouillée de la publication finale
    # Entre les deux publications, la lecture d'un document a confirmé la surface : seuls les libellés changent.
    outgoing = sale(app_surface_kind="built", surface_source="pdf", surface_confidence=0.95)

    result = base_reads.suppress_echo(sale(app_surface_kind="built", surface_confidence=0.8), outgoing)

    assert result is outgoing
    assert base_reads.moved_groups(SALE_ID) == frozenset()


def test_what_the_base_kept_is_the_reference_not_what_was_sent() -> None:
    """La base retient 54 m² quand la collecte envoie 50 : la lecture suivante rend 54, personne n'a agi."""
    read(**POSED)
    locked(**POSED)
    wrote(**POSED)  # ``returning`` : la ligne gardée, alors que 50 m² ont été envoyés
    locked(**POSED)

    assert base_reads.moved_groups(SALE_ID) == frozenset()
    outgoing = sale(surface_m2=50, app_surface_m2=50)
    assert base_reads.suppress_echo(sale(**POSED), outgoing) is outgoing


def rolled_back(**values) -> None:
    """Une écriture dont la transaction est annulée : la portée sort par une erreur."""
    with pytest.raises(RuntimeError, match="annulée"), base_reads.written_scope():
        base_reads.stage_written([row(**values)])
        raise RuntimeError("transaction annulée")


def test_a_write_whose_transaction_was_rolled_back_is_not_a_move() -> None:
    """L'écriture est notée en attente ; la transaction échoue ; la reprise relit la ligne d'avant."""
    read()
    locked()
    rolled_back(app_surface_kind="built", surface_source="pdf", surface_confidence=0.95)
    locked()

    assert base_reads.moved_groups(SALE_ID) == frozenset()
    outgoing = sale(app_surface_kind="built", surface_source="pdf", surface_confidence=0.95)
    assert base_reads.suppress_echo(sale(), outgoing) is outgoing


def test_a_rolled_back_write_does_not_hide_a_later_move() -> None:
    read(rooms_count=3)
    locked(rooms_count=3)
    rolled_back(rooms_count=3, occupancy_status="vacant")
    locked(rooms_count=2)  # ni la ligne d'avant, ni celle de l'écriture annulée

    assert base_reads.moved_groups(SALE_ID) == {"rooms"}


def test_a_rolled_back_write_leaves_nothing_that_a_later_writer_could_be_taken_for() -> None:
    """Annulée, l'écriture « loué » ne compte plus : si un autre écrit « loué » ensuite, c'est bien un mouvement."""
    read(occupancy_status="occupied")
    rolled_back(occupancy_status="rented")
    locked(occupancy_status="occupied")
    assert base_reads.moved_groups(SALE_ID) == frozenset()

    locked(occupancy_status="rented")

    assert base_reads.moved_groups(SALE_ID) == {"occupancy"}


def test_a_validated_write_followed_by_a_rolled_back_one_is_still_the_reference() -> None:
    """Écriture validée (publication), puis écriture annulée de la même ligne, sans lecture entre les deux."""
    read(surface_confidence=0.7)
    wrote(surface_confidence=0.8)
    rolled_back(surface_confidence=0.9)
    locked(surface_confidence=0.8)  # la base est dans l'état de la première écriture : personne d'autre n'a écrit

    assert base_reads.moved_groups(SALE_ID) == frozenset()


def test_a_committed_write_read_back_before_its_confirmation_is_not_a_move() -> None:
    """Un autre fil relit la ligne juste après la validation, avant que le premier soit sorti de sa portée."""
    read()
    locked()
    with base_reads.written_scope():
        base_reads.stage_written([row(app_surface_kind="built")])
        locked(app_surface_kind="built")  # l'autre fil, entre la validation et la confirmation
    locked(app_surface_kind="built")

    assert base_reads.moved_groups(SALE_ID) == frozenset()


def test_a_write_noted_in_the_transaction_of_another_waits_for_its_owner() -> None:
    """Écriture imbriquée : tant que celui qui tient la transaction n'a ni validé ni annulé, la référence ne bouge pas.

    Une lecture sous verrou tranche alors : elle reconnaît l'écriture si elle la relit, sinon elle l'oublie, et un
    changement ultérieur vers la même valeur par un autre écrivain reste un mouvement.
    """
    read(occupancy_status="occupied")
    base_reads.stage_written([row(occupancy_status="rented")])  # hors de toute portée
    locked(occupancy_status="occupied")  # la transaction de l'appelant a été annulée
    assert base_reads.moved_groups(SALE_ID) == frozenset()

    locked(occupancy_status="rented")  # un autre écrivain, plus tard

    assert base_reads.moved_groups(SALE_ID) == {"occupancy"}


def test_a_new_row_is_confirmed_under_the_identifier_the_base_returned() -> None:
    """Une vente nouvelle n'a pas d'identifiant en mémoire : c'est celui du ``returning`` qui est noté et confirmé."""
    with base_reads.written_scope():
        base_reads.stage_written([row(surface_confidence=0.8), {"surface_m2": 1}])  # la seconde, sans identifiant
    rolled_back(surface_confidence=0.9)
    locked(surface_confidence=0.8)
    assert base_reads.moved_groups(SALE_ID) == frozenset()

    locked(surface_confidence=0.5)

    assert base_reads.moved_groups(SALE_ID) == {"surface"}


def test_scopes_do_not_leak_from_one_transaction_to_the_next() -> None:
    wrote(rooms_count=3)
    with base_reads.written_scope():
        pass  # une transaction qui n'écrit rien ne confirme rien
    rolled_back(rooms_count=5)
    with base_reads.written_scope():
        pass  # et ne ressuscite pas l'écriture annulée juste avant
    locked(rooms_count=3)

    assert base_reads.moved_groups(SALE_ID) == frozenset()


def test_a_move_after_the_process_own_write_is_still_seen() -> None:
    read(rooms_count=3)
    locked(rooms_count=3)
    wrote(rooms_count=3)
    locked(rooms_count=2)

    result = base_reads.suppress_echo(sale(rooms_count=2), sale(rooms_count=3))

    assert result.rooms_count == 2


def test_a_read_without_lock_noted_after_a_write_it_did_not_see_is_not_a_move() -> None:
    """Deux fils : l'hydratation de l'un lit la ligne avant la validation de l'autre, et la note après."""
    read()  # index du passage
    locked()
    wrote(surface_source="pdf", surface_confidence=0.95)  # fil A : publication validée
    read()  # fil B : hydratation lue avant la validation de A, notée après
    locked(surface_source="pdf", surface_confidence=0.95)  # publication finale
    outgoing = sale(app_surface_kind="carrez", surface_source="pdf_carrez", surface_confidence=0.97)

    result = base_reads.suppress_echo(sale(surface_source="pdf", surface_confidence=0.95), outgoing)

    assert base_reads.moved_groups(SALE_ID) == frozenset()
    assert result is outgoing


def test_a_move_stays_known_for_the_rest_of_the_run() -> None:
    """La vente brute garde la valeur lue : renormalisée plus tard dans le passage, elle ne revient pas non plus."""
    read(rooms_count=3)
    locked(rooms_count=4)
    first = base_reads.suppress_echo(sale(rooms_count=4), sale(rooms_count=3))
    wrote(rooms_count=first.rooms_count)
    locked(rooms_count=4)

    second = base_reads.suppress_echo(sale(rooms_count=4), sale(rooms_count=3))

    assert second.rooms_count == 4
    # Un même écho retenu plusieurs fois dans le passage compte une fois.
    assert base_reads.suppressed_count() == 1


def test_a_value_this_process_wrote_and_never_read_is_not_an_echo() -> None:
    """Vente nouvelle écrite par ce processus, changée ensuite par un autre : le mouvement est vu, mais la valeur
    que la collecte porte vient de la source, pas d'une lecture de la base. Ce qui est écrit n'est pas « lu »."""
    wrote(rooms_count=3)
    locked(rooms_count=2)
    assert base_reads.moved_groups(SALE_ID) == {"rooms"}
    outgoing = sale(rooms_count=3)

    assert base_reads.suppress_echo(sale(rooms_count=2), outgoing) is outgoing
    assert base_reads.suppressed_count() == 0


def test_a_write_staged_for_a_row_never_read_is_resolved_by_its_first_locked_read() -> None:
    """Sans confirmation (vente nouvelle, identifiant inconnu de l'appelant) : la lecture sous verrou tranche."""
    base_reads.stage_written([row(rooms_count=3)])
    locked(rooms_count=3)
    assert base_reads.moved_groups(SALE_ID) == frozenset()

    locked(rooms_count=5)
    assert base_reads.moved_groups(SALE_ID) == {"rooms"}


def test_a_partial_row_gives_values_but_no_state() -> None:
    """Une ligne lue sans toutes les colonnes d'un groupe ne dit pas si ce groupe a bougé."""
    base_reads.note({"id": SALE_ID, "rooms_count": 3})
    base_reads.note_locked({"id": SALE_ID, "surface_m2": 54})  # ni les pièces, ni les autres colonnes de surface
    base_reads.note_locked({"source_url": URL, "rooms_count": 9})  # sans identifiant : ignorée
    assert base_reads.moved_groups(SALE_ID) == frozenset()

    base_reads.note_locked({"id": SALE_ID, "rooms_count": 4})

    assert base_reads.moved_groups(SALE_ID) == {"rooms"}
    assert base_reads.suppress_echo(sale(rooms_count=4), sale(rooms_count=3)).rooms_count == 4


def test_reset_forgets_reads_and_counter() -> None:
    read(rooms_count=3)
    locked(rooms_count=4)
    base_reads.suppress_echo(sale(rooms_count=4), sale(rooms_count=3))
    assert base_reads.suppressed_count() == 1

    base_reads.reset()

    outgoing = sale(rooms_count=3)
    assert base_reads.suppressed_count() == 0
    assert base_reads.moved_groups(SALE_ID) == frozenset()
    assert base_reads.suppress_echo(sale(rooms_count=4), outgoing) is outgoing


# --- une fiche réellement relue n'est pas un écho ---------------------------------------------------------------------------


def test_a_value_the_source_really_published_again_is_not_an_echo() -> None:
    """La base tenait 3, revient à 2 pendant le passage ; la fiche relue publie réellement 3 : 3 passe."""
    read(rooms_count=3)
    locked(rooms_count=2)
    reread = sale({"source_detail_status": "complete", "source_factual_snapshot": {"rooms_count": 3}}, rooms_count=3)

    assert base_reads.suppress_echo(sale(rooms_count=2), reread) is reread
    assert base_reads.suppressed_count() == 0


@pytest.mark.parametrize("flag", ["_known_unchanged", "_detail_fetch_failed"])
def test_the_same_value_from_a_listing_that_was_not_read_again_is_an_echo(flag: str) -> None:
    """Même instantané, mais la fiche n'a pas été relue : il date d'un passage précédent, la valeur vient de la base."""
    read(rooms_count=3)
    locked(rooms_count=2)
    not_reread = sale({flag: True, "source_factual_snapshot": {"rooms_count": 3}}, rooms_count=3)

    assert base_reads.suppress_echo(sale(rooms_count=2), not_reread).rooms_count == 2
    assert base_reads.suppressed_count() == 1


def test_a_reread_listing_that_does_not_publish_the_value_does_not_protect_it() -> None:
    """Fiche relue, mais la valeur vient d'ailleurs (document, ligne stockée) : son instantané ne la porte pas."""
    read(rooms_count=3, occupancy_status="rented")
    locked(rooms_count=2, occupancy_status="occupied")
    payload = {"source_factual_snapshot": {"rooms_count": None, "occupancy_status": "Loué"}}
    reread = sale(payload, rooms_count=3, occupancy_status="rented")

    result = base_reads.suppress_echo(sale(), reread)

    assert result.rooms_count == 2  # absente de l'instantané : seulement relue
    assert result.occupancy_status == "rented"  # publiée par la source (« Loué »)


def test_a_published_surface_is_read_in_the_snapshot_as_normalisation_reads_it() -> None:
    read(**POSED)
    locked()
    published = sale({"source_factual_snapshot": {"surface_m2": "54,00 m²"}}, surface_m2=54, app_surface_m2=54)
    assert base_reads.suppress_echo(sale(), published) is published

    # Une seule des deux valeurs sortantes vient de la fiche ; l'autre est celle de la base : le groupe est repris.
    mixed = sale({"source_factual_snapshot": {"surface_m2": "50 m²"}}, surface_m2=50, app_surface_m2=54)
    read(surface_m2=50)
    assert base_reads.suppress_echo(sale(surface_m2=48, app_surface_m2=48), mixed).app_surface_m2 == 48


# --- ce qui suit le groupe repris -----------------------------------------------------------------------------------------

DOCUMENT_SURFACE = {
    "surface_m2": 48.5,
    "app_surface_m2": 48.5,
    "app_surface_kind": "carrez",
    "surface_source": "pdf",
    "surface_confidence": 0.9,
}
DOCUMENT_TRACES = {
    "surface_extraction": {"source": "pdf", "value_m2": 48.5, "document_url": "https://example.test/ccv.pdf"},
    "pdf_fact_provenance": {
        "surface_m2": {"value": 48.5, "source": "pdf", "payload_keys": ["surface_extraction", "surface_analysis"]},
        "carrez_surface_m2": {"value": 48.5, "source": "pdf", "payload_keys": ["surface_extraction"]},
        "description": {"value": "texte de la pièce", "source": "pdf", "payload_keys": []},
    },
}


def test_the_neighbouring_columns_and_the_traces_follow_the_surface_taken_from_the_base() -> None:
    """Pendant l'import, la lecture d'une pièce écrit 48,5 m² Carrez, avec sa preuve et sa trace."""
    read()
    locked(**DOCUMENT_SURFACE)
    existing = sale(
        deepcopy(DOCUMENT_TRACES), **DOCUMENT_SURFACE,
        carrez_surface_m2=48.5, surface_scope="private", surface_evidence="superficie loi Carrez de 48,50 m²",
    )
    stale_payload = {
        "_known_unchanged": True,
        "title": "Une maison",
        "surface_analysis": {"périmée": True},
        "pdf_fact_provenance": {
            "surface_m2": {"value": 50, "source": "pdf", "payload_keys": ["surface_analysis"]},
            # La base n'a aucune trace pour l'habitable : celle de la vente sortante ne décrit plus rien.
            "habitable_surface_m2": {"value": 50, "source": "pdf", "payload_keys": []},
            "rooms_count": {"value": 2, "source": "pdf", "payload_keys": []},
        },
    }
    outgoing = sale(deepcopy(stale_payload), habitable_surface_m2=50, surface_evidence="50 m² habitables")

    result = base_reads.suppress_echo(existing, outgoing)

    assert surface(result) == surface(existing)
    assert (result.carrez_surface_m2, result.habitable_surface_m2) == (Decimal("48.5"), None)
    assert (result.surface_scope, result.surface_evidence) == ("private", "superficie loi Carrez de 48,50 m²")
    # La valeur écrite garde ce qui l'a établie : sans cela, la trace d'une pièce ne saurait plus la retirer.
    assert result.raw_payload["surface_extraction"] == DOCUMENT_TRACES["surface_extraction"]
    traces = result.raw_payload["pdf_fact_provenance"]
    assert traces["surface_m2"] == DOCUMENT_TRACES["pdf_fact_provenance"]["surface_m2"]
    assert traces["carrez_surface_m2"] == DOCUMENT_TRACES["pdf_fact_provenance"]["carrez_surface_m2"]
    # Ce qui décrivait l'ancienne valeur du groupe part ; les traces des autres champs ne bougent pas.
    assert "surface_analysis" not in result.raw_payload
    assert "habitable_surface_m2" not in traces
    assert traces["rooms_count"] == stale_payload["pdf_fact_provenance"]["rooms_count"]
    assert "description" not in traces
    assert result.raw_payload["title"] == "Une maison"
    # Rien de l'appelant ni de la ligne verrouillée n'est modifié.
    assert outgoing.raw_payload == stale_payload
    assert existing.raw_payload == DOCUMENT_TRACES
    assert result.raw_payload["surface_extraction"] is not existing.raw_payload["surface_extraction"]


def test_the_trace_of_a_value_follows_its_group_for_occupancy_too() -> None:
    read(occupancy_status="rented")
    locked(occupancy_status="vacant")
    trace = {"value": "vacant", "source": "pdf", "payload_keys": []}
    existing = sale({"pdf_fact_provenance": {"occupancy_status": trace}}, occupancy_status="vacant")
    outgoing = sale({"pdf_fact_provenance": {"occupancy_status": {"value": "rented", "source": "pdf"}}},
                    occupancy_status="rented")

    result = base_reads.suppress_echo(existing, outgoing)

    assert result.occupancy_status == "vacant"
    assert result.raw_payload["pdf_fact_provenance"] == {"occupancy_status": trace}


def test_a_group_that_is_not_taken_keeps_its_own_columns_and_traces() -> None:
    read()
    locked(**DOCUMENT_SURFACE)
    payload = {"source_factual_snapshot": {"surface_m2": "61 m²"}, "surface_extraction": {"value_m2": 61}}
    outgoing = sale(payload, surface_m2=61, app_surface_m2=61, carrez_surface_m2=61)

    result = base_reads.suppress_echo(sale(deepcopy(DOCUMENT_TRACES), **DOCUMENT_SURFACE), outgoing)

    assert result is outgoing
    assert result.raw_payload == payload


def test_copies_of_the_withheld_value_follow_the_written_value() -> None:
    """La valeur retenue ne reste pas dans la ligne écrite : ni au premier niveau du payload, ni dans une observation."""
    read(**POSED)
    locked()
    other_source = "https://example.test/autre-source"
    submitted = sale(
        {"_known_unchanged": True, "rooms_count": 3, "surface_m2": 54, "app_surface_m2": 54, "title": "Une maison",
         "habitable_surface_m2": 54, "surface_evidence": "preuve de l'ancienne valeur"},
        **POSED, habitable_surface_m2=54, surface_evidence="preuve de l'ancienne valeur",
    )
    submitted.observations = [
        {"source_url": URL, "raw_payload": {"rooms_count": 3, "surface_m2": 54, "_known_unchanged": True}},
        # L'observation d'une autre source dit ce que cette source a donné : même sans instantané, même avec la
        # même valeur, ce n'est pas une copie de la vente soumise.
        {"source_name": "avoventes", "source_url": other_source, "raw_payload": {"rooms_count": 3, "surface_m2": 54}},
        # Même URL lue par un autre collecteur : une autre source aussi.
        {"source_name": "notaires", "source_url": URL, "raw_payload": {"rooms_count": 3, "surface_m2": 54}},
        {"source_url": "https://example.test/sans-payload"},
    ]
    kept_observations = deepcopy(submitted.observations)
    existing = sale()
    guarded = base_reads.suppress_echo(existing, submitted)
    result = guarded.model_copy(deep=True)

    base_reads.align_copies(result, submitted, guarded)

    assert (result.raw_payload["rooms_count"], result.raw_payload["surface_m2"]) == (2, 50)
    assert result.raw_payload["app_surface_m2"] == 50
    # Les colonnes voisines reprises avec la surface suivent dans la copie de premier niveau.
    assert (result.raw_payload["habitable_surface_m2"], result.raw_payload["surface_evidence"]) == (None, None)
    assert result.raw_payload["title"] == "Une maison"
    assert "occupancy_status" not in result.raw_payload  # une clé absente n'est pas créée
    own, other, same_url_other_collector, bare = result.observations
    assert own["raw_payload"]["rooms_count"] == 2 and own["raw_payload"]["surface_m2"] == 50
    assert other["raw_payload"] == {"rooms_count": 3, "surface_m2": 54}
    assert same_url_other_collector["raw_payload"] == {"rooms_count": 3, "surface_m2": 54}
    assert bare == {"source_url": "https://example.test/sans-payload"}
    # Les objets de l'appelant ne sont pas modifiés.
    assert submitted.observations == kept_observations
    assert submitted.raw_payload["rooms_count"] == 3


def test_a_copy_whose_source_really_published_the_value_is_evidence_not_a_copy() -> None:
    read(rooms_count=3)
    locked(rooms_count=2)
    submitted = sale({"_known_unchanged": True, "rooms_count": 3}, rooms_count=3)
    published = {"rooms_count": 3, "source_factual_snapshot": {"rooms_count": 3}}
    submitted.observations = [{"source_url": URL, "raw_payload": dict(published)}]
    guarded = base_reads.suppress_echo(sale(rooms_count=2), submitted)
    result = guarded.model_copy(deep=True)

    base_reads.align_copies(result, submitted, guarded)

    assert result.raw_payload["rooms_count"] == 2
    assert result.observations[0]["raw_payload"] == published


def test_a_neighbouring_column_the_reread_listing_just_published_is_not_taken_from_the_base() -> None:
    """Surface de 54 m² issue d'une pièce ; la fiche relue publie pour la première fois une Carrez de 53,2 m² ; un
    autre écrivain change la seule confiance de la surface avant la publication."""
    document = {"surface_m2": 54, "app_surface_m2": 54, "app_surface_kind": "built", "surface_source": "pdf"}
    read(**document, surface_confidence=0.95)
    locked(**document, surface_confidence=0.9)
    existing = sale(**document, surface_confidence=0.9, surface_evidence="preuve de la pièce")
    carrez_trace = {"value": 53.2, "source": "listing", "payload_keys": []}
    payload = {
        # La vente brute : la surface reprise de la ligne stockée, la Carrez lue sur la fiche.
        "surface_m2": 54,
        "app_surface_m2": 54,
        "carrez_surface_m2": "53,2 m²",
        "surface_evidence": "copie de l'ancienne preuve",
        "source_factual_snapshot": {"carrez_surface_m2": "53,2 m²", "surface_scope": None, "surface_m2": None},
        "pdf_fact_provenance": {"carrez_surface_m2": carrez_trace},
    }
    submitted = sale(payload, **document, surface_confidence=0.95, carrez_surface_m2=53.2, surface_scope="private",
                     surface_evidence="copie de l'ancienne preuve")

    guarded = base_reads.suppress_echo(existing, submitted)
    result = guarded.model_copy(deep=True)
    base_reads.align_copies(result, submitted, guarded)

    assert result.surface_confidence == Decimal("0.9")  # le groupe est bien repris de la base
    # La Carrez vient de la source : ni la colonne, ni sa trace, ni la copie de premier niveau ne sont touchées.
    assert result.carrez_surface_m2 == Decimal("53.2")
    assert result.raw_payload["carrez_surface_m2"] == "53,2 m²"
    assert result.raw_payload["pdf_fact_provenance"] == {"carrez_surface_m2": carrez_trace}
    # Ce que l'instantané ne donne pas suit le groupe, comme avant.
    assert (result.surface_scope, result.surface_evidence) == (None, "preuve de la pièce")
    assert result.raw_payload["surface_evidence"] == "preuve de la pièce"
    assert base_reads.suppressed_count() == 0


def test_the_same_neighbouring_column_follows_the_group_when_the_listing_was_not_reread() -> None:
    document = {"surface_m2": 54, "app_surface_m2": 54, "app_surface_kind": "built", "surface_source": "pdf"}
    read(**document, surface_confidence=0.95, carrez_surface_m2=53.2)
    locked(**document, surface_confidence=0.9, carrez_surface_m2=None)
    payload = {"_known_unchanged": True, "source_factual_snapshot": {"carrez_surface_m2": "53,2 m²"}}
    submitted = sale(payload, **document, surface_confidence=0.95, carrez_surface_m2=53.2)

    result = base_reads.suppress_echo(sale(**document, surface_confidence=0.9), submitted)

    assert result.carrez_surface_m2 is None


def test_copies_are_left_alone_when_nothing_was_withheld() -> None:
    read()
    locked()
    submitted = sale({"rooms_count": 7}, rooms_count=2)
    guarded = base_reads.suppress_echo(sale(), submitted)
    assert guarded is submitted
    payload = submitted.raw_payload

    base_reads.align_copies(submitted, submitted, guarded)

    assert submitted.raw_payload is payload and payload == {"rooms_count": 7}


# --- compteur, journal, contrat ---------------------------------------------------------------------------------------------


def test_labels_alone_are_taken_from_the_base_without_counting_an_echo(caplog) -> None:
    read(**{**LISTING, "app_surface_kind": "habitable"})
    locked(**{**LISTING, "app_surface_kind": "declared"})
    existing = sale(app_surface_kind="declared")

    with caplog.at_level(logging.INFO, logger="src.base_reads"):
        result = base_reads.suppress_echo(existing, sale(app_surface_kind="built"))

    assert result.app_surface_kind == "declared"
    assert base_reads.suppressed_count() == 0
    # Journalisé à part, sans valeur : ce n'est pas un écho de valeur.
    assert [record.getMessage() for record in caplog.records] == [f"Base labels kept sale_id={SALE_ID} group=surface"]


def test_a_withheld_value_is_logged_without_the_value(caplog) -> None:
    read(rooms_count=3)
    locked(rooms_count=4)

    with caplog.at_level(logging.INFO, logger="src.base_reads"):
        base_reads.suppress_echo(sale(rooms_count=4), sale(rooms_count=3))

    assert [record.getMessage() for record in caplog.records] == [f"Base echo suppressed sale_id={SALE_ID} group=rooms"]


def test_groups_cover_the_five_fields_and_nothing_else() -> None:
    assert {group.name: group.columns for group in base_reads.GROUPS} == {
        "surface": SURFACE,
        "land": ("land_surface_m2",),
        "rooms": ("rooms_count",),
        "occupancy": ("occupancy_status",),
        "visits": ("visit_dates",),
    }
    assert all(set(group.value_columns) <= set(group.columns) for group in base_reads.GROUPS)
    described = [column for group in base_reads.GROUPS for column in (*group.family, *group.satellites)]
    assert all(column in AuctionSale.model_fields for column in described)
    # Ce que l'écriture relit pour savoir ce que la base a gardé : l'identifiant et l'état de chaque groupe.
    assert base_reads.KEPT_COLUMNS == ("id", *SURFACE, "land_surface_m2", "rooms_count", "occupancy_status", "visit_dates")


def test_the_guard_names_no_registry_object() -> None:
    """La garde compare des colonnes ; elle ne sait rien de ce qui a fait bouger la base."""
    source = Path(base_reads.__file__).read_text(encoding="utf-8").casefold()

    for word in ("held", "claim", "auction_fact", "decision", "project_sale", "registre"):
        assert word not in source, word
