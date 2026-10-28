"""Rattachement d'une annonce sans voie à la même vente publiée ailleurs avec son adresse.

Vench et Petites Affiches ne donnent souvent que la commune (« UN APPARTEMENT à Nice »), alors que Licitor,
Avoventes, Info-Enchères ou Enchères immobilières publient la même vente avec l'adresse et l'avocat. Les clés de
``src.dedupe`` exigent une voie numérotée (adresse), ou le même tribunal, jour et prix à l'euro près avec un signal
fort (clé stricte, que le balayage écarte pour Vench et Petites Affiches) : elles ne rapprochent presque jamais
ces annonces.

La règle ci-dessous n'agit que pour une annonce dont l'adresse se réduit à la commune (``street_class`` = ``none``)
et seulement vers une vente d'une autre source qui a une voie. Tout doit concorder :

* même tribunal (code canonique) ;
* même jour d'audience (jour civil à Paris) ;
* même commune : même code INSEE (géocodé, ou résolu sans ambiguïté par ``find_commune`` à partir du nom et du
  code postal, ou du nom unique dans le département), ou même nom de commune normalisé avec le même code postal ;
* mise à prix à 1 % près ;
* type de bien compatible.

Tribunal inconnu d'un seul côté : la paire reste acceptée si tout le reste concorde strictement, soit même INSEE
(connu ou résolu), même jour, même mise à prix à l'euro près, type compatible. Deux tribunaux connus doivent être
égaux ; deux tribunaux inconnus ne rapprochent rien. Cela ne change pas l'attribution du tribunal des ventes.

Un candidat ambigu ne rapproche rien : l'annonce doit avoir un seul candidat, et la vente un seul rapprochement.
Les gardes de ``src.dedupe`` s'appliquent en plus (annonces Vench / Petites Affiches de numéros différents,
multi-lots, numéros de lot, surfaces très éloignées).

La vente qui a l'adresse garde son adresse, sa position et tous ses champs : l'annonce sans voie n'apporte que ce
qui manque (avocat, contact, pièces, heure d'audience, ...), jamais de coordonnées ni de score.
"""

from __future__ import annotations

from copy import deepcopy
from typing import Any

from src.dedupe import (
    _city_from_address,
    _civil_day,
    _distinct_shared_listings,
    _is_empty,
    _is_multi_lot,
    _locality,
    _merge_into,
    _mergeable_fields,
    _postal_code_from_text,
    _prices_close,
    _surface_for_comparison,
    _timed_same_day_sale_date,
    _whole_euros,
    street_class,
)
from src.models import AuctionSale
from src.municipality_location import find_commune
from src.normalize import clean_text
from src.reference_data.names import commune_lookup_name

STREETLESS_CONFIDENCE = "streetless"
STREETLESS_PRICE_TOLERANCE = 0.01
_SURFACE_VETO = 0.2
_UNKNOWN_COURTS = frozenset({"", "other", "unknown"})
_GENERIC_TYPES = frozenset({"", "other", "unknown", "autre", "mixed"})

# Ce que l'annonce sans voie n'apporte jamais : position (un centre de commune n'est pas l'adresse) et valeurs
# calculées à partir d'une annonce pauvre. Ces champs reprennent ceux de la vente qui a l'adresse.
_NEVER_IMPORTED = (
    "latitude",
    "longitude",
    "quality_flags",
    "score_factors",
    "score_version",
    "score_confidence",
    "investment_score",
    "investment_summary",
)
# Fusionnés en liste ou en dictionnaire par ``_merge_into`` (ajout, pas d'écrasement) : hors du rétablissement.
_MERGED_COLLECTIONS = frozenset({"documents", "visit_dates", "raw_payload", "sale_date", *_NEVER_IMPORTED})
_NOT_RECORDED_AS_CONFLICT = frozenset({"title", "description"})


def _court(sale: AuctionSale) -> str | None:
    code = (clean_text(sale.tribunal_code) or "").lower()
    return None if code in _UNKNOWN_COURTS else code


def _insee(sale: AuctionSale) -> str | None:
    geocode = sale.raw_payload.get("geocode") if isinstance(sale.raw_payload, dict) else None
    if isinstance(geocode, dict) and geocode.get("accepted") is True and geocode.get("citycode"):
        return str(geocode["citycode"]).strip().upper() or None
    return None


def _commune_name(sale: AuctionSale) -> str:
    """Nom de commune normalisé, sans département entre parenthèses ni arrondissement (« Paris 8ème » : paris)."""
    address = clean_text(sale.address)
    postal_code = clean_text(sale.postal_code) or (_postal_code_from_text(address) if address else None)
    city = clean_text(sale.city) or (_city_from_address(address, postal_code) if address else None)
    return commune_lookup_name(city)


def _resolved_insee(sale: AuctionSale) -> str | None:
    """Code INSEE de la commune d'après le nom et le code postal (ou le nom unique du département).

    ``find_commune`` ne renvoie une commune que si elle est unique : ambigu, le résultat est vide.
    """
    commune = find_commune(sale.city, sale.postal_code, sale.department)
    return str(commune["code_insee"]).strip().upper() if commune else None


def _commune_insee(sale: AuctionSale) -> str | None:
    """Code INSEE géocodé, sinon résolu par le référentiel des communes."""
    return _insee(sale) or _resolved_insee(sale)


def _same_insee(first: AuctionSale, second: AuctionSale) -> bool:
    first_insee, second_insee = _commune_insee(first), _commune_insee(second)
    return bool(first_insee and first_insee == second_insee)


def same_commune(first: AuctionSale, second: AuctionSale) -> bool:
    """Même code INSEE (géocodé ou résolu), ou même nom de commune normalisé avec le même code postal."""
    if _same_insee(first, second):
        return True
    (first_postal, _), (second_postal, _) = _locality(first), _locality(second)
    first_name, second_name = _commune_name(first), _commune_name(second)
    return bool(first_postal and first_postal == second_postal and first_name and first_name == second_name)


def types_compatible(first: AuctionSale, second: AuctionSale) -> bool:
    """Types identiques, ou l'un des deux vague (autre, inconnu, mixte). Un parking n'est que parking."""
    left, right = (first.property_type or "").lower(), (second.property_type or "").lower()
    if left == right:
        return True
    if "parking" in (left, right):
        return False
    return left in _GENERIC_TYPES or right in _GENERIC_TYPES


def core_match(streetless: AuctionSale, other: AuctionSale) -> bool:
    """Les concordances (tribunal, jour, commune, mise à prix, type), sans les gardes d'exclusion."""
    day = _civil_day(streetless.sale_date)
    if day is None or day != _civil_day(other.sale_date):
        return False
    if not _prices_close(streetless.starting_price_eur, other.starting_price_eur, STREETLESS_PRICE_TOLERANCE):
        return False
    if not types_compatible(streetless, other):
        return False
    first_court, second_court = _court(streetless), _court(other)
    if first_court and second_court:
        return first_court == second_court and same_commune(streetless, other)
    if first_court or second_court:
        # Tribunal inconnu d'un seul côté : tout le reste doit concorder strictement.
        price = _whole_euros(streetless.starting_price_eur)
        return price is not None and price == _whole_euros(other.starting_price_eur) and _same_insee(streetless, other)
    return False


def _vetoed(streetless: AuctionSale, anchor: AuctionSale) -> bool:
    """Un seul désaccord connu écarte la paire (et ne la rend pas ambiguë)."""
    if streetless.source_name == anchor.source_name:
        return True
    if _distinct_shared_listings(streetless, anchor):
        return True
    if _is_multi_lot(streetless) or _is_multi_lot(anchor):
        return True
    for key in ("lot_number", "lot_id"):
        first_lot, second_lot = streetless.raw_payload.get(key), anchor.raw_payload.get(key)
        if first_lot and second_lot and str(first_lot) != str(second_lot):
            return True
    first_surface, second_surface = _surface_for_comparison(streetless), _surface_for_comparison(anchor)
    if first_surface and second_surface:
        gap = abs(float(first_surface) - float(second_surface)) / max(float(first_surface), float(second_surface))
        if gap > _SURFACE_VETO:
            return True
    return False


def merge_streetless_sales(sales: list[AuctionSale]) -> list[AuctionSale]:
    """Rattache chaque annonce sans voie à l'unique vente qui a sa voie et concorde, sinon ne fait rien."""
    by_day: dict[Any, list[AuctionSale]] = {}
    for sale in sales:
        if (day := _civil_day(sale.sale_date)) is not None:
            by_day.setdefault(day, []).append(sale)

    candidates: dict[int, list[AuctionSale]] = {}
    suitors: dict[int, list[AuctionSale]] = {}
    for bucket in by_day.values():
        streetless = [sale for sale in bucket if street_class(sale) == "none"]
        for sale in streetless:
            matches = [other for other in bucket if other is not sale and core_match(sale, other)]
            candidates[id(sale)] = matches
            for other in matches:
                suitors.setdefault(id(other), []).append(sale)

    merged_away: set[int] = set()
    for bucket in by_day.values():
        for sale in bucket:
            matches = candidates.get(id(sale))
            if matches is None or len(matches) != 1:
                continue
            anchor = matches[0]
            if id(anchor) in merged_away or len(suitors.get(id(anchor), [])) != 1:
                continue
            if street_class(anchor) != "street" or _vetoed(sale, anchor):
                continue
            absorb_streetless(anchor, sale)
            merged_away.add(id(sale))
    return [sale for sale in sales if id(sale) not in merged_away]


def absorb_streetless(anchor: AuctionSale, streetless: AuctionSale) -> AuctionSale:
    """Fusionne ``streetless`` dans ``anchor`` en ne remplissant que les champs vides de ``anchor``."""
    before = {
        field: getattr(anchor, field)
        for field in _mergeable_fields()
        if field not in _MERGED_COLLECTIONS and not _is_empty(getattr(anchor, field))
    }
    never_imported = {field: deepcopy(getattr(anchor, field)) for field in _NEVER_IMPORTED}
    sale_date_before = anchor.sale_date
    conflicts_before = deepcopy(anchor.raw_payload.get("source_conflicts"))

    _merge_into(anchor, streetless, confidence=STREETLESS_CONFIDENCE)

    for field, value in before.items():
        if getattr(anchor, field) != value:
            setattr(anchor, field, value)
    for field, value in never_imported.items():
        setattr(anchor, field, value)
    # Même jour, une seule heure connue : l'heure d'audience manquante est le seul écart accepté.
    if not _is_empty(sale_date_before):
        anchor.sale_date = _timed_same_day_sale_date(sale_date_before, streetless.sale_date) or sale_date_before

    if conflicts_before is None:
        anchor.raw_payload.pop("source_conflicts", None)
    else:
        anchor.raw_payload["source_conflicts"] = conflicts_before
    _record_kept_values(anchor, streetless, before)
    return anchor


def _record_kept_values(anchor: AuctionSale, streetless: AuctionSale, before: dict[str, Any]) -> None:
    """Garde la trace des valeurs de l'annonce sans voie qui diffèrent de celles, conservées, de la vente."""
    conflicts = anchor.raw_payload.setdefault("source_conflicts", [])
    for field, kept in before.items():
        alternative = getattr(streetless, field)
        if field in _NOT_RECORDED_AS_CONFLICT or _is_empty(alternative) or alternative == kept:
            continue
        if isinstance(kept, (list, dict)):
            continue
        conflict = {
            "field": field,
            "selected": str(kept),
            "observed_primary": str(kept),
            "alternative": str(alternative),
            "selected_source": anchor.source_url,
            "alternative_source": streetless.source_url,
            "observed_primary_source": anchor.source_url,
        }
        if conflict not in conflicts:
            conflicts.append(conflict)
    if not conflicts:
        anchor.raw_payload.pop("source_conflicts", None)
