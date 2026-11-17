"""Réglages de la voie d'enrichissement parallèle (décision du propriétaire du 17/11/2026).

Trois variables, posées par ``.github/workflows/data-pipeline.yml`` depuis des variables de dépôt GitHub :

* ``PIPELINE_ENRICHMENT_GENERAL_WORKERS`` (0 à 3) : processus réservés aux pièces et aux faits, à côté d'un
  processus réservé aux fiches. 0 (ou absente) : le travailleur mixte d'avant, seul. C'est le retour arrière.
* ``PIPELINE_WORKER_LOCK_MODE`` (``exclusive`` | ``shared``) : mode dans lequel les travailleurs de la voie
  prennent le verrou des écritures du catalogue et le tour des sources. Tout le reste les prend en exclusif.
* ``PIPELINE_HOST_TURNS`` (``on`` | ``off``) : tours par hôte entre processus (``src.host_turn``).

Sans valeur explicite, les deux derniers suivent le nombre de processus : ``shared`` et ``on`` dès qu'il y en a un,
``exclusive`` et ``off`` sinon (le travailleur mixte d'avant, ses verrous et sa politesse ; mais pas tout l'avant :
l'attente des verrous dans la file de PostgreSQL, la copie commune de robots.txt et le report sans essai sur
``lock_timeout`` restent quel que soit N, voir « Voie parallèle » du runbook de la file). Plusieurs processus sans mode partagé
s'excluraient sur le verrou du catalogue ; sans tours par hôte, deux processus pourraient interroger le même site en
même temps : ``lane_settings`` refuse ces combinaisons, avec un message qui dit quoi changer.

Module feuille : le lanceur, le travailleur et les clients HTTP le lisent sans s'importer entre eux.
"""

from __future__ import annotations

import os
from dataclasses import dataclass

GENERAL_WORKERS_ENV = "PIPELINE_ENRICHMENT_GENERAL_WORKERS"
WORKER_LOCK_MODE_ENV = "PIPELINE_WORKER_LOCK_MODE"
HOST_TURNS_ENV = "PIPELINE_HOST_TURNS"
MAX_GENERAL_WORKERS = 3
EXCLUSIVE = "exclusive"
SHARED = "shared"
LOCK_MODES = (EXCLUSIVE, SHARED)
_ON = {"on", "true", "1", "yes"}
_OFF = {"off", "false", "0", "no"}


class LaneSettingsError(ValueError):
    """Réglages de la voie invalides ou incohérents : rien ne démarre."""


@dataclass(frozen=True)
class LaneSettings:
    general_workers: int
    lock_mode: str
    host_turns: bool

    @property
    def parallel(self) -> bool:
        return self.general_workers > 0


def _raw(name: str) -> str:
    return (os.getenv(name) or "").strip().lower()


def _general_workers() -> int:
    raw = _raw(GENERAL_WORKERS_ENV)
    if not raw:
        return 0
    try:
        value = int(raw)
    except ValueError as exc:
        raise LaneSettingsError(f"{GENERAL_WORKERS_ENV} must be an integer from 0 to {MAX_GENERAL_WORKERS}, got {raw!r}") from exc
    if not 0 <= value <= MAX_GENERAL_WORKERS:
        raise LaneSettingsError(f"{GENERAL_WORKERS_ENV} must be from 0 to {MAX_GENERAL_WORKERS}, got {value}")
    return value


def _host_turns(default: bool) -> bool:
    raw = _raw(HOST_TURNS_ENV)
    if not raw:
        return default
    if raw in _ON:
        return True
    if raw in _OFF:
        return False
    raise LaneSettingsError(f"{HOST_TURNS_ENV} must be on or off, got {raw!r}")


def lane_settings() -> LaneSettings:
    """Les réglages vérifiés ; ``LaneSettingsError`` pour une valeur invalide ou une combinaison refusée."""
    workers = _general_workers()
    mode = _raw(WORKER_LOCK_MODE_ENV) or (SHARED if workers else EXCLUSIVE)
    if mode not in LOCK_MODES:
        raise LaneSettingsError(f"{WORKER_LOCK_MODE_ENV} must be exclusive or shared, got {mode!r}")
    host_turns = _host_turns(default=workers > 0)
    if workers and mode != SHARED:
        raise LaneSettingsError(
            f"{GENERAL_WORKERS_ENV}={workers} needs {WORKER_LOCK_MODE_ENV}=shared: in exclusive mode the parallel "
            f"workers would exclude each other on the catalogue writer lock. Set {WORKER_LOCK_MODE_ENV}=shared, or "
            f"{GENERAL_WORKERS_ENV}=0 to go back to the single worker."
        )
    if workers and not host_turns:
        raise LaneSettingsError(
            f"{GENERAL_WORKERS_ENV}={workers} needs {HOST_TURNS_ENV}=on: without host turns two processes could "
            f"request the same site at the same time. Set {HOST_TURNS_ENV}=on, or {GENERAL_WORKERS_ENV}=0 to go "
            "back to the single worker."
        )
    return LaneSettings(general_workers=workers, lock_mode=mode, host_turns=host_turns)


def host_turns_enabled() -> bool:
    """Tours par hôte actifs dans ce processus. Lecture tolérante : une valeur invalide est refusée au démarrage de
    l'unité et du travailleur (``lane_settings``), pas au milieu d'une requête d'une collecte."""
    try:
        return lane_settings().host_turns
    except LaneSettingsError:
        raw = _raw(HOST_TURNS_ENV)
        return raw in _ON
