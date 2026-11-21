"""Exclut une vente de toute lecture automatique de ses pièces (opposition, correction, autre motif).

    python -m scripts.exclude_sale_from_document_reading --source-url URL --reason opposition [--request-id UUID]

Commande opérateur (lots V3b-0 et V3b-1). Elle inscrit l'URL source de la vente dans
``public.document_reading_exclusions`` par la connexion directe (``SUPABASE_DB_URL``) : dès lors, ni la lecture
Qwen, ni le banc de lecture des pièces, ni la passe d'écriture ne lisent plus ses pièces. Dans la même transaction,
la lecture des pièces déjà servie aux abonnés est supprimée (``auction_document_readings``). Une vente déjà exclue
garde son inscription. Elle retire ensuite de la fiche les valeurs que la lecture des pièces par Claude y avait
écrites (``src.document_vision_pass.withdraw``, sous le verrou d'écriture du catalogue). La sortie ne reprend que des
comptes, jamais l'URL.
"""

from __future__ import annotations

import argparse
import json
import sys
from collections.abc import Sequence
from pathlib import Path
from uuid import UUID

PIPELINE_ROOT = Path(__file__).resolve().parents[1]
if str(PIPELINE_ROOT) not in sys.path:
    sys.path.insert(0, str(PIPELINE_ROOT))

from src.config import load_settings  # noqa: E402
from src.document_reading_exclusions import (  # noqa: E402
    REASONS,
    exclude_sale_from_document_reading,
    forget_readings_of_excluded_sales,
)
from src.document_vision_pass import withdraw  # noqa: E402


def _source_url(text: str) -> str:
    value = text.strip()
    if not value.startswith(("https://", "http://")) or not 8 <= len(value) <= 2000:
        raise argparse.ArgumentTypeError("URL source http(s) attendue (8 à 2000 caractères)")
    return value


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--source-url", type=_source_url, required=True, help="URL source de la vente")
    parser.add_argument("--reason", choices=REASONS, required=True)
    parser.add_argument("--request-id", type=UUID, default=None, help="demande d'exercice des droits, s'il y en a une")
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    db_url = load_settings().get("supabase_db_url")
    if not db_url:
        print("SUPABASE_DB_URL est requise.", file=sys.stderr)
        return 2
    from src.storage.supabase_client import connect

    with connect(str(db_url)) as connection:
        added = exclude_sale_from_document_reading(
            connection, args.source_url, reason=args.reason, request_id=args.request_id
        )
        readings_removed = forget_readings_of_excluded_sales(connection)
    # Exclue d'abord : la passe ne peut plus réécrire ce que le retrait enlève.
    withdrawn = withdraw(str(db_url), source_url=args.source_url)
    print(
        json.dumps(
            {
                "excluded": True,
                "already_excluded": not added,
                "readings_removed": readings_removed,
                "withdrawn": withdrawn,
            }
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
