"""Horloge décalée pour la suite de tests : détecte les dates codées en dur qui finissent par casser un test.

Activé par la variable d'environnement ``IMMOJUDIS_TEST_CLOCK_OFFSET_DAYS`` (nombre de jours, ex. 60), jamais par
défaut. Le job hebdomadaire ``.github/workflows/pipeline-clock-offset.yml`` lance toute la suite avec +60 jours : un
test dont la date d'audience, la fenêtre de fraîcheur ou la rétention est écrite en dur (et non relative à
« aujourd'hui ») y échoue avant de casser la CI le jour venu.

Pourquoi pas ``time-machine`` : cette dépendance n'est pas dans les verrous du pipeline et n'a pas été ajoutée sans
l'accord du propriétaire (voir la note du workflow). Le décalage se fait donc avec la bibliothèque standard :
``datetime.datetime.now/utcnow/today``, ``datetime.date.today`` et ``time.time``. ``time.monotonic`` (durées,
échéances) n'est pas décalée. Les appels qui lisent l'horloge système sans passer par Python (PostgreSQL ``now()``,
sous-processus) ne sont pas décalés : le job est un détecteur de dates codées en dur, pas une simulation complète.
"""

from __future__ import annotations

import datetime as _datetime
import os
import time as _time

ENV_VARIABLE = "IMMOJUDIS_TEST_CLOCK_OFFSET_DAYS"
_installed_offset: _datetime.timedelta | None = None


def configured_offset_days(environ: dict[str, str] | None = None) -> float | None:
    """Décalage demandé en jours ; ``None`` sans variable, ou si la valeur est invalide ou nulle."""
    raw = (environ if environ is not None else os.environ).get(ENV_VARIABLE, "").strip()
    if not raw:
        return None
    try:
        days = float(raw)
    except ValueError:
        return None
    return days if days != 0 else None


def install_clock_offset(days: float) -> None:
    """Décale l'horloge Python de ``days`` jours, pour le reste du processus (une seule fois)."""
    global _installed_offset
    if _installed_offset is not None:
        return
    offset = _datetime.timedelta(days=days)
    real_datetime, real_date, real_time = _datetime.datetime, _datetime.date, _time.time

    class _AcceptsRealInstances(type):
        """Les valeurs réelles (psycopg, pydantic) restent des instances de la classe décalée."""

        def __instancecheck__(cls, obj):
            return isinstance(obj, cls.__mro__[1])

        def __subclasscheck__(cls, subclass):
            return issubclass(subclass, cls.__mro__[1])

    class ShiftedDatetime(real_datetime, metaclass=_AcceptsRealInstances):  # type: ignore[misc, valid-type]
        @classmethod
        def now(cls, tz=None):
            return real_datetime.now(tz) + offset

        @classmethod
        def utcnow(cls):
            return real_datetime.utcnow() + offset

        @classmethod
        def today(cls):
            return real_datetime.now() + offset

    class ShiftedDate(real_date, metaclass=_AcceptsRealInstances):  # type: ignore[misc, valid-type]
        @classmethod
        def today(cls):
            return (real_datetime.now() + offset).date()

    _datetime.datetime = ShiftedDatetime  # type: ignore[misc]
    _datetime.date = ShiftedDate  # type: ignore[misc]
    _time.time = lambda: real_time() + offset.total_seconds()  # type: ignore[assignment]
    _installed_offset = offset


def install_from_environment() -> float | None:
    days = configured_offset_days()
    if days is not None:
        install_clock_offset(days)
    return days
