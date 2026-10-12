"""Canonical facts and sale nature for the public display synthesis.

The display prompt receives these values in a ``[FAITS CANONIQUES]`` block at
the top of its context, and the display checks use the same helpers so that
the prompt and the verification never disagree on what is known.

Every helper accepts either an ``AuctionSale`` or the ``model_dump()`` mapping
that ``verify_display_claims`` receives.
"""

from __future__ import annotations

import re
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import date, datetime
from decimal import Decimal, InvalidOperation
from typing import Any

from src.extraction_profiles import build_procedure_profile

CANONICAL_FACTS_HEADER = "[FAITS CANONIQUES]"

PROPERTY_TYPE_LABELS = {
    "apartment": "appartement",
    "house": "maison",
    "building": "immeuble",
    "land": "terrain",
    "commercial": "local commercial",
    "parking": "stationnement",
    "mixed": "ensemble mixte",
}
OCCUPANCY_LABELS = {
    "vacant": "libre",
    "occupied": "occupé",
    "rented": "loué",
    "owner_occupied": "occupé par le propriétaire",
    "squatted": "occupé sans droit ni titre",
}
SURFACE_KIND_LABELS = {
    "carrez": "loi Carrez",
    "habitable": "habitable",
    "land": "terrain",
    "built": "bâtie ou de plancher",
}
JUDICIAL_FRAMEWORKS = {"judicial_seizure", "judicial_partition", "insolvency", "judicial"}
NON_JUDICIAL_SOURCES = {"notaires", "cessions_etat", "agrasc"}
VERIFIED_STATUSES = {"verified", "cross_checked"}
FIXED_PRICE_RE = re.compile(r"\bvente\s+au\s+prix\b|\bpas\s+d['’]\s*ench[eè]res?\b", re.I)
AMI_RE = re.compile(r"\bappel\s+[àa]\s+manifestation\s+d['’]\s*int[ée]r[êe]t\b", re.I)
INTERACTIVE_RE = re.compile(r"\bimmo[-\s]?interactif\b|\bvente\s+(?:notariale\s+)?interactive\b", re.I)


@dataclass(frozen=True)
class SaleNature:
    """What the synthesis may call the sale.

    ``judicial_terms_allowed`` covers « judiciaire » and « tribunal »;
    ``starting_price_term_allowed`` covers « mise à prix ».  ``unknown``
    allows both: the checks only reject a vocabulary that a known nature
    excludes.
    """

    code: str
    label: str | None
    judicial_terms_allowed: bool = True
    starting_price_term_allowed: bool = True
    price_label: str = "Mise à prix"


def _value(sale: Any, key: str) -> Any:
    if isinstance(sale, Mapping):
        return sale.get(key)
    return getattr(sale, key, None)


def _payload(sale: Any) -> dict[str, Any]:
    payload = _value(sale, "raw_payload")
    return payload if isinstance(payload, dict) else {}


def _fold(value: Any) -> str:
    return str(value or "").strip().casefold()


def _listing_text(sale: Any) -> str:
    """Source listing text only: a PDF clause cannot change the sale nature."""
    payload = _payload(sale)
    parts = (
        _value(sale, "title"),
        payload.get("source_description"),
        payload.get("description"),
        _value(sale, "description"),
        _value(sale, "raw_text"),
    )
    return " ".join(str(part) for part in parts if isinstance(part, str))


def _transaction_type(sale: Any) -> str:
    features = _payload(sale).get("source_property_features")
    conditions = features.get("sale_conditions") if isinstance(features, dict) else None
    return _fold(conditions.get("transaction_type")) if isinstance(conditions, dict) else ""


def _procedure_family(sale: Any) -> str:
    """Reuse the source procedure profile for sales without a usable venue."""
    view = dict(_payload(sale))
    for key in ("sale_procedure", "sale_venue_type", "sale_legal_framework", "sale_verification_status"):
        value = _value(sale, key)
        if value and value not in ("unknown", "pending"):
            view[key] = value
    for key in ("title", "raw_text", "source_name"):
        view.setdefault(key, _value(sale, key))
    try:
        return str(build_procedure_profile(view).get("family") or "unknown")
    except Exception:  # pragma: no cover - a profile failure must not block a display
        return "unknown"


def sale_nature(sale: Any) -> SaleNature:
    """Resolve the sale nature conservatively.

    A non-judicial nature needs strong evidence (official source, verified
    venue or explicit listing wording), because it forbids judicial words in
    the synthesis.  A judicial nature only needs a judicial venue.
    """
    source = _fold(_value(sale, "source_name"))
    venue = _fold(_value(sale, "sale_venue_type"))
    framework = _fold(_value(sale, "sale_legal_framework"))
    verified = _fold(_value(sale, "sale_verification_status")) in VERIFIED_STATUSES
    procedure = _value(sale, "sale_procedure")
    state_method = _fold(procedure.get("state_sale_method")) if isinstance(procedure, dict) else ""
    text = _listing_text(sale)

    if source == "agrasc":
        return SaleNature(
            "agrasc",
            "vente d'un bien confisqué, organisée pour l'AGRASC (pas une vente au tribunal)",
            judicial_terms_allowed=False,
        )
    if source == "cessions_etat" or framework == "state_sale" or (venue == "state" and verified):
        if AMI_RE.search(text):
            return SaleNature(
                "state_ami",
                "appel à manifestation d'intérêt de l'État (pas d'enchères)",
                judicial_terms_allowed=False,
                starting_price_term_allowed=False,
                price_label="Prix",
            )
        method = {
            "adjudication": "cession immobilière de l'État par adjudication",
            "appel_offres": "cession immobilière de l'État par appel d'offres",
            "cession_amiable": "cession amiable d'un bien de l'État",
        }.get(state_method, "cession immobilière de l'État")
        return SaleNature(
            "state",
            method,
            judicial_terms_allowed=False,
            price_label="Mise à prix" if state_method == "adjudication" else "Prix",
        )
    notarial = source == "notaires" or venue == "notary" or framework == "voluntary_notarial"
    if FIXED_PRICE_RE.search(text) and (notarial or venue != "tribunal"):
        return SaleNature(
            "fixed_price",
            "vente au prix, sans enchères",
            judicial_terms_allowed=False,
            starting_price_term_allowed=False,
            price_label="Prix",
        )
    if notarial:
        if framework in JUDICIAL_FRAMEWORKS:
            return SaleNature("notarial_judicial", "vente aux enchères devant notaire, ordonnée en justice")
        transaction = _transaction_type(sale)
        if transaction == "vni" or INTERACTIVE_RE.search(text):
            return SaleNature(
                "notarial_interactive",
                "vente notariale interactive (offres en ligne)",
                judicial_terms_allowed=False,
                price_label="Première offre possible",
            )
        if transaction == "vae":
            return SaleNature("notarial_auction", "vente aux enchères notariale", judicial_terms_allowed=False)
        return SaleNature("notarial", "vente notariale", judicial_terms_allowed=False)
    if venue == "tribunal" or framework in JUDICIAL_FRAMEWORKS:
        return SaleNature("judicial", _judicial_label(sale))
    family = _procedure_family(sale)
    if family == "judicial":
        return SaleNature("judicial", _judicial_label(sale))
    return SaleNature("unknown", None)


def _judicial_label(sale: Any) -> str:
    tribunal = str(_value(sale, "tribunal") or "").strip()
    return f"vente judiciaire aux enchères ({tribunal})" if tribunal else "vente judiciaire aux enchères"


def _decimal(value: Any) -> Decimal | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        number = Decimal(str(value))
    except (InvalidOperation, ValueError):
        return None
    return number if number.is_finite() and number > 0 else None


def format_area(value: Any) -> str | None:
    number = _decimal(value)
    if number is None:
        return None
    text = format(number.quantize(Decimal("0.01")).normalize(), "f")
    return f"{text.replace('.', ',')} m²"


def format_money(value: Any) -> str | None:
    number = _decimal(value)
    if number is None:
        return None
    whole = number.quantize(Decimal("1"))
    if whole != number:
        return f"{number.quantize(Decimal('0.01')):,.2f} €".replace(",", " ").replace(".", ",")
    return f"{int(whole):,} €".replace(",", " ")


def format_sale_date(value: Any) -> str | None:
    if isinstance(value, str):
        try:
            value = datetime.fromisoformat(value)
        except ValueError:
            return None
    if isinstance(value, datetime):
        value = value.date()
    return value.strftime("%d/%m/%Y") if isinstance(value, date) else None


def known_offer_amounts(sale: Any) -> list[Decimal]:
    """Starting price plus offer/price amounts structured from the source."""
    payload = _payload(sale)
    candidates: list[Any] = [_value(sale, "starting_price_eur"), payload.get("starting_price_eur")]
    features = payload.get("source_property_features")
    if isinstance(features, dict):
        for block in ("sale_conditions", "sale", "prices"):
            values = features.get(block)
            if isinstance(values, dict):
                candidates.extend(
                    values.get(key) for key in ("starting_price_eur", "first_offer_eur", "last_offer_eur", "price_eur")
                )
    amounts: list[Decimal] = []
    for candidate in candidates:
        number = _decimal(candidate)
        if number is not None and number not in amounts:
            amounts.append(number)
    return amounts


def energy_classes(sale: Any) -> tuple[str | None, str | None]:
    payload = _payload(sale)
    for key in ("source_energy_diagnostics", "pdf_energy_diagnostics"):
        diagnostics = payload.get(key)
        if not isinstance(diagnostics, dict):
            continue
        dpe = str(diagnostics.get("dpe_class") or "").strip().upper() or None
        ges = str(diagnostics.get("ges_class") or "").strip().upper() or None
        dpe = dpe if dpe and re.fullmatch(r"[A-G]", dpe) else None
        ges = ges if ges and re.fullmatch(r"[A-G]", ges) else None
        if dpe or ges:
            return dpe, ges
    return None, None


def _retained_surface(sale: Any) -> tuple[str, str] | None:
    app_surface = format_area(_value(sale, "app_surface_m2"))
    if app_surface:
        kind = SURFACE_KIND_LABELS.get(_fold(_value(sale, "app_surface_kind")), "principale")
        return app_surface, kind
    surface = format_area(_value(sale, "surface_m2"))
    if not surface:
        return None
    for field, kind in (("carrez_surface_m2", "loi Carrez"), ("habitable_surface_m2", "habitable")):
        if _decimal(_value(sale, field)) == _decimal(_value(sale, "surface_m2")):
            return surface, kind
    if _fold(_value(sale, "property_type")) == "land":
        return surface, "terrain"
    return surface, "principale"


def _annexes(sale: Any) -> list[str]:
    annexes = [
        label
        for field, label in (
            ("has_garden", "jardin"),
            ("has_terrace", "terrasse"),
            ("has_garage", "garage"),
            ("has_pool", "piscine"),
        )
        if _value(sale, field) is True
    ]
    parking = _value(sale, "parking_count")
    if isinstance(parking, int) and parking > 0 and not (parking == 1 and "garage" in annexes):
        annexes.append(f"{parking} stationnement{'s' if parking > 1 else ''}")
    return annexes


def canonical_display_facts(sale: Any) -> list[tuple[str, str]]:
    """Known facts, in the order the synthesis presents them."""
    facts: list[tuple[str, str]] = []
    nature = sale_nature(sale)
    facts.append(
        (
            "NATURE_VENTE",
            nature.label or "non déterminée : ne qualifie pas la nature de la vente",
        )
    )
    property_type = PROPERTY_TYPE_LABELS.get(_fold(_value(sale, "property_type")))
    if property_type:
        facts.append(("Type de bien", property_type))
    city = str(_value(sale, "city") or "").strip()
    postal_code = str(_value(sale, "postal_code") or _value(sale, "department") or "").strip()
    if city:
        facts.append(("Commune", f"{city} ({postal_code})" if postal_code else city))
    sale_date = format_sale_date(_value(sale, "sale_date"))
    if sale_date:
        facts.append(("Date de vente", sale_date))
    amounts = known_offer_amounts(sale)
    if amounts:
        facts.append((nature.price_label, format_money(amounts[0]) or ""))
    retained = _retained_surface(sale)
    if retained:
        facts.append(("Surface retenue", f"{retained[0]} ({retained[1]})"))
    retained_value = retained[0] if retained else None
    for field, label in (
        ("habitable_surface_m2", "Surface habitable"),
        ("carrez_surface_m2", "Surface loi Carrez"),
        ("land_surface_m2", "Surface du terrain"),
    ):
        value = format_area(_value(sale, field))
        if value and value != retained_value:
            facts.append((label, value))
    for field, label in (
        ("rooms_count", "Pièces"),
        ("bedrooms_count", "Chambres"),
        ("bathrooms_count", "Salles d'eau ou de bain"),
    ):
        value = _value(sale, field)
        if isinstance(value, int) and not isinstance(value, bool) and value > 0:
            facts.append((label, str(value)))
    annexes = _annexes(sale)
    if annexes:
        facts.append(("Annexes", ", ".join(annexes)))
    dpe, ges = energy_classes(sale)
    if dpe:
        facts.append(("DPE", f"classe {dpe}"))
    if ges:
        facts.append(("GES", f"classe {ges}"))
    occupancy = OCCUPANCY_LABELS.get(_fold(_value(sale, "occupancy_status")))
    if occupancy:
        facts.append(("Occupation", occupancy))
    return [(label, value) for label, value in facts if value]


def canonical_facts_block(sale: Any) -> str:
    """The block placed first in every display context.

    Items end with a full stop so the block stays readable once the context
    builder flattens whitespace.
    """
    lines = [f"- {label} : {value}." for label, value in canonical_display_facts(sale)]
    return "\n".join([CANONICAL_FACTS_HEADER, *lines])
