from __future__ import annotations

import json
from pathlib import Path
from typing import Iterable

import pandas as pd

from src.config import PROCESSED_DIR
from src.models import AuctionSale


def export_sales(sales: Iterable[AuctionSale], output_dir: Path = PROCESSED_DIR) -> tuple[Path, Path]:
    output_dir.mkdir(parents=True, exist_ok=True)
    rows = [sale.to_storage_dict() for sale in sales]

    json_path = output_dir / "auction_sales.json"
    csv_path = output_dir / "auction_sales.csv"

    json_path.write_text(json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8")
    pd.DataFrame(rows).to_csv(csv_path, index=False)
    return json_path, csv_path
