"""Balayage des doublons déjà publiés, lancé à part de la collecte (workflow « Dedupe sweep »).

Pourquoi un point d'entrée dédié : la collecte planifiée lance toujours une seule source
(``src.autonomous_runner``), alors que le nettoyage de ``src.main`` n'a lieu que pour
``--source all`` sans limite. ``reconcile_duplicate_sales_in_supabase`` n'y tournait donc jamais.

``python -m src.dedupe_apply`` :

* ``DEDUPE_RECONCILE_MODE=candidates`` (ou ``--candidates``) : lecture seule, même rapport que
  ``python -m src.dedupe_candidates`` ; rien n'est écrit ;
* sinon, tant que ``DEDUPE_RECONCILE_ENABLED`` n'est pas vrai : rien n'est écrit non plus ;
* sinon : vérification que la migration 20261028110000 est appliquée (sans elle, la suppression d'une ligne
  effacerait favoris, notes, alertes et rapports des comptes : le balayage refuse), passerelle du catalogue
  vers le graphe des issues (préalable que la base exige avant toute suppression de fiche), puis fusion et
  suppression des lignes secondaires, au plus ``MAX_MERGES_PER_PASS`` lignes par passage (relancer pour la
  suite). Les données des comptes des lignes supprimées passent à la fiche conservée côté base (déclencheur
  ``auction_sales_carry_sale_user_data``).
"""

from __future__ import annotations

import argparse
import logging
import os
from pathlib import Path

from src.config import load_settings
from src.dedupe_candidates import report_duplicate_candidates

LOGGER = logging.getLogger(__name__)

# Plafond dur d'écriture par passage : ``DEDUPE_RECONCILE_MAX_MERGES`` peut le baisser, jamais le dépasser.
MAX_MERGES_PER_PASS = 100


def _write_summary(lines: list[str]) -> None:
    summary_path = os.getenv("GITHUB_STEP_SUMMARY")
    if not summary_path:
        return
    with Path(summary_path).open("a", encoding="utf-8") as handle:
        handle.write("\n".join(lines) + "\n")


MERGE_TRIGGER = "auction_sales_carry_sale_user_data"


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
        LOGGER.error("Dedupe sweep: could not check the merge trigger (%s)", type(exc).__name__)
        return False


def merges_cap(settings: dict[str, object]) -> int:
    configured = settings.get("dedupe_reconcile_max_merges")
    value = int(configured) if isinstance(configured, (int, float, str)) else MAX_MERGES_PER_PASS
    return max(0, min(value, MAX_MERGES_PER_PASS))


def apply_duplicate_sweep(*, candidates_only: bool = False, output: Path | None = None) -> int:
    """Code de sortie : 0 (fait, ou volontairement sans effet), 1 (configuration ou échec)."""
    settings = load_settings()
    if not settings.get("supabase_url") or not settings.get("supabase_service_role_key"):
        LOGGER.error("Dedupe sweep: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.")
        return 1

    if candidates_only or settings.get("dedupe_reconcile_mode") == "candidates":
        LOGGER.info("Dedupe sweep: candidates mode, nothing is written.")
        return 0 if report_duplicate_candidates(output=output) is not None else 1

    if not settings.get("dedupe_reconcile_enabled"):
        message = (
            "DEDUPE_RECONCILE_ENABLED n'est pas « true » : rien n'a été fusionné ni supprimé. "
            "Relire le rapport « Dedupe candidates report », puis poser la variable de dépôt."
        )
        LOGGER.warning("Dedupe sweep: %s", message)
        # Annotation GitHub : visible sur la page de l'exécution, pas seulement dans le journal.
        print(f"::warning title=Dedupe sweep désactivé::{message}")
        _write_summary(["### Balayage des doublons", f"- {message}"])
        return 0

    cap = merges_cap(settings)
    if cap <= 0:
        LOGGER.warning("Dedupe sweep: DEDUPE_RECONCILE_MAX_MERGES is 0; nothing to do.")
        return 0

    if not merge_trigger_deployed(str(settings.get("supabase_db_url") or "")):
        message = (
            f"Le déclencheur {MERGE_TRIGGER} (migration 20261028110000) est absent ou illisible : une suppression "
            "effacerait les favoris, notes, alertes et rapports des comptes. Appliquer la migration (et vérifier "
            "SUPABASE_DB_URL), puis relancer."
        )
        LOGGER.error("Dedupe sweep: %s", message)
        print(f"::error title=Dedupe sweep refusé::{message}")
        _write_summary(["### Balayage des doublons", f"- Refusé : {message}"])
        return 1

    # Imports tardifs : le mode sans écriture ci-dessus ne dépend ni de la passerelle ni du client complet.
    from src.outcome_ingestion.catalogue_bridge import (
        OutcomeCatalogueBridgeError,
        bridge_auction_sales_before_cleanup,
    )
    from src.reviewed_aliases import ReviewedAliasRegistryError
    from src.storage.supabase_client import reconcile_duplicate_sales_in_supabase

    try:
        # La base refuse la suppression d'une fiche non rattachée au graphe des issues.
        bridge = bridge_auction_sales_before_cleanup(settings)
        LOGGER.info(
            "Dedupe sweep: catalogue bridge scanned=%s created=%s reused=%s",
            bridge.scanned_count,
            bridge.created_count,
            bridge.reused_count,
        )
        deleted = reconcile_duplicate_sales_in_supabase(max_merges=cap)
    except (OutcomeCatalogueBridgeError, ReviewedAliasRegistryError) as exc:
        LOGGER.error("Dedupe sweep stopped before deleting anything it could not protect: %s", exc)
        _write_summary(["### Balayage des doublons", f"- Arrêté sans suppression sûre : {exc}"])
        return 1

    lines = [
        "### Balayage des doublons",
        f"- Lignes secondaires supprimées : {deleted} (plafond {cap} par passage)",
    ]
    if deleted >= cap:
        lines.append("- Le plafond est atteint : relancer le workflow pour la suite.")
    _write_summary(lines)
    LOGGER.info("Dedupe sweep: %s secondary rows merged and deleted (cap %s per pass).", deleted, cap)
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--candidates",
        action="store_true",
        help="Lecture seule : liste les paires, sans rien fusionner ni supprimer.",
    )
    parser.add_argument("--output", type=Path, default=None, help="Écrit aussi le rapport de candidats en JSON.")
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    return apply_duplicate_sweep(candidates_only=args.candidates, output=args.output)


if __name__ == "__main__":
    raise SystemExit(main())
