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
   au moins n'est pas vide. Pour une fiche non relue, une valeur lue dans une colonne voisine suffit (la surface
   affichée se déduit de l'habitable, de la Carrez ou du terrain) ; pour une fiche réellement relue, seule compte
   la valeur lue dans la même colonne ;
3. la source ne vient pas de publier cette valeur : une fiche réellement relue dont la lecture par la règle de la
   collecte (``pdf_fact_scope.pdf_source_reader`` : instantané et contexte, relus par ``normalize_sale``) donne
   la valeur n'est jamais un écho, même si la base a déjà rendu la même valeur. La valeur peut donc venir d'une
   clé de l'instantané comme du texte de la page.

Une valeur sortante vide n'est jamais remplacée : un garde-fou de normalisation doit pouvoir vider une valeur. Quand
la base n'a pas bougé, ``suppress_echo`` rend la vente telle quelle : l'écriture est celle d'avant ce module.

Seule une lecture sous verrou dit si la base a bougé. Une lecture sans verrou peut être notée après une écriture
qu'elle n'a pas vue (deux fils, publication progressive) : elle alimente les valeurs lues et ne pose l'état de
référence que s'il n'existe pas encore.

Le compteur (``suppressed_count``) est alimenté à la fusion, avant l'écriture : si la transaction est ensuite
annulée et jamais rejouée, le couple reste compté. Il peut donc surestimer, jamais sous-estimer.

Ce module ne sait pas pourquoi la base a bougé. Il ne lit que les colonnes et clés ci-dessous, et, pour savoir ce
qu'une fiche relue publie, la lecture de la source de ``pdf_fact_scope`` (donc ``normalize_sale``).

Deux cas théoriques des portées d'écriture, tous deux dans le sens prudent (la garde laisse écrire, ou retient une
valeur relue, jamais l'inverse) : des portées imbriquées sorties dans le désordre versent leurs notes dans une
portée qui n'est plus la bonne ; un autre écrivain qui écrit exactement l'état en attente d'une portée ensuite
annulée n'est pas vu comme un mouvement tant que cette portée est ouverte.
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
# Clé de ``raw_payload`` (et de la vente brute) : ce que la source a publié à la dernière lecture de sa fiche.
SOURCE_SNAPSHOT_KEY = "source_factual_snapshot"
# Marqueurs d'une vente brute dont la fiche n'a pas été relue à ce passage : annonce inchangée, fiche en échec.
_NOT_REREAD_FLAGS = ("_known_unchanged", "_detail_fetch_failed")


def was_reread(raw_sale: Any) -> bool:
    """Vrai si la fiche de cette vente brute (ou de ce ``raw_payload``) a été réellement relue à ce passage."""
    return isinstance(raw_sale, Mapping) and not any(raw_sale.get(flag) for flag in _NOT_REREAD_FLAGS)


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
    # Groupes que la base a changés pendant le passage, hors écritures de ce processus.
    moved: set[str] = field(default_factory=set)
    # Valeurs lues en base pendant le passage, par groupe puis par colonne de la famille.
    values: dict[str, dict[str, set[Any]]] = field(default_factory=dict)


_LOCK = threading.Lock()
_ROWS: dict[str, _RowReads] = {}
_SUPPRESSED: set[tuple[str, str]] = set()
# Écritures en attente d'une transaction (voir ``written_scope``) : par ligne et par groupe, ce que la base en a
# gardé. Chaque transaction a les siennes : celle qui annule ne jette pas celles d'une autre.
_Staged = dict[str, dict[str, tuple[Any, ...]]]
# La portée du fil courant, où ``stage_written`` note.
_WRITTEN_SCOPE: ContextVar[_Staged | None] = ContextVar("base_reads_written_scope", default=None)
# Toutes les portées ouvertes, lues sous ``_LOCK`` par ``note_locked`` : entre la validation en base d'une
# transaction et la sortie de sa portée, un autre fil peut relire sous verrou ce qu'elle vient d'écrire. Ce n'est
# pas un mouvement de la base.
_OPEN_SCOPES: list[_Staged] = []

# Clé technique d'une vente brute, jamais écrite en base : les champs qu'un collecteur a repris de la ligne stockée
# parce que la page de la source ne les donnait pas (Vench, page restreinte ou pauvre). Ces champs ne sont pas ce
# que la source a publié : ils n'entrent ni dans l'instantané de la fiche, ni dans son empreinte de fraîcheur.
RELAYED_FIELDS_KEY = "_base_relayed_fields"
# Dans l'instantané de la fiche, la liste de ces mêmes champs : leur clé en est absente, puisque la source ne les a
# pas donnés. Une restauration « valeur de la source » sait ainsi que cette valeur est inconnue, et non vide.
SNAPSHOT_RELAYED_FIELDS_KEY = "fields_from_stored_row"


def mark_relayed(raw_sale: dict[str, Any], fields: Iterable[str]) -> None:
    """Note dans la vente brute les champs repris de la ligne stockée (un appel par vente, par son collecteur)."""
    names = sorted(set(fields))
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


def suppressed_sample(limit: int) -> list[dict[str, str]]:
    """Les ``limit`` premiers couples (vente, groupe) retenus, triés : pour le résumé du passage, sans valeur."""
    with _LOCK:
        pairs = sorted(_SUPPRESSED)[:limit]
    return [{"sale_id": row_id, "group": group} for row_id, group in pairs]


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
    values = reads.values.setdefault(group.name, {})
    for column in group.family:
        if column in row and (value := _canonical(row[column])) is not None:
            values.setdefault(column, set()).add(value)


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

    Un groupe qui n'est plus dans son état de référence a été changé par un autre écrivain. Il reste marqué jusqu'à
    la fin du passage, car une copie de l'ancienne valeur peut encore se trouver dans une vente en mémoire. Un
    groupe relu dans l'état qu'une transaction de ce processus vient d'écrire (la sienne, ou celle d'un autre fil
    dont la portée n'est pas encore refermée) ne dit rien : ni mouvement, ni nouvelle référence (c'est la sortie
    de cette portée qui la posera, ou non).
    """
    row_id = row.get("id")
    if not row_id:
        return
    with _LOCK:
        reads = _ROWS.setdefault(str(row_id), _RowReads())
        staged = [scope[str(row_id)] for scope in _OPEN_SCOPES if str(row_id) in scope]
        for group in GROUPS:
            _add_values(reads, group, row)
            if not all(column in row for column in group.columns):
                continue
            state = _state(row, group)
            if any(state == states.get(group.name) for states in staged):
                continue
            if group.name in reads.last and reads.last[group.name] != state:
                reads.moved.add(group.name)
            reads.last[group.name] = state


def stage_written(rows: Iterable[Mapping[str, Any]]) -> None:
    """Note ce que la base a gardé d'une écriture de ce processus, tant que sa transaction n'est pas validée.

    ``rows`` vient du ``returning`` de l'écriture : c'est la ligne telle que la base l'a gardée, pas telle qu'elle a
    été envoyée (la base peut retenir une valeur), sous l'identifiant que la base lui donne (une vente nouvelle n'en
    a pas encore en mémoire). L'état de référence ne change qu'à la sortie sans erreur de ``written_scope``.

    Hors de toute portée, personne ne dira si l'écriture a été validée : rien n'est noté, et la lecture sous verrou
    suivante tranche seule.
    """
    scope = _WRITTEN_SCOPE.get()
    if scope is None:
        LOGGER.warning("Sale write noted outside any written scope; echo reference left unchanged")
        return
    with _LOCK:  # ``note_locked`` d'un autre fil lit cette portée
        for row in rows:
            row_id = row.get("id")
            if not row_id:
                continue
            staged = scope.setdefault(str(row_id), {})
            for group in GROUPS:
                if all(column in row for column in group.columns):
                    staged[group.name] = _state(row, group)


@contextmanager
def written_scope() -> Iterator[None]:
    """Portée d'une transaction d'écriture : à ouvrir **autour** de la transaction, par celui qui la valide.

    Sortie sans erreur (la transaction est validée) : ce que la base a gardé des lignes notées par ``stage_written``
    devient leur état de référence. Sortie par une erreur (la transaction est annulée) : ces notes sont jetées, la
    référence ne change pas. Une écriture faite dans la transaction d'un autre (appel imbriqué) ne décide de rien :
    elle est notée dans la portée de celui qui valide ou annule. Une portée ouverte dans une autre lui verse ses
    notes à la sortie au lieu de les confirmer.
    """
    outer = _WRITTEN_SCOPE.get()
    staged: _Staged = {}
    token = _WRITTEN_SCOPE.set(staged)
    with _LOCK:
        _OPEN_SCOPES.append(staged)
    committed = False
    try:
        yield
        committed = True
    finally:
        _WRITTEN_SCOPE.reset(token)
        with _LOCK:
            _OPEN_SCOPES[:] = [scope for scope in _OPEN_SCOPES if scope is not staged]
            if committed:
                for row_id, states in staged.items():
                    if outer is not None:
                        # Portée imbriquée : celle qui l'entoure valide ou annule, c'est elle qui confirmera.
                        outer.setdefault(row_id, {}).update(states)
                    else:
                        _ROWS.setdefault(row_id, _RowReads()).last.update(states)


def _published_by_source(source: Any, group: EchoGroup, outgoing: list[Any]) -> bool:
    """Vrai si la fiche a été réellement relue et que sa lecture donne chaque valeur sortante du groupe.

    ``source`` porte le ``raw_payload`` de la fiche (et, s'il les a, titre et drapeaux). « Ce que la source
    publie » se lit par la seule règle qui le dise, celle de la restauration des pièces : l'instantané et son
    contexte relus par ``normalize_sale``. Une valeur que la collecte a lue dans le texte de la page y est donc,
    comme celle d'une clé de l'instantané. Limite de cette règle : pour une annonce Licitor à plusieurs lots dont
    le lot n'est plus désigné, seule la clé de l'instantané est lue.
    """
    payload = getattr(source, "raw_payload", None)
    if not was_reread(payload):
        return False
    snapshot = payload.get(SOURCE_SNAPSHOT_KEY)
    if not isinstance(snapshot, dict):
        return False
    from src.pdf_fact_scope import pdf_source_reader  # import tardif : ce module-là importe celui-ci

    read_source = pdf_source_reader(source, snapshot)
    # Les colonnes de valeur seulement : la lecture de la source calcule elle-même la surface affichée (depuis
    # l'habitable, la Carrez ou le terrain). Un terrain de 65 m² publié ne fait pas d'une surface de 65 m² relue en
    # base une valeur publiée.
    published = {_canonical(read_source(column)) for column in group.value_columns} - {None}
    return all(value in published for value in outgoing)


def _snapshot_carries(payload: Any, column: str) -> bool:
    """Vrai si la fiche a été réellement relue et que son instantané donne une valeur à cette colonne."""
    if not was_reread(payload):
        return False
    snapshot = payload.get(SOURCE_SNAPSHOT_KEY)
    return isinstance(snapshot, Mapping) and _canonical(snapshot.get(column)) is not None


def _columns_to_take(group: EchoGroup, payload: Any) -> tuple[str, ...]:
    """Colonnes reprises avec le groupe : les siennes, et ses voisines sauf celles que la source vient de publier."""
    return (*group.columns, *(column for column in group.satellites if not _snapshot_carries(payload, column)))


def _is_echo(group: EchoGroup, outgoing: dict[str, Any], read: Mapping[str, set[Any]], source: Any) -> bool:
    """``outgoing`` : valeur sortante par colonne de valeur ; ``read`` : valeurs lues en base par colonne."""
    values = [value for value in outgoing.values() if value is not None]
    if not values:
        return False
    if was_reread(getattr(source, "raw_payload", None)):
        # Fiche relue : la valeur peut venir de la page. Elle n'est une relecture que si la base portait cette
        # valeur dans cette colonne même ; un terrain de 65 m² lu en base ne dit rien d'une surface de 65 m².
        reread_only = all(value is None or value in read.get(column, ()) for column, value in outgoing.items())
    else:
        family = set().union(*read.values())
        reread_only = all(value in family for value in values)
    return reread_only and not _published_by_source(source, group, values)


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
        read_values = {
            name: {column: set(values) for column, values in columns.items()} for name, columns in reads.values.items()
        }
    result = incoming
    for group in GROUPS:
        if group.name not in moved:
            continue
        outgoing = {column: _canonical(getattr(incoming, column)) for column in group.value_columns}
        if not _is_echo(group, outgoing, read_values.get(group.name, {}), incoming):
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
        if outgoing != {column: _canonical(getattr(existing, column)) for column in group.value_columns}:
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
        result.raw_payload = _aligned_copy(result, group, stale, result)
        result.observations = [
            {**item, "raw_payload": _aligned_copy(_ObservedSource(item), group, stale, result)}
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


@dataclass(frozen=True)
class _ObservedSource:
    """Une observation embarquée, vue comme la fiche d'une source : ce que ``_published_by_source`` lit."""

    item: Mapping[str, Any]

    @property
    def raw_payload(self) -> Any:
        return self.item.get("raw_payload")

    @property
    def source_name(self) -> Any:
        return self.item.get("source_name")

    @property
    def source_url(self) -> Any:
        return self.item.get("source_url")


def _aligned_copy(source: Any, group: EchoGroup, stale: set[Any], result: Any) -> dict[str, Any]:
    """Le ``raw_payload`` de ``source``, ou une copie dont les clés du groupe prennent les valeurs de ``result``.

    ``source`` est la fiche qui porte la copie : la ligne écrite, ou une observation. Jamais modifiée en place.
    """
    payload = source.raw_payload
    copied = {column: _canonical(payload.get(column)) for column in group.value_columns}
    if not _is_echo(group, copied, {column: stale for column in group.value_columns}, source):
        return payload
    taken = _columns_to_take(group, payload)
    return {**payload, **{column: _jsonable(getattr(result, column)) for column in taken if column in payload}}
