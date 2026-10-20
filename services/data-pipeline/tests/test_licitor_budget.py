"""Licitor : la lecture des fiches s'arrête au budget de la source et reprend au passage suivant.

Huit runs « Execution budget exceeded » (19/10/2026) : les fiches se lisent une à une, espacées, et un
inventaire national dépasse le plafond du lanceur. La source se borne maintenant elle-même, émet toute la
liste (l'inventaire reste certifié) et laisse les fiches non lues « à relire ».
"""

from __future__ import annotations

from contextlib import nullcontext
from datetime import date, timedelta
from types import SimpleNamespace

import pytest

from src import autonomous_runner
from src.sources import common, licitor

DETAIL_HTML = """<html><body><h1>Une maison</h1><p>Mise à prix : 50 000 €</p></body></html>"""


class _Clock:
    """Horloge simulée : chaque lecture de page coûte ``step`` secondes."""

    def __init__(self, step: float = 10.0) -> None:
        self.now = 0.0
        self.step = step

    def monotonic(self) -> float:
        return self.now


class _Client:
    def __init__(self, clock: _Clock, fetched: list[str]) -> None:
        self.clock = clock
        self.fetched = fetched

    def get(self, url: str) -> str:
        self.fetched.append(url)
        self.clock.now += self.clock.step
        return DETAIL_HTML


def _french_day(offset: int) -> str:
    months = ("janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre",
              "novembre", "décembre")
    day = date.today() + timedelta(days=offset)
    return f"{day.day} {months[day.month - 1]} {day.year}"


def _list_sales(count: int) -> list[dict[str, object]]:
    # Ordre de la liste : de la vente la plus lointaine à la plus proche.
    return [
        {
            "source_name": "licitor",
            "source_url": f"https://www.licitor.com/annonce/{index:02d}.html",
            "department": "33",
            "city": "Bordeaux",
            "title": f"Lot {index}",
            "starting_price_eur": "50 000 €",
            "sale_date": _french_day(100 - 10 * index),
            "source_lots": [{"raw_text": f"Lot {index}", "title": f"Lot {index}"}],
        }
        for index in range(count)
    ]


@pytest.fixture
def scrape(monkeypatch):
    def run(count: int, *, budget: str | None, known: dict[str, str] | None = None):
        clock, fetched = _Clock(), []
        monkeypatch.setattr(licitor, "time", clock)
        if budget is None:
            monkeypatch.delenv(licitor.SOURCE_BUDGET_ENV, raising=False)
        else:
            monkeypatch.setenv(licitor.SOURCE_BUDGET_ENV, budget)
        monkeypatch.setattr(licitor, "LicitorClient", lambda **kwargs: _Client(clock, fetched))
        monkeypatch.setattr(licitor, "_collect_list_sales", lambda client, max_pages, errors: _list_sales(count))
        monkeypatch.setattr(licitor, "TARGET_DEPARTMENTS", ("33",))
        return licitor.scrape_licitor_aquitaine_result(max_pages=1, known=known), fetched

    return run


def test_without_a_source_budget_every_changed_detail_page_is_read(scrape) -> None:
    result, fetched = scrape(5, budget=None)

    assert len(fetched) == 5
    assert result.coverage["details_deferred"] == 0
    assert not result.coverage.get("budget_exhausted")
    assert all(not sale.get("_detail_fetch_failed") for sale in result.sales)


def test_the_source_stops_reading_details_at_its_budget_and_emits_the_whole_list(scrape) -> None:
    # 25 s de budget, 10 s par fiche : trois fiches lues (t = 0, 10, 20), les trois autres reportées.
    result, fetched = scrape(6, budget="25")

    assert len(fetched) == 3
    assert len(result.sales) == 6  # toute la liste est émise : l'inventaire n'est pas amputé
    deferred = [sale for sale in result.sales if sale.get("source_detail_status") == "deferred"]
    assert len(deferred) == 3
    assert all(sale["_detail_fetch_failed"] for sale in deferred)
    assert result.coverage["budget_exhausted"] is True
    assert result.coverage["stop_reason"] == "source_budget_exhausted"
    assert (result.coverage["details_to_fetch"], result.coverage["details_deferred"]) == (6, 3)


def test_the_nearest_sales_are_read_first(scrape) -> None:
    result, fetched = scrape(6, budget="25")

    # La liste va du plus lointain (00) au plus proche (05) : les trois plus proches sont lus.
    assert sorted(url.rsplit("/", 1)[1] for url in fetched) == ["03.html", "04.html", "05.html"]
    read = {sale["source_url"] for sale in result.sales if sale.get("source_detail_status") != "deferred"}
    assert read == set(fetched)


def test_unchanged_listings_are_never_read_nor_deferred(scrape) -> None:
    sales = _list_sales(4)
    known = {sales[0]["source_url"]: common.listing_signature(sales[0]), sales[1]["source_url"]: common.listing_signature(sales[1])}

    result, fetched = scrape(4, budget="5", known=known)

    # Deux fiches inchangées reprises du catalogue ; des deux autres, une seule est lue avant le budget.
    assert len(fetched) == 1
    unchanged = [sale for sale in result.sales if sale.get("_known_unchanged")]
    assert len(unchanged) == 2
    assert all("source_detail_status" not in sale for sale in unchanged)
    assert result.coverage["details_deferred"] == 1


def test_a_deferred_listing_is_read_by_the_next_run_once_the_first_ones_are_known(scrape) -> None:
    first, _ = scrape(6, budget="25")
    read_first = {sale["source_url"] for sale in first.sales if sale.get("source_detail_status") != "deferred"}
    sales = {sale["source_url"]: sale for sale in _list_sales(6)}
    # Passage suivant : les fiches lues sont fraîches (signature connue), il reste les trois autres.
    known = {url: common.listing_signature(sales[url]) for url in read_first}

    second, fetched = scrape(6, budget="25", known=known)

    assert {url.rsplit("/", 1)[1] for url in fetched} == {"00.html", "01.html", "02.html"}
    assert second.coverage["details_deferred"] == 0
    assert not second.coverage.get("budget_exhausted")


def test_an_invalid_budget_is_ignored(scrape) -> None:
    result, fetched = scrape(3, budget="pas-un-nombre")

    assert len(fetched) == 3
    assert not result.coverage.get("budget_exhausted")


# --- lanceur planifié ---------------------------------------------------------------------------------


def test_the_scheduled_run_gives_licitor_a_budget_below_its_hard_kill(monkeypatch) -> None:
    run_id = "00000000-0000-0000-0000-000000000009"
    subprocess_calls = []

    class FakeDb:
        def execute(self, statement, params=None):
            if "returning source" in statement:
                return SimpleNamespace(fetchone=lambda: ("licitor",))
            if "select summary from public.auction_runs" in statement:
                return SimpleNamespace(fetchone=lambda: ({},))
            return SimpleNamespace(fetchone=lambda: None)

    monkeypatch.setattr(autonomous_runner, "load_settings", lambda: {"supabase_db_url": "postgresql://test"})
    monkeypatch.setattr(autonomous_runner, "_postgres_connect", lambda _url: nullcontext(FakeDb()))
    monkeypatch.setattr(autonomous_runner, "register_run", lambda _run_id: None)
    monkeypatch.setattr(autonomous_runner, "finish_source", lambda _db_url, _run_id: None)
    monkeypatch.setattr(
        autonomous_runner.subprocess,
        "run",
        lambda command, **kwargs: subprocess_calls.append((command, kwargs)) or SimpleNamespace(returncode=0),
    )

    autonomous_runner.execute(run_id)

    kwargs = subprocess_calls[0][1]
    assert kwargs["timeout"] == 50 * 60
    assert kwargs["env"][licitor.SOURCE_BUDGET_ENV] == str(50 * 60 - autonomous_runner.LICITOR_BUDGET_MARGIN_SECONDS)
    assert float(kwargs["env"][licitor.SOURCE_BUDGET_ENV]) < kwargs["timeout"]
