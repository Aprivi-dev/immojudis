"""Drapeau ``probable_duplicate`` : les ventes publiées que le balayage des doublons supprimerait.

``python -m src.probable_duplicates`` (workflow « Probable duplicate flags ») reprend, sans la refaire, la logique
de candidats du balayage (``plan_duplicate_reconciliation`` : identifiant d'annonce commun, adresse précise, même
contenu, clé de repli stricte commune / jour / prix) et pose ``probable_duplicate`` dans ``quality_flags`` sur les
lignes secondaires, celles qui seraient supprimées. La ligne conservée n'est pas marquée : c'est la copie qui
restera. Le site refuse la vue aérienne « bâtiment » d'une vente marquée (deux copies peuvent porter des points
différents) ; la colonne n'est exposée aux comptes que par la liste blanche de
``app_private.public_position_quality_flags``.

* Aucune fusion, aucune suppression : seule la colonne ``quality_flags`` des lignes qui changent est écrite, une ligne
  à la fois (``PATCH``), et uniquement avec ``--write``. Sans cette option, le passage est un essai à blanc.
* Le drapeau est retiré dès que la condition disparaît : ligne qui n'est plus candidate (annonce corrigée, groupe
  devenu trop gros, alias relu), ligne conservée après une fusion, ligne qui a quitté les statuts publiés.
* Un balayage partiel (plafond de lecture atteint, erreur de lecture) ne retire jamais un drapeau : rien ne prouve
  que la condition a disparu. Les ajouts restent permis (une paire vue est une paire vue).
* Une collecte qui réécrit la ligne remet ses drapeaux à ceux de la source : le passage suivant le repose. Le recalcul
  des ventes (``recompute_scoring``) le conserve.

Code de sortie : 0 (fait, ou essai à blanc), 1 (configuration, lecture ou écriture en échec).
"""

from __future__ import annotations

import argparse
import logging
from dataclasses import dataclass
from dataclasses import field as dataclass_field
from typing import Any

import httpx

from src.config import load_settings
from src.position_quality import PROBABLE_DUPLICATE
from src.storage.duplicate_sweep import DuplicateSweepPlan
from src.storage.postgrest_helpers import _rest_headers
from src.storage.supabase_client import plan_duplicate_reconciliation

LOGGER = logging.getLogger(__name__)

_TIMEOUT = httpx.Timeout(60.0, connect=30.0)
_PAGE_SIZE = 1000
# Plafond d'écritures par passage : un passage qui voudrait en faire davantage est suspect (le premier en pose environ
# autant qu'il y a de lignes en trop) ; le reste est repris au passage suivant.
MAX_WRITES_PER_PASS = 3000


@dataclass
class FlagUpdates:
    """Listes ``quality_flags`` complètes à écrire, par identifiant de ligne."""

    add: dict[str, list[str]] = dataclass_field(default_factory=dict)
    remove: dict[str, list[str]] = dataclass_field(default_factory=dict)

    @property
    def total(self) -> int:
        return len(self.add) + len(self.remove)


def _with_flag(flags: list[str]) -> list[str]:
    return [*flags, PROBABLE_DUPLICATE]


def _without_flag(flags: list[str]) -> list[str]:
    return [flag for flag in flags if flag != PROBABLE_DUPLICATE]


def _string_flags(value: object) -> list[str]:
    return [flag for flag in value if isinstance(flag, str)] if isinstance(value, list) else []


def plan_flag_updates(plan: DuplicateSweepPlan, flagged_rows: list[dict[str, Any]]) -> FlagUpdates:
    """Ce qu'il faut écrire pour que les lignes marquées soient exactement les secondaires du plan.

    ``flagged_rows`` : les lignes qui portent aujourd'hui le drapeau (``id``, ``quality_flags``), tous statuts.
    """
    updates = FlagUpdates()
    wanted: set[str] = set()
    for group in plan.groups:
        for secondary in group.secondaries:
            if not secondary.id:
                continue
            wanted.add(secondary.id)
            if PROBABLE_DUPLICATE not in secondary.quality_flags:
                updates.add[secondary.id] = _with_flag(list(secondary.quality_flags))
    if plan.truncated:
        # Lecture partielle : la condition n'est pas démontrée disparue pour les lignes qu'on n'a pas lues.
        return updates
    for row in flagged_rows:
        row_id = str(row.get("id") or "")
        flags = _string_flags(row.get("quality_flags"))
        if row_id and row_id not in wanted and PROBABLE_DUPLICATE in flags:
            updates.remove[row_id] = _without_flag(flags)
    return updates


def fetch_flagged_rows(supabase_url: str, api_key: str) -> list[dict[str, Any]]:
    """Toutes les lignes qui portent le drapeau, quel que soit leur statut. Lève ``httpx.HTTPError`` en cas d'échec."""
    endpoint = f"{supabase_url.rstrip('/')}/rest/v1/auction_sales"
    rows: list[dict[str, Any]] = []
    offset = 0
    while True:
        response = httpx.get(
            endpoint,
            params={
                "select": "id,quality_flags",
                "quality_flags": f'cs.["{PROBABLE_DUPLICATE}"]',
                "order": "id.asc",
                "limit": str(_PAGE_SIZE),
                "offset": str(offset),
            },
            headers=_rest_headers(api_key, prefer="count=none"),
            timeout=_TIMEOUT,
        )
        if response.is_error:
            raise httpx.HTTPError(f"HTTP {response.status_code} while reading the flagged rows")
        page = response.json()
        if not page:
            return rows
        rows.extend(row for row in page if isinstance(row, dict))
        offset += len(page)


def _write_flags(supabase_url: str, api_key: str, row_id: str, flags: list[str]) -> bool:
    """Écrit la liste ``quality_flags`` d'une ligne ; seule colonne touchée."""
    try:
        response = httpx.patch(
            f"{supabase_url.rstrip('/')}/rest/v1/auction_sales",
            params={"id": f"eq.{row_id}"},
            json={"quality_flags": flags},
            headers=_rest_headers(api_key, prefer="return=minimal"),
            timeout=_TIMEOUT,
        )
    except httpx.HTTPError as exc:
        LOGGER.warning("Probable duplicate flag: write failed for %s: %s", row_id, exc)
        return False
    if response.is_error:
        LOGGER.warning(
            "Probable duplicate flag: write failed for %s (%s): %s", row_id, response.status_code, response.text[:200]
        )
        return False
    return True


def flag_probable_duplicates(*, write: bool = False) -> int:
    """Calcule les ajouts et retraits, et les écrit si ``write``. Code de sortie : 0 (fait) ou 1 (échec)."""
    settings = load_settings()
    url, key = settings.get("supabase_url"), settings.get("supabase_service_role_key")
    if not url or not key:
        LOGGER.error("Probable duplicate flag: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.")
        return 1
    plan = plan_duplicate_reconciliation(max_merges=None)
    if plan is None:
        LOGGER.error("Probable duplicate flag: the duplicate plan is unavailable.")
        return 1
    try:
        flagged = fetch_flagged_rows(str(url), str(key))
    except httpx.HTTPError as exc:
        LOGGER.error("Probable duplicate flag: reading the flagged rows failed (%s); nothing is written.", exc)
        return 1
    updates = plan_flag_updates(plan, flagged)
    LOGGER.info(
        "Probable duplicate flag: scanned=%s truncated=%s candidates=%s flagged=%s to_add=%s to_remove=%s write=%s",
        plan.scanned,
        plan.truncated,
        plan.secondary_count,
        len(flagged),
        len(updates.add),
        len(updates.remove),
        write,
    )
    if not write:
        LOGGER.info("Probable duplicate flag: dry run, nothing is written (use --write).")
        return 0
    failures = 0
    written = 0
    for row_id, flags in [*updates.remove.items(), *updates.add.items()]:
        if written >= MAX_WRITES_PER_PASS:
            LOGGER.warning("Probable duplicate flag: write cap (%s) reached; the rest waits for the next pass.", written)
            break
        if _write_flags(str(url), str(key), row_id, flags):
            written += 1
        else:
            failures += 1
    LOGGER.info("Probable duplicate flag: written=%s failed=%s", written, failures)
    return 1 if failures else 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--write", action="store_true", help="Écrit les drapeaux (sinon : essai à blanc).")
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    return flag_probable_duplicates(write=args.write)


if __name__ == "__main__":
    raise SystemExit(main())
