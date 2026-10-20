"""Horloge décalée pour la suite de tests : détecte les dates codées en dur qui finissent par casser un test.

Activé par la variable d'environnement ``IMMOJUDIS_TEST_CLOCK_OFFSET_DAYS`` (nombre de jours, ex. 60), jamais par
défaut. Le job hebdomadaire ``.github/workflows/pipeline-clock-offset.yml`` lance toute la suite avec +60 jours : un
test dont la date d'audience, la fenêtre de fraîcheur ou la rétention est écrite en dur (et non relative à
« aujourd'hui ») y échoue avant de casser la CI le jour venu.

Moteur : ``time-machine``, qui décale toutes les horloges Python, y compris celles des extensions C (pandas,
psycopg). Cette dépendance n'est PAS dans les verrous du pipeline : l'ajouter demande l'accord du propriétaire (voir la
note du workflow). Sans elle, le décalage n'est pas appliqué et le job le dit (``unavailable_reason``) au lieu de
tourner à vide. Un essai avec la bibliothèque standard seule (``datetime``, ``time.time`` remplacés) a été écarté :
remplacer ``datetime.datetime`` fait boucler l'import de pandas, et un décalage partiel donne des dizaines de faux
échecs (horloges mélangées d'un module à l'autre).

Ce que le décalage ne couvre pas : l'horloge de PostgreSQL (``now()``) et celle des sous-processus ;
``os.utime(path)`` sans argument lit l'horloge système réelle (un test qui s'en sert doit passer ``time.time()``).
"""

from __future__ import annotations

import datetime as _datetime
import os

ENV_VARIABLE = "IMMOJUDIS_TEST_CLOCK_OFFSET_DAYS"
_state: dict[str, object] = {}


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


def install_clock_offset(days: float) -> bool:
    """Décale l'horloge de ``days`` jours pour le reste du processus (une seule fois) ; faux sans time-machine."""
    if "traveller" in _state:
        return True
    try:
        import time_machine
    except ImportError:
        _state["unavailable_reason"] = "time-machine n'est pas installé : horloge non décalée"
        return False
    traveller = time_machine.travel(_datetime.datetime.now(_datetime.UTC) + _datetime.timedelta(days=days), tick=True)
    traveller.start()
    _state["traveller"] = traveller
    return True


def install_from_environment() -> float | None:
    """Installe le décalage demandé par l'environnement ; renvoie les jours demandés (``None`` si aucun)."""
    days = configured_offset_days()
    if days is not None:
        install_clock_offset(days)
    return days


def unavailable_reason() -> str | None:
    return str(_state["unavailable_reason"]) if "unavailable_reason" in _state else None
