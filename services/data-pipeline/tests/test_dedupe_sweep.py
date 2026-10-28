"""Le balayage des lignes déjà publiées fusionne sur preuve ; la clé de repli stricte y est limitée.

La clé stricte ne s'y applique qu'hors Vench / Petites Affiches et hors d'un (jour, prix) partagé par
plus de 5 annonces ; un groupe de plus de 5 lignes n'est jamais fusionné automatiquement.
"""

from src import merge_guards
from src.dedupe import SWEEP_STRICT_EXCLUDED_SOURCES, SWEEP_STRICT_MAX_GROUP, merge_duplicate_sales
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
    monkeypatch.setattr(merge_guards, "merge_trigger_deployed", lambda db_url: True)
    rows = _rows(sales)
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


def test_reconcile_sweep_merges_a_strict_key_pair_outside_vench_and_petites_affiches(monkeypatch) -> None:
    _, by_key = _pairs()

    deleted, captured = _run_sweep(monkeypatch, by_key)

    assert deleted == 1
    assert len(captured["payload"]) == 1
    assert captured["payload"][0]["dedupe_confidence"] == "strict_key"


def test_the_sweep_strict_key_ignores_vench_and_petites_affiches() -> None:
    # Même tribunal, jour, mise à prix, surface : la clé stricte rapprocherait ces paires, pas le balayage.
    for source_name, url in (
        ("vench", "https://www.vench.fr/vente-880001-une-maison-ondres.html"),
        (
            "petites_affiches",
            "https://www.petitesaffiches.fr/encheres-immobilieres/vente/immobiliere/j/une-maison-a-ondres-880002.html",
        ),
    ):
        pair = [_sale("licitor", "https://www.licitor.com/annonce/30.html"), _sale(source_name, url)]

        assert len(merge_duplicate_sales(pair)) == 1
        assert len(merge_duplicate_sales(pair, strict_excluded_sources=SWEEP_STRICT_EXCLUDED_SOURCES)) == 2


def test_the_sweep_strict_key_skips_a_day_and_price_shared_by_more_than_five_sales() -> None:
    def lots(count: int):
        pair = [_sale("licitor", "https://www.licitor.com/annonce/40.html"), _sale("avoventes", "https://avoventes.fr/enchere/40")]
        # Autres lots du même jour au même prix, d'un autre tribunal : ils n'ont aucun partenaire.
        others = []
        for index in range(count):
            other = _sale("notaires", f"https://www.notaires.test/lot-{index}", surface_m2=str(200 + index * 40))
            other.tribunal_code = f"autre-{index}"
            others.append(other)
        return [*pair, *others]

    options = {"strict_max_group": SWEEP_STRICT_MAX_GROUP}
    assert SWEEP_STRICT_MAX_GROUP == 5
    assert len(merge_duplicate_sales(lots(3), **options)) == 4  # 5 annonces au (jour, prix) : paire fusionnée
    assert len(merge_duplicate_sales(lots(4), **options)) == 6  # 6 annonces : aucune fusion
    assert len(merge_duplicate_sales(lots(5), **options)) == 7
    assert len(merge_duplicate_sales(lots(5))) == 6  # sans plafond (collecte), la paire fusionne


def test_the_sweep_skips_a_group_of_more_than_five_rows(monkeypatch) -> None:
    from src.storage import duplicate_sweep

    assert duplicate_sweep.MAX_GROUP_ROWS == 5

    def plan_for(secondary_count: int):
        rows = [_sale("licitor", f"https://www.licitor.com/annonce/6{index}.html") for index in range(secondary_count + 1)]
        survivor = rows[0]
        survivor.source_urls = [row.source_url for row in rows]
        monkeypatch.setattr(duplicate_sweep, "merge_duplicate_sales", lambda sales, **kwargs: [survivor])
        # Les lignes secondaires ne sont plus des survivantes : seules leurs URL restent dans la fiche.
        return duplicate_sweep.build_plan(rows, _EmptyRegistry(), max_merges=None)

    kept = plan_for(4)  # 5 lignes : encore fusionné
    assert len(kept.groups) == 1 and kept.groups[0].secondaries and kept.oversized_groups == 0
    skipped = plan_for(5)  # 6 lignes : à relire à la main
    assert skipped.groups == [] and skipped.impacted_sales == [] and skipped.oversized_groups == 1
    assert "plus de 5 lignes" in duplicate_sweep.markdown_summary(skipped)


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
    """Sert les lignes par pages comme PostgREST (order=id.asc, id=gt.<curseur>, limit) et note chaque appel."""

    def __init__(self, rows):
        self.rows = rows
        self.calls: list[dict[str, str]] = []

    def __call__(self, endpoint, params, headers, timeout):
        self.calls.append(dict(params))
        assert "offset" not in params and params["order"] == "id.asc"
        after = params.get("id", "gt.")[len("gt.") :]
        return _Response([row for row in self.rows if str(row["id"]) > after][: int(params["limit"])])


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
    # Identifiants croissants : le balayage pagine par curseur sur ``id``.
    return [
        {**sale.to_storage_dict(exclude_none=False), "id": f"00000000-0000-4000-8000-{index:012d}", "status": "upcoming"}
        for index, sale in enumerate(sales)
    ]


def test_sweep_reads_past_the_old_two_thousand_row_window(monkeypatch) -> None:
    # La paire de doublons est tout en fin de liste : l'ancien balayage (2 000 lignes) ne la voyait pas.
    sales = [*(_filler(index) for index in range(2_300)), *_id_pair(166526)]
    paged = _configure(monkeypatch, _rows(sales), dedupe_reconcile_max_rows=20_000)

    plan = supabase_client.plan_duplicate_reconciliation()

    assert plan is not None
    assert plan.scanned == 2_302
    assert not plan.truncated
    assert len(paged.calls) == 25  # 23 pages de 100 + 1 de 2, puis la page vide qui prouve la fin
    assert all(call["limit"] == "100" and call["order"] == "id.asc" for call in paged.calls)
    assert "id" not in paged.calls[0] and paged.calls[1]["id"] == "gt.00000000-0000-4000-8000-000000000099"
    assert len(plan.groups) == 1
    assert plan.groups[0].reason == "listing_id"


def test_sweep_flags_a_truncated_scan_when_the_read_ceiling_is_hit(monkeypatch) -> None:
    sales = [_filler(index) for index in range(1_500)]
    _configure(monkeypatch, _rows(sales))

    plan = supabase_client.plan_duplicate_reconciliation(limit=1_000)

    assert plan is not None
    assert plan.truncated
    assert plan.scanned == 1_000


class _FailingResponse(_Response):
    is_error = True
    status_code = 503
    text = "service unavailable"


def test_sweep_flags_a_partial_scan_when_a_page_fails_midway(monkeypatch, tmp_path, caplog) -> None:
    import json

    from src import dedupe_candidates
    from src.storage import duplicate_sweep

    sales = [*(_filler(index) for index in range(1_200)), *_id_pair(166526)]
    paged = _configure(monkeypatch, _rows(sales), dedupe_reconcile_max_rows=20_000)

    def failing_second_page(endpoint, params, headers, timeout):
        if "id" in params:
            return _FailingResponse([])
        return paged(endpoint, params, headers, timeout)

    monkeypatch.setattr(supabase_client.httpx, "get", failing_second_page)
    output = tmp_path / "rapport.json"
    summary = tmp_path / "summary.md"
    monkeypatch.setenv("GITHUB_STEP_SUMMARY", str(summary))

    with caplog.at_level("WARNING"):
        plan = dedupe_candidates.report_duplicate_candidates(output=output)

    assert plan is not None
    assert plan.scanned == 100  # la première page ; une erreur autre qu'un délai n'est pas réessayée
    assert plan.truncated
    assert plan.truncation_reason == "fetch_error"
    assert "the scan is partial" in caplog.text
    report = json.loads(output.read_text(encoding="utf-8"))
    assert report["truncated"] is True and report["truncation_reason"] == "fetch_error"
    assert "balayage partiel" in summary.read_text(encoding="utf-8")
    assert "erreur Supabase" in duplicate_sweep.markdown_summary(plan)


def test_sweep_flags_a_partial_scan_when_the_connection_drops_midway(monkeypatch) -> None:
    import httpx

    sales = [_filler(index) for index in range(1_300)]
    paged = _configure(monkeypatch, _rows(sales), dedupe_reconcile_max_rows=20_000)

    def dropping_second_page(endpoint, params, headers, timeout):
        if "id" in params:
            raise httpx.ReadTimeout("timeout")
        return paged(endpoint, params, headers, timeout)

    monkeypatch.setattr(supabase_client.httpx, "get", dropping_second_page)

    plan = supabase_client.plan_duplicate_reconciliation()

    assert plan is not None and plan.truncated and plan.truncation_reason == "fetch_error"


class _TimeoutResponse(_Response):
    is_error = True
    status_code = 500
    text = '{"code":"57014","message":"canceling statement due to statement timeout"}'


def test_a_statement_timeout_halves_the_page_size_and_rereads_the_same_page(monkeypatch) -> None:
    sales = [_filler(index) for index in range(130)]
    paged = _configure(monkeypatch, _rows(sales), dedupe_reconcile_max_rows=20_000)

    def heavy_pages(endpoint, params, headers, timeout):
        if int(params["limit"]) > 30:  # 57014 tant que la page dépasse 30 lignes
            paged.calls.append(dict(params))
            return _TimeoutResponse([])
        return paged(endpoint, params, headers, timeout)

    monkeypatch.setattr(supabase_client.httpx, "get", heavy_pages)

    plan = supabase_client.plan_duplicate_reconciliation()

    assert plan is not None
    assert plan.scanned == 130 and not plan.truncated and plan.truncation_reason is None
    limits = [call["limit"] for call in paged.calls]
    assert limits[:3] == ["100", "50", "25"]  # même page relue avec 100, 50 puis 25 lignes
    assert set(limits[2:]) == {"25"}  # la taille réduite reste pour la suite
    assert "id" not in paged.calls[1] and "id" not in paged.calls[2]  # curseur inchangé pendant la réduction


def test_a_read_timeout_also_halves_the_page_size(monkeypatch) -> None:
    import httpx

    paged = _configure(monkeypatch, _rows([_filler(index) for index in range(60)]), dedupe_reconcile_max_rows=20_000)
    attempts: list[str] = []

    def flaky(endpoint, params, headers, timeout):
        attempts.append(params["limit"])
        if params["limit"] == "100":
            raise httpx.ReadTimeout("timeout")
        return paged(endpoint, params, headers, timeout)

    monkeypatch.setattr(supabase_client.httpx, "get", flaky)

    plan = supabase_client.plan_duplicate_reconciliation()

    assert plan is not None and plan.scanned == 60 and not plan.truncated
    assert attempts[:2] == ["100", "50"]


def test_a_timeout_below_the_minimum_page_size_ends_the_scan_as_partial(monkeypatch) -> None:
    from src.storage import duplicate_sweep

    _configure(monkeypatch, _rows([_filler(index) for index in range(60)]), dedupe_reconcile_max_rows=20_000)
    limits: list[str] = []

    def always_timing_out(endpoint, params, headers, timeout):
        limits.append(params["limit"])
        return _TimeoutResponse([])

    monkeypatch.setattr(supabase_client.httpx, "get", always_timing_out)

    plan = supabase_client.plan_duplicate_reconciliation()

    assert plan is not None and plan.scanned == 0
    assert plan.truncated and plan.truncation_reason == "fetch_error"
    assert limits == ["100", "50", "25", "12", "10"]  # s'arrête à MIN_PAGE_SIZE, ne boucle pas
    assert duplicate_sweep.MIN_PAGE_SIZE == 10


def test_the_page_size_is_adjustable_and_bounded(monkeypatch) -> None:
    from src.storage import duplicate_sweep

    monkeypatch.delenv(duplicate_sweep.PAGE_SIZE_ENV, raising=False)
    assert duplicate_sweep._page_size() == 100
    for raw, expected in (("40", 40), ("1", 10), ("5000", 1000), ("abc", 100)):
        monkeypatch.setenv(duplicate_sweep.PAGE_SIZE_ENV, raw)
        assert duplicate_sweep._page_size() == expected


def test_the_write_sweep_reads_through_the_same_paged_path(monkeypatch) -> None:
    paged = _configure(monkeypatch, _rows(_id_pair(166526)), dedupe_reconcile_max_merges=100)
    monkeypatch.setattr(supabase_client, "_upsert_with_rest", lambda *args, **kwargs: None)
    monkeypatch.setattr(supabase_client, "_delete_secondary_sale_rows", lambda url, key, sales, **kw: 1)
    monkeypatch.setattr(supabase_client, "_sync_normalized_sale_tables_with_rest", lambda *a, **k: None)
    monkeypatch.setattr(supabase_client, "_upsert_asset_tables_with_rest", lambda *a, **k: None)
    monkeypatch.setattr(merge_guards, "merge_trigger_deployed", lambda db_url: True)

    assert supabase_client.reconcile_duplicate_sales_in_supabase() == 1
    assert paged.calls and all(call["limit"] == "100" and call["order"] == "id.asc" for call in paged.calls)


def test_sweep_keeps_reading_when_the_server_caps_the_page_size(monkeypatch) -> None:
    # PostgREST (max_rows) peut renvoyer moins de lignes que demandé : une page courte n'est pas la fin.
    sales = [*(_filler(index) for index in range(700)), *_id_pair(166526)]
    paged = _configure(monkeypatch, _rows(sales), dedupe_reconcile_max_rows=20_000)
    server_cap = 40

    def capped(endpoint, params, headers, timeout):
        paged.calls.append(dict(params))
        after = params.get("id", "gt.")[len("gt.") :]
        page = [row for row in paged.rows if str(row["id"]) > after]
        return _Response(page[: min(int(params["limit"]), server_cap)])

    monkeypatch.setattr(supabase_client.httpx, "get", capped)

    plan = supabase_client.plan_duplicate_reconciliation()

    assert plan is not None
    assert plan.scanned == 702
    assert not plan.truncated and plan.truncation_reason is None
    assert len(paged.calls) == 19  # 17 pages de 40 + 1 de 22, puis la page vide qui prouve la fin
    assert len(plan.groups) == 1


def test_a_read_ceiling_report_says_so(monkeypatch) -> None:
    from src.storage import duplicate_sweep

    _configure(monkeypatch, _rows([_filler(index) for index in range(1_500)]))

    plan = supabase_client.plan_duplicate_reconciliation(limit=1_000)

    assert plan is not None and plan.truncation_reason == "read_ceiling"
    assert "plafond de lecture atteint" in duplicate_sweep.markdown_summary(plan)


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
