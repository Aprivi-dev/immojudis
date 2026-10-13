"""Le balayage des lignes déjà publiées ne fusionne que sur preuve, jamais par la clé de repli stricte."""

from src.dedupe import merge_duplicate_sales
from src.normalize import normalize_sale
from src.storage import supabase_client


def _sale(source_name: str, source_url: str, **extra: object):
    sale = normalize_sale(
        {
            "source_name": source_name,
            "source_url": source_url,
            "city": "Ondres",
            "postal_code": "40440",
            "property_type": "house",
            "surface_m2": "80",
            "starting_price_eur": "70 000 €",
            "sale_date": "mardi 10 novembre 2026 à 14h",
            **extra,
        }
    )
    sale.tribunal_code = "dax"
    return sale


def _pairs():
    by_id = [
        _sale("vench", "https://www.vench.fr/vente-166526-une-maison-ondres.html", starting_price_eur="50 000 €"),
        _sale(
            "petites_affiches",
            "https://www.petitesaffiches.fr/encheres-immobilieres/vente/immobiliere/j/une-maison-a-ondres-166526.html",
            starting_price_eur="50 000 €",
        ),
    ]
    by_key = [
        _sale("licitor", "https://www.licitor.com/annonce/20.html"),
        _sale("avoventes", "https://avoventes.fr/enchere/20"),
    ]
    return by_id, by_key


def test_sweep_mode_merges_by_listing_id_but_not_by_the_strict_key() -> None:
    by_id, by_key = _pairs()

    assert len(merge_duplicate_sales([*by_id, *by_key], strict_fallback=False)) == 3
    assert len(merge_duplicate_sales([*by_id, *by_key])) == 2


class _EmptyRegistry:
    def protected_sale_ids(self):
        return frozenset()

    def protected_source_urls(self):
        return frozenset()


class _Response:
    is_error = False
    status_code = 200
    text = ""

    def __init__(self, rows):
        self._rows = rows

    def json(self):
        return self._rows


def _run_sweep(monkeypatch, sales):
    rows = [{**sale.to_storage_dict(exclude_none=False), "status": "upcoming"} for sale in sales]
    captured: dict[str, object] = {}
    monkeypatch.setattr(
        supabase_client,
        "load_settings",
        lambda: {"supabase_url": "https://supabase.test", "supabase_service_role_key": "secret"},
    )
    monkeypatch.setattr(supabase_client.httpx, "get", lambda *args, **kwargs: _Response(rows))
    monkeypatch.setattr(supabase_client, "_fetch_reviewed_alias_registry", lambda url, key: _EmptyRegistry())
    monkeypatch.setattr(
        supabase_client, "_upsert_with_rest", lambda url, key, payload: captured.setdefault("payload", payload)
    )
    monkeypatch.setattr(
        supabase_client,
        "_delete_secondary_sale_rows",
        lambda url, key, sales, **kwargs: len(supabase_client._secondary_source_urls(sales)),
    )
    monkeypatch.setattr(supabase_client, "_sync_normalized_sale_tables_with_rest", lambda *args, **kwargs: None)
    monkeypatch.setattr(supabase_client, "_upsert_asset_tables_with_rest", lambda *args, **kwargs: None)
    return supabase_client.reconcile_duplicate_sales_in_supabase(limit=20), captured


def test_reconcile_sweep_leaves_a_strict_key_pair_untouched(monkeypatch) -> None:
    _, by_key = _pairs()

    deleted, captured = _run_sweep(monkeypatch, by_key)

    assert deleted == 0
    assert "payload" not in captured


def test_reconcile_sweep_repairs_a_listing_id_pair(monkeypatch) -> None:
    by_id, _ = _pairs()

    deleted, captured = _run_sweep(monkeypatch, by_id)

    assert deleted == 1
    assert len(captured["payload"]) == 1
    assert captured["payload"][0]["dedupe_confidence"] == "listing_id"
