"""Copie commune des politiques robots.txt, partagée par tous les processus (migration 20261204100000).

Table privée ``app_private.robots_policies`` : une ligne par origine (``robots_policy_copies.origin_key``), avec
les règles retenues pour notre agent, le ``Crawl-delay``, l'heure de lecture et l'empreinte de l'agent (la même
forme que les copies de ``auction_source_state.coverage``), et le dernier échec (classe, heure, échecs consécutifs,
client qui l'a relevé). Les règles de
fraîcheur et de repli sont celles de ``robots_policy_copies`` ; ce module ne fait que lire et écrire la ligne.

Tolérant : sans base, sans la migration (table absente) ou base injoignable, il ne rend rien et n'écrit rien, et
chaque processus lit robots.txt comme avant. Une table absente n'est cherchée qu'une fois par processus.
"""

from __future__ import annotations

import logging
import threading
from datetime import datetime
from typing import Any

from psycopg.types.json import Jsonb

from src.config import load_settings
from src.sources.robots_policy_copies import RobotsFailure, RobotsPolicyCopy, SharedPolicy
from src.timestamps import aware_timestamp

LOGGER = logging.getLogger(__name__)

UNDEFINED_TABLE_SQLSTATE = "42P01"
_SELECT_SQL = """select rules, crawl_delay, verified_at, user_agent_digest, last_failure_class, last_failure_at,
    failure_count, last_failure_by
  from app_private.robots_policies where origin = %s"""
_SAVE_VERIFIED_SQL = """insert into app_private.robots_policies
    (origin, rules, crawl_delay, verified_at, user_agent_digest, last_failure_class, last_failure_at, updated_at)
  values (%s, %s, %s, %s, %s, null, null, now())
  on conflict (origin) do update set
    rules = excluded.rules, crawl_delay = excluded.crawl_delay, verified_at = excluded.verified_at,
    user_agent_digest = excluded.user_agent_digest,
    last_failure_class = case when robots_policies.last_failure_at > excluded.verified_at
                              then robots_policies.last_failure_class end,
    last_failure_at = case when robots_policies.last_failure_at > excluded.verified_at
                           then robots_policies.last_failure_at end,
    last_failure_by = case when robots_policies.last_failure_at > excluded.verified_at
                           then robots_policies.last_failure_by end,
    failure_count = case when robots_policies.last_failure_at > excluded.verified_at
                         then robots_policies.failure_count else 0 end,
    updated_at = now()
  where robots_policies.verified_at is null or robots_policies.verified_at <= excluded.verified_at"""
# Échecs consécutifs : un échec qui suit un échec (sans lecture réussie plus récente) prolonge la série.
_SAVE_FAILURE_SQL = """insert into app_private.robots_policies
    (origin, last_failure_class, last_failure_at, last_failure_by, failure_count, updated_at)
  values (%s, %s, %s, %s, 1, now())
  on conflict (origin) do update set
    last_failure_class = excluded.last_failure_class, last_failure_at = excluded.last_failure_at,
    last_failure_by = excluded.last_failure_by,
    failure_count = case
      when robots_policies.last_failure_at is not null
       and (robots_policies.verified_at is null or robots_policies.last_failure_at >= robots_policies.verified_at)
        then robots_policies.failure_count + 1
      else 1 end,
    updated_at = now()
  where robots_policies.last_failure_at is null or robots_policies.last_failure_at <= excluded.last_failure_at
  returning last_failure_class, last_failure_at, failure_count, last_failure_by"""

_state = {"disabled": False}
_state_lock = threading.Lock()


def _db_url() -> str:
    return str(load_settings().get("supabase_db_url") or "")


def _run(sql: str, parameters: tuple[Any, ...], *, fetch: bool) -> Any:
    with _state_lock:
        if _state["disabled"]:
            return None
    db_url = _db_url()
    if not db_url:
        return None
    from src.storage.supabase_client import shared_postgres_connection

    try:
        with shared_postgres_connection(db_url) as db:
            cursor = db.execute(sql, parameters)
            return cursor.fetchone() if fetch else True
    except Exception as exc:  # noqa: BLE001 - copie facultative : sans elle, robots.txt est lu comme avant
        if getattr(exc, "sqlstate", None) == UNDEFINED_TABLE_SQLSTATE:
            with _state_lock:
                _state["disabled"] = True
            LOGGER.info("Shared robots.txt policies unavailable (migration 20261204100000 not applied)")
        else:
            LOGGER.warning("Shared robots.txt policy store unavailable (%s)", type(exc).__name__)
        return None


def load(origin_key: str) -> SharedPolicy | None:
    """La copie commune de cette origine (``None`` : rien de connu, ou pas de copie commune)."""
    row = _run(_SELECT_SQL, (origin_key,), fetch=True)
    if not row:
        return None
    rules, crawl_delay, verified_at, digest, failure_class, failed_at, failure_count, failure_by = row
    copy = None
    if verified_at is not None:
        copy = RobotsPolicyCopy.from_json({
            "rules": rules, "crawl_delay": float(crawl_delay) if crawl_delay is not None else None,
            "verified_at": verified_at.isoformat() if isinstance(verified_at, datetime) else verified_at,
            "user_agent_digest": digest,
        })
    return SharedPolicy(copy=copy, failure=_failure(failure_class, failed_at, failure_count, failure_by))


def _failure(failure_class: Any, failed_at: Any, failure_count: Any, failure_by: Any) -> RobotsFailure | None:
    failed = aware_timestamp(failed_at)
    if not failure_class or failed is None:
        return None
    return RobotsFailure(str(failure_class), failed, max(1, int(failure_count or 1)),
                         str(failure_by) if failure_by else None)


def save_verified(origin_key: str, copy: RobotsPolicyCopy) -> None:
    """Une lecture réussie : elle remplace la copie (jamais par une plus ancienne) et efface l'échec plus ancien."""
    _run(
        _SAVE_VERIFIED_SQL,
        (origin_key, Jsonb([list(rule) for rule in copy.rules]), copy.crawl_delay, copy.verified_at,
         copy.user_agent_digest),
        fetch=False,
    )


def save_failure(origin_key: str, failure: RobotsFailure) -> RobotsFailure | None:
    """Un échec de lecture : la copie déjà gardée reste (repli d'une panne passagère, 24 h au plus).

    Rend l'échec tel que la copie commune le garde, avec le nombre d'échecs consécutifs : celui-ci, ou un échec plus
    récent relevé par un autre processus. ``None`` sans copie commune (pas de base, table absente, base injoignable).
    """
    row = _run(_SAVE_FAILURE_SQL, (origin_key, failure.failure_class, failure.failed_at, failure.recorded_by),
               fetch=True)
    if row:
        return _failure(*row)
    shared = load(origin_key)  # un échec plus récent l'a emporté (``where`` de ``_SAVE_FAILURE_SQL``)
    return shared.failure if shared is not None else None
