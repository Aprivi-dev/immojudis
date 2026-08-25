from __future__ import annotations

import httpx
import pytest

from src.official_sources.justice_activity import (
    JusticeActivityClient,
    JusticeActivitySchemaError,
    parse_activity_metric,
    parse_available_years,
    parse_justice_activity_html,
    parse_source_version,
)


def _row(code: str, name: str, *, new: str = "", terminated: str = "") -> str:
    cells = [""] * 72
    cells[0] = f'<a i_elst="{code}">{name}</a>'
    cells[12] = new
    cells[34] = terminated
    return "<tr>" + "".join(f"<td>{value}</td>" for value in cells) + "</tr>"


def _table(*rows: str) -> str:
    headers = ["Colonne"] * 72
    headers[12] = "Ventes, saisies immobilières"
    headers[34] = "Ventes, saisies immobilières"
    return (
        "<table><thead><tr>"
        + "".join(f"<th>{value}</th>" for value in headers)
        + "</tr></thead><tbody>"
        + "".join(rows)
        + "</tbody></table>"
    )


def test_activity_metric_preserves_suppressed_missing_and_zero() -> None:
    assert parse_activity_metric(" NC ").status == "suppressed"
    assert parse_activity_metric("\xa0").status == "missing"
    assert parse_activity_metric("0").value == 0
    assert parse_activity_metric("1 234").value == 1234


def test_activity_metric_rejects_unexpected_values() -> None:
    with pytest.raises(JusticeActivitySchemaError, match="unexpected"):
        parse_activity_metric("< 5")


def test_parse_activity_table_extracts_reviewed_columns() -> None:
    parsed = parse_justice_activity_html(
        _table(
            _row("00000000", "FRANCE", new="186", terminated="205"),
            _row("33000001", "BORDEAUX", new="NC", terminated="&nbsp;"),
        ),
        activity_year=2019,
        source_version="v26.02.2",
        require_full_snapshot=False,
    )

    assert parsed.national.new_sales_seizures.value == 186
    assert parsed.national.terminated_sales_seizures.value == 205
    assert len(parsed.records) == 1
    assert parsed.records[0].source_court_code == "33000001"
    assert parsed.records[0].source_court_name == "BORDEAUX"
    assert parsed.records[0].new_sales_seizures.status == "suppressed"
    assert parsed.records[0].terminated_sales_seizures.status == "missing"
    assert len(parsed.records[0].canonical_hash) == 64
    assert len(parsed.content_hash) == 64


def test_parse_activity_table_rejects_duplicates_and_schema_drift() -> None:
    duplicate = _table(
        _row("00000000", "FRANCE"),
        _row("33000001", "BORDEAUX"),
        _row("33000001", "BORDEAUX BIS"),
    )
    with pytest.raises(JusticeActivitySchemaError, match="duplicate"):
        parse_justice_activity_html(
            duplicate,
            activity_year=2019,
            source_version="v26.02.2",
            require_full_snapshot=False,
        )

    with pytest.raises(JusticeActivitySchemaError, match="source version"):
        parse_justice_activity_html(
            _table(_row("00000000", "FRANCE"), _row("33000001", "BORDEAUX")),
            activity_year=2019,
            source_version="inconnue",
            require_full_snapshot=False,
        )

    with pytest.raises(JusticeActivitySchemaError, match="columns have changed"):
        parse_justice_activity_html(
            duplicate.replace("Ventes, saisies immobilières", "Colonne", 1),
            activity_year=2019,
            source_version="v26.02.2",
            require_full_snapshot=False,
        )


def test_full_snapshot_requires_national_coverage() -> None:
    with pytest.raises(JusticeActivitySchemaError, match="too few tribunal rows"):
        parse_justice_activity_html(
            _table(_row("00000000", "FRANCE"), _row("33000001", "BORDEAUX")),
            activity_year=2019,
            source_version="v26.02.2",
        )


def test_source_metadata_parsers_are_bounded() -> None:
    assert parse_source_version("StatJur v26.02.2") == "v26.02.2"
    assert parse_available_years('<option value="2019">2019</option><option>2018</option>') == (2018, 2019)
    with pytest.raises(JusticeActivitySchemaError, match="version"):
        parse_source_version("StatJur")


def test_client_validates_period_then_parses_full_snapshot() -> None:
    rows = [_row("00000000", "FRANCE", new="186", terminated="205")]
    rows.extend(_row(f"{index:08d}", f"TRIBUNAL {index}", new="1", terminated="2") for index in range(1, 151))
    table = _table(*rows)
    calls: list[tuple[str, str]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        body = request.content.decode()
        calls.append((request.method, body))
        if request.method == "GET":
            return httpx.Response(200, text="StatJur v26.02.2", request=request)
        if "lst_priod" in body:
            return httpx.Response(200, text='<option value="2019">2019</option>', request=request)
        return httpx.Response(200, text=table, request=request)

    with httpx.Client(transport=httpx.MockTransport(handler)) as http_client:
        with JusticeActivityClient(client=http_client, minimum_request_interval_seconds=0) as client:
            result = client.fetch_year(2019)

    assert len(result.records) == 150
    assert calls[0][0] == "POST"
    assert calls[1][0] == "GET"
    assert "priod=2019" in calls[2][1]


def test_client_rejects_an_unpublished_period() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, text='<option value="2019">2019</option>', request=request)

    with httpx.Client(transport=httpx.MockTransport(handler)) as http_client:
        client = JusticeActivityClient(client=http_client, minimum_request_interval_seconds=0)
        with pytest.raises(Exception, match="does not publish"):
            client.fetch_year(2020, source_version="v26.02.2")


def test_client_enforces_the_reviewed_request_interval() -> None:
    ticks = iter((0.0, 1.0, 4.0))
    sleeps: list[float] = []

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, text="StatJur v26.02.2", request=request)

    with httpx.Client(transport=httpx.MockTransport(handler)) as http_client:
        client = JusticeActivityClient(
            client=http_client,
            minimum_request_interval_seconds=4,
            clock=lambda: next(ticks),
            sleeper=sleeps.append,
        )
        assert client.source_version() == "v26.02.2"
        assert client.source_version() == "v26.02.2"

    assert sleeps == [3.0]
