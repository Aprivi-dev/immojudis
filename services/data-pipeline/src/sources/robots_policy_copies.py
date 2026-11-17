"""Dernière politique robots.txt vérifiée par origine, réutilisable 24 heures au plus.

RFC 9309 §2.4 : un robot peut garder une copie de robots.txt jusqu'à 24 heures et s'en servir quand le
fichier est momentanément injoignable. Sans copie, une seule panne passagère de robots.txt arrêtait tout
l'inventaire avant la première requête (Enchères Immobilières, novembre 2026 : 7 passages sur 14 arrêtés en
50 secondes, ``http_attempts 0``).

Le client HTTP (``common.PoliteHttpClient``) ne se sert d'une copie que pour une panne passagère (délai
dépassé, erreur réseau, réponse 5xx) ; un refus (401, 403, page de défi) et une copie de plus de 24 heures
gardent l'arrêt. Les règles Disallow et le Crawl-delay de la copie s'appliquent comme celles d'une lecture
fraîche.

Les passages tournent dans des runs GitHub Actions séparés : la copie est gardée dans le JSON ``coverage``
de ``public.auction_source_state`` sous la clé ``COVERAGE_KEY`` (aucune colonne). Le client la publie dans
sa couverture ; ``autonomous_runner.finish_source`` la conserve d'un passage à l'autre ; ``src.main`` la
relit (passage planifié seulement) et l'installe ici avant la collecte. Base illisible ou clé absente : aucune
copie, comportement d'avant (arrêt).
"""

from __future__ import annotations

import hashlib
import math
import threading
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

from src.timestamps import aware_timestamp

#: RFC 9309 §2.4 : au-delà, la copie ne vaut plus rien.
MAX_AGE = timedelta(hours=24)
#: Clé du JSON ``auction_source_state.coverage`` (et de la couverture d'un passage) qui porte les copies.
COVERAGE_KEY = "robots_policy_copies"
#: Une politique plus longue n'est pas gardée (le JSON de couverture reste petit) : sans copie, arrêt.
MAX_RULES = 1000


@dataclass(frozen=True)
class RobotsPolicyCopy:
    """Règles retenues pour notre agent, telles que lues lors de la dernière lecture réussie."""

    rules: tuple[tuple[str, str], ...]
    crawl_delay: float | None
    verified_at: datetime
    # Les règles dépendent du groupe choisi pour notre User-Agent : une copie faite pour un autre agent
    # ne vaut pas. Empreinte seulement, l'agent lui-même n'est pas recopié.
    user_agent_digest: str

    def age(self, now: datetime) -> timedelta:
        return now - self.verified_at

    def usable(self, user_agent: str, now: datetime) -> bool:
        return (
            self.user_agent_digest == user_agent_digest(user_agent)
            and timedelta(0) <= self.age(now) <= MAX_AGE
        )

    def to_json(self) -> dict[str, Any]:
        return {
            "verified_at": self.verified_at.isoformat(),
            "rules": [list(rule) for rule in self.rules],
            "crawl_delay": self.crawl_delay,
            "user_agent_digest": self.user_agent_digest,
        }

    @classmethod
    def from_json(cls, value: object) -> RobotsPolicyCopy | None:
        """Copie relue du JSON stocké ; ``None`` pour toute forme inattendue (jamais une politique devinée)."""
        if not isinstance(value, Mapping):
            return None
        verified_at = aware_timestamp(value.get("verified_at"))
        raw_rules = value.get("rules")
        digest = value.get("user_agent_digest")
        if verified_at is None or not isinstance(raw_rules, list) or not isinstance(digest, str) or not digest:
            return None
        if len(raw_rules) > MAX_RULES:
            return None
        rules: list[tuple[str, str]] = []
        for rule in raw_rules:
            if (
                not isinstance(rule, (list, tuple))
                or len(rule) != 2
                or rule[0] not in {"allow", "disallow"}
                or not isinstance(rule[1], str)
            ):
                return None
            rules.append((rule[0], rule[1]))
        delay = value.get("crawl_delay")
        if delay is not None:
            if isinstance(delay, bool) or not isinstance(delay, (int, float)):
                return None
            delay = float(delay)
            if not math.isfinite(delay) or delay < 0:
                return None
        return cls(tuple(rules), delay, verified_at, digest)


def user_agent_digest(user_agent: str) -> str:
    return hashlib.sha256(user_agent.encode("utf-8")).hexdigest()[:16]


def origin_key(origin: tuple[str, str, int]) -> str:
    scheme, host, port = origin
    return f"{scheme}://{host}:{port}"


def parse_copies(value: object) -> dict[str, RobotsPolicyCopy]:
    """Copies lisibles d'un JSON ``{origine: copie}`` ; une entrée malformée est ignorée."""
    if not isinstance(value, Mapping):
        return {}
    copies: dict[str, RobotsPolicyCopy] = {}
    for key, raw in value.items():
        copy = RobotsPolicyCopy.from_json(raw)
        if isinstance(key, str) and copy is not None:
            copies[key] = copy
    return copies


def merge_copies(*values: object, now: datetime | None = None) -> dict[str, dict[str, Any]]:
    """Fusion JSON des copies : la plus récente par origine, sans celles de plus de 24 heures."""
    current = now or datetime.now(UTC)
    merged: dict[str, RobotsPolicyCopy] = {}
    for value in values:
        for key, copy in parse_copies(value).items():
            if not timedelta(0) <= copy.age(current) <= MAX_AGE:
                continue
            kept = merged.get(key)
            if kept is None or copy.verified_at > kept.verified_at:
                merged[key] = copy
    return {key: copy.to_json() for key, copy in sorted(merged.items())}


_lock = threading.Lock()
_installed: dict[str, RobotsPolicyCopy] = {}


def install(stored: Iterable[object]) -> None:
    """Remplace les copies connues de ce processus par celles lues en base (``src.main``) ou reçues du parent
    (travailleur de collecte isolé) : JSON ``{origine: copie}``, la plus récente par origine, 24 h au plus."""
    copies = parse_copies(merge_copies(*stored))
    with _lock:
        _installed.clear()
        _installed.update(copies)


def installed_json() -> dict[str, dict[str, Any]]:
    """Copies installées, pour les transmettre à un travailleur de collecte isolé."""
    with _lock:
        return {key: copy.to_json() for key, copy in _installed.items()}


def recall(key: str, user_agent: str, now: datetime | None = None) -> RobotsPolicyCopy | None:
    """Copie persistée de cette origine encore valable pour notre agent, sinon ``None``."""
    with _lock:
        copy = _installed.get(key)
    if copy is None or not copy.usable(user_agent, now or datetime.now(UTC)):
        return None
    return copy
