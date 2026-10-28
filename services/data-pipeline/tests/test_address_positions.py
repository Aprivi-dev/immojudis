"""Cause 2 : géocodage BAN en lot des ventes à venir qui ont une adresse mais pas de position précise."""

from __future__ import annotations

import csv
import io
import json
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from types import SimpleNamespace

import httpx
import pytest
from psycopg.types.json import Jsonb

from src import address_positions, municipality_location
from src.address_positions import (
    UPDATE_ATTEMPT_SQL,
    UPDATE_POSITION_SQL,
    batch_url,
    csv_payload,
    parse_batch_response,
    run_pass,
    select_candidates,
)

API = "https://data.geopf.fr/geocodage/search/"
STAMP = datetime(2026, 10, 28, 9, 0, tzinfo=UTC)


def _row(
    row_id: str,
    address: str | None,
    *,
    city: str = "Longvic",
    postal_code: str | None = "21600",
    department: str | None = "21",
    latitude: float | None = 47.29,
    longitude: float | None = 5.06,
    precision: str | None = "municipality",
    geocode: dict | None = None,
    flags: list[str] | None = None,
    invalid_address: dict | None = None,
):
    return (
        row_id, "vench", f"https://www.vench.fr/vente/{row_id}", STAMP, address, city, postal_code, department,
        None if latitude is None else Decimal(str(latitude)), None if longitude is None else Decimal(str(longitude)),
        flags or [], precision, geocode, None, invalid_address,
    )


def _stamp(days_ago: int) -> str:
    return (datetime.now(UTC) - timedelta(days=days_ago)).isoformat().replace("+00:00", "Z")


SEMBAT = "20 rue Marcel Sembat, Longvic"
SEMBAT_QUERY = "20 rue Marcel Sembat, Longvic 21600"
PARIS = "31 rue Mademoiselle, PARIS 75006"


# --- sélection --------------------------------------------------------------------------------------


def test_selection_keeps_sales_with_a_street_and_drops_the_rest() -> None:
    rows = [
        _row("a", SEMBAT),
        _row("b", "21600 Longvic"),
        _row("c", PARIS, city="Paris", postal_code="75006", department="75"),
        _row("d", SEMBAT, invalid_address={"reason": "price"}),
        _row("e", "Lieu-dit Les Vignes 21600 Longvic"),
    ]

    candidates, counts = select_candidates(rows, limit=500)

    assert [candidate.row_id for candidate in candidates] == ["a", "c", "e"]
    assert counts["no_street"] == 1 and counts["invalid_address"] == 1 and counts["eligible"] == 3


def test_selection_builds_the_cleaned_query_and_the_postcode_of_the_address() -> None:
    rows = [_row("a", "6 rue des Templiers, 69002 LYON 69003", city="LYON", postal_code="69003", department="69")]

    candidates, _ = select_candidates(rows, limit=500)

    assert candidates[0].query == "6 rue des Templiers, 69002 LYON"
    assert candidates[0].postcode == "69002"


def test_selection_skips_a_recent_attempt_on_the_same_query_but_not_on_another() -> None:
    same = {"provider": "ban_geoplateforme", "query": SEMBAT_QUERY, "accepted": False,
            "attempted_at": _stamp(3), "rejection_reason": "no_result"}
    other = {**same, "query": "Longvic"}
    old = {**same, "attempted_at": _stamp(20)}
    commune_level = {"provider": "ban_geoplateforme", "query": SEMBAT_QUERY, "accepted": True,
                     "type": "municipality", "attempted_at": _stamp(3)}
    rows = [
        _row("same", SEMBAT, geocode=same),
        _row("other", SEMBAT, geocode=other),
        _row("old", SEMBAT, geocode=old),
        _row("commune", SEMBAT, geocode=commune_level),
    ]

    candidates, counts = select_candidates(rows, limit=500)

    assert sorted(candidate.row_id for candidate in candidates) == ["old", "other"]
    assert counts["cached"] == 2


def test_selection_sends_never_tried_sales_first_then_the_oldest_attempts_and_respects_the_cap() -> None:
    older = {"provider": "ban_geoplateforme", "query": "x", "accepted": False, "attempted_at": _stamp(30)}
    newer = {**older, "attempted_at": _stamp(16)}
    rows = [
        _row("newer", SEMBAT, geocode=newer),
        _row("older", SEMBAT, geocode=older),
        _row("fresh1", SEMBAT, geocode={"provider": "reference_communes", "accepted": True, "type": "municipality"}),
        _row("fresh2", SEMBAT, precision=None, latitude=None, longitude=None),
    ]

    candidates, _ = select_candidates(rows, limit=3)

    assert [candidate.row_id for candidate in candidates] == ["fresh1", "fresh2", "older"]


# --- CSV et réponse -------------------------------------------------------------------------------------


def test_the_batch_url_is_the_csv_endpoint_of_the_configured_search_url() -> None:
    assert batch_url(API) == "https://data.geopf.fr/geocodage/search/csv"
    assert batch_url("https://ban.test/search") == "https://ban.test/search/csv"


def test_the_csv_carries_the_query_and_the_postcode_column() -> None:
    candidates, _ = select_candidates([_row("a", '20 rue "Marcel" Sembat, Longvic'), _row("b", PARIS, postal_code="75006")], limit=5)

    rows = list(csv.DictReader(io.StringIO(csv_payload(candidates).decode("utf-8"))))

    assert rows[0] == {"id": "a", "q": '20 rue "Marcel" Sembat, Longvic 21600', "postcode": "21600"}
    assert rows[1]["id"] == "b" and rows[1]["postcode"] == "75006"


RESPONSE = """id,q,postcode,latitude,longitude,result_score,result_type,result_label,result_street,result_name,result_city,result_citycode,result_postcode,result_status
a,"20 rue Marcel Sembat, Longvic",21600,47.29363,5.059551,0.96,housenumber,20 Rue Marcel Sembat 21600 Longvic,Rue Marcel Sembat,20 Rue Marcel Sembat,Longvic,21355,21600,ok
b,"zzz",,,,,,,,,,,,not-found
c,"31 rue Mademoiselle, PARIS 75006",75006,48.8451,2.3123,0.30,housenumber,31 Rue Mademoiselle 75015 Paris,Rue Mademoiselle,31 Rue Mademoiselle,Paris,75115,75015,ok
d,"x",,,,,,,,,,,,error
e,"y",,,,,,,,,,,,skipped
f,"Longvic",,47.29,5.06,0.9,municipality,Longvic,,Longvic,Longvic,21355,21600,ok
"""


def test_the_response_is_read_with_the_thresholds_of_geocode_sale() -> None:
    results = parse_batch_response(RESPONSE, min_score=0.45)

    assert results["a"].latitude == Decimal("47.29363") and results["a"].result_type == "housenumber"
    assert results["a"].street == "Rue Marcel Sembat" and results["a"].citycode == "21355"
    assert results["b"] is None
    assert results["c"] is None  # score 0,30 : sous le minimum
    assert "d" not in results and "e" not in results  # erreur ou ligne ignorée : renvoyée au passage suivant
    assert results["f"].result_type == "municipality"


def test_a_house_number_below_0_6_is_refused_like_in_geocode_sale() -> None:
    text = RESPONSE.replace("0.96", "0.55")

    assert parse_batch_response(text, min_score=0.45)["a"] is None


def test_post_batch_sends_a_multipart_csv_and_retries_on_429() -> None:
    sent = []
    responses = [SimpleNamespace(status_code=429), SimpleNamespace(status_code=200, text=RESPONSE, raise_for_status=lambda: None)]
    sleeps = []

    def post(url, **kwargs):
        sent.append((url, kwargs))
        return responses.pop(0)

    candidates, _ = select_candidates([_row("a", SEMBAT)], limit=5)

    text = address_positions.post_batch(candidates, api_url=API, post=post, sleep=sleeps.append)

    assert text == RESPONSE
    assert len(sent) == 2 and sleeps == [1]
    url, kwargs = sent[0]
    assert url == "https://data.geopf.fr/geocodage/search/csv"
    assert kwargs["data"]["columns"] == "q" and kwargs["data"]["postcode"] == "postcode"
    assert "latitude" in kwargs["data"]["result_columns"] and "result_status" in kwargs["data"]["result_columns"]
    assert kwargs["files"]["data"][2] == "text/csv"


def test_post_batch_raises_on_an_http_error() -> None:
    def raise_for_status():
        raise httpx.HTTPStatusError("boom", request=httpx.Request("POST", API), response=httpx.Response(500))

    candidates, _ = select_candidates([_row("a", SEMBAT)], limit=5)

    with pytest.raises(httpx.HTTPStatusError):
        address_positions.post_batch(
            candidates, api_url=API, post=lambda *a, **k: SimpleNamespace(status_code=500, raise_for_status=raise_for_status)
        )


# --- passage complet ---------------------------------------------------------------------------------------


class FakeConnection:
    def __init__(self, rows, rowcounts=None, failing=()):
        self.rows = rows
        self.statements: list[tuple[str, tuple]] = []
        self.events: list[str] = []  # "savepoint", "release", "rollback", dans l'ordre
        self.rowcounts = rowcounts or {}
        self.failing = set(failing)

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def transaction(self):
        connection = self

        class Savepoint:
            def __enter__(self):
                connection.events.append("savepoint")

            def __exit__(self, exc_type, *_):
                connection.events.append("rollback" if exc_type else "release")
                return False

        return Savepoint()

    def execute(self, sql, params=()):
        self.statements.append((sql, params))
        if sql.startswith("set transaction"):
            return SimpleNamespace()
        if "from public.auction_sales" in sql and "select" in sql:
            return SimpleNamespace(fetchall=lambda: self.rows)
        row_id = params[-2]
        if row_id in self.failing:
            raise RuntimeError("deadlock detected")
        return SimpleNamespace(rowcount=self.rowcounts.get(row_id, 1))


@pytest.fixture(autouse=True)
def reference_communes(monkeypatch):
    monkeypatch.setattr(municipality_location, "load_communes", lambda: [])
    municipality_location.reset_cache()
    yield
    municipality_location.reset_cache()


def _run(rows, response_text, **kwargs):
    connection = FakeConnection(rows, kwargs.pop("rowcounts", None), kwargs.pop("failing", ()))
    calls = []

    def post(url, **post_kwargs):
        calls.append((url, post_kwargs))
        return SimpleNamespace(status_code=200, text=response_text, raise_for_status=lambda: None)

    counts = run_pass(lambda: connection, api_url=API, min_score=0.45, post=post, **kwargs)
    return counts, connection, calls


def _writes(connection):
    return [(sql, params) for sql, params in connection.statements if sql in {UPDATE_POSITION_SQL, UPDATE_ATTEMPT_SQL}]


def test_a_pass_moves_the_commune_centre_to_the_address_and_records_the_refusals() -> None:
    rows = [
        _row("a", SEMBAT),
        _row("b", "9 rue Inconnue, Longvic"),
        _row("f", "5 chemin du Moulin, Longvic"),
    ]

    counts, connection, calls = _run(rows, RESPONSE)

    assert len(calls) == 1 and calls[0][0].endswith("/search/csv")
    assert counts["selected"] == 3 and counts["accepted"] == 1 and counts["refused"] == 2 and counts["unanswered"] == 0
    assert counts["written"] == 3
    position, attempt, commune_only = _writes(connection)
    # a : nouveau point, précision « adresse », preuve BAN complète.
    sql, params = position
    assert sql == UPDATE_POSITION_SQL
    assert (params[0], params[1]) == (Decimal("47.29363"), Decimal("5.059551"))
    patch = params[3].obj
    assert patch["geo_precision"] == "address"
    assert patch["geocode"]["provider"] == "ban_geoplateforme" and patch["geocode"]["query"] == SEMBAT_QUERY
    assert patch["geocode"]["type"] == "housenumber" and patch["geocode"]["accepted"] is True
    assert set(patch) <= {"geo_precision", "geocode", "commune"}
    assert params[4] == "a" and params[5] == STAMP
    # b : aucune adresse trouvée, seul le cache négatif est écrit, sans toucher aux coordonnées.
    sql, params = attempt
    assert sql == UPDATE_ATTEMPT_SQL
    assert params[0].obj["geocode"]["accepted"] is False and params[0].obj["geocode"]["rejection_reason"] == "no_result"
    assert "geo_precision" not in params[0].obj
    assert "latitude" not in UPDATE_ATTEMPT_SQL and "longitude" not in UPDATE_ATTEMPT_SQL
    # f : la BAN n'a trouvé que la commune, la vente garde son centre de commune (aucune coordonnée écrite).
    sql, params = commune_only
    assert sql == UPDATE_ATTEMPT_SQL
    assert params[0].obj["geocode"]["rejection_reason"] == "municipality_only"


def test_a_commune_level_answer_never_replaces_the_existing_point() -> None:
    counts, connection, _ = _run([_row("f", "5 chemin du Moulin, Longvic")], RESPONSE)

    # « f » répond au niveau de la commune : refusé, cache négatif seul.
    assert counts["accepted"] == 0 and counts["refused"] == 1
    (sql, params), = _writes(connection)
    assert sql == UPDATE_ATTEMPT_SQL
    assert params[0].obj["geocode"]["rejection_reason"] == "municipality_only"


def test_another_street_is_refused() -> None:
    text = RESPONSE.replace("Rue Marcel Sembat,20 Rue", "Rue Voltaire,20 Rue")

    counts, connection, _ = _run([_row("a", SEMBAT)], text)

    assert counts["accepted"] == 0 and counts["refused"] == 1
    (sql, params), = _writes(connection)
    assert params[0].obj["geocode"]["rejection_reason"] == "street_mismatch"


def test_a_result_outside_the_department_is_refused_and_flagged() -> None:
    text = RESPONSE.replace("47.29363,5.059551", "43.3,5.37")  # Marseille, pas en Côte-d'Or

    counts, connection, _ = _run([_row("a", SEMBAT)], text)

    assert counts["accepted"] == 0
    (sql, params), = _writes(connection)
    assert sql == UPDATE_ATTEMPT_SQL
    assert params[0].obj["geocode"]["rejection_reason"] == "outside_department"


def test_a_row_rewritten_since_the_read_is_left_for_the_next_pass() -> None:
    counts, _, _ = _run([_row("a", SEMBAT)], RESPONSE, rowcounts={"a": 0})

    assert counts["written"] == 0 and counts["changed_meanwhile"] == 1


def test_a_failing_row_is_rolled_back_alone_and_the_others_are_written() -> None:
    rows = [_row("a", SEMBAT), _row("b", "9 rue Inconnue, Longvic"), _row("f", "5 chemin du Moulin, Longvic")]

    counts, connection, _ = _run(rows, RESPONSE, failing={"b"})

    assert counts["written"] == 2 and counts["failed"] == 1 and counts["changed_meanwhile"] == 0
    assert [params[-2] for _, params in _writes(connection)] == ["a", "b", "f"]
    # Un point de sauvegarde par ligne : la ligne en échec est annulée seule.
    assert connection.events == ["savepoint", "release", "savepoint", "rollback", "savepoint", "release"]


def test_every_chunk_is_written_right_after_its_answer_not_at_the_end(monkeypatch) -> None:
    monkeypatch.setattr(address_positions, "CHUNK_SIZE", 2)
    rows = [_row(f"r{index}", SEMBAT) for index in range(5)]
    connection = FakeConnection(rows)
    journal: list[str] = []
    original_execute = connection.execute

    def execute(sql, params=()):
        if sql in {UPDATE_POSITION_SQL, UPDATE_ATTEMPT_SQL}:
            journal.append("write")
        return original_execute(sql, params)

    connection.execute = execute

    def post(url, **kwargs):
        journal.append("post")
        ids = [row["id"] for row in csv.DictReader(io.StringIO(kwargs["files"]["data"][1].decode("utf-8")))]
        text = "id,result_status\n" + "".join(f"{row_id},not-found\n" for row_id in ids)
        return SimpleNamespace(status_code=200, text=text, raise_for_status=lambda: None)

    counts = run_pass(lambda: connection, api_url=API, min_score=0.45, max_sales=5, post=post)

    assert counts["written"] == 5
    assert journal == ["post", "write", "write", "post", "write", "write", "post", "write"]


def test_the_catalogue_lock_is_held_only_while_a_chunk_is_written(monkeypatch) -> None:
    monkeypatch.setattr(address_positions, "CHUNK_SIZE", 2)
    rows = [_row(f"r{index}", SEMBAT) for index in range(4)]
    connection = FakeConnection(rows)
    held = {"now": False, "acquired": 0, "writes_without_lock": 0, "posts_with_lock": 0}

    class Lock:
        def __enter__(self):
            held["now"] = True
            held["acquired"] += 1

        def __exit__(self, *_):
            held["now"] = False
            return False

    original_execute = connection.execute

    def execute(sql, params=()):
        if sql in {UPDATE_POSITION_SQL, UPDATE_ATTEMPT_SQL} and not held["now"]:
            held["writes_without_lock"] += 1
        return original_execute(sql, params)

    connection.execute = execute

    def post(url, **kwargs):
        held["posts_with_lock"] += int(held["now"])
        ids = [row["id"] for row in csv.DictReader(io.StringIO(kwargs["files"]["data"][1].decode("utf-8")))]
        text = "id,result_status\n" + "".join(f"{row_id},not-found\n" for row_id in ids)
        return SimpleNamespace(status_code=200, text=text, raise_for_status=lambda: None)

    run_pass(lambda: connection, api_url=API, min_score=0.45, max_sales=4, post=post, writer_lock=Lock)

    assert held == {"now": False, "acquired": 2, "writes_without_lock": 0, "posts_with_lock": 0}


def test_a_busy_catalogue_lock_stops_the_writes_and_the_pass_still_succeeds() -> None:
    from src.catalogue_lock import CatalogueLockTimeout

    def busy():
        raise CatalogueLockTimeout("another job keeps writing the catalogue")

    counts, connection, _ = _run([_row("a", SEMBAT)], RESPONSE, writer_lock=busy)

    assert counts["lock_busy"] == 1 and counts["written"] == 0 and _writes(connection) == []


def test_a_dry_run_writes_nothing() -> None:
    counts, connection, calls = _run([_row("a", SEMBAT)], RESPONSE, dry_run=True)

    assert counts["accepted"] == 1 and counts["written"] == 0
    assert _writes(connection) == []
    assert len(calls) == 1


def test_nothing_is_sent_when_no_sale_is_eligible() -> None:
    counts, connection, calls = _run([_row("b", "21600 Longvic")], RESPONSE)

    assert calls == [] and counts["selected"] == 0 and _writes(connection) == []


def test_the_cap_limits_the_number_of_addresses_sent() -> None:
    rows = [_row(f"r{index}", SEMBAT) for index in range(40)]

    counts, _, calls = _run(rows, "id,result_status\n", max_sales=12)

    assert counts["selected"] == 12
    sent = list(csv.DictReader(io.StringIO(calls[0][1]["files"]["data"][1].decode("utf-8"))))
    assert len(sent) == 12


def test_large_passes_are_split_in_several_requests(monkeypatch) -> None:
    monkeypatch.setattr(address_positions, "CHUNK_SIZE", 5)
    rows = [_row(f"r{index}", SEMBAT) for index in range(12)]

    _, _, calls = _run(rows, "id,result_status\n", max_sales=12)

    assert len(calls) == 3


def test_the_time_budget_stops_the_pass_between_requests(monkeypatch) -> None:
    monkeypatch.setattr(address_positions, "CHUNK_SIZE", 5)
    rows = [_row(f"r{index}", SEMBAT) for index in range(12)]
    ticks = iter([0.0, 0.0, 999.0, 999.0, 999.0])

    connection = FakeConnection(rows)
    calls = []

    def post(url, **kwargs):
        calls.append(url)
        return SimpleNamespace(status_code=200, text="id,result_status\n", raise_for_status=lambda: None)

    run_pass(
        lambda: connection, api_url=API, min_score=0.45, max_sales=12, budget_seconds=100, post=post,
        clock=lambda: next(ticks),
    )

    assert len(calls) == 1


def test_the_selection_sql_only_reads_upcoming_sales_with_an_address_and_an_approximate_point() -> None:
    sql = address_positions.CANDIDATES_SQL

    assert "status in ('upcoming', 'unknown', 'postponed')" in sql
    assert "sale_date >= now()" in sql
    assert "geo_precision' = 'municipality'" in sql and "reference_communes" in sql
    assert "latitude is null" in sql
    assert "raw_payload->'cadastre_location'" not in sql
    # Lecture : jamais le JSON complet de la vente.
    assert "raw_payload," not in sql and "select *" not in sql


def test_the_writes_touch_only_the_position_keys_and_guard_the_revision() -> None:
    for sql in (UPDATE_POSITION_SQL, UPDATE_ATTEMPT_SQL):
        assert "raw_payload = coalesce(raw_payload, '{}'::jsonb) ||" in sql
        assert "updated_at = %s" in sql
        assert "set updated_at" not in sql and ", updated_at" not in sql.split("where")[0]


def test_the_patch_is_jsonb() -> None:
    _, connection, _ = _run([_row("a", SEMBAT)], RESPONSE)

    (_, params), = _writes(connection)
    assert isinstance(params[2], Jsonb) and isinstance(params[3], Jsonb)


# --- entrée en ligne de commande -------------------------------------------------------------------------


def test_main_is_a_no_op_when_disabled(monkeypatch, capsys) -> None:
    monkeypatch.setenv("ADDRESS_POSITIONS_ENABLED", "false")
    monkeypatch.setattr(address_positions, "load_settings", lambda: {"geocode_enabled": True})

    assert address_positions.main([]) == 0
    assert "skipped" in json.loads(capsys.readouterr().out)


def test_main_is_a_no_op_when_geocoding_is_off(monkeypatch, capsys) -> None:
    monkeypatch.delenv("ADDRESS_POSITIONS_ENABLED", raising=False)
    monkeypatch.setattr(address_positions, "load_settings", lambda: {"geocode_enabled": False})

    assert address_positions.main([]) == 0
    assert "skipped" in json.loads(capsys.readouterr().out)
