"""Lectures en base d'un passage de collecte, et garde d'écho à l'écriture.

Une collecte recopie dans la vente des valeurs qu'elle n'a fait que relire en base : annonce inchangée, fiche en
échec, valeur établie par un document, page Vench restreinte, colonne remplie par la ligne déjà stockée lors d'une
fusion. Entre cette lecture et l'écriture il se passe de quelques secondes à plusieurs dizaines de minutes. Si la
base a changé entre-temps, réécrire la valeur lue défait ce changement : c'est un écho.

Règle : **un groupe de colonnes que la collecte n'a fait que relire en base n'est pas réécrit si la base a bougé
depuis.** À l'écriture, sous le verrou de la ligne, le groupe sortant reprend alors celui de la ligne verrouillée,
avec ses colonnes voisines et ses traces.

Trois conditions, par groupe :

1. la base a bougé : sous le verrou de publication, la ligne n'est plus dans l'état de référence (première lecture
   du passage, puis ce que la base a gardé de chaque écriture validée de ce processus) ;
2. la vente sortante n'apporte rien : chaque colonne de valeur est vide ou égale à une valeur lue en base, et l'une
   au moins n'est pas vide ;
3. la source ne vient pas de publier cette valeur : une fiche réellement relue dont l'instantané porte la valeur
   n'est jamais un écho, même si la base a déjà rendu la même valeur.

Une valeur sortante vide n'est jamais remplacée : un garde-fou de normalisation doit pouvoir vider une valeur. Quand
la base n'a pas bougé, ``suppress_echo`` rend la vente telle quelle : l'écriture est celle d'avant ce module.

Seule une lecture sous verrou dit si la base a bougé. Une lecture sans verrou peut être notée après une écriture
qu'elle n'a pas vue (deux fils, publication progressive) : elle alimente les valeurs lues et ne pose l'état de
référence que s'il n'existe pas encore.

Ce module ne sait pas pourquoi la base a bougé et ne lit rien d'autre que les colonnes et clés ci-dessous.
"""

from __future__ import annotations

import logging
import threading
from collections.abc import Iterable, Iterator, Mapping
from contextlib import contextmanager
from contextvars import ContextVar
from copy import deepcopy
from dataclasses import dataclass, field
from decimal import Decimal, InvalidOperation
from typing import Any

LOGGER = logging.getLogger(__name__)

# Traces des valeurs lues dans les pièces : par champ, la valeur projetée et les clés de ``raw_payload`` qui la décrivent.
_PROVENANCE_KEY = "pdf_fact_provenance"
# Ce que la source a publié à la dernière lecture de sa fiche.
_SOURCE_SNAPSHOT_KEY = "source_factual_snapshot"
_NOT_REREAD_FLAGS = ("_known_unchanged", "_detail_fetch_failed")


@dataclass(frozen=True)
class EchoGroup:
    """Colonnes écrites et reprises ensemble.

    ``columns`` font l'état du groupe ; ``value_columns`` portent la valeur ; ``family`` liste les colonnes dont une
    valeur lue en base suffit à faire de la valeur sortante une simple relecture (la surface affichée se déduit
    aussi de l'habitable, de la Carrez ou du terrain). ``satellites`` et ``trace_keys`` décrivent la même valeur
    (détail de la surface, preuve, trace de la pièce lue) : repris de la base avec le groupe, jamais sans lui.
    """

    name: str
    columns: tuple[str, ...]
    value_columns: tuple[str, ...]
    family: tuple[str, ...]
    satellites: tuple[str, ...] = ()
    trace_keys: tuple[str, ...] = ()


GROUPS: tuple[EchoGroup, ...] = (
    EchoGroup(
        "surface",
        ("surface_m2", "app_surface_m2", "app_surface_kind", "surface_source", "surface_confidence"),
        ("surface_m2", "app_surface_m2"),
        ("surface_m2", "app_surface_m2", "habitable_surface_m2", "carrez_surface_m2", "land_surface_m2"),
        satellites=("habitable_surface_m2", "carrez_surface_m2", "surface_scope", "surface_evidence"),
        trace_keys=("surface_extraction", "surface_analysis"),
    ),
    EchoGroup(
        "land", ("land_surface_m2",), ("land_surface_m2",), ("land_surface_m2",),
        trace_keys=("land_surface_extraction",),
    ),
    EchoGroup("rooms", ("rooms_count",), ("rooms_count",), ("rooms_count",)),
    EchoGroup("occupancy", ("occupancy_status",), ("occupancy_status",), ("occupancy_status",)),
    EchoGroup(
        "visits", ("visit_dates",), ("visit_dates",), ("visit_dates",),
        trace_keys=("pdf_visit_dates_extraction",),
    ),
)
# Colonnes relues à l'écriture pour savoir ce que la base a gardé (``returning``).
KEPT_COLUMNS: tuple[str, ...] = ("id", *dict.fromkeys(column for group in GROUPS for column in group.columns))


@dataclass
class _RowReads:
    # État de référence de chaque groupe : première lecture du passage, puis ce que la base a gardé d'une écriture
    # validée de ce processus, puis chaque lecture sous verrou.
    last: dict[str, tuple[Any, ...]] = field(default_factory=dict)
    # Ce que la base a gardé d'une écriture de ce processus dont la transaction n'est pas encore validée.
    pending: dict[str, tuple[Any, ...]] = field(default_factory=dict)
    # Groupes que la base a changés pendant le passage, hors écritures de ce processus.
    moved: set[str] = field(default_factory=set)
    # Valeurs lues en base pendant le passage, par groupe.
    values: dict[str, set[Any]] = field(default_factory=dict)


_LOCK = threading.Lock()
_ROWS: dict[str, _RowReads] = {}
_SUPPRESSED: set[tuple[str, str]] = set()
# Lignes dont une écriture est en attente dans la transaction en cours de ce fil (voir ``written_scope``).
_WRITTEN_SCOPE: ContextVar[list[str] | None] = ContextVar("base_reads_written_scope", default=None)

# Clé technique d'une vente brute, jamais écrite en base : les champs qu'un collecteur a repris de la ligne stockée
# parce que la page de la source ne les donnait pas (Vench, page restreinte ou pauvre). Ces champs ne sont pas ce
# que la source a publié : ils n'entrent ni dans l'instantané de la fiche, ni dans son empreinte de fraîcheur.
RELAYED_FIELDS_KEY = "_base_relayed_fields"
# Dans l'instantané de la fiche, la liste de ces mêmes champs : leur clé en est absente, puisque la source ne les a
# pas donnés. Une restauration « valeur de la source » sait ainsi que cette valeur est inconnue, et non vide.
SNAPSHOT_RELAYED_FIELDS_KEY = "fields_from_stored_row"


def mark_relayed(raw_sale: dict[str, Any], fields: Iterable[str]) -> None:
    """Note dans la vente brute les champs repris de la ligne stockée (cumulé d'un appel à l'autre)."""
    names = sorted({*relayed_fields(raw_sale), *fields})
    if names:
        raw_sale[RELAYED_FIELDS_KEY] = names


def relayed_fields(raw_sale: Mapping[str, Any]) -> frozenset[str]:
    """Champs de la vente brute qui viennent de la ligne stockée, et non de la page de la source."""
    return _names(raw_sale.get(RELAYED_FIELDS_KEY))


def snapshot_relayed_fields(snapshot: Any) -> frozenset[str]:
    """Champs que l'instantané déclare inconnus de la source (repris de la ligne stockée à la lecture)."""
    return _names(snapshot.get(SNAPSHOT_RELAYED_FIELDS_KEY)) if isinstance(snapshot, Mapping) else frozenset()


def _names(value: Any) -> frozenset[str]:
    return frozenset(str(name) for name in value) if isinstance(value, (list, tuple, set, frozenset)) else frozenset()


def reset() -> None:
    """Oublie les lectures et le compteur : à appeler à l'ouverture de chaque passage."""
    with _LOCK:
        _ROWS.clear()
        _SUPPRESSED.clear()


def suppressed_count() -> int:
    """Nombre de couples (ligne, groupe) dont une valeur relue et périmée n'a pas été réécrite pendant le passage."""
    with _LOCK:
        return len(_SUPPRESSED)


def moved_groups(row_id: Any) -> frozenset[str]:
    """Groupes de cette ligne que la base a changés pendant le passage (diagnostic et tests)."""
    with _LOCK:
        reads = _ROWS.get(str(row_id))
        return frozenset(reads.moved) if reads else frozenset()


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


def _add_values(reads: _RowReads, group: EchoGroup, row: Mapping[str, Any]) -> None:
    values = reads.values.setdefault(group.name, set())
    for column in group.family:
        if column in row and (value := _canonical(row[column])) is not None:
            values.add(value)


def note(row: Mapping[str, Any]) -> None:
    """Mémorise une ligne lue en base sans verrou (détails connus du passage).

    Ses valeurs peuvent être recopiées dans une vente écrite plus tard. Elle ne dit pas si la base a bougé : elle a
    pu être lue avant une écriture de ce processus et notée après. Elle ne pose l'état de référence que la première
    fois.
    """
    row_id = row.get("id")
    if not row_id:
        return
    with _LOCK:
        reads = _ROWS.setdefault(str(row_id), _RowReads())
        for group in GROUPS:
            _add_values(reads, group, row)
            # Une ligne lue sans toutes les colonnes du groupe ne dit rien de son état.
            if group.name not in reads.last and all(column in row for column in group.columns):
                reads.last[group.name] = _state(row, group)


def note_locked(row: Mapping[str, Any]) -> None:
    """Mémorise une ligne lue sous le verrou de publication : c'est elle qui dit si la base a bougé.

    Un groupe qui n'est ni dans son état de référence, ni dans l'état gardé par une écriture de ce processus en
    attente de validation, a été changé par un autre écrivain. Il reste marqué jusqu'à la fin du passage, car une
    copie de l'ancienne valeur peut encore se trouver dans une vente en mémoire.
    """
    row_id = row.get("id")
    if not row_id:
        return
    with _LOCK:
        reads = _ROWS.setdefault(str(row_id), _RowReads())
        for group in GROUPS:
            _add_values(reads, group, row)
            if not all(column in row for column in group.columns):
                continue
            state = _state(row, group)
            ours = reads.pending.pop(group.name, None)
            if state != ours and group.name in reads.last and reads.last[group.name] != state:
                reads.moved.add(group.name)
            reads.last[group.name] = state


def stage_written(rows: Iterable[Mapping[str, Any]]) -> None:
    """Note ce que la base a gardé d'une écriture de ce processus, tant que sa transaction n'est pas validée.

    ``rows`` vient du ``returning`` de l'écriture : c'est la ligne telle que la base l'a gardée, pas telle qu'elle a
    été envoyée (la base peut retenir une valeur), sous l'identifiant que la base lui donne (une vente nouvelle n'en
    a pas encore en mémoire). L'état de référence ne change qu'à la sortie sans erreur de ``written_scope``.
    """
    scope = _WRITTEN_SCOPE.get()
    with _LOCK:
        for row in rows:
            row_id = row.get("id")
            if not row_id:
                continue
            reads = _ROWS.setdefault(str(row_id), _RowReads())
            for group in GROUPS:
                if all(column in row for column in group.columns):
                    reads.pending[group.name] = _state(row, group)
            if scope is not None:
                scope.append(str(row_id))


@contextmanager
def written_scope() -> Iterator[None]:
    """Portée d'une transaction d'écriture : à ouvrir **autour** de la transaction, par celui qui la valide.

    Sortie sans erreur (la transaction est validée) : ce que la base a gardé des lignes notées par ``stage_written``
    devient leur état de référence. Sortie par une erreur (la transaction est annulée) : ces notes sont jetées, la
    référence ne change pas. Une écriture faite dans la transaction d'un autre (appel imbriqué) ne décide de rien :
    elle est notée dans la portée de celui qui valide ou annule.
    """
    staged: list[str] = []
    token = _WRITTEN_SCOPE.set(staged)
    try:
        yield
    except BaseException:
        _settle(staged, committed=False)
        raise
    else:
        _settle(staged, committed=True)
    finally:
        _WRITTEN_SCOPE.reset(token)


def _settle(row_ids: list[str], *, committed: bool) -> None:
    with _LOCK:
        for row_id in row_ids:
            reads = _ROWS.get(row_id)
            if reads is None:
                continue
            if committed:
                reads.last.update(reads.pending)
            reads.pending.clear()


def _source_value(column: str, raw: Any) -> Any:
    """Valeur comparable d'un champ de l'instantané, lue comme la normalisation la lit."""
    if _canonical(raw) is None:
        return None
    if column == "visit_dates":
        return _canonical(raw if isinstance(raw, (list, tuple)) else [raw])
    if column == "occupancy_status":
        from src.normalize import normalize_occupancy_status

        return _canonical(normalize_occupancy_status(raw))
    if isinstance(raw, (int, float, Decimal)) and not isinstance(raw, bool):
        return _canonical(raw)
    if column == "rooms_count":
        from src.room_counts import parse_rooms_count

        return _canonical(parse_rooms_count(raw))
    from src.normalize import parse_surface

    return _canonical(parse_surface(raw))


def _published_by_source(payload: Any, group: EchoGroup, outgoing: list[Any]) -> bool:
    """Vrai si la fiche a été réellement relue et que son instantané porte chaque valeur sortante du groupe."""
    if not isinstance(payload, Mapping) or any(payload.get(flag) for flag in _NOT_REREAD_FLAGS):
        return False
    snapshot = payload.get(_SOURCE_SNAPSHOT_KEY)
    if not isinstance(snapshot, Mapping):
        return False
    published = {_source_value(column, snapshot.get(column)) for column in group.family} - {None}
    return all(value is None or value in published for value in outgoing)


def _snapshot_carries(payload: Any, column: str) -> bool:
    """Vrai si la fiche a été réellement relue et que son instantané donne une valeur à cette colonne."""
    if not isinstance(payload, Mapping) or any(payload.get(flag) for flag in _NOT_REREAD_FLAGS):
        return False
    snapshot = payload.get(_SOURCE_SNAPSHOT_KEY)
    return isinstance(snapshot, Mapping) and _canonical(snapshot.get(column)) is not None


def _columns_to_take(group: EchoGroup, payload: Any) -> tuple[str, ...]:
    """Colonnes reprises avec le groupe : les siennes, et ses voisines sauf celles que la source vient de publier."""
    return (*group.columns, *(column for column in group.satellites if not _snapshot_carries(payload, column)))


def _is_echo(group: EchoGroup, outgoing: list[Any], read_values: set[Any], payload: Any) -> bool:
    if all(value is None for value in outgoing):
        return False
    if any(value is not None and value not in read_values for value in outgoing):
        return False
    return not _published_by_source(payload, group, outgoing)


def _jsonable(value: Any) -> Any:
    if isinstance(value, Decimal):
        return int(value) if value == value.to_integral_value() else float(value)
    return list(value) if isinstance(value, list) else value


def _take_traces(payload: dict[str, Any], base_payload: Any, group: EchoGroup, columns: tuple[str, ...]) -> None:
    """Aligne sur la ligne de la base les traces qui décrivent les colonnes reprises (leur valeur est la sienne)."""
    base_payload = base_payload if isinstance(base_payload, Mapping) else {}
    base_traces = base_payload.get(_PROVENANCE_KEY)
    base_traces = base_traces if isinstance(base_traces, Mapping) else {}
    traces = payload.get(_PROVENANCE_KEY)
    traces = dict(traces) if isinstance(traces, Mapping) else {}
    keys = set(group.trace_keys)
    for column in columns:
        for trace in (base_traces.get(column), traces.get(column)):
            if isinstance(trace, Mapping):
                keys.update(str(key) for key in trace.get("payload_keys") or [])
        if column in base_traces:
            traces[column] = deepcopy(base_traces[column])
        else:
            traces.pop(column, None)
    for key in keys:
        if key in base_payload:
            payload[key] = deepcopy(base_payload[key])
        else:
            payload.pop(key, None)
    if traces:
        payload[_PROVENANCE_KEY] = traces
    else:
        payload.pop(_PROVENANCE_KEY, None)


def suppress_echo(existing: Any, incoming: Any) -> Any:
    """Rend ``incoming``, ou une copie dont les groupes seulement relus reprennent ceux de ``existing``.

    ``existing`` est la ligne qui reçoit la fusion (la ligne verrouillée, ou le résultat d'une fusion précédente du
    même lot) ; ``incoming`` n'est jamais modifiée. Avec le groupe viennent ses colonnes voisines et ses traces dans
    ``raw_payload`` : la valeur écrite reste décrite par ce qui l'a établie.
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
        if not _is_echo(group, outgoing, read_values.get(group.name, set()), getattr(incoming, "raw_payload", None)):
            continue
        if _state(existing, group) == _state(incoming, group):
            continue
        if result is incoming:
            result = incoming.model_copy()
            result.raw_payload = dict(incoming.raw_payload)
        # Une colonne voisine que la fiche relue vient de publier (une Carrez donnée pour la première fois) reste
        # celle de la source : seul le reste du groupe est repris de la base.
        taken = _columns_to_take(group, incoming.raw_payload)
        for column in taken:
            value = getattr(existing, column)
            setattr(result, column, list(value) if isinstance(value, list) else value)
        _take_traces(result.raw_payload, getattr(existing, "raw_payload", None), group, taken)
        if outgoing != [_canonical(getattr(existing, column)) for column in group.value_columns]:
            with _LOCK:
                _SUPPRESSED.add((str(row_id), group.name))
            LOGGER.info("Base echo suppressed sale_id=%s group=%s", row_id, group.name)
        else:
            # Même valeur, autres libellés : ceux de la base sont gardés, rien n'est compté.
            LOGGER.info("Base labels kept sale_id=%s group=%s", row_id, group.name)
    return result


def align_copies(result: Any, submitted: Any, guarded: Any) -> None:
    """Après la fusion : les copies de la valeur retenue ne restent pas dans la ligne écrite.

    ``raw_payload`` garde au premier niveau une copie des colonnes, et chaque observation embarquée une copie du
    ``raw_payload`` de sa source. Pour chaque groupe que ``suppress_echo`` a repris (``guarded`` diffère de
    ``submitted``), le ``raw_payload`` de la ligne et l'observation de la source soumise prennent la valeur de
    ``result`` s'ils portent encore la valeur retenue. L'observation d'une autre source dit ce que cette source a
    donné : elle n'est jamais touchée. Une copie dont la source a réellement publié la valeur non plus.
    """
    if guarded is submitted:
        return
    for group in GROUPS:
        if _state(submitted, group) == _state(guarded, group):
            continue
        stale = {_canonical(getattr(submitted, column)) for column in group.value_columns} - {None}
        if not stale:
            continue
        result.raw_payload = _aligned_copy(result.raw_payload, group, stale, result)
        result.observations = [
            {**item, "raw_payload": _aligned_copy(item["raw_payload"], group, stale, result)}
            if _is_observation_of(item, submitted) and isinstance(item.get("raw_payload"), dict)
            else item
            for item in result.observations or []
        ]


def _is_observation_of(item: Any, sale: Any) -> bool:
    """Vrai si cette observation embarquée est celle de la source de ``sale`` (même URL, même collecteur)."""
    return (
        isinstance(item, dict)
        and item.get("source_url") == sale.source_url
        and item.get("source_name") in (None, sale.source_name)
    )


def _aligned_copy(payload: dict[str, Any], group: EchoGroup, stale: set[Any], result: Any) -> dict[str, Any]:
    """``payload``, ou une copie dont les clés du groupe prennent les valeurs de ``result`` (jamais modifié en place)."""
    copied = [_canonical(payload.get(column)) for column in group.value_columns]
    if not _is_echo(group, copied, stale, payload):
        return payload
    taken = _columns_to_take(group, payload)
    return {**payload, **{column: _jsonable(getattr(result, column)) for column in taken if column in payload}}
