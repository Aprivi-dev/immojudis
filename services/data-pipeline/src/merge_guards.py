"""Garde-fous communs aux chemins qui fusionnent ou suppriment des lignes de ``auction_sales``.

Trois chemins suppriment une ligne secondaire après fusion : le balayage ``python -m src.dedupe_apply``, le
nettoyage de ``src.main`` (``--source all``) et la réconciliation. Les garde-fous vivent ici pour que chacun
les applique, et dans les fonctions de ``src.storage.supabase_client`` elles-mêmes (pas seulement dans
l'appelant) :

* le déclencheur ``auction_sales_carry_sale_user_data`` (migration 20261028110000) doit être en place : sans lui,
  supprimer une ligne efface les favoris, notes, alertes et rapports des comptes ;
* un plafond dur de ``MAX_MERGES_PER_PASS`` lignes supprimées par passage.
"""

from __future__ import annotations

import logging

LOGGER = logging.getLogger(__name__)

# Plafond dur d'écriture par passage : ``DEDUPE_RECONCILE_MAX_MERGES`` peut le baisser, jamais le dépasser.
MAX_MERGES_PER_PASS = 100

MERGE_TRIGGER = "auction_sales_carry_sale_user_data"


class MergeGuardRefused(RuntimeError):
    """Une fusion ou une suppression de lignes est refusée faute de garde-fou en place."""


def merge_trigger_deployed(db_url: str | None) -> bool:
    """Vrai si le déclencheur qui transfère les données des comptes avant une suppression est en place.

    Faux au moindre doute (pas d'URL de base, base injoignable, déclencheur absent) : mieux vaut ne rien
    supprimer que d'effacer les favoris et les notes de comptes.
    """
    if not db_url:
        return False
    try:
        from src.storage.supabase_client import connect

        with connect(db_url) as db:
            row = db.execute(
                "select exists(select 1 from pg_catalog.pg_trigger where tgname = %s"
                " and tgrelid = 'public.auction_sales'::regclass and not tgisinternal and tgenabled <> 'D')",
                (MERGE_TRIGGER,),
            ).fetchone()
        return bool(row and row[0])
    except Exception as exc:  # noqa: BLE001 - fail closed
        LOGGER.error("Merge guard: could not check the merge trigger (%s)", type(exc).__name__)
        return False


def merges_cap(settings: dict[str, object]) -> int:
    configured = settings.get("dedupe_reconcile_max_merges")
    value = int(configured) if isinstance(configured, (int, float, str)) else MAX_MERGES_PER_PASS
    return max(0, min(value, MAX_MERGES_PER_PASS))


def refusal_message() -> str:
    return (
        f"Le déclencheur {MERGE_TRIGGER} (migration 20261028110000) est absent ou illisible : une suppression "
        "effacerait les favoris, notes, alertes et rapports des comptes. Appliquer la migration (et vérifier "
        "SUPABASE_DB_URL), puis relancer."
    )


def require_merge_trigger(settings: dict[str, object]) -> None:
    """Lève ``MergeGuardRefused`` si le déclencheur de report des données des comptes manque."""
    if not merge_trigger_deployed(str(settings.get("supabase_db_url") or "")):
        raise MergeGuardRefused(refusal_message())
