"""Source injoignable : sonde espacée, puis suspension de 7 jours après 72 h (décision du 17/11/2026, lot 5).

Enchères Immobilières ne répondait plus depuis le 15/11/2026 (« robots.txt could not be verified … timed out »,
``ConnectTimeout``, 0 requête) : chaque collecte attendait jusqu'à 6 h entre deux essais, et chaque passage du
travailleur perdait ~2,5 min sur quatre essais de robots.txt pour les fiches de la source. Trois règles, appliquées
à la fin de chaque collecte (``src.autonomous_runner.finish_source``) :

* (a) quand le dernier échec est une panne passagère de robots.txt (pas de réponse TCP, délai, 5xx), que la collecte
  n'a envoyé aucune requête de page et que la copie commune de robots.txt existe (migration 20261204100000), la
  collecte suivante est une sonde : une seule lecture de robots.txt, sans reprise (``robots_policy_copies.before_fetch``),
  60 min après le premier échec, puis 2 h, 4 h et 6 h au plus (``robots_policy_copies.probe_interval``). Aucun
  processus ne relit robots.txt avant ce délai : le site ne reçoit jamais plus de requêtes qu'avant (quatre essais
  par collecte, espacées de 30 min à 6 h) ;
* (b) la classe de l'échec (``robots_policy_copies.failure_class``) est gardée dans la couverture de la source
  (``failure_class``, ``unreachable_since``) et dans le détail de son alerte ;
* (c) après 72 h d'échecs de connexion continus (pas de réponse TCP, délai), la source est suspendue 7 jours.
  « Continus » : au moins ``MIN_OBSERVED_FAILURES`` échecs relevés par le client des pages de la source (jamais ceux
  du client des pièces : ``robots_policy_copies.PAGES``), sans trou de plus de ``OBSERVATION_GAP`` entre deux
  (une pause du pipeline fait repartir l'horloge). Ensuite
  (``suspended_until``, ``suspension_reason`` commençant par ``SUSPENSION_REASON``) : le planificateur ne la lance
  plus, la file ne prend plus ses fiches (``claim_auction_enrichment_jobs_family`` filtre ``suspended_until``), et
  les pièces hébergées sur son site attendent la reprise sans perdre d'essai (``suspended_host_until``). Rien n'est
  retiré du catalogue. L'alerte ``pipeline.source.<nom>.suspended_unreachable`` l'annonce, avec la date de reprise.
  À l'échéance, la collecte relancée par le planificateur est la sonde : si le site ne répond toujours pas, la
  suspension repart pour 7 jours.

Interrupteur sans commit : la variable de dépôt ``PIPELINE_SOURCE_AUTO_SUSPEND`` (``on`` par défaut). ``off`` coupe
(a) et (c) : l'espacement progressif d'avant (``autonomous_runner.next_attempt``) et aucune nouvelle suspension. Une
suspension déjà posée court jusqu'à son terme (la remettre à zéro : ``suspended_until`` de la source). La copie
commune de robots.txt, l'attente sans requête après un échec récent (``before_fetch``) et ``suspended_host_until``
restent : elles ne dépendent pas de ce réglage.

Le relais (``SOURCE_FETCH_RELAY_URL``) n'est jamais une issue : contourner un site qui ne nous répond plus pourrait
contourner un blocage (``src.sources.cloud_transport`` ne le permet qu'aux hôtes de sa liste).
"""

from __future__ import annotations

import importlib
import logging
import os
import threading
import time
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any

from src.host_turn import host_of
from src.sources.robots_policy_copies import (
    PAGES,
    PROBE_MAX_INTERVAL,
    TRANSIENT_FAILURES,
    UNREACHABLE_FAILURES,
    probe_interval,
)
from src.timestamps import aware_timestamp

LOGGER = logging.getLogger(__name__)

UNREACHABLE_SUSPENSION_AFTER = timedelta(hours=72)
UNREACHABLE_SUSPENSION = timedelta(days=7)
SUSPENSION_REASON = "source_unreachable"
#: Échecs relevés au moins, sur les 72 h, pour qu'elles comptent comme continues (une sonde toutes les 6 h au plus
#: en fait une douzaine).
MIN_OBSERVED_FAILURES = 6
#: Au-delà de ce trou entre deux échecs relevés (deux intervalles de sonde, au plus long), l'horloge repart.
OBSERVATION_GAP = 2 * PROBE_MAX_INTERVAL
AUTO_SUSPEND_ENV = "PIPELINE_SOURCE_AUTO_SUSPEND"
CACHE_SECONDS = 60.0
_QUERY = """select source_name, suspended_until from public.auction_source_state
  where suspended_until > now() and suspension_reason like %s"""


def auto_suspend_enabled() -> bool:
    """``PIPELINE_SOURCE_AUTO_SUSPEND`` : ``on`` (défaut) ou ``off`` ; une autre valeur garde ``on``, signalée."""
    raw = (os.getenv(AUTO_SUSPEND_ENV) or "").strip().lower()
    if raw in {"", "on", "true", "1", "yes"}:
        return True
    if raw in {"off", "false", "0", "no"}:
        return False
    print(f"::warning title=Réglage ignoré::{AUTO_SUSPEND_ENV}={raw!r} n'est ni on ni off ; on est gardé", flush=True)
    return True


@dataclass(frozen=True)
class UnreachableDecision:
    """Ce que la fin d'une collecte retient de son échec de robots.txt."""

    failure_class: str | None
    unreachable_since: datetime | None
    probe_at: datetime | None
    suspend_until: datetime | None
    suspension_reason: str | None
    robots_failures: int = 0
    observed_failures: int = 0
    last_observed_at: datetime | None = None

    def coverage(self) -> dict[str, Any]:
        return {
            "failure_class": self.failure_class,
            "unreachable_since": self.unreachable_since.isoformat() if self.unreachable_since else None,
            "robots_failures": self.robots_failures,
            "unreachable_observed_failures": self.observed_failures,
            "unreachable_last_observed_at": self.last_observed_at.isoformat() if self.last_observed_at else None,
        }


def decide(previous_coverage: dict[str, Any], coverage: dict[str, Any], *, now: datetime,
           probe_available: bool, auto_suspend: bool = True) -> UnreachableDecision:
    """Classe de l'échec, début de l'indisponibilité, heure de la sonde et suspension, d'après la couverture.

    ``robots_failures`` : collectes consécutives finies sur une panne passagère (espacement de la sonde).
    ``unreachable_since`` ne court que sur des échecs de connexion relevés par le client des pages, sans trou de plus
    de ``OBSERVATION_GAP`` ; un même échec relu par deux collectes ne compte qu'une fois.
    """
    robots = coverage.get("robots_policy")
    robots = robots if isinstance(robots, dict) else {}
    # A copy reused for a passing outage still counts when not one request of the run succeeded.
    failed = robots.get("state") in {"unavailable", "refused"} or (
        robots.get("state") == "reused_copy" and not coverage.get("requests_succeeded")
    )
    failure_class = robots.get("failure_class") if failed else None
    failure_class = str(failure_class) if failure_class else None
    transient = failure_class in TRANSIENT_FAILURES
    robots_failures = int(previous_coverage.get("robots_failures") or 0) + 1 if transient else 0

    previous_since = aware_timestamp(previous_coverage.get("unreachable_since"))
    previous_count = int(previous_coverage.get("unreachable_observed_failures") or 0)
    previous_last = aware_timestamp(previous_coverage.get("unreachable_last_observed_at"))
    since, count, last = None, 0, None
    if failure_class in UNREACHABLE_FAILURES:
        observed_at = aware_timestamp(robots.get("observed_at")) or now
        if robots.get("observed_by") != PAGES:
            # Not seen by the source's pages client (a document download, an unknown recorder): never counted; a
            # series already running is kept as it is (the gap rule still applies to it).
            since, count, last = previous_since, previous_count, previous_last
        elif (
            previous_since is not None and previous_last is not None and previous_count > 0
            and timedelta(0) <= observed_at - previous_last <= OBSERVATION_GAP
        ):
            # The same failure read again by a later collection is counted once.
            fresh = observed_at > previous_last
            since, count, last = previous_since, previous_count + int(fresh), max(observed_at, previous_last)
        elif previous_last is not None and timedelta(0) <= previous_last - observed_at:
            since, count, last = previous_since, previous_count, previous_last
        else:
            since, count, last = observed_at, 1, observed_at
    # Only a run that sent no page request is a probe: a run that went on with the 24-hour copy of robots.txt and
    # tried its pages keeps the spacing of before, so the site never receives more requests than it did.
    probe_only = not int(coverage.get("requests_attempted") or 0)
    probe_at = (
        now + probe_interval(robots_failures)
        if auto_suspend and transient and probe_available and probe_only else None
    )
    suspend_until = None
    reason = None
    if (
        auto_suspend and since is not None and last is not None and count >= MIN_OBSERVED_FAILURES
        and now - since >= UNREACHABLE_SUSPENSION_AFTER and now - last <= OBSERVATION_GAP
    ):
        suspend_until = now + UNREACHABLE_SUSPENSION
        reason = (
            f"{SUSPENSION_REASON}: no answer since {since.isoformat()} ({failure_class}, {count} failures); "
            f"probe at {suspend_until.isoformat()}"
        )
    return UnreachableDecision(failure_class, since, probe_at, suspend_until, reason, robots_failures, count, last)


_cache: dict[str, tuple[float, dict[str, datetime]]] = {}
_cache_lock = threading.Lock()


def _suspended_sources(db_url: str) -> dict[str, datetime]:
    with _cache_lock:
        cached = _cache.get(db_url)
        if cached is not None and time.monotonic() - cached[0] < CACHE_SECONDS:
            return cached[1]
    try:
        from src.storage.supabase_client import connect

        with connect(db_url, connect_timeout=5, retry_delays=()) as db:
            rows = db.execute(_QUERY, (SUSPENSION_REASON + "%",)).fetchall()
        value = {str(name): stamp for name, until in rows if (stamp := aware_timestamp(until)) is not None}
    except Exception as exc:  # noqa: BLE001 - lecture facultative : sans elle, la pièce est lue comme avant
        LOGGER.warning("Unreachable source suspensions unreadable (%s)", type(exc).__name__)
        value = {}
    with _cache_lock:
        _cache[db_url] = (time.monotonic(), value)
    return value


def reset_cache() -> None:
    with _cache_lock:
        _cache.clear()


def suspended_host_until(url: str, db_url: str) -> datetime | None:
    """Reprise prévue quand ``url`` est hébergée sur le site d'une source suspendue pour indisponibilité."""
    if not db_url:
        return None
    host = host_of(url)
    if host is None:
        return None
    for source, until in _suspended_sources(db_url).items():
        try:
            base = host_of(str(importlib.import_module(f"src.sources.{source}").BASE_URL))
        except (ImportError, AttributeError):
            continue
        if base and (host == base or host.endswith("." + base)):
            return until
    return None
