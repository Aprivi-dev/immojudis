"""Source injoignable : sonde horaire, puis suspension de 7 jours après 72 h (décision du 17/11/2026, lot 5).

Enchères Immobilières ne répondait plus depuis le 15/11/2026 (« robots.txt could not be verified … timed out »,
``ConnectTimeout``, 0 requête) : chaque collecte attendait jusqu'à 6 h entre deux essais, et chaque passage du
travailleur perdait ~2,5 min sur quatre essais de robots.txt pour les fiches de la source. Trois règles, appliquées
à la fin de chaque collecte (``src.autonomous_runner.finish_source``) :

* (a) quand le dernier échec est une panne passagère de robots.txt (pas de réponse TCP, délai, 5xx), que la collecte
  n'a envoyé aucune requête de page et que la copie commune de robots.txt existe (migration 20261204100000), la
  collecte suivante part 60 min plus tard (``PROBE_INTERVAL``) au lieu de jusqu'à 6 h : elle commence par une seule
  lecture de robots.txt, sans reprise (``robots_policy_copies.before_fetch``). Aucun processus ne relit robots.txt avant ce délai : le volume de
  requêtes vers le site baisse (une par heure au plus, contre quatre par passage) ;
* (b) la classe de l'échec (``robots_policy_copies.failure_class``) est gardée dans la couverture de la source
  (``failure_class``, ``unreachable_since``) et dans le détail de son alerte ;
* (c) après 72 h d'échecs de connexion continus (pas de réponse TCP, délai), la source est suspendue 7 jours
  (``suspended_until``, ``suspension_reason`` commençant par ``SUSPENSION_REASON``) : le planificateur ne la lance
  plus, la file ne prend plus ses fiches (``claim_auction_enrichment_jobs_family`` filtre ``suspended_until``), et
  les pièces hébergées sur son site attendent la reprise sans perdre d'essai (``suspended_host_until``). Rien n'est
  retiré du catalogue. L'alerte ``pipeline.source.<nom>.suspended_unreachable`` l'annonce, avec la date de reprise.
  À l'échéance, la collecte relancée par le planificateur est la sonde : si le site ne répond toujours pas, la
  suspension repart pour 7 jours.

Le relais (``SOURCE_FETCH_RELAY_URL``) n'est jamais une issue : contourner un site qui ne nous répond plus pourrait
contourner un blocage (``src.sources.cloud_transport`` ne le permet qu'aux hôtes de sa liste).
"""

from __future__ import annotations

import importlib
import logging
import threading
import time
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

from src.host_turn import host_of
from src.sources.robots_policy_copies import PROBE_INTERVAL, TRANSIENT_FAILURES, UNREACHABLE_FAILURES
from src.timestamps import aware_timestamp

LOGGER = logging.getLogger(__name__)

UNREACHABLE_SUSPENSION_AFTER = timedelta(hours=72)
UNREACHABLE_SUSPENSION = timedelta(days=7)
SUSPENSION_REASON = "source_unreachable"
CACHE_SECONDS = 60.0
_QUERY = """select source_name, suspended_until from public.auction_source_state
  where suspended_until > now() and suspension_reason like %s"""


@dataclass(frozen=True)
class UnreachableDecision:
    """Ce que la fin d'une collecte retient de son échec de robots.txt."""

    failure_class: str | None
    unreachable_since: datetime | None
    probe_at: datetime | None
    suspend_until: datetime | None
    suspension_reason: str | None

    def coverage(self) -> dict[str, Any]:
        return {
            "failure_class": self.failure_class,
            "unreachable_since": self.unreachable_since.isoformat() if self.unreachable_since else None,
        }


def decide(previous_coverage: dict[str, Any], coverage: dict[str, Any], *, now: datetime,
           probe_available: bool) -> UnreachableDecision:
    """Classe de l'échec, début de l'indisponibilité, heure de la sonde et suspension, d'après la couverture."""
    robots = coverage.get("robots_policy")
    robots = robots if isinstance(robots, dict) else {}
    # A copy reused for a passing outage still counts when not one request of the run succeeded.
    failed = robots.get("state") in {"unavailable", "refused"} or (
        robots.get("state") == "reused_copy" and not coverage.get("requests_succeeded")
    )
    failure_class = robots.get("failure_class") if failed else None
    failure_class = str(failure_class) if failure_class else None
    unreachable = failure_class in UNREACHABLE_FAILURES
    previous_since = aware_timestamp(previous_coverage.get("unreachable_since"))
    since = (previous_since or now) if unreachable else None
    # Only a run that sent no page request is a probe: a run that went on with the 24-hour copy of robots.txt and
    # tried its pages keeps the spacing of before, so the site never receives more requests than it did.
    probe_only = not int(coverage.get("requests_attempted") or 0)
    probe_at = now + PROBE_INTERVAL if failure_class in TRANSIENT_FAILURES and probe_available and probe_only else None
    suspend_until = None
    reason = None
    if since is not None and now - since >= UNREACHABLE_SUSPENSION_AFTER:
        suspend_until = now + UNREACHABLE_SUSPENSION
        reason = (
            f"{SUSPENSION_REASON}: no answer since {since.isoformat()} ({failure_class}); "
            f"probe at {suspend_until.isoformat()}"
        )
    return UnreachableDecision(failure_class, since, probe_at, suspend_until, reason)


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
        value = {str(name): until for name, until in rows if aware_timestamp(until) is not None}
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
            return aware_timestamp(until) or datetime.now(UTC) + UNREACHABLE_SUSPENSION
    return None
