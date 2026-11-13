"""Sale nature and known amounts used by the public text checks (``display_evidence``).

Every helper accepts either an ``AuctionSale`` or the ``model_dump()`` mapping
that ``verify_display_claims`` receives.
"""

from __future__ import annotations

import re
from collections.abc import Mapping
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from typing import Any

from src.extraction_profiles import build_procedure_profile

PROPERTY_TYPE_LABELS = {
    "apartment": "appartement",
    "house": "maison",
    "building": "immeuble",
    "land": "terrain",
    "commercial": "local commercial",
    "parking": "stationnement",
    "mixed": "ensemble mixte",
}
JUDICIAL_FRAMEWORKS = {"judicial_seizure", "judicial_partition", "insolvency", "judicial"}
NON_JUDICIAL_SOURCES = {"notaires", "cessions_etat", "agrasc"}
VERIFIED_STATUSES = {"verified", "cross_checked"}
FIXED_PRICE_RE = re.compile(r"\bvente\s+au\s+prix\b|\bpas\s+d['’]\s*ench[eè]res?\b", re.I)
AMI_RE = re.compile(r"\bappel\s+[àa]\s+manifestation\s+d['’]\s*int[ée]r[êe]t\b", re.I)
INTERACTIVE_RE = re.compile(r"\bimmo[-\s]?interactif\b|\bvente\s+(?:notariale\s+)?interactive\b", re.I)
ADJUDICATION_RE = re.compile(r"\badjudication\b", re.I)
ONLINE_AUCTION_RE = re.compile(r"\bench[eè]res?\s+en\s+ligne\b|\bagora\s?store\b", re.I)


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


def sale_listing_text(sale: Any) -> str:
    """Title, source description and raw text of the listing (no PDF)."""
    return _listing_text(sale)


def state_auction_wording(sale: Any) -> str:
    """How a State sale « by auction » is named, from the listing's own words.

    The cessions source stores ``state_sale_method = adjudication`` for any
    « Vente aux enchères », including online Agorastore sales; « par
    adjudication » is only written when the listing says so (audit 03/11/2026).
    """
    text = _listing_text(sale)
    if ADJUDICATION_RE.search(text):
        return "par adjudication"
    procedure = _value(sale, "sale_procedure")
    if (isinstance(procedure, dict) and procedure.get("participation_mode") == "online") or ONLINE_AUCTION_RE.search(text):
        return "par enchères en ligne"
    return "aux enchères"


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
            "adjudication": f"cession immobilière de l'État {state_auction_wording(sale)}",
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


def positive_decimal(value: Any) -> Decimal | None:
    """Montant ou surface strictement positif et fini ; ``None`` pour tout le reste (booléens compris)."""
    if value is None or isinstance(value, bool):
        return None
    try:
        number = Decimal(str(value))
    except (InvalidOperation, ValueError):
        return None
    return number if number.is_finite() and number > 0 else None


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
        number = positive_decimal(candidate)
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

