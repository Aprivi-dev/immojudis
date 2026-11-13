"""Ventes stockées relues pour un recalcul : lecture des lignes et reconstruction du modèle.

Les colonnes lues (``RECOMPUTE_SALE_SELECT``) et la reconstruction (``sale_from_storage_row``) changent ensemble :
une clé de ligne lue par la reconstruction doit être demandée à la base. Partagé par le recalcul
(``src.recompute_scoring``), le rapport des ventes insuffisantes (``src.insufficient_sales``) et la réparation des
faits extraits de la source (``src.source_extraction_backfill``).
"""

from __future__ import annotations

from typing import Any

import httpx

from src.admission import licitor_lot_count
from src.base_reads import SOURCE_SNAPSHOT_KEY
from src.config import load_settings
from src.normalize import normalize_sale
from src.position_quality import preserved_position_flags
from src.sources.agrasc_extraction import refresh_agrasc_raw_sale
from src.sources.avoventes_extraction import refresh_avoventes_raw_sale
from src.sources.cessions_etat_extraction import refresh_cessions_raw_sale
from src.sources.encheres_immobilieres import refresh_encheres_immobilieres_raw_sale
from src.sources.encheres_publiques_extraction import refresh_encheres_publiques_raw_sale
from src.sources.licitor_extraction import refresh_licitor_raw_sale
from src.sources.petites_affiches import refresh_petites_affiches_raw_sale
from src.storage.column_sets import UPSERT_COLUMNS
from src.storage.known_sale_projection import DATA_REFRESH_SALE_SELECT
from src.storage.postgrest_helpers import postgrest_request_with_retries, rest_headers
from src.timestamps import assumed_utc_timestamp

# Full rows per request (raw source pages are heavy) and identifiers per request.
PAGE_SIZE = 25
# Colonnes lues pour un recalcul, nommées une à une : celles du modèle, et aucune autre. ``select=*`` rendait aussi
# les colonnes internes de la table, qui finissaient recopiées dans ``raw_payload`` à l'écriture.
RECOMPUTE_SALE_SELECT = DATA_REFRESH_SALE_SELECT
# Colonnes de la ligne versées dans la vente brute renormalisée, donc dans ``raw_payload`` : celles que la collecte
# écrit. Toute autre clé de la ligne est ignorée.
RECOMPUTE_PAYLOAD_COLUMNS = frozenset(UPSERT_COLUMNS) - {"raw_payload"}
# Identifiant et dates techniques : lus pour le modèle, jamais versés, et retirés de la mémoire brute où un recalcul
# antérieur à la liste explicite les avait recopiés.
RECOMPUTE_ROW_ONLY_COLUMNS = frozenset(RECOMPUTE_SALE_SELECT.split(",")) - RECOMPUTE_PAYLOAD_COLUMNS - {"raw_payload"}
# Champs de la source qu'une colonne vide ne doit pas effacer au recalcul (voir ``sale_from_storage_row``).
STORAGE_FALLBACK_SOURCE_FIELDS = ("sale_date", "starting_price_eur", "visit_dates")
# Parmi eux, ceux pour lesquels l'instantané de la fiche fait foi quand il existe. La clé de premier niveau de
# ``raw_payload`` n'est pas fiable pour les visites : la collecte d'une annonce inchangée et le recalcul précédent y
# recopient la colonne, donc une valeur retirée de la colonne y resterait et reviendrait ici. Une vente sans
# instantané (jamais relue depuis qu'il existe) n'a que cette clé : elle garde alors le repli d'origine.
SNAPSHOT_FIRST_FALLBACK_FIELDS = frozenset({"visit_dates"})
ID_PAGE_SIZE = 1_000


def fetch_sales(
    *, source: str | None, limit: int | None, readiness_unassessed_only: bool = False
) -> list[dict[str, Any]]:
    """Stored sales, most recently updated first.

    Two passes keep the database safe: the identifiers are listed first (tiny
    rows, a stable snapshot of the scope), then the full rows are read in small
    batches. Full rows carry the raw source pages (about 135 kB each on
    average); reading 200 of them per request has crashed the production
    database, and offset pagination skipped or repeated rows changed meanwhile.
    """
    settings = load_settings()
    supabase_url = str(settings["supabase_url"] or "").rstrip("/")
    api_key = str(settings["supabase_service_role_key"] or "")
    if not supabase_url or not api_key:
        raise RuntimeError("Supabase URL/service role key are missing")

    endpoint = f"{supabase_url}/rest/v1/auction_sales"
    headers = rest_headers(api_key)
    filters: dict[str, str] = {}
    if source:
        filters["source_name"] = f"eq.{source}"
    if readiness_unassessed_only:
        filters["premium_readiness_status"] = "eq.unassessed"
        filters["status"] = "in.(upcoming,unknown,postponed)"

    def get(params: dict[str, str]) -> list[dict[str, Any]]:
        response = postgrest_request_with_retries(
            "GET",
            endpoint,
            table="auction_sales",
            params={**filters, **params},
            headers=headers,
            timeout=120,
        )
        if response.is_error:
            raise httpx.HTTPStatusError(
                f"{response.status_code} response from Supabase auction_sales: {response.text}",
                request=response.request,
                response=response,
            )
        page = response.json()
        return page if isinstance(page, list) else []

    ids: list[str] = []
    seen: set[str] = set()
    offset = 0
    while limit is None or len(ids) < limit:
        page = get(
            {
                "select": "id",
                "order": "updated_at.desc.nullslast,id.asc",
                "limit": str(ID_PAGE_SIZE),
                "offset": str(offset),
            }
        )
        for row in page:
            sale_id = str(row.get("id") or "")
            if sale_id and sale_id not in seen:
                seen.add(sale_id)
                ids.append(sale_id)
        if len(page) < ID_PAGE_SIZE:
            break
        offset += ID_PAGE_SIZE
    if limit is not None:
        ids = ids[:limit]

    rows: list[dict[str, Any]] = []
    for start in range(0, len(ids), PAGE_SIZE):
        chunk = ids[start : start + PAGE_SIZE]
        page = get({"select": RECOMPUTE_SALE_SELECT, "id": f"in.({','.join(chunk)})"})
        by_id = {str(row.get("id")): row for row in page}
        # A row deleted between the two passes is simply absent.
        rows.extend(by_id[sale_id] for sale_id in chunk if sale_id in by_id)
    return rows


def sale_from_storage_row(row: dict[str, Any]):
    original_payload = dict(row.get("raw_payload")) if isinstance(row.get("raw_payload"), dict) else {}
    original_payload.pop("raw_payload", None)
    for column in RECOMPUTE_ROW_ONLY_COLUMNS:
        original_payload.pop(column, None)
    row_payload = {key: value for key, value in row.items() if key in RECOMPUTE_PAYLOAD_COLUMNS}
    snapshot = original_payload.get(SOURCE_SNAPSHOT_KEY)
    snapshot = snapshot if isinstance(snapshot, dict) and snapshot else None
    # Une colonne restée vide d'un ancien passage ne masque pas la valeur lue par la source : sans cela la date et
    # la mise à prix d'Avoventes 319c133c (« mardi 01 septembre 2026 à 13h30 », « 120 000,00 € ») ou les visites
    # d'Enchères Publiques ne revenaient jamais au recalcul. La normalisation repasse ses garde-fous dessus.
    unused_copies: dict[str, Any] = {}
    for field in STORAGE_FALLBACK_SOURCE_FIELDS:
        if row_payload.get(field) not in (None, "", []):
            continue
        copy = original_payload.get(field)
        source_value = snapshot.get(field) if snapshot is not None and field in SNAPSHOT_FIRST_FALLBACK_FIELDS else copy
        if source_value not in (None, "", []):
            row_payload[field] = source_value
        elif copy not in (None, "", []):
            # L'instantané dit que la source ne donne pas ce champ : la copie de premier niveau n'est pas rejouée,
            # mais une colonne vide que le recalcul n'a pas remplie ne l'écrase pas non plus.
            unused_copies[field] = copy
    raw_sale = {**original_payload, **row_payload}
    # Stored titles are display titles generated by the pipeline. Surface
    # reconciliation needs the original editorial title and description.
    for field in ("title", "description", "raw_text", "source_blocks"):
        if original_payload.get(field):
            raw_sale[field] = original_payload[field]
    # Cessions de l'État : rejoue la lecture structurée sur le texte de fiche
    # stocké (aucune requête au site) ; ses valeurs priment sur les colonnes.
    refresh_cessions_raw_sale(raw_sale)
    # Licitor : même principe (lots, procédure, conditions, avocats, visites).
    refresh_licitor_raw_sale(raw_sale)
    # AGRASC : même relecture sur les champs opérateur stockés (types des pièces, Points clés).
    refresh_agrasc_raw_sale(raw_sale)
    # Avoventes : encadré de vente, tuiles et caractéristiques relus sur le même texte.
    refresh_avoventes_raw_sale(raw_sale)
    # Petites Affiches, Enchères Immobilières, Enchères Publiques : même relecture
    # locale (texte de fiche, images et blocs stockés), sans requête.
    refresh_petites_affiches_raw_sale(raw_sale)
    refresh_encheres_immobilieres_raw_sale(raw_sale)
    refresh_encheres_publiques_raw_sale(raw_sale)
    sale = normalize_sale(raw_sale)
    sale.id = str(row.get("id")) if row.get("id") else None
    sale.primary_source = row.get("primary_source") or sale.primary_source
    if isinstance(row.get("source_urls"), list):
        sale.source_urls = [str(item) for item in row["source_urls"] if item]
    sale.content_hash = row.get("content_hash")
    sale.first_seen_at = assumed_utc_timestamp(row.get("first_seen_at"))
    sale.last_seen_at = assumed_utc_timestamp(row.get("last_seen_at"))
    sale.created_at = assumed_utc_timestamp(row.get("created_at"))
    sale.updated_at = assumed_utc_timestamp(row.get("updated_at"))
    # Les autres drapeaux se recalculent ; ceux de la position ne se déduisent pas du texte de la vente, ils viennent
    # d'un contrôle ou d'un géocodage passé : on les garde jusqu'à ce qu'une position vérifiée les retire. Même chose pour
    # « probable_duplicate », qui vient d'un rapprochement entre lignes (src.probable_duplicates).
    normalized_flags = list(sale.quality_flags)
    sale.quality_flags = preserved_position_flags(row.get("quality_flags"))
    # « multi_lot_sale » d'une page Licitor à plusieurs lots est relu à l'instant par normalize_sale et rien ne le
    # recalcule ensuite : le perdre levait à chaque recalcul la quarantaine des lots incertains (31 lignes visibles
    # le 03/11/2026, dont Cannes / Le Cannet affichant toutes deux le premier lot) et les garde-fous propres à un lot
    # (pièces jointes communes aux lots, prix lu dans le texte).
    if "multi_lot_sale" in normalized_flags and sale.source_name == "licitor" and licitor_lot_count(raw_sale) > 1:
        sale.quality_flags.append("multi_lot_sale")
    sale.raw_payload = raw_sale
    for field, copy in unused_copies.items():
        if not getattr(sale, field):
            sale.raw_payload[field] = copy
    return sale
