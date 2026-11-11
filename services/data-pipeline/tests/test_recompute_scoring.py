from decimal import Decimal
from types import SimpleNamespace

import pytest

from src import recompute_scoring as recompute_module
from src.asset_normalization import normalize_asset_features
from src.models import AuctionSale
from src.recompute_scoring import _sale_from_storage_row, _validate_persisted_sale_procedure


def _fake_postgrest(monkeypatch, sales):
    monkeypatch.setattr(
        recompute_module,
        "load_settings",
        lambda: {"supabase_url": "https://supabase.test", "supabase_service_role_key": "secret"},
    )
    calls: list[dict[str, object]] = []

    class Response:
        is_error = False
        status_code = 200
        text = ""

        def __init__(self, rows):
            self._rows = rows

        def json(self):
            return self._rows

    def fake_request(method, endpoint, *, table, params, **kwargs):
        calls.append({"method": method, "endpoint": endpoint, "table": table, "params": params})
        if params["select"] == "id":
            offset, size = int(params["offset"]), int(params["limit"])
            return Response([{"id": sale["id"]} for sale in sales[offset : offset + size]])
        wanted = params["id"].removeprefix("in.(").removesuffix(")").split(",")
        # PostgREST does not keep the order of an in() filter.
        return Response([sale for sale in reversed(sales) if sale["id"] in wanted])

    monkeypatch.setattr(recompute_module, "_postgrest_request_with_retries", fake_request)
    return calls


def test_fetch_sales_lists_ids_then_reads_full_rows_in_small_batches(monkeypatch) -> None:
    sales = [{"id": f"id-{index:03d}", "source_url": f"https://example.test/{index}"} for index in range(60)]
    calls = _fake_postgrest(monkeypatch, sales)

    rows = recompute_module._fetch_sales(source=None, limit=None)

    assert [row["id"] for row in rows] == [sale["id"] for sale in sales]
    assert all(call["method"] == "GET" and call["table"] == "auction_sales" for call in calls)
    full_reads = [call for call in calls if call["params"]["select"] != "id"]
    assert len(full_reads) == 3  # 25 + 25 + 10
    assert calls[0]["params"]["order"] == "updated_at.desc.nullslast,id.asc"


def test_fetch_sales_limit_keeps_the_most_recent_and_skips_rows_deleted_meanwhile(monkeypatch) -> None:
    sales = [{"id": f"id-{index}"} for index in range(5)]
    calls = _fake_postgrest(monkeypatch, sales)
    original = recompute_module._postgrest_request_with_retries

    def deleting_request(method, endpoint, *, table, params, **kwargs):
        if params["select"] != "id":
            sales.pop(1)  # deleted between the two passes
        return original(method, endpoint, table=table, params=params, **kwargs)

    monkeypatch.setattr(recompute_module, "_postgrest_request_with_retries", deleting_request)

    rows = recompute_module._fetch_sales(source=None, limit=3)

    assert [row["id"] for row in rows] == ["id-0", "id-2"]
    assert len(calls) == 2


def test_fetch_sales_can_target_only_active_unassessed_readiness(monkeypatch) -> None:
    monkeypatch.setattr(
        recompute_module,
        "load_settings",
        lambda: {
            "supabase_url": "https://supabase.test",
            "supabase_service_role_key": "secret",
        },
    )
    captured: dict[str, object] = {}

    class Response:
        is_error = False
        status_code = 200
        text = ""

        @staticmethod
        def json():
            return []

    def fake_request(_method, _endpoint, **kwargs):
        captured.update(kwargs)
        return Response()

    monkeypatch.setattr(recompute_module, "_postgrest_request_with_retries", fake_request)

    recompute_module._fetch_sales(
        source=None,
        limit=None,
        readiness_unassessed_only=True,
    )

    assert captured["params"]["premium_readiness_status"] == "eq.unassessed"
    assert captured["params"]["status"] == "in.(upcoming,unknown,postponed)"


def test_readiness_backfill_persists_incomplete_rows_without_publication_admission(monkeypatch) -> None:
    row = {
        "id": "11111111-1111-4111-8111-111111111111",
        "source_name": "test",
        "source_url": "https://example.test/incomplete",
        "updated_at": "2026-09-19T08:00:00+00:00",
    }
    sale = AuctionSale(source_name=row["source_name"], source_url=row["source_url"])
    writes: list[dict[str, object]] = []

    monkeypatch.setattr(recompute_module, "_load_env_fallbacks", lambda: None)
    monkeypatch.setattr(recompute_module, "_fetch_sales", lambda **_kwargs: [row])
    monkeypatch.setattr(recompute_module, "_sale_from_storage_row", lambda _row: sale)
    monkeypatch.setattr(
        recompute_module,
        "load_settings",
        lambda: {
            "supabase_url": "https://supabase.test",
            "supabase_service_role_key": "secret",
        },
    )

    class Response:
        is_error = False
        status_code = 204
        text = ""

    def fake_request(method, _endpoint, **kwargs):
        writes.append({"method": method, **kwargs})
        return Response()

    monkeypatch.setattr(recompute_module, "_postgrest_request_with_retries", fake_request)

    assert recompute_module.backfill_catalogue_readiness() == 0
    assert writes[0]["method"] == "PATCH"
    assert writes[0]["params"] == {
        "id": f"eq.{row['id']}",
        "updated_at": f"eq.{row['updated_at']}",
    }
    assert writes[0]["json"]["premium_readiness_status"] == "internal_only"
    assert "id" not in writes[0]["json"]
    assert "source_name" not in writes[0]["json"]


def test_merge_refetched_source_details_preserves_and_extends_evidence() -> None:
    merged = recompute_module._merge_refetched_source_details(
        {
            "source_name": "encheres_publiques",
            "source_url": "https://www.encheres-publiques.com/encheres/lot_123",
            "raw_payload": {
                "source_blocks": {"mise_a_prix": "100000"},
                "collector_marker": "preserved",
            },
        },
        {
            "address": "1 rue Exemple, 74000 Annecy",
            "raw_text": "Vente volontaire organisée par Office du Parc",
            "source_blocks": {
                "organisateur": "Office du Parc",
                "organisateur_categorie": "notaire",
            },
            "status": "unknown",
        },
    )

    assert merged["address"] == "1 rue Exemple, 74000 Annecy"
    assert merged["raw_payload"]["collector_marker"] == "preserved"
    assert merged["raw_payload"]["source_blocks"] == {
        "mise_a_prix": "100000",
        "organisateur": "Office du Parc",
        "organisateur_categorie": "notaire",
    }
    assert merged["raw_payload"]["procedure_source_refresh"]["status"] == "verified_source_page"
    assert "status" not in merged or merged["status"] != "unknown"


def test_refresh_unknown_sale_procedures_refetches_only_supported_unknowns(monkeypatch) -> None:
    rows = [
        {
            "source_name": "licitor",
            "source_url": "https://www.licitor.com/annonce/example/123.html",
            "sale_venue_type": "unknown",
            "raw_payload": {},
        },
        {
            "source_name": "avoventes",
            "source_url": "https://avoventes.fr/known",
            "sale_venue_type": "unknown",
            "raw_payload": {},
        },
    ]
    refreshed = AuctionSale(
        source_name="licitor",
        source_url="https://www.licitor.com/annonce/example/123.html",
        sale_venue_type="tribunal",
    )
    writes: list[str] = []

    monkeypatch.setattr(recompute_module, "_load_env_fallbacks", lambda: None)
    monkeypatch.setattr(recompute_module, "_fetch_sales", lambda **_kwargs: rows)
    monkeypatch.setattr(recompute_module, "_procedure_refresh_clients", lambda: {})
    monkeypatch.setattr(
        recompute_module,
        "_fetch_procedure_source_details",
        lambda row, _clients: {"raw_text": "Tribunal judiciaire de Paris"},
    )
    monkeypatch.setattr(
        recompute_module,
        "_recomputed_sale_from_storage_row",
        lambda row, geocode: refreshed,
    )
    monkeypatch.setattr(
        recompute_module,
        "upsert_sales_to_supabase",
        lambda sales, refresh_last_seen: writes.extend(sale.source_url for sale in sales) or len(sales),
    )

    exit_code = recompute_module.refresh_unknown_sale_procedures()

    assert exit_code == 0
    assert writes == ["https://www.licitor.com/annonce/example/123.html"]


def test_recomputed_sale_validates_geocode_before_court_assignment(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[str] = []

    def fake_geocode(sale: AuctionSale) -> AuctionSale:
        calls.append("geocode")
        sale.raw_payload["geocode"] = {
            "provider": "ban_geoplateforme",
            "accepted": True,
            "citycode": "33063",
        }
        return sale

    def fake_tribunal(sale: AuctionSale) -> AuctionSale:
        calls.append("tribunal")
        assert sale.raw_payload["geocode"]["citycode"] == "33063"
        return sale

    monkeypatch.setattr(recompute_module, "geocode_sale", fake_geocode)
    monkeypatch.setattr(recompute_module, "fill_tribunal", fake_tribunal)
    monkeypatch.setattr(recompute_module, "classify_sale_procedure", lambda sale: calls.append("procedure") or sale)
    monkeypatch.setattr(recompute_module, "normalize_asset_features", lambda sale: calls.append("assets") or sale)

    sale = recompute_module._recomputed_sale_from_storage_row(
        {
            "id": "historical-geocode",
            "source_name": "avoventes",
            "source_url": "https://example.test/historical-geocode",
            "address": "30 cours de l'Intendance",
            "postal_code": "33000",
            "city": "Bordeaux",
            "raw_payload": {},
        },
        geocode=True,
    )

    assert sale.raw_payload["geocode"]["provider"] == "ban_geoplateforme"
    assert calls == ["geocode", "tribunal", "procedure", "assets"]


def test_storage_recompute_preserves_editorial_text_for_surface_reconciliation() -> None:
    row = {
        "id": "725939b3-f8f1-4c84-b8c4-32be90143291",
        "source_name": "encheres_publiques",
        "source_url": "https://example.test/130432",
        "property_type": "house",
        "title": "Maison 1 877 m²",
        "description": "Description d'affichage stockée",
        "surface_m2": 1877,
        "habitable_surface_m2": 1877,
        "app_surface_m2": 1877,
        "raw_payload": {
            "title": "Un ensemble immobilier de 187 m² situé rue Gâte-Bourse",
            "description": (
                "Un ensemble immobilier de 10 pièces de 187 m² avec un garage de 18 m², "
                "édifié sur une parcelle de 1 110 m²."
            ),
            "surface_m2": 1877,
            "habitable_surface_m2": 1877,
        },
    }

    sale = _sale_from_storage_row(row)
    normalize_asset_features(sale)

    assert sale.surface_m2 == Decimal("187")
    assert sale.habitable_surface_m2 is None
    assert sale.land_surface_m2 == Decimal("1110")
    assert sale.app_surface_m2 == Decimal("187")
    assert sale.raw_payload["surface_reconciliation"]["rejected_surface_m2"] == "1877"


def test_storage_recompute_reclassifies_future_unknown_status() -> None:
    from datetime import UTC, datetime, timedelta

    in_a_month = (datetime.now(UTC) + timedelta(days=30)).strftime("%Y-%m-%dT13:00:00+00:00")
    row = {
        "id": "future-status",
        "source_name": "info_encheres",
        "source_url": "https://example.test/future-status",
        "status": "unknown",
        "sale_date": in_a_month,
        "raw_payload": {"status": "unknown"},
    }

    sale = _sale_from_storage_row(row)

    assert sale.status == "upcoming"


def test_storage_recompute_restores_partial_pdf_surface_scope() -> None:
    row = {
        "id": "35f44afc-36ff-4c0b-93c0-4288334989a2",
        "source_name": "info_encheres",
        "source_url": "https://www.info-encheres.com/vente-6009.html",
        "property_type": "apartment",
        "title": "Appartement 4 m²",
        "surface_m2": 3.78,
        "carrez_surface_m2": 3.78,
        "app_surface_m2": 3.78,
        "app_surface_kind": "carrez",
        "surface_scope": "total",
        "surface_source": "pdf",
        "surface_confidence": 0.45,
        "raw_payload": {
            "surface_extraction": {
                "source": "pdf",
                "value_m2": "3.78",
                "surface_scope": "partial",
            }
        },
    }

    sale = _sale_from_storage_row(row)
    normalize_asset_features(sale)

    assert sale.surface_m2 == Decimal("3.78")
    assert sale.carrez_surface_m2 == Decimal("3.78")
    assert sale.app_surface_m2 is None
    assert sale.app_surface_kind is None
    assert sale.surface_scope == "partial"
    assert sale.title == "Appartement"


# --- Registre des pièces, étape PA : liste de colonnes explicite, rien d'interne dans raw_payload -------------------------


def test_fetch_sales_reads_named_columns_and_never_the_whole_row(monkeypatch) -> None:
    sales = [{"id": f"id-{index}", "source_url": f"https://example.test/{index}"} for index in range(3)]
    calls = _fake_postgrest(monkeypatch, sales)

    recompute_module._fetch_sales(source=None, limit=None)

    selects = [call["params"]["select"] for call in calls]
    assert selects == ["id", recompute_module.RECOMPUTE_SALE_SELECT]
    columns = recompute_module.RECOMPUTE_SALE_SELECT.split(",")
    assert "*" not in recompute_module.RECOMPUTE_SALE_SELECT
    assert len(columns) == len(set(columns))
    # Les colonnes du modèle, et aucune autre : une colonne interne de la table ne sort pas de la base.
    assert set(columns) == {name for name, field in AuctionSale.model_fields.items() if not field.exclude}
    assert "held_fields" not in columns and "premium_readiness_override" not in columns


def test_every_row_column_the_recompute_reads_is_in_the_named_list() -> None:
    """Colonne par colonne : chaque clé de ligne lue par le module est demandée à la base."""
    import ast
    from pathlib import Path

    tree = ast.parse(Path(recompute_module.__file__).read_text(encoding="utf-8"))
    read: set[str] = set()
    for node in ast.walk(tree):
        target = None
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr == "get":
            target, argument = node.func.value, node.args[0] if node.args else None
        elif isinstance(node, ast.Subscript):
            target, argument = node.value, node.slice
        if isinstance(target, ast.Name) and target.id == "row":
            if isinstance(argument, ast.Constant) and isinstance(argument.value, str):
                read.add(argument.value)

    assert {"id", "updated_at", "raw_payload", "source_urls", "content_hash", "quality_flags"} <= read
    assert read <= set(recompute_module.RECOMPUTE_SALE_SELECT.split(","))


def test_recompute_pours_only_written_columns_into_the_raw_payload() -> None:
    row = {
        "id": "99900000-1000-4000-8000-000000000001",
        "source_name": "licitor",
        "source_url": "https://example.test/recompute-keys",
        "created_at": "2026-11-01T08:00:00+00:00",
        "updated_at": "2026-11-11T08:00:00+00:00",
        "first_seen_at": "2026-11-01T08:00:00+00:00",
        "last_seen_at": "2026-11-10T08:00:00+00:00",
        "content_hash": "abc",
        "rooms_count": 3,
        "city": "Alphaville",
        # Ce que rendait ``select=*`` : des colonnes que le modèle ne connaît pas.
        "held_fields": {"property.rooms_count": {"value": 3, "claim_id": "c", "decision_id": "d"}},
        "premium_readiness_override": "forced",
        "location": "0101000020E6100000",
        "catalogue_quarantined": False,
        "raw_payload": {
            "source_name": "licitor",
            "source_url": "https://example.test/recompute-keys",
            "title": "Une maison",
            "lot_number": "2",
            # Traces d'un recalcul antérieur à la liste explicite.
            "id": "99900000-1000-4000-8000-000000000001",
            "updated_at": "2026-11-05T08:00:00+00:00",
            "created_at": "2026-11-01T08:00:00+00:00",
        },
    }

    sale = _sale_from_storage_row(row)

    for key in ("id", "updated_at", "created_at", "first_seen_at", "last_seen_at", "held_fields",
                "premium_readiness_override", "location", "catalogue_quarantined"):
        assert key not in sale.raw_payload, key
    # Les colonnes écrites et les clés propres à la source y restent, comme avant.
    assert sale.raw_payload["rooms_count"] == 3
    assert sale.raw_payload["city"] == "Alphaville"
    assert sale.raw_payload["lot_number"] == "2"
    assert sale.raw_payload["content_hash"] == "abc"
    # Le modèle garde l'identifiant et les dates de la ligne : la garde de révision de l'écriture en dépend.
    assert sale.id == row["id"]
    assert sale.updated_at.isoformat() == "2026-11-11T08:00:00+00:00"
    assert sale.created_at is not None and sale.first_seen_at is not None and sale.last_seen_at is not None
    assert set(sale.raw_payload) & recompute_module.RECOMPUTE_ROW_ONLY_COLUMNS == set()


def test_recompute_row_only_columns_are_the_identifier_and_the_row_dates() -> None:
    assert recompute_module.RECOMPUTE_ROW_ONLY_COLUMNS == {
        "id", "created_at", "updated_at", "first_seen_at", "last_seen_at",
    }
    assert "raw_payload" not in recompute_module.RECOMPUTE_PAYLOAD_COLUMNS


def test_emptied_visit_dates_do_not_come_back_from_their_copy_in_the_raw_payload() -> None:
    """Second écho des visites : la colonne vidée ne se reprend pas dans la copie que le recalcul y avait versée."""
    visits = ["LE LUNDI 24 AOUT 2026 DE 10H00 A 11H00"]
    row = {
        "id": "99900000-1000-4000-8000-000000000002",
        "source_name": "avoventes",
        "source_url": "https://example.test/visites",
        "visit_dates": visits,
        "raw_payload": {"source_name": "avoventes", "source_url": "https://example.test/visites", "title": "Maison"},
    }
    first = _sale_from_storage_row(row)
    assert first.visit_dates == visits and first.raw_payload["visit_dates"] == visits

    # La colonne est vidée en base ; la ligne relue porte la mémoire brute écrite par le recalcul précédent.
    emptied = {**row, "visit_dates": [], "raw_payload": dict(first.raw_payload)}
    second = _sale_from_storage_row(emptied)

    assert second.visit_dates == []
    assert second.raw_payload["visit_dates"] == []


def test_visit_dates_read_by_the_source_still_come_back_from_the_source_snapshot() -> None:
    visits = ["LE LUNDI 24 AOUT 2026 DE 10H00 A 11H00"]
    row = {
        "id": "99900000-1000-4000-8000-000000000003",
        "source_name": "avoventes",
        "source_url": "https://example.test/visites-source",
        "visit_dates": [],
        "raw_payload": {
            "source_name": "avoventes",
            "source_url": "https://example.test/visites-source",
            "title": "Maison",
            "source_factual_snapshot": {"visit_dates": visits},
        },
    }

    assert _sale_from_storage_row(row).visit_dates == visits


def test_persisted_sale_procedure_validation_accepts_consistent_payload() -> None:
    row = {
        "sale_venue_type": "tribunal",
        "sale_legal_framework": "judicial_seizure",
        "sale_verification_status": "cross_checked",
        "sale_procedure": {
            "schema_version": "sale_procedure_v1",
            "venue_type": "tribunal",
            "legal_framework": "judicial_seizure",
            "rules": {"lawyer_required": True},
            "verification": {"status": "cross_checked"},
        },
    }

    assert _validate_persisted_sale_procedure(row) == []


def test_persisted_sale_procedure_validation_rejects_empty_or_inconsistent_payload() -> None:
    assert _validate_persisted_sale_procedure(
        {
            "sale_venue_type": "tribunal",
            "sale_legal_framework": "judicial_seizure",
            "sale_verification_status": "verified",
            "sale_procedure": {},
        }
    ) == ["missing sale_procedure"]

    issues = _validate_persisted_sale_procedure(
        {
            "sale_venue_type": "notary",
            "sale_legal_framework": "voluntary_notarial",
            "sale_verification_status": "verified",
            "sale_procedure": {
                "schema_version": "outdated",
                "venue_type": "tribunal",
                "legal_framework": "unknown",
                "verification": {"status": "pending"},
            },
        }
    )

    assert issues == [
        "invalid schema_version",
        "venue_type mismatch",
        "legal_framework mismatch",
        "missing rules",
        "verification status mismatch",
    ]


def test_persisted_sale_procedure_validation_detects_stale_but_well_formed_payload() -> None:
    row = {
        "sale_venue_type": "tribunal",
        "sale_legal_framework": "unknown",
        "sale_verification_status": "pending",
        "sale_procedure": {
            "schema_version": "sale_procedure_v1",
            "ruleset_version": "fr_auction_participation_2026-08-20",
            "venue_type": "tribunal",
            "legal_framework": "unknown",
            "participation_mode": "in_person",
            "rules": {"lawyer_required": None},
            "verification": {"status": "pending"},
        },
    }
    expected = AuctionSale(
        source_name="avoventes",
        source_url="https://example.test/stale",
        sale_venue_type="tribunal",
        sale_legal_framework="judicial_seizure",
        sale_verification_status="verified",
        sale_procedure={
            "ruleset_version": "fr_auction_participation_2026-08-20",
            "participation_mode": "lawyer_mandate",
            "rules": {"lawyer_required": True},
        },
    )

    assert _validate_persisted_sale_procedure(row, expected_sale=expected) == [
        "legal_framework differs from recompute",
        "verification status differs from recompute",
        "participation_mode differs from recompute",
        "rules differs from recompute",
    ]


def test_persisted_sale_procedure_validation_detects_stale_state_sale_method() -> None:
    row = {
        "sale_venue_type": "state",
        "sale_legal_framework": "state_sale",
        "sale_verification_status": "cross_checked",
        "sale_procedure": {
            "schema_version": "sale_procedure_v1",
            "ruleset_version": "fr_auction_participation_2026-08-20",
            "venue_type": "state",
            "legal_framework": "state_sale",
            "participation_mode": "unknown",
            "state_sale_method": "unknown",
            "rules": {"lawyer_required": None},
            "verification": {"status": "cross_checked"},
        },
    }
    expected = AuctionSale(
        source_name="cessions_etat",
        source_url="https://example.test/state-sale",
        sale_venue_type="state",
        sale_legal_framework="state_sale",
        sale_verification_status="cross_checked",
        sale_procedure={
            "ruleset_version": "fr_auction_participation_2026-08-20",
            "participation_mode": "unknown",
            "state_sale_method": "appel_offres",
            "rules": {"lawyer_required": None},
        },
    )

    assert _validate_persisted_sale_procedure(row, expected_sale=expected) == [
        "state_sale_method differs from recompute",
    ]


class LockNotAvailable(Exception):
    """Same class name as psycopg.errors.LockNotAvailable."""


def test_a_batch_that_waits_too_long_for_the_catalogue_lock_is_retried(monkeypatch) -> None:
    from src import recompute_scoring

    calls: list[int] = []

    def upsert(batch, refresh_last_seen):
        calls.append(len(batch))
        if len(calls) < 3:
            raise LockNotAvailable("canceling statement due to lock timeout")
        return len(batch)

    slept: list[float] = []
    monkeypatch.setattr(recompute_scoring, "upsert_sales_to_supabase", upsert)

    assert recompute_scoring._upsert_batch_with_lock_retry(["a", "b"], sleep=slept.append) == 2
    assert calls == [2, 2, 2]
    assert slept == [20.0, 60.0]


def test_a_lock_timeout_that_never_clears_still_fails_and_other_errors_are_not_retried(monkeypatch) -> None:
    import pytest

    from src import recompute_scoring

    def always_locked(batch, refresh_last_seen):
        raise LockNotAvailable("lock timeout")

    monkeypatch.setattr(recompute_scoring, "upsert_sales_to_supabase", always_locked)
    with pytest.raises(LockNotAvailable):
        recompute_scoring._upsert_batch_with_lock_retry(["a"], sleep=lambda _: None)

    def broken(batch, refresh_last_seen):
        raise ValueError("bad row")

    slept: list[float] = []
    monkeypatch.setattr(recompute_scoring, "upsert_sales_to_supabase", broken)
    with pytest.raises(ValueError):
        recompute_scoring._upsert_batch_with_lock_retry(["a"], sleep=slept.append)
    assert slept == []


def test_recompute_is_complete_when_the_admission_rule_refuses_expired_sales(monkeypatch) -> None:
    """05/11/2026 : chaque recalcul complet concluait à un échec (1 369 écrites sur 1 501) ; l'écart était fait des
    ventes que la règle d'admission n'écrit jamais (expirées, sans mise à prix ni surface)."""
    rows = [{"source_url": "https://example.test/live"}, {"source_url": "https://example.test/expired"}]
    sales = {row["source_url"]: SimpleNamespace(source_url=row["source_url"]) for row in rows}
    written: list[str] = []
    monkeypatch.setattr(recompute_module, "_load_env_fallbacks", lambda: None)
    monkeypatch.setattr(recompute_module, "_fetch_sales", lambda **_kwargs: rows)
    monkeypatch.setattr(
        recompute_module, "_recomputed_sale_from_storage_row", lambda row, geocode=False: sales[row["source_url"]]
    )
    monkeypatch.setattr(
        recompute_module,
        "catalogue_write_rejection",
        lambda sale: "expired_sale" if sale.source_url.endswith("expired") else None,
    )
    monkeypatch.setattr(recompute_module, "closes_expired_offer_deadline", lambda _sale: False)
    monkeypatch.setattr(
        recompute_module,
        "_upsert_batch_with_lock_retry",
        lambda batch: written.extend(sale.source_url for sale in batch) or len(batch),
    )
    monkeypatch.setattr(recompute_module, "_print_summary", lambda *_args, **_kwargs: None)

    assert recompute_module.recompute_scoring() == 0
    assert written == ["https://example.test/live"]


def test_recompute_still_fails_when_a_writable_sale_is_not_written(monkeypatch) -> None:
    rows = [{"source_url": "https://example.test/a"}, {"source_url": "https://example.test/b"}]
    monkeypatch.setattr(recompute_module, "_load_env_fallbacks", lambda: None)
    monkeypatch.setattr(recompute_module, "_fetch_sales", lambda **_kwargs: rows)
    monkeypatch.setattr(
        recompute_module,
        "_recomputed_sale_from_storage_row",
        lambda row, geocode=False: SimpleNamespace(source_url=row["source_url"]),
    )
    monkeypatch.setattr(recompute_module, "catalogue_write_rejection", lambda _sale: None)
    monkeypatch.setattr(recompute_module, "_upsert_batch_with_lock_retry", lambda batch: len(batch) - 1)
    monkeypatch.setattr(recompute_module, "_print_summary", lambda *_args, **_kwargs: None)

    assert recompute_module.recompute_scoring(batch_size=10) == 1
