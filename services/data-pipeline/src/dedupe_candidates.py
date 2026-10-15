"""Rapport des doublons que le balayage fusionnerait, sans aucune écriture.

``python -m src.dedupe_candidates`` (ou ``DEDUPE_RECONCILE_MODE=candidates`` pendant une collecte
complète) liste, pour relecture par le propriétaire avant d'activer ``DEDUPE_RECONCILE_ENABLED``, les
paires que ``reconcile_duplicate_sales_in_supabase`` supprimerait : ligne conservée, ligne supprimée
(identifiant, source, commune, date, mise à prix) et la raison de la fusion. Le rapport ne contient ni
adresse ni coordonnée de contact.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
from collections import Counter
from pathlib import Path

from src.storage.supabase_client import (
    DuplicateMergeGroup,
    DuplicateRowSummary,
    DuplicateSweepPlan,
    plan_duplicate_reconciliation,
)

LOGGER = logging.getLogger(__name__)

# Raisons internes (dedupe_confidence) rendues lisibles.
REASON_LABELS = {
    "listing_id": "identifiant d'annonce commun (Vench / Petites Affiches), même lieu, même jour ou même prix",
    "address": "même adresse précise",
    "content_hash": "même contenu (hash)",
    "source_url": "même URL source",
}


def _row_text(row: DuplicateRowSummary) -> str:
    return (
        f"{row.id or '-'} | {row.source_name} | {row.city or '-'} | {row.sale_date or '-'} | "
        f"{row.starting_price_eur or '-'} EUR | {row.source_url}"
    )


def candidate_lines(plan: DuplicateSweepPlan) -> list[str]:
    """Une ligne par paire (conservée / supprimée), prête pour un journal."""
    lines: list[str] = []
    for group in plan.groups:
        reason = REASON_LABELS.get(group.reason, group.reason)
        for secondary in group.secondaries:
            lines.append(f"CONSERVEE {_row_text(group.primary)} <- SUPPRIMEE {_row_text(secondary)} :: {reason}")
    return lines


def candidates_as_dicts(plan: DuplicateSweepPlan) -> list[dict[str, object]]:
    def row(summary: DuplicateRowSummary) -> dict[str, object]:
        return {
            "id": summary.id,
            "source": summary.source_name,
            "city": summary.city,
            "sale_date": summary.sale_date,
            "starting_price_eur": summary.starting_price_eur,
            "status": summary.status,
            "source_url": summary.source_url,
        }

    def group_dict(group: DuplicateMergeGroup) -> dict[str, object]:
        return {
            "reason": group.reason,
            "reason_label": REASON_LABELS.get(group.reason, group.reason),
            "kept": row(group.primary),
            "removed": [row(secondary) for secondary in group.secondaries],
        }

    return [group_dict(group) for group in plan.groups]


def markdown_summary(plan: DuplicateSweepPlan) -> str:
    by_reason = Counter(group.reason for group in plan.groups for _ in group.secondaries)
    parts = [
        "### Doublons candidats (aucune écriture)",
        f"- Lignes lues : {plan.scanned}" + (" (plafond de lecture atteint : balayage partiel)" if plan.truncated else ""),
        f"- Groupes à fusionner : {len(plan.groups)} ; lignes qui seraient supprimées : {plan.secondary_count}",
    ]
    for reason, count in sorted(by_reason.items()):
        parts.append(f"  - {REASON_LABELS.get(reason, reason)} : {count}")
    if plan.groups:
        parts += [
            "",
            "| Conservée (id, source, commune, date, prix) | Supprimée (id, source, commune, date, prix) | Raison |",
            "| --- | --- | --- |",
        ]
        for group in plan.groups:
            for secondary in group.secondaries:
                parts.append(
                    f"| {_cell(group.primary)} | {_cell(secondary)} | {REASON_LABELS.get(group.reason, group.reason)} |"
                )
    return "\n".join(parts) + "\n"


def _cell(row: DuplicateRowSummary) -> str:
    return (
        f"`{(row.id or '-')[:8]}` {row.source_name}, {row.city or '-'}, "
        f"{(row.sale_date or '-')[:16]}, {row.starting_price_eur or '-'} EUR"
    )


def emit_candidates_report(plan: DuplicateSweepPlan, *, output: Path | None = None) -> None:
    """Écrit le rapport dans le journal, le résumé de job GitHub (si présent) et un fichier JSON facultatif."""
    LOGGER.info(
        "Duplicate candidates (no write): scanned=%s truncated=%s groups=%s rows_to_remove=%s",
        plan.scanned,
        plan.truncated,
        len(plan.groups),
        plan.secondary_count,
    )
    for line in candidate_lines(plan):
        LOGGER.info("DUPLICATE_CANDIDATE %s", line)
    summary_path = os.getenv("GITHUB_STEP_SUMMARY")
    if summary_path:
        with Path(summary_path).open("a", encoding="utf-8") as handle:
            handle.write(markdown_summary(plan))
    if output is not None:
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(
            json.dumps(
                {
                    "scanned": plan.scanned,
                    "truncated": plan.truncated,
                    "groups": candidates_as_dicts(plan),
                },
                ensure_ascii=False,
                indent=2,
            ),
            encoding="utf-8",
        )


def report_duplicate_candidates(*, output: Path | None = None) -> DuplicateSweepPlan | None:
    """Calcule et publie le rapport. Lecture seule ; ``None`` si Supabase n'est pas configuré."""
    plan = plan_duplicate_reconciliation(max_merges=None)
    if plan is None:
        LOGGER.warning("Duplicate candidates: Supabase is not configured; nothing to report.")
        return None
    emit_candidates_report(plan, output=output)
    return plan


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=None, help="Écrit aussi le rapport en JSON.")
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    plan = report_duplicate_candidates(output=args.output)
    return 0 if plan is not None else 1


if __name__ == "__main__":
    raise SystemExit(main())
