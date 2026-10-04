import json
import stat
from datetime import date

import pytest

from src.sources.avoventes_history import inspect_avoventes_archive, main

URL = "https://avoventes.fr/ventes-passees?page=67"


def card(*, slug="bien-temoin", price="150 000 €", starting="100 000 €",
         when="3 juillet 2026 à 10h00", event="", sale_kind="Vente aux enchères"):
    return f"""<article data-link="/enchere/{slug}">
      <h2>{sale_kind} Maison</h2><p>Maison témoin</p>
      <p>1 rue Exemple 33000 Bordeaux</p>
      <p>Mise à prix initiale : {starting}</p><p>Adjugé : {price}</p>
      <p>Date de la vente : {when}</p><span>{event}</span>
    </article>"""


def inspect(cards, **kwargs):
    return inspect_avoventes_archive(
        "<h1>Ventes passées</h1>" + cards, page_url=URL,
        period_start=date(2023, 10, 3), as_of=date(2026, 10, 3), **kwargs,
    )


def test_archive_prices_stay_unpublished_and_do_not_infer_a_court():
    report = inspect(card())
    candidate, = report["candidates"]
    assert report["summary"]["price_pairs_to_review"] == 1
    assert candidate["starting_price_eur"] == "100000"
    assert candidate["adjudication_price_eur"] == "150000"
    assert candidate["sale_date"] == "2026-07-03T08:00:00+00:00"
    assert candidate["tribunal"] is None
    assert candidate["sale_venue_type"] == "unknown"
    assert candidate["candidate_grade"] == "C"
    assert candidate["review_status"] == "pending"
    assert candidate["finality_status"] == "unknown"
    assert not candidate["publication_eligible"] and not candidate["training_eligible"]
    assert len(candidate["source_content_hash"]) == 64
    assert report["summary"]["cross_source_unique_count"] is None
    assert not report["summary"]["coverage_complete"]


@pytest.mark.parametrize(("fields", "reason"), [
    ({"price": "Non indiqué"}, "missing_or_invalid_reported_price"),
    ({"price": "0 €"}, "missing_or_invalid_reported_price"),
    ({"starting": "0 €"}, "missing_or_invalid_starting_price"),
    ({"starting": "-100 000 €"}, "missing_or_invalid_starting_price"),
    ({"when": "3 juillet à 10h00"}, "missing_or_invalid_sale_date"),
    ({"when": "31 février 2026 à 10h00"}, "missing_or_invalid_sale_date"),
    ({"when": "3 juillet 2044 à 10h00"}, "sale_outside_requested_period"),
    ({"when": "1 janvier 2020 à 10h00"}, "sale_outside_requested_period"),
    ({"event": "Retirée"}, "non_adjudication_event_requires_review"),
    ({"event": "Non requise"}, "non_adjudication_event_requires_review"),
    ({"sale_kind": "Vente amiable"}, "amicable_sale_outside_scope"),
])
def test_unknown_invalid_or_conflicting_results_never_become_price_pairs(fields, reason):
    report = inspect(card(**fields))
    assert report["summary"]["price_pairs_to_review"] == 0
    assert reason in report["candidates"][0]["exclusion_reasons"]


def test_duplicates_are_counted_once_and_conflicting_prices_are_quarantined():
    exact = inspect(card() + card())
    assert exact["summary"]["distinct_source_rounds"] == 1
    assert exact["summary"]["duplicate_cards"] == 1
    conflicting = inspect(card() + card(price="170 000 €"))
    assert conflicting["summary"]["price_pairs_to_review"] == 0
    assert conflicting["candidates"][0]["exclusion_reasons"] == ["conflicting_archive_cards"]


def test_different_rounds_on_the_same_source_url_remain_distinct():
    report = inspect(card() + card(when="3 septembre 2026 à 10h00", event="Surenchère"))
    assert len(report["candidates"]) == 2
    assert "surenchere_mentioned" in report["candidates"][1]["quality_flags"]
    assert {row["finality_status"] for row in report["candidates"]} == {"unknown"}


def test_a_duplicate_cannot_hide_an_exclusion_or_a_surenchere_warning():
    report = inspect(card() + card(sale_kind="Vente amiable", event="Surenchère"))
    candidate, = report["candidates"]
    assert report["summary"]["price_pairs_to_review"] == 0
    assert "amicable_sale_outside_scope" in candidate["exclusion_reasons"]
    assert "surenchere_mentioned" in candidate["quality_flags"]


def test_outliers_and_small_starting_prices_are_flagged_without_silent_trimming():
    report = inspect(card(starting="500 €", price="100 000 €"))
    assert report["summary"]["price_pairs_to_review"] == 1
    flags = report["candidates"][0]["quality_flags"]
    assert "ratio_outlier_requires_review" in flags
    assert "below_current_licitor_starting_price_threshold" in flags


def test_only_an_observed_next_archive_page_is_exposed():
    report = inspect(card() + """
      <a href="?page=68">Suivant</a><a href="?page=66">Précédent</a>
      <a href="https://evil.example/ventes-passees?page=68">Piège</a>
      <a href="/recherche?page=68">Catalogue</a>
    """)
    assert report["next_page_urls"] == ["https://avoventes.fr/ventes-passees?page=68"]


@pytest.mark.parametrize("url", [
    "https://avoventes.fr/recherche", "https://evil.example/ventes-passees",
    "https://user:secret@avoventes.fr/ventes-passees", URL + "&page=68", URL + "&unknown=1",
])
def test_archive_scope_is_explicit(url):
    with pytest.raises(ValueError):
        inspect_avoventes_archive("<h1>Ventes passées</h1>" + card(), page_url=url,
                                 period_start=date(2023, 10, 3), as_of=date(2026, 10, 3))


def test_wrong_or_empty_page_does_not_claim_complete_collection():
    for html in ("<h1>Rechercher</h1>" + card(), "<h1>Ventes passées</h1>"):
        with pytest.raises(ValueError):
            inspect_avoventes_archive(html, page_url=URL, period_start=date(2023, 10, 3),
                                     as_of=date(2026, 10, 3))


def test_local_import_keeps_private_output_and_never_overwrites(tmp_path, capsys):
    capture = tmp_path / "capture.html"
    output = tmp_path / "diagnostic.json"
    capture.write_text("<h1>Ventes passées</h1>" + card())
    args = ["--html", str(capture), "--page-url", URL, "--period-start", "2023-10-03",
            "--as-of", "2026-10-03", "--output", str(output)]
    assert main(args) == 0
    assert stat.S_IMODE(output.stat().st_mode) == 0o600
    assert "address" not in capsys.readouterr().out
    assert json.loads(output.read_text())["summary"]["published_results"] == 0
    with pytest.raises(FileExistsError):
        main(args)
