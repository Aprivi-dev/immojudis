"""Lectures en base d'un passage de collecte, et garde d'écho à l'écriture.

Une collecte recopie dans la vente des valeurs qu'elle n'a fait que relire en base : annonce inchangée, fiche en
échec, valeur établie par un document, page Vench restreinte, colonne remplie par la ligne déjà stockée lors d'une
fusion. Entre cette lecture et l'écriture il se passe de quelques secondes à plusieurs dizaines de minutes. Si la
base a changé entre-temps, réécrire la valeur lue défait ce changement : c'est un écho.

Règle : **un groupe de colonnes que la collecte n'a fait que relire en base n'est pas réécrit si la base a bougé
depuis.** À l'écriture, sous le verrou de la ligne, le groupe sortant reprend alors celui de la ligne verrouillée.

Deux conditions, par groupe :

1. la base a bougé : deux observations successives de la ligne diffèrent pendant le passage, sans que ce soit
   l'effet d'une écriture de ce processus ;
2. la vente sortante n'apporte rien : chaque colonne de valeur est vide ou égale à une valeur lue en base, et l'une
   au moins n'est pas vide.

Une valeur sortante vide n'est jamais remplacée : un garde-fou de normalisation doit pouvoir vider une valeur. Une
valeur que la source vient de donner et que la base n'a jamais rendue n'est jamais remplacée non plus. Quand la base
n'a pas bougé, ``suppress_echo`` rend la vente telle quelle : l'écriture est celle d'avant ce module.

Ce module ne sait pas pourquoi la base a bougé et ne lit rien d'autre que les colonnes ci-dessous.
"""

from __future__ import annotations

import logging
import threading
from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field
from decimal import Decimal, InvalidOperation
from typing import Any

LOGGER = logging.getLogger(__name__)


@dataclass(frozen=True)
class EchoGroup:
    """Colonnes écrites et reprises ensemble.

    ``value_columns`` portent la valeur ; ``family`` liste les colonnes dont une valeur lue en base suffit à faire
    de la valeur sortante une simple relecture (la surface affichée se déduit aussi de l'habitable, de la Carrez ou
    du terrain).
    """

    name: str
    columns: tuple[str, ...]
    value_columns: tuple[str, ...]
    family: tuple[str, ...]


GROUPS: tuple[EchoGroup, ...] = (
    EchoGroup(
        "surface",
        ("surface_m2", "app_surface_m2", "app_surface_kind", "surface_source", "surface_confidence"),
        ("surface_m2", "app_surface_m2"),
        ("surface_m2", "app_surface_m2", "habitable_surface_m2", "carrez_surface_m2", "land_surface_m2"),
    ),
    EchoGroup("land", ("land_surface_m2",), ("land_surface_m2",), ("land_surface_m2",)),
    EchoGroup("rooms", ("rooms_count",), ("rooms_count",), ("rooms_count",)),
    EchoGroup("occupancy", ("occupancy_status",), ("occupancy_status",), ("occupancy_status",)),
    EchoGroup("visits", ("visit_dates",), ("visit_dates",), ("visit_dates",)),
)


@dataclass
class _RowReads:
    # Dernier état connu de chaque groupe en base (lecture, ou écriture de ce processus).
    last: dict[str, tuple[Any, ...]] = field(default_factory=dict)
    # Groupes que la base a changés pendant le passage, hors écritures de ce processus.
    moved: set[str] = field(default_factory=set)
    # Valeurs lues en base pendant le passage, par groupe.
    values: dict[str, set[Any]] = field(default_factory=dict)


_LOCK = threading.Lock()
_ROWS: dict[str, _RowReads] = {}
_SUPPRESSED: set[tuple[str, str]] = set()

# Clé technique d'une vente brute, jamais écrite en base : les champs qu'un collecteur a repris de la ligne stockée
# parce que la page de la source ne les donnait pas (Vench, page restreinte ou pauvre). Ces champs ne sont pas ce
# que la source a publié : ils n'entrent ni dans l'instantané de la fiche, ni dans son empreinte de fraîcheur.
RELAYED_FIELDS_KEY = "_base_relayed_fields"


def mark_relayed(raw_sale: dict[str, Any], fields: Iterable[str]) -> None:
    """Note dans la vente brute les champs repris de la ligne stockée (cumulé d'un appel à l'autre)."""
    names = sorted({*relayed_fields(raw_sale), *fields})
    if names:
        raw_sale[RELAYED_FIELDS_KEY] = names


def relayed_fields(raw_sale: Mapping[str, Any]) -> frozenset[str]:
    """Champs de la vente brute qui viennent de la ligne stockée, et non de la page de la source."""
    names = raw_sale.get(RELAYED_FIELDS_KEY)
    return frozenset(str(name) for name in names) if isinstance(names, (list, tuple, set, frozenset)) else frozenset()


def reset() -> None:
    """Oublie les lectures et le compteur : à appeler à l'ouverture de chaque passage."""
    with _LOCK:
        _ROWS.clear()
        _SUPPRESSED.clear()


def suppressed_count() -> int:
    """Nombre de couples (ligne, groupe) dont une valeur relue et périmée n'a pas été réécrite pendant le passage."""
    with _LOCK:
        return len(_SUPPRESSED)


def _canonical(value: Any) -> Any:
    """Forme comparable d'une valeur lue en base (JSON) ou portée par le modèle (``Decimal``, liste)."""
    if value is None or value == "" or value == [] or value == {} or value == ():
        return None
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float, Decimal)):
        try:
            number = Decimal(str(value))
        except InvalidOperation:
            return str(value)
        return number.normalize() if number.is_finite() else str(value)
    if isinstance(value, (list, tuple, set, frozenset)):
        items = sorted({str(item) for item in value if item is not None and item != ""})
        return tuple(items) or None
    return str(value)


def _get(source: Any, column: str) -> Any:
    return source.get(column) if isinstance(source, Mapping) else getattr(source, column)


def _state(source: Any, group: EchoGroup) -> tuple[Any, ...]:
    return tuple(_canonical(_get(source, column)) for column in group.columns)


def note(row: Mapping[str, Any]) -> None:
    """Mémorise une ligne lue en base (détails connus, ou ligne lue sous le verrou de publication).

    Un groupe dont l'état diffère de son dernier état connu a été changé en base depuis : il est marqué pour le
    reste du passage, car une copie de l'ancienne valeur peut encore se trouver dans une vente en mémoire.
    """
    row_id = row.get("id")
    if not row_id:
        return
    with _LOCK:
        reads = _ROWS.setdefault(str(row_id), _RowReads())
        for group in GROUPS:
            values = reads.values.setdefault(group.name, set())
            for column in group.family:
                if column in row and (value := _canonical(row[column])) is not None:
                    values.add(value)
            # Une ligne lue sans toutes les colonnes du groupe ne dit rien de son état.
            if not all(column in row for column in group.columns):
                continue
            state = _state(row, group)
            if group.name in reads.last and reads.last[group.name] != state:
                reads.moved.add(group.name)
            reads.last[group.name] = state


def note_written(row_id: Any, row: Mapping[str, Any]) -> None:
    """Mémorise ce que ce processus vient d'écrire : sa propre écriture n'est pas un mouvement de la base."""
    if not row_id:
        return
    with _LOCK:
        reads = _ROWS.get(str(row_id))
        if reads is None:
            # Ligne jamais lue pendant le passage : aucune valeur relue ne peut y revenir.
            return
        for group in GROUPS:
            if all(column in row for column in group.columns):
                reads.last[group.name] = _state(row, group)


def suppress_echo(existing: Any, incoming: Any) -> Any:
    """Rend ``incoming``, ou une copie dont les groupes seulement relus reprennent ceux de ``existing``.

    ``existing`` est la ligne qui reçoit la fusion (la ligne verrouillée, ou le résultat d'une fusion précédente du
    même lot) ; ``incoming`` n'est jamais modifiée.
    """
    row_id = getattr(existing, "id", None)
    if not row_id:
        return incoming
    with _LOCK:
        reads = _ROWS.get(str(row_id))
        if reads is None or not reads.moved:
            return incoming
        moved = set(reads.moved)
        read_values = {name: set(values) for name, values in reads.values.items()}
    result = incoming
    for group in GROUPS:
        if group.name not in moved:
            continue
        outgoing = [_canonical(getattr(incoming, column)) for column in group.value_columns]
        if all(value is None for value in outgoing):
            continue
        known = read_values.get(group.name, set())
        if any(value is not None and value not in known for value in outgoing):
            continue
        if _state(existing, group) == _state(incoming, group):
            continue
        if result is incoming:
            result = incoming.model_copy()
        for column in group.columns:
            value = getattr(existing, column)
            setattr(result, column, list(value) if isinstance(value, list) else value)
        if outgoing != [_canonical(getattr(existing, column)) for column in group.value_columns]:
            with _LOCK:
                _SUPPRESSED.add((str(row_id), group.name))
            LOGGER.info("Base echo suppressed sale_id=%s group=%s", row_id, group.name)
    return result
