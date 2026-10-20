"""Vench : l'en-tête et le texte qui donnent la même surface ne sont pas deux lots (fiche 166573)."""

from decimal import Decimal

from src.normalize import _is_ambiguous_mixed_lot_surface, normalize_sale
from src.sources.vench import parse_vench_detail_html

HTML = """
<div id="page-heading"><h1>Appartement &bull; 20,46m² &bull; Le Vaudreuil</h1></div>
<p>Adresse</p><p>27100 <a>Le Vaudreuil</a></p>
<p>DATE DE L'AUDIENCE</p><strong>11/12/2026 à 10:00</strong>
<p>Mise à prix : 20 000 €</p>
<div class="descriptionContener"><p>Dans un immeuble en copropriété, lot n°12 : un appartement et un local
commercial. {surface} au 2ème étage.</p></div>
"""


def _sale(surface_sentence: str):
    raw = parse_vench_detail_html(
        HTML.format(surface=surface_sentence), "https://www.vench.fr/vente-166573-appartement-le-vaudreuil.html"
    )
    return normalize_sale(raw)


def test_the_same_value_in_the_heading_and_the_text_keeps_the_surface() -> None:
    sale = _sale("De 20,46 m²")

    assert sale.property_type == "mixed"
    assert sale.surface_m2 == Decimal("20.46")
    assert sale.app_surface_m2 == Decimal("20.46")
    assert "ambiguous_surface" not in sale.quality_flags


def test_two_different_values_still_mean_several_lots() -> None:
    sale = _sale("De 31,5 m²")

    assert sale.app_surface_m2 is None
    assert "ambiguous_surface" in sale.quality_flags


def test_the_lot_check_counts_distinct_values() -> None:
    assert not _is_ambiguous_mixed_lot_surface("mixed", "lot 3 : 20,46m² puis De 20,46 m²")
    assert not _is_ambiguous_mixed_lot_surface("mixed", "lot 3 : 1 200 m² puis 1200 m2")
    assert _is_ambiguous_mixed_lot_surface("mixed", "lot 3 : 20,46m² puis 30 m²")
