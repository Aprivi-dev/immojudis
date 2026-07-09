from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from pydantic import ValidationError

from src.config import PROCESSED_DIR
from src.models import AuctionSale
from src.quality import build_extraction_gap_report, format_extraction_gap_report

DEFAULT_EXPORT_PATH = PROCESSED_DIR / "auction_sales.json"


def load_exported_sales(path: Path) -> list[AuctionSale]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise ValueError(f"export not found: {path}") from exc
    except json.JSONDecodeError as exc:
        raise ValueError(f"invalid JSON export {path}: {exc}") from exc
    if not isinstance(payload, list):
        raise ValueError(f"export must contain a JSON array: {path}")

    sales: list[AuctionSale] = []
    errors: list[str] = []
    for index, row in enumerate(payload):
        if not isinstance(row, dict):
            errors.append(f"row {index}: expected object")
            continue
        try:
            sales.append(AuctionSale.model_validate(row))
        except ValidationError as exc:
            errors.append(f"row {index}: {_compact_validation_error(exc)}")
    if errors:
        suffix = "" if len(errors) <= 5 else f" (+{len(errors) - 5} more)"
        raise ValueError("invalid auction sale export rows: " + "; ".join(errors[:5]) + suffix)
    return sales


def run_extraction_audit(
    path: Path = DEFAULT_EXPORT_PATH,
    *,
    source: str | None = None,
    fail_on_required_gaps: bool = False,
    max_sale_gaps: int = 8,
    report_json_path: Path | None = None,
) -> int:
    sales = load_exported_sales(path)
    if source:
        sales = [sale for sale in sales if sale.source_name == source]
    report = build_extraction_gap_report(sales)

    print("Immojudis extraction audit")
    print(f"- input: {path}")
    if source:
        print(f"- source_filter: {source}")
    for line in format_extraction_gap_report(report, max_sale_gaps=max_sale_gaps):
        print(line)

    if report_json_path:
        report_json_path.parent.mkdir(parents=True, exist_ok=True)
        report_json_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"- report_json: {report_json_path}")

    return 1 if fail_on_required_gaps and int(report["required_gap_sales"]) > 0 else 0


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Audite la complétude d'un export d'extraction Immojudis.")
    parser.add_argument(
        "--input",
        type=Path,
        default=DEFAULT_EXPORT_PATH,
        help="Chemin vers auction_sales.json.",
    )
    parser.add_argument("--source", default=None, help="Filtre optionnel sur source_name.")
    parser.add_argument(
        "--fail-on-required-gaps",
        action="store_true",
        help="Retourne 1 si au moins une vente a un champ obligatoire manquant.",
    )
    parser.add_argument(
        "--max-sale-gaps",
        type=int,
        default=8,
        help="Nombre maximum de fiches incomplètes affichées dans la sortie texte.",
    )
    parser.add_argument(
        "--report-json",
        type=Path,
        default=None,
        help="Écrit le rapport complet en JSON.",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        return run_extraction_audit(
            args.input,
            source=args.source,
            fail_on_required_gaps=args.fail_on_required_gaps,
            max_sale_gaps=args.max_sale_gaps,
            report_json_path=args.report_json,
        )
    except ValueError as exc:
        print(f"Extraction audit failed: {exc}", file=sys.stderr)
        return 2


def _compact_validation_error(exc: ValidationError) -> str:
    parts: list[str] = []
    for item in exc.errors():
        loc = ".".join(str(part) for part in item.get("loc", ())) or "root"
        parts.append(f"{loc}: {item.get('msg')}")
    return "; ".join(parts)


if __name__ == "__main__":
    sys.exit(main())
