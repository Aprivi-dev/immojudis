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

Copie commune à tous les processus (migration 20261204100000, ``src.sources.robots_policy_store``) : la voie
d'enrichissement fait tourner plusieurs processus, qui liraient chacun robots.txt. La même copie, gardée dans une
table privée, sert alors à deux choses, avec les mêmes règles de fraîcheur que ci-dessus :

* lue depuis moins de ``REUSE_WITHOUT_FETCH`` (30 min, un passage du travailleur d'avant), elle tient lieu de
  lecture : aucun processus ne relit robots.txt plus souvent qu'un seul ne le faisait ;
* plus vieille, elle reste la copie de repli d'une panne passagère (24 h au plus, ``MAX_AGE``).

La table garde aussi le dernier échec (``RobotsFailure``), avec sa classe (``failure_class``), le nombre d'échecs
consécutifs et le client qui l'a relevé (``PAGES`` : le client des pages d'une source, ``DOCUMENTS`` : celui des
pièces). Après une panne passagère (pas de réponse TCP, délai, 5xx), l'hôte n'est relu qu'après ``probe_interval``,
par une seule requête sans reprise (la sonde) : 60 min après le premier échec, puis 2 h, 4 h, et 6 h au plus. Dans
les 24 h qui suivent un échec, cela fait cinq sondes, puis quatre par jour, tous processus confondus, contre quatre
essais à chaque collecte espacée de 30 min à 6 h avant (``autonomous_runner.next_attempt`` : 24 puis 16 requêtes) :
jamais plus de requêtes qu'avant. Un refus
(401, 403, page de défi) n'est jamais gardé comme une politique : il est rendu tel quel jusqu'à la sonde suivante,
puis robots.txt est relu.
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
#: Copie commune assez récente pour tenir lieu de lecture (un passage du travailleur d'avant).
REUSE_WITHOUT_FETCH = timedelta(minutes=30)
#: Après un premier échec, robots.txt n'est relu (sonde : une requête, sans reprise) qu'après ce délai ; il double
#: à chaque échec consécutif, jusqu'à ``PROBE_MAX_INTERVAL`` (``probe_interval``).
PROBE_INTERVAL = timedelta(minutes=60)
PROBE_MAX_INTERVAL = timedelta(hours=6)
#: Qui a relevé un échec : le client des pages d'une source (``common.PoliteHttpClient``), seul compté pour la
#: suspension d'une source, ou celui des pièces (``document_politeness``).
PAGES = "pages"
DOCUMENTS = "documents"
RECORDERS = frozenset({PAGES, DOCUMENTS})
#: Classes d'échec : pas de réponse TCP, délai de lecture, erreur 5xx (passagères), refus, autre erreur HTTP.
NO_TCP_RESPONSE = "no_tcp_response"
TIMEOUT = "timeout"
SERVER_ERROR = "server_error"
ACCESS_REFUSED = "access_refused"
HTTP_ERROR = "http_error"
TRANSIENT_FAILURES = frozenset({NO_TCP_RESPONSE, TIMEOUT, SERVER_ERROR})
#: Échecs de connexion (le site ne répond pas) : ceux qui, prolongés, suspendent une source.
UNREACHABLE_FAILURES = frozenset({NO_TCP_RESPONSE, TIMEOUT})


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


def probe_interval(failures: int) -> timedelta:
    """Délai avant la sonde suivante après ``failures`` échecs consécutifs : 60 min, 2 h, 4 h, puis 6 h."""
    return min(PROBE_INTERVAL * 2 ** min(max(0, int(failures) - 1), 8), PROBE_MAX_INTERVAL)


def failure_class(*, status_code: int | None = None, error: BaseException | None = None,
                  refused: bool = False) -> str:
    """Classe d'un échec de lecture de robots.txt (ou d'une requête) : la même pour la copie commune, la couverture
    d'une source et le détail de son alerte.

    Seule une erreur réseau compte comme panne de connexion : pas de réponse TCP (connexion refusée ou sans
    réponse, nom introuvable), ou délai et coupure de lecture. Une erreur TLS (le serveur a répondu) et toute autre
    exception (une valeur invalide, une erreur de code) sont des ``http_error``.
    """
    if refused or status_code in {401, 403}:
        return ACCESS_REFUSED
    if isinstance(status_code, int) and status_code >= 500:
        return SERVER_ERROR
    if isinstance(status_code, int) and status_code >= 400:
        return HTTP_ERROR
    chain = _causes(error)
    if any(_is_tls_error(cause) for cause in chain):
        return HTTP_ERROR
    if any(_is_connect_error(cause) for cause in chain):
        return NO_TCP_RESPONSE
    if any(_is_read_failure(cause) for cause in chain):
        return TIMEOUT
    return HTTP_ERROR


def _causes(error: BaseException | None) -> list[BaseException]:
    chain: list[BaseException] = []
    current = error
    while current is not None and current not in chain and len(chain) < 10:
        chain.append(current)
        current = current.__cause__ or current.__context__
    return chain


def _is_tls_error(error: BaseException) -> bool:
    import ssl

    return isinstance(error, ssl.SSLError) or "[SSL" in str(error) or "CERTIFICATE_VERIFY_FAILED" in str(error)


def _is_connect_error(error: BaseException) -> bool:
    import socket

    import httpx

    return isinstance(error, (httpx.ConnectError, httpx.ConnectTimeout, ConnectionError, socket.gaierror))


def _is_read_failure(error: BaseException) -> bool:
    import httpx

    return isinstance(error, (httpx.TimeoutException, httpx.NetworkError, httpx.RemoteProtocolError, TimeoutError))


@dataclass(frozen=True)
class RobotsFailure:
    """Dernier échec de lecture d'une origine : sa classe, son heure, les échecs consécutifs et qui l'a relevé."""

    failure_class: str
    failed_at: datetime
    count: int = 1
    recorded_by: str | None = None

    @property
    def transient(self) -> bool:
        return self.failure_class in TRANSIENT_FAILURES

    def probe_not_before(self) -> datetime:
        return self.failed_at + probe_interval(self.count)

    def series_started_at(self) -> datetime:
        """Début estimé de la série d'échecs consécutifs, que la table ne garde pas : le dernier échec moins les
        espacements des sondes qui l'ont précédé (60 min, 2 h, 4 h, puis 6 h). Des échecs plus rapprochés (deux
        processus à la même sonde, ``http_error`` relus sans attente) avancent l'estimation, jamais l'inverse tant
        que chaque sonde a lieu à son heure.

        La durée est estimée à partir du nombre d'échecs, pas mesurée : des sondes plus espacées que prévu (aucun
        processus ne demande l'hôte à l'heure de la sonde, la sonde suivante n'a lieu qu'à la visite d'après) la
        sous-estiment : la panne peut avoir commencé bien avant l'heure rendue. D'où la seconde borne, propre à la
        tâche, de ``pdf_pass_outcomes.HOST_OUTAGE_DEFERRAL_LIMIT``."""
        return self.failed_at - sum((probe_interval(count) for count in range(1, self.count)), timedelta(0))

    def to_json(self) -> dict[str, Any]:
        return {"failure_class": self.failure_class, "failed_at": self.failed_at.isoformat(), "count": self.count,
                "recorded_by": self.recorded_by}


@dataclass(frozen=True)
class SharedPolicy:
    """Ce que la copie commune sait d'une origine."""

    copy: RobotsPolicyCopy | None
    failure: RobotsFailure | None


@dataclass(frozen=True)
class BeforeFetch:
    """Que faire avant de lire robots.txt : ``reuse`` (la copie tient lieu de lecture), ``refused`` ou
    ``not_due`` (l'échec récent est rendu sans requête), ``fetch`` (``probe`` : une seule requête, sans reprise)."""

    action: str
    copy: RobotsPolicyCopy | None = None
    failure: RobotsFailure | None = None
    probe: bool = False


def before_fetch(shared: SharedPolicy | None, user_agent: str, now: datetime | None = None) -> BeforeFetch:
    """La règle commune de fraîcheur, avant toute lecture de robots.txt (client des pages et client des pièces)."""
    current = now or datetime.now(UTC)
    if shared is None:
        return BeforeFetch("fetch")
    copy, failure = shared.copy, shared.failure
    recent_failure = failure is not None and (copy is None or failure.failed_at >= copy.verified_at)
    if recent_failure and failure is not None and current < failure.probe_not_before():
        if failure.transient:
            return BeforeFetch("not_due", failure=failure)
        if failure.failure_class == ACCESS_REFUSED:
            return BeforeFetch("refused", failure=failure)
    if (
        not recent_failure
        and copy is not None
        and copy.usable(user_agent, current)
        and copy.age(current) <= REUSE_WITHOUT_FETCH
    ):
        return BeforeFetch("reuse", copy=copy)
    return BeforeFetch("fetch", failure=failure if recent_failure else None,
                       probe=bool(recent_failure and failure is not None and failure.transient))


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


def recall(key: str, user_agent: str, now: datetime | None = None,
           shared: RobotsPolicyCopy | None = None) -> RobotsPolicyCopy | None:
    """Copie persistée de cette origine encore valable pour notre agent (installée ou commune, la plus récente),
    sinon ``None``."""
    current = now or datetime.now(UTC)
    with _lock:
        installed = _installed.get(key)
    usable = [copy for copy in (installed, shared) if copy is not None and copy.usable(user_agent, current)]
    return max(usable, key=lambda copy: copy.verified_at) if usable else None
