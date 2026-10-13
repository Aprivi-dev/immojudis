"""Réparation des textes déjà stockés : passe les ventes à venir dans le filtre `personal_data`.

    python -m src.redact_personal_data           # compte seulement : lecture seule, rien n'est écrit
    python -m src.redact_personal_data --check   # idem, code de sortie 1 s'il reste des textes à filtrer
    python -m src.redact_personal_data --apply   # écrit (prend le verrou d'écriture du catalogue)

Le compte ne contient que des identifiants et des noms de champs : jamais le texte lui-même, pour ne
pas recopier les noms dans les journaux. Avant d'écrire, lancer le mode « compte » et vérifier que
le total correspond aux ventes attendues.

Ce que la collecte écrit désormais est déjà filtré (`redact_storage_row`) : ce script ne sert qu'à
rattraper les lignes écrites avant. Le recalcul complet (workflow « Recompute Existing Sales »)
les rattraperait aussi, en repassant par l'écriture, mais il refait toute la normalisation : ce
script ne touche que les textes.
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any

from src.config import load_settings
from src.personal_data import (
    PAYLOAD_TEXT_KEYS,
    SALE_TEXT_COLUMNS,
    redact_personal_data,
    redact_personal_text,
    redact_storage_row,
)

LOGGER = logging.getLogger(__name__)

ACTIVE_STATUSES = ("upcoming", "unknown", "postponed")
SAMPLE_IDS = 20


@dataclass
class TableReport:
    rows_to_update: int = 0
    fields: dict[str, int] = field(default_factory=dict)
    sample_ids: list[str] = field(default_factory=list)

    def record(self, row_id: str, changed_fields: Sequence[str]) -> None:
        self.rows_to_update += 1
        for name in changed_fields:
            self.fields[name] = self.fields.get(name, 0) + 1
        if len(self.sample_ids) < SAMPLE_IDS:
            self.sample_ids.append(row_id)

    def as_dict(self) -> dict[str, Any]:
        return {"rows_to_update": self.rows_to_update, "fields": dict(sorted(self.fields.items())), "sample_ids": self.sample_ids}


# --- Calcul des changements (pur, testé sans base) ----------------------------------------------
def plan_sale_changes(row: Mapping[str, Any], *, text_columns: Sequence[str], has_observations: bool) -> dict[str, Any]:
    """Colonnes d'une ligne de vente qui changent une fois filtrées.

    `row["payload_text"]` ne contient que les clés texte de `raw_payload` : le résultat porte
    `payload` (les seules clés modifiées, à fusionner dans `raw_payload`) et jamais le document entier.
    """
    candidate: dict[str, Any] = {column: row.get(column) for column in text_columns}
    payload_text = row.get("payload_text")
    candidate["raw_payload"] = dict(payload_text) if isinstance(payload_text, dict) else {}
    if has_observations:
        candidate["observations"] = row.get("observations")
    redacted = redact_storage_row(json.loads(json.dumps(candidate)))
    changes: dict[str, Any] = {}
    for column in text_columns:
        if redacted.get(column) != row.get(column):
            changes[column] = redacted[column]
    payload_changes = {
        key: value for key, value in redacted["raw_payload"].items() if value != candidate["raw_payload"].get(key)
    }
    if payload_changes:
        changes["payload"] = payload_changes
    if has_observations and redacted.get("observations") != row.get("observations"):
        changes["observations"] = redacted["observations"]
    return changes


def plan_risk_changes(row: Mapping[str, Any]) -> dict[str, Any]:
    changes: dict[str, Any] = {}
    evidence = redact_personal_text(row.get("evidence"))
    if evidence != row.get("evidence"):
        changes["evidence"] = evidence
    evidence_json = redact_personal_data(row.get("evidence_json"))
    if evidence_json != row.get("evidence_json"):
        changes["evidence_json"] = evidence_json
    return changes


def plan_occurrence_changes(row: Mapping[str, Any]) -> dict[str, Any]:
    excerpt = redact_personal_text(row.get("excerpt"))
    return {"excerpt": excerpt} if excerpt != row.get("excerpt") else {}


@dataclass(frozen=True)
class TableSpec:
    table: str
    select: str  # colonnes lues, hors `id`
    plan: Any  # Callable[[Mapping], dict]
    json_columns: tuple[str, ...] = ()


_PAYLOAD_SELECT = (
    "case when jsonb_typeof(raw_payload) = 'object' then (select coalesce(jsonb_object_agg(e.key, e.value), "
    "'{}'::jsonb) from jsonb_each(raw_payload) as e where e.key = any(%(payload_keys)s)) "
    "else '{}'::jsonb end as payload_text"
)

# Les copies normalisées et les risques sont lus par `source_url`, lot après lot.
DEPENDENT_TABLES: tuple[TableSpec, ...] = (
    TableSpec(
        "properties",
        f"description, {_PAYLOAD_SELECT}",
        lambda row: plan_sale_changes(row, text_columns=("description",), has_observations=False),
    ),
    TableSpec(
        "judicial_sales",
        _PAYLOAD_SELECT,
        lambda row: plan_sale_changes(row, text_columns=(), has_observations=False),
    ),
    TableSpec("auction_risks", "evidence, evidence_json", plan_risk_changes, json_columns=("evidence_json",)),
    TableSpec("auction_risk_occurrences", "excerpt", plan_occurrence_changes),
)

# --- Accès base -----------------------------------------------------------------------------------
def _json(value: Any) -> Any:
    from psycopg.types.json import Jsonb

    return Jsonb(value)


def _update(connection: Any, table: str, row: Mapping[str, Any], changes: Mapping[str, Any], *, guard: bool) -> bool:
    """Applique `changes` à une ligne ; `payload` est fusionné dans `raw_payload`, pas remplacé."""
    assignments: list[str] = []
    values: list[Any] = []
    for column, value in changes.items():
        if column == "payload":
            assignments.append("raw_payload = coalesce(raw_payload, '{}'::jsonb) || %s")
            values.append(_json(value))
        elif column in ("observations", "evidence_json"):
            assignments.append(f"{column} = %s")
            values.append(_json(value))
        else:
            assignments.append(f"{column} = %s")
            values.append(value)
    where = "id = %s"
    values.append(row["id"])
    if guard:
        where += " and updated_at = %s"
        values.append(row["updated_at"])
    if "payload" in changes:
        where += " and jsonb_typeof(raw_payload) = 'object'"
    cursor = connection.execute(f"update public.{table} set {', '.join(assignments)} where {where}", values)
    return bool(cursor.rowcount)


def _dict_rows(cursor: Any) -> list[dict[str, Any]]:
    names = [column.name for column in cursor.description]
    return [dict(zip(names, record, strict=True)) for record in cursor.fetchall()]


def repair(
    connection: Any,
    *,
    apply: bool,
    statuses: Sequence[str] | None = ACTIVE_STATUSES,
    batch_size: int = 50,
    limit: int | None = None,
) -> dict[str, Any]:
    """Parcourt les ventes par lots ; n'écrit que si `apply`. Retourne le compte par table.

    `statuses=None` parcourt toutes les ventes, quel que soit leur statut.
    """
    reports = {name: TableReport() for name in ("auction_sales", *(spec.table for spec in DEPENDENT_TABLES))}
    skipped_concurrent = 0
    scanned = 0
    last_id: str | None = None
    if not apply:
        connection.execute("set transaction read only")
    while limit is None or scanned < limit:
        size = batch_size if limit is None else min(batch_size, limit - scanned)
        cursor = connection.execute(
            f"select id, source_url, updated_at, {', '.join(SALE_TEXT_COLUMNS)}, observations, {_PAYLOAD_SELECT} "
            "from public.auction_sales where (%(statuses)s::text[] is null or status = any(%(statuses)s)) "
            "and (%(last)s::uuid is null or id > %(last)s::uuid) "
            "order by id limit %(size)s",
            {"statuses": list(statuses) if statuses is not None else None, "last": last_id, "size": size, "payload_keys": list(PAYLOAD_TEXT_KEYS)},
        )
        sales = _dict_rows(cursor)
        if not sales:
            break
        scanned += len(sales)
        last_id = str(sales[-1]["id"])
        for sale in sales:
            changes = plan_sale_changes(sale, text_columns=SALE_TEXT_COLUMNS, has_observations=True)
            if not changes:
                continue
            reports["auction_sales"].record(str(sale["id"]), sorted(changes))
            if apply and not _update(connection, "auction_sales", sale, changes, guard=True):
                skipped_concurrent += 1
        source_urls = [sale["source_url"] for sale in sales]
        for spec in DEPENDENT_TABLES:
            rows = _dict_rows(
                connection.execute(
                    f"select id, {spec.select} from public.{spec.table} where source_url = any(%(urls)s)",
                    {"urls": source_urls, "payload_keys": list(PAYLOAD_TEXT_KEYS)},
                )
            )
            for row in rows:
                changes = spec.plan(row)
                if not changes:
                    continue
                reports[spec.table].record(str(row["id"]), sorted(changes))
                if apply:
                    _update(connection, spec.table, row, changes, guard=False)
        if apply:
            connection.commit()
    if not apply:
        connection.rollback()
    return {
        "mode": "apply" if apply else "count-only",
        "statuses": list(statuses) if statuses is not None else "all",
        "scanned_sales": scanned,
        "rows_to_update": sum(report.rows_to_update for report in reports.values()),
        "skipped_concurrent_updates": skipped_concurrent,
        "tables": {name: report.as_dict() for name, report in reports.items()},
    }


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Filtre les noms de personnes physiques dans les textes déjà stockés des ventes à venir."
    )
    parser.add_argument("--apply", action="store_true", help="Écrit les textes filtrés. Sans cette option : compte seulement.")
    parser.add_argument("--check", action="store_true", help="Compte seulement ; code de sortie 1 s'il reste des textes à filtrer.")
    parser.add_argument("--all-statuses", action="store_true", help="Inclut aussi les ventes passées (par défaut : à venir).")
    parser.add_argument("--limit", type=int, default=None, help="Nombre maximum de ventes parcourues.")
    parser.add_argument("--batch-size", type=int, default=50, help="Ventes lues par lot.")
    args = parser.parse_args(argv)
    if args.apply and args.check:
        parser.error("--apply et --check s'excluent")
    if args.batch_size < 1 or (args.limit is not None and args.limit < 1):
        parser.error("--batch-size et --limit doivent être positifs")
    return args


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    db_url = str(load_settings().get("supabase_db_url") or "")
    if not db_url:
        LOGGER.error("SUPABASE_DB_URL est requis : le script lit et écrit en direct dans Postgres")
        return 2
    from src.storage.supabase_client import connect

    statuses = None if args.all_statuses else ACTIVE_STATUSES

    def run() -> dict[str, Any]:
        connection = connect(db_url)
        try:
            return repair(connection, apply=args.apply, statuses=statuses, batch_size=args.batch_size, limit=args.limit)
        finally:
            connection.close()

    if args.apply:
        from src.catalogue_lock import catalogue_writer_lock

        with catalogue_writer_lock(label="redact-personal-data"):
            report = run()
    else:
        report = run()
    print(json.dumps(report, ensure_ascii=False, indent=2, default=str))
    return 1 if args.check and report["rows_to_update"] else 0


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s - %(message)s")
    sys.exit(main())
