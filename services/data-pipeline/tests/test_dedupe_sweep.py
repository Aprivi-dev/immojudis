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


def test_reconcile_sweep_never_deletes_on_an_id_collision_between_two_places(monkeypatch) -> None:
    ondres = _sale("vench", "https://www.vench.fr/vente-166526-une-maison-ondres.html", starting_price_eur="50 000 €")
    lyon = _sale(
        "petites_affiches",
        "https://www.petitesaffiches.fr/encheres-immobilieres/vente/immobiliere/j/un-appartement-a-lyon-166526.html",
        starting_price_eur="50 000 €",
        city="Lyon",
        postal_code="69003",
    )

    deleted, captured = _run_sweep(monkeypatch, [ondres, lyon])

    assert deleted == 0
    assert "payload" not in captured


# --- Pagination complète, plafond d'écriture, mode candidats -------------------------------------


def _filler(index: int):
    """Une vente sans rapport avec les autres (commune, URL et mise à prix propres)."""
    return normalize_sale(
        {
            "source_name": "avoventes",
            "source_url": f"https://avoventes.fr/enchere/filler-{index}",
            "city": f"Commune{index}",
            "postal_code": "40440",
            "property_type": "house",
            "surface_m2": "80",
            "starting_price_eur": f"{10_000 + index} €",
            "sale_date": "mardi 10 novembre 2026 à 14h",
        }
    )


def _id_pair(listing_id: int, city: str = "Ondres"):
    slug = city.lower()
    return [
        _sale(
            "vench",
            f"https://www.vench.fr/vente-{listing_id}-une-maison-{slug}.html",
            starting_price_eur="50 000 €",
            city=city,
        ),
        _sale(
            "petites_affiches",
            "https://www.petitesaffiches.fr/encheres-immobilieres/vente/immobiliere/j/"
            f"une-maison-a-{slug}-{listing_id}.html",
            starting_price_eur="50 000 €",
            city=city,
        ),
    ]


class _PagedGet:
    """Sert les lignes par pages comme PostgREST (limit/offset) et note chaque appel."""

    def __init__(self, rows):
        self.rows = rows
        self.calls: list[dict[str, str]] = []

    def __call__(self, endpoint, params, headers, timeout):
        self.calls.append(dict(params))
        offset, limit = int(params["offset"]), int(params["limit"])
        return _Response(self.rows[offset : offset + limit])


def _configure(monkeypatch, rows, **settings):
    paged = _PagedGet(rows)
    monkeypatch.setattr(
        supabase_client,
        "load_settings",
        lambda: {"supabase_url": "https://supabase.test", "supabase_service_role_key": "secret", **settings},
    )
    monkeypatch.setattr(supabase_client.httpx, "get", paged)
    monkeypatch.setattr(supabase_client, "_fetch_reviewed_alias_registry", lambda url, key: _EmptyRegistry())
    return paged


def _rows(sales):
    return [{**sale.to_storage_dict(exclude_none=False), "status": "upcoming"} for sale in sales]


def test_sweep_reads_past_the_old_two_thousand_row_window(monkeypatch) -> None:
    # La paire de doublons est tout en fin de liste : l'ancien balayage (2 000 lignes) ne la voyait pas.
    sales = [*(_filler(index) for index in range(2_300)), *_id_pair(166526)]
    paged = _configure(monkeypatch, _rows(sales), dedupe_reconcile_max_rows=20_000)

    plan = supabase_client.plan_duplicate_reconciliation()

    assert plan is not None
    assert plan.scanned == 2_302
    assert not plan.truncated
    assert len(paged.calls) == 3  # 1 000 + 1 000 + 302
    assert all(call["order"].endswith("id.asc") for call in paged.calls)
    assert len(plan.groups) == 1
    assert plan.groups[0].reason == "listing_id"


def test_sweep_flags_a_truncated_scan_when_the_read_ceiling_is_hit(monkeypatch) -> None:
    sales = [_filler(index) for index in range(1_500)]
    _configure(monkeypatch, _rows(sales))

    plan = supabase_client.plan_duplicate_reconciliation(limit=1_000)

    assert plan is not None
    assert plan.truncated
    assert plan.scanned == 1_000


def test_sweep_cap_defers_whole_groups_beyond_the_per_pass_maximum(monkeypatch) -> None:
    sales = [*_id_pair(100, "Ondres"), *_id_pair(200, "Dax"), *_id_pair(300, "Pau")]
    _configure(monkeypatch, _rows(sales))

    plan = supabase_client.plan_duplicate_reconciliation(max_merges=2)

    assert plan is not None
    assert len(plan.groups) == 2
    assert plan.secondary_count == 2
    assert plan.deferred_rows == 1
    assert len(plan.impacted_sales) == 2


def test_reconcile_with_a_zero_cap_writes_nothing(monkeypatch) -> None:
    _configure(monkeypatch, _rows(_id_pair(100)), dedupe_reconcile_max_merges=0)
    writes: list[object] = []
    monkeypatch.setattr(supabase_client, "_upsert_with_rest", lambda *args, **kwargs: writes.append("upsert"))

    assert supabase_client.reconcile_duplicate_sales_in_supabase() == 0
    assert writes == []


def test_candidates_report_lists_each_pair_and_never_writes(monkeypatch, tmp_path) -> None:
    import json

    from src import dedupe_candidates
    from src.storage import duplicate_sweep

    sales = [*_id_pair(166526), *_id_pair(777, "Dax")]
    _configure(monkeypatch, _rows(sales))

    def forbidden(*args, **kwargs):
        raise AssertionError("le mode candidats ne doit rien écrire")

    for name in (
        "_upsert_with_rest",
        "_postgres_upsert",
        "_delete_secondary_sale_rows",
        "_delete_secondary_sale_rows_with_postgres",
        "_sync_normalized_sale_tables_with_rest",
        "_upsert_asset_tables_with_rest",
    ):
        monkeypatch.setattr(supabase_client, name, forbidden)
    summary = tmp_path / "summary.md"
    monkeypatch.setenv("GITHUB_STEP_SUMMARY", str(summary))
    output = tmp_path / "rapport.json"

    plan = dedupe_candidates.report_duplicate_candidates(output=output)

    assert plan is not None and len(plan.groups) == 2
    lines = duplicate_sweep.candidate_lines(plan)
    assert len(lines) == 2
    for line in lines:
        assert "CONSERVEE" in line and "SUPPRIMEE" in line
        assert "identifiant d'annonce commun" in line
    assert any("Ondres" in line for line in lines) and any("Dax" in line for line in lines)
    report = json.loads(output.read_text(encoding="utf-8"))
    assert {entry["reason"] for entry in report["groups"]} == {"listing_id"}
    for entry in report["groups"]:
        assert {entry["kept"]["source"], entry["removed"][0]["source"]} == {"vench", "petites_affiches"}
        assert entry["removed"][0]["sale_date"] and entry["removed"][0]["starting_price_eur"]
    assert "Doublons candidats" in summary.read_text(encoding="utf-8")


def test_dedupe_settings_default_to_off_and_unknown_modes_do_not_write(monkeypatch) -> None:
    from src.config import load_settings

    for name in (
        "DEDUPE_RECONCILE_ENABLED",
        "DEDUPE_RECONCILE_MODE",
        "DEDUPE_RECONCILE_MAX_ROWS",
        "DEDUPE_RECONCILE_MAX_MERGES",
    ):
        monkeypatch.delenv(name, raising=False)
    settings = load_settings()
    assert settings["dedupe_reconcile_enabled"] is False
    assert settings["dedupe_reconcile_mode"] == "apply"
    assert settings["dedupe_reconcile_max_rows"] == 20_000
    assert settings["dedupe_reconcile_max_merges"] == 100

    monkeypatch.setenv("DEDUPE_RECONCILE_MODE", "candidats-typo")
    assert load_settings()["dedupe_reconcile_mode"] == "candidates"
    monkeypatch.setenv("DEDUPE_RECONCILE_MODE", "Candidates")
    assert load_settings()["dedupe_reconcile_mode"] == "candidates"


def test_reconcile_in_candidates_mode_reports_the_pairs_and_writes_nothing(monkeypatch, tmp_path, caplog) -> None:
    import logging

    _configure(monkeypatch, _rows(_id_pair(166526)), dedupe_reconcile_mode="candidates")

    def forbidden(*args, **kwargs):
        raise AssertionError("le mode candidats ne doit rien écrire")

    for name in (
        "_upsert_with_rest",
        "_postgres_upsert",
        "_delete_secondary_sale_rows",
        "_delete_secondary_sale_rows_with_postgres",
    ):
        monkeypatch.setattr(supabase_client, name, forbidden)
    monkeypatch.delenv("GITHUB_STEP_SUMMARY", raising=False)

    with caplog.at_level(logging.INFO):
        deleted = supabase_client.reconcile_duplicate_sales_in_supabase()

    assert deleted == 0
    assert any("DUPLICATE_CANDIDATE" in record.getMessage() for record in caplog.records)
