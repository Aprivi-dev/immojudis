"""Petites Affiches ne publie que le jour : la vente est marquée « date seule », jamais une heure fictive.

La date est stockée à minuit UTC (convention des dates sans heure), qui se lit 01:00 ou 02:00 à Paris.
Le marqueur ``raw_payload.date_precision = "day"`` est celui que lisent l'admission, la rétention SQL et
``src/lib/sale-countdown.ts`` ; l'affichage (liste, fiche, export) l'ignore ou le déduit de minuit UTC.
"""

from datetime import UTC, datetime
from pathlib import Path

import pytest

from src.admission import catalogue_expiry_deadline, is_date_only
from src.normalize import normalize_sale
from src.sources.petites_affiches import parse_petites_affiches_detail_html, parse_petites_affiches_html

FIXTURES = Path(__file__).parent / "fixtures"

CARD = """
<div class="annonce_lot_1 col-md-6">
  <div class="annonceListe">
    <div class="imgList">
      <a href="/encheres-immobilieres/vente/immobiliere/judiciaire/appartement-bordeaux-1.html"><img src="/i.jpg" /></a>
      <div class="miseAPrix">Mise a Prix : <strong>80 000</strong> €</div>
    </div>
    <div class="titreVente">
      <a href="/encheres-immobilieres/vente/immobiliere/judiciaire/appartement-bordeaux-1.html">
        UN APPARTEMENT a BORDEAUX <br /><strong>Ref. : 123 - Appartement</strong>
      </a>
    </div>
    <div class="lieuVente"><strong>TJ DE BORDEAUX</strong></div>
    <div class="adresse"><strong class="lot-adresse">Bordeaux</strong></div>
    <div class="dateVente"><strong>{date}</strong></div>
    <div class="infos">51 m² - 33000 Bordeaux</div>
  </div>
</div>
"""


def _card_sale(date: str):
    raw = parse_petites_affiches_html(CARD.format(date=date), fallback_department="33")[0]
    return normalize_sale(raw)


def test_a_card_that_only_gives_the_day_is_marked_date_only() -> None:
    sale = _card_sale("24/06/2026")

    assert sale.sale_date == datetime(2026, 6, 24, tzinfo=UTC)
    assert sale.raw_payload["date_precision"] == "day"


def test_a_card_with_an_hour_keeps_its_hour_and_is_not_marked() -> None:
    sale = _card_sale("24/06/2026 à 14h00")

    assert sale.sale_date == datetime(2026, 6, 24, 12, 0, tzinfo=UTC)  # 14 h à Paris, en été
    assert "date_precision" not in sale.raw_payload


def test_a_date_only_petites_affiches_sale_stays_listed_for_the_whole_paris_day() -> None:
    sale = _card_sale("24/06/2026")

    deadline = catalogue_expiry_deadline(sale)

    # Fin du 24 juin à Paris (22:00 UTC le 24 en été), pas minuit UTC.
    assert deadline is not None and deadline.astimezone(UTC) >= datetime(2026, 6, 24, 21, 59, tzinfo=UTC)


def test_a_stored_row_without_the_marker_is_still_read_as_date_only_from_its_source_text() -> None:
    # Lignes enregistrées avant le marqueur : raw_payload.sale_date garde le texte source sans heure.
    assert is_date_only("24/06/2026", None)
    assert is_date_only("24/06/2026", "day")
    assert not is_date_only("24/06/2026 à 14h00", None)
    assert not is_date_only("2026-06-24T14:00:00+02:00", None)


@pytest.mark.parametrize("fixture", sorted(p.name for p in FIXTURES.glob("petites_affiches_fiche_*.html")))
def test_detail_pages_mark_exactly_the_dates_that_have_no_hour(fixture: str) -> None:
    html = (FIXTURES / fixture).read_text(encoding="utf-8")
    raw = parse_petites_affiches_detail_html(html, "https://www.petitesaffiches.fr/encheres-immobilieres/vente/immobiliere/j/x-1.html")

    sale = normalize_sale(raw)

    if sale.sale_date is None:
        assert "date_precision" not in sale.raw_payload
        return
    at_utc_midnight = (sale.sale_date.hour, sale.sale_date.minute) == (0, 0)
    assert (sale.raw_payload.get("date_precision") == "day") == at_utc_midnight
