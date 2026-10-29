from __future__ import annotations

import hashlib
import re
import unicodedata
from collections.abc import Iterable
from copy import deepcopy
from datetime import UTC, date, datetime, time
from typing import Any
from zoneinfo import ZoneInfo

from src.models import AuctionSale
from src.normalize import clean_text, normalize_documents

PARIS = ZoneInfo("Europe/Paris")
_STREET_NUMBER_RE = re.compile(r"\d")
_POSTAL_CODE_RE = re.compile(r"\b(\d{5})\b")
_TRAILING_DEPARTMENT_RE = re.compile(r"\s*\((?:\d{2}|2[AB]|97\d)\)\s*$", re.IGNORECASE)

PRIMARY_SOURCE_PRIORITY = {
    "avoventes": 0,
    "info_encheres": 1,
    "licitor": 2,
    "vench": 3,
    "petites_affiches": 4,
    "encheres_immobilieres": 5,
    "encheres_publiques": 6,
    "notaires": 7,
    "agrasc": 8,
    "cessions_etat": 9,
}

STREET_TOKEN_REPLACEMENTS = (
    (r"\b(?:av|aven)\b", "avenue"),
    (r"\bbd\b", "boulevard"),
    (r"\b(?:r|ruee)\b", "rue"),
    (r"\b(?:all|alle)\b", "allee"),
    (r"\bimp\b", "impasse"),
    (r"\bch\b", "chemin"),
    (r"\brte\b", "route"),
    (r"\bpl\b", "place"),
    (r"\bsq\b", "square"),
    (r"\bfg\b", "faubourg"),
    (r"\bst\b", "saint"),
    (r"\bste\b", "sainte"),
)

FRENCH_ADDRESS_PARTICLES_RE = re.compile(r"\b(?:d|de|du|des|la|le|les|l)\b")

RICHNESS_FIELDS = (
    "address",
    "postal_code",
    "tribunal",
    "property_type",
    "surface_m2",
    "habitable_surface_m2",
    "land_surface_m2",
    "carrez_surface_m2",
    "app_surface_m2",
    "rooms_count",
    "bedrooms_count",
    "bathrooms_count",
    "parking_count",
    "occupancy_status",
    "lawyer_name",
    "lawyer_contact",
    "latitude",
    "longitude",
    "investment_score",
    "investment_summary",
)


def compute_content_hash(sale: AuctionSale) -> str:
    parts = [
        clean_text(sale.address) or "",
        clean_text(sale.city) or "",
        sale.sale_date.isoformat() if sale.sale_date else "",
        str(sale.starting_price_eur or ""),
    ]
    normalized = "|".join(part.lower() for part in parts)
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()


def dedupe_sales(sales: Iterable[AuctionSale]) -> list[AuctionSale]:
    return merge_duplicate_sales(sales)


# Balayage des lignes déjà publiées : la clé de repli stricte n'y sert que hors Vench / Petites Affiches
# (l'identifiant d'annonce commun prouve l'identité de ces deux sources, et leur recoupement par la clé
# stricte n'est pas retenu), et jamais sur un jour et un prix partagés par plus de 5 annonces : ce sont
# des lots distincts d'une même audience.
SWEEP_STRICT_EXCLUDED_SOURCES = frozenset({"vench", "petites_affiches"})
SWEEP_STRICT_MAX_GROUP = 5


def merge_duplicate_sales(
    sales: Iterable[AuctionSale],
    *,
    strict_fallback: bool = True,
    strict_excluded_sources: frozenset[str] = frozenset(),
    strict_max_group: int | None = None,
    streetless_fallback: bool = True,
) -> list[AuctionSale]:
    """Fusionne les observations d'un même bien.

    ``strict_fallback=False`` désactive la clé de repli stricte (tribunal, jour, prix, signal fort).
    ``streetless_fallback=False`` désactive le rattachement d'une annonce sans voie (``src.dedupe_streetless``).
    Le balayage qui relit les lignes déjà publiées la restreint plutôt que de la couper :
    ``strict_excluded_sources`` écarte les annonces de ces sources de la clé stricte, et
    ``strict_max_group`` écarte les (jour, prix) partagés par plus d'annonces que ce plafond.
    """
    by_source_url: dict[str, AuctionSale] = {}
    for sale in sales:
        _ensure_observation_metadata(sale)
        if not sale.content_hash:
            sale.content_hash = compute_content_hash(sale)
        existing = by_source_url.get(sale.source_url)
        if existing is None:
            by_source_url[sale.source_url] = sale
        elif existing is sale:
            continue
        elif _is_richer(sale, existing):
            # Keep the richer observation but fold the older one in: its documents,
            # observations and fields must not disappear with it.
            by_source_url[sale.source_url] = sale
            _merge_into(sale, existing, confidence="source_url")
        else:
            _merge_into(existing, sale, confidence="source_url")

    # Un identifiant d'annonce commun (Vench / Petites Affiches) prouve l'identité : il passe AVANT le hash de
    # contenu et l'adresse. Sinon, pour les lots d'un même immeuble (même adresse, même jour, même mise à prix),
    # ces clés rapprochent n'importe quelle ligne de l'autre source, pas celle du même numéro d'annonce, et
    # un groupe entier de lots finit en une seule fusion trop grosse pour être appliquée.
    by_hash: dict[str, AuctionSale] = {}
    passthrough: list[AuctionSale] = []
    for sale in _merge_by_shared_listing_id(list(by_source_url.values())):
        key = sale.content_hash or compute_content_hash(sale)
        if not _has_strong_dedupe_signal(sale):
            sale.dedupe_confidence = sale.dedupe_confidence or "source_url_only"
            passthrough.append(sale)
            continue
        existing = by_hash.get(key)
        if existing is None:
            by_hash[key] = sale
            sale.dedupe_confidence = sale.dedupe_confidence or "content_hash"
            continue
        if not _same_property(existing, sale):
            passthrough.append(sale)
            continue
        preferred, secondary = _choose_primary(existing, sale), sale
        if preferred is sale:
            secondary = existing
            by_hash[key] = sale
        _merge_into(preferred, secondary, confidence="content_hash")

    # Dernière passe : fusionner les annonces partageant une même adresse précise
    # (numéro + voie + commune) même si la date ou le prix diffèrent légèrement —
    # cas typique de deux sources référençant le même bien. Le hash de contenu
    # ci-dessus ne les rapproche pas car il inclut date et prix.
    # La clé de repli stricte (tribunal, jour, prix, signal fort) ne passe qu'en dernier.
    survivors = _merge_by_address([*by_hash.values(), *passthrough])
    if not strict_fallback:
        return survivors
    survivors = _merge_by_strict_key(
        survivors, excluded_sources=strict_excluded_sources, max_group=strict_max_group
    )
    if not streetless_fallback:
        return survivors
    # Import tardif : ce module s'appuie sur les clés et les gardes de celui-ci.
    from src.dedupe_streetless import merge_streetless_sales

    return merge_streetless_sales(survivors)


def _is_richer(candidate: AuctionSale, current: AuctionSale) -> bool:
    return _richness_score(candidate) > _richness_score(current)


def _choose_primary(first: AuctionSale, second: AuctionSale) -> AuctionSale:
    first_score = _richness_score(first)
    second_score = _richness_score(second)
    if first_score != second_score:
        return first if first_score > second_score else second
    first_priority = PRIMARY_SOURCE_PRIORITY.get(first.source_name, 99)
    second_priority = PRIMARY_SOURCE_PRIORITY.get(second.source_name, 99)
    if first_priority != second_priority:
        return first if first_priority < second_priority else second
    return first


def _richness_score(sale: AuctionSale) -> int:
    score = sum(not _is_empty(getattr(sale, field)) for field in RICHNESS_FIELDS)
    score += min(len(sale.documents), 3)
    score += min(len(sale.score_factors), 3)
    score -= min(len(sale.quality_flags), 3)
    if sale.raw_text:
        score += min(len(sale.raw_text) // 250, 4)
    return score


def _field_authority(sale: AuctionSale, field: str) -> tuple[int, str]:
    payload = sale.raw_payload
    documentary = int(bool(payload.get(f"pdf_{field}_extraction")))
    if "surface" in field:
        documentary = int(str(sale.surface_source or "").lower() in {"pdf", "document", "carrez"})
    checks = payload.get("source_checks") or {}
    checked = str((checks.get(sale.source_url) or {}).get("checked_at") or "")
    return documentary, checked


# Position et lieu : une annonce sans voie (« Nice », « 06000 Nice ») ne les écrase jamais sur une vente qui a
# une voie, et n'apporte jamais de coordonnées (un centre de commune n'est pas l'adresse de la vente).
_LOCATION_FIELDS = frozenset({"address", "postal_code", "city", "department", "latitude", "longitude"})
_POSITION_FIELDS = frozenset({"latitude", "longitude"})


def _merge_into(target: AuctionSale, source: AuctionSale, confidence: str) -> AuctionSale:
    keep_location = street_class(target) == "street" and street_class(source) == "none"
    target.primary_source = target.primary_source or target.source_name
    target.dedupe_confidence = confidence
    for url in [source.source_url, *source.source_urls]:
        if url and url not in target.source_urls:
            target.source_urls.append(url)

    target.observations.extend(_new_observations(target, source))
    # Adresses internes (non persistées sur la vente) : celles de la source fusionnée suivent la survivante.
    known_contacts = {contact["email"] for contact in target.internal_contacts}
    target.internal_contacts.extend(
        contact for contact in source.internal_contacts if contact["email"] not in known_contacts
    )

    for field in _mergeable_fields():
        current = getattr(target, field)
        incoming = getattr(source, field)
        if keep_location and field in _LOCATION_FIELDS and (field in _POSITION_FIELDS or not _is_empty(current)):
            continue
        if _is_empty(current) and not _is_empty(incoming):
            setattr(target, field, incoming)
        elif (
            field == "sale_date"
            and not _is_empty(incoming)
            and (timed := _timed_same_day_sale_date(current, incoming)) is not None
        ):
            # Même jour civil à Paris, une seule heure connue : ce n'est pas un désaccord entre sources,
            # la date horodatée l'emporte sur la date seule (minuit UTC) quelle que soit sa source.
            setattr(target, field, timed)
        elif field not in {"raw_payload", "raw_text"} and not _is_empty(incoming) and current != incoming and not isinstance(current, (list, dict)):
            conflicts = target.raw_payload.setdefault("source_conflicts", [])
            incoming_selected = _field_authority(source, field) > _field_authority(target, field)
            if incoming_selected:
                setattr(target, field, incoming)
            conflict = {"field": field, "selected": str(getattr(target, field)), "observed_primary": str(current), "alternative": str(current if incoming_selected else incoming), "selected_source": source.source_url if incoming_selected else target.source_url, "alternative_source": target.source_url if incoming_selected else source.source_url, "observed_primary_source": target.source_url}
            if conflict not in conflicts:
                conflicts.append(conflict)
        elif field in {"documents", "quality_flags", "score_factors"} and isinstance(current, list) and isinstance(incoming, list):
            if field == "score_factors":
                setattr(target, field, _merge_score_factors(current, incoming))
            else:
                setattr(target, field, _merge_lists(current, incoming))
        elif field == "raw_payload" and isinstance(current, dict) and isinstance(incoming, dict):
            current.setdefault("source_checks", {}).update(incoming.get("source_checks") or {})
            previous_content_changed = bool(current.get("source_content_changed"))
            if incoming.get("source_content_changed"):
                current["source_content_changed"] = True
                # A non-major source change marks the text stale instead of
                # erasing it (see display_invalidation); serve it until rebuilt.
                if incoming.get("llm_display_status") == "stale" and current.get("llm_display_description"):
                    current["llm_display_status"] = "stale"
                else:
                    current["llm_display_status"] = "pending"
                    current.pop("llm_display_description", None)
                    current.pop("llm_prompt_version", None)
                current.pop("document_facts_version", None)
            # Invalidation metadata is part of the revision contract.  A
            # second collector can carry an operational refresh on top of a
            # documentary invalidation; dropping these markers here would
            # make the merged row look eligible for a deterministic refresh
            # (or enqueue a new LLM pass without the previous provenance).
            if incoming.get("source_operational_changed"):
                current["source_operational_changed"] = True
            incoming_reason = incoming.get("source_content_change_reason")
            current_reason = current.get("source_content_change_reason")
            if incoming_reason and (
                not previous_content_changed
                or (
                    current_reason is not None
                    and incoming.get("source_content_changed")
                    and current_reason == "source_operational_changed"
                    and incoming_reason != "source_operational_changed"
                )
            ):
                current["source_content_change_reason"] = incoming_reason
            # A prior documentary marker with an unknown or documentary
            # reason is deliberately retained.  An operational second source
            # must not turn that pending/unknown invalidation into a
            # refreshable one merely by replacing its superseded payload.
            if incoming.get("superseded_analysis") is not None and (
                not previous_content_changed
                or current_reason == "source_operational_changed"
                or not current.get("superseded_analysis")
            ):
                current["superseded_analysis"] = deepcopy(incoming["superseded_analysis"])
            current.setdefault("merged_sources", [])
            summary = _observation_summary(source, slim_payload=True)
            current["merged_sources"] = _with_merged_source(current["merged_sources"], summary)

    if source.raw_text and source.raw_text not in (target.raw_text or ""):
        target.raw_text = clean_text(f"{target.raw_text or ''}\n\n--- SOURCE {source.source_name.upper()} ---\n{source.raw_text}")
    return target


def _has_known_time(value: datetime) -> bool:
    """Vrai si la date porte une heure : un minuit UTC est une date seule (le jour sans l'heure)."""
    utc_value = value.replace(tzinfo=UTC) if value.tzinfo is None else value.astimezone(UTC)
    return utc_value.time() != time(0, 0)


def _timed_same_day_sale_date(first: Any, second: Any) -> datetime | None:
    """La date horodatée, si les deux dates tombent le même jour civil à Paris et qu'une seule a une heure.

    Petites Affiches publie souvent le jour seul (minuit UTC) d'une vente que Vench donne à 14 h : la
    date seule ne doit pas écraser l'heure. Dans tous les autres cas (jours différents, deux heures
    connues et différentes, aucune heure) renvoie None et la règle d'autorité des champs s'applique.
    """
    if not isinstance(first, datetime) or not isinstance(second, datetime):
        return None
    if _civil_day(first) != _civil_day(second):
        return None
    first_timed, second_timed = _has_known_time(first), _has_known_time(second)
    if first_timed == second_timed:
        return None
    return first if first_timed else second


def _ensure_observation_metadata(sale: AuctionSale) -> None:
    sale.documents = normalize_documents(sale.documents, source_url=sale.source_url)
    sale.primary_source = sale.primary_source or sale.source_name
    if sale.source_url not in sale.source_urls:
        sale.source_urls.append(sale.source_url)
    if not sale.observations:
        sale.observations.append(_observation_summary(sale))


def _new_observations(target: AuctionSale, source: AuctionSale) -> list[dict[str, Any]]:
    existing_urls = {item.get("source_url") for item in target.observations if isinstance(item, dict)}
    observations = source.observations or [_observation_summary(source)]
    return [item for item in observations if isinstance(item, dict) and item.get("source_url") not in existing_urls]


# What a ``merged_sources`` copy keeps of the source payload: what enrichment reads from it
# (``extract_structured._source_payloads_for_sale``: identity, text blocks, page text and the description keys
# ``SOURCE_DESCRIPTION_KEYS``, kept in step by a test). Derived analyses (asset normalisation, scores, conflicts,
# observations…) are recomputed on the merged sale itself; copying them made each copy about 85 KB.
MERGED_SOURCE_PAYLOAD_KEYS = frozenset({
    "source_name", "source_url", "external_id", "source_blocks", "raw_text",
    "source_description", "description", "descriptif", "designation", "désignation",
    "renseignements_de_vente", "criteres_resume", "complement", "body",
})


def _merged_source_payload(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        return {}
    return deepcopy({key: value for key, value in payload.items() if key in MERGED_SOURCE_PAYLOAD_KEYS})


def _observation_summary(sale: AuctionSale, *, slim_payload: bool = False) -> dict[str, Any]:
    return {
        "source_name": sale.source_name,
        "source_url": sale.source_url,
        "external_id": sale.external_id,
        "title": sale.title,
        "city": sale.city,
        "postal_code": sale.postal_code,
        "department": sale.department,
        "starting_price_eur": float(sale.starting_price_eur) if sale.starting_price_eur is not None else None,
        "sale_date": sale.sale_date.isoformat() if sale.sale_date else None,
        # A summary becomes part of the primary payload. Copy the source
        # graph so merging two models that share a raw_payload cannot create a
        # back-reference from merged_sources to the payload being built.
        "raw_payload": _merged_source_payload(sale.raw_payload) if slim_payload else deepcopy(sale.raw_payload),
    }


def _with_merged_source(entries: Any, summary: dict[str, Any]) -> list[Any]:
    """``merged_sources`` with ``summary`` as the only copy of its source URL, and one copy per other URL.

    The same pair of listings is merged again at every run: appending used to stack a full copy of the source
    payload each time (150 copies, 12.8 MB in one row on 2026-10-29), and every write of such a row ran the
    ``auction_sales`` triggers over the whole JSON. Older duplicates heal at the next merge: the last copy of
    each URL is kept.
    """
    latest: dict[str, Any] = {}
    kept: list[Any] = []
    for entry in [*(entries if isinstance(entries, list) else []), summary]:
        url = entry.get("source_url") if isinstance(entry, dict) else None
        if url:
            latest.pop(url, None)
            latest[url] = entry
        else:
            kept.append(entry)
    return [*kept, *latest.values()]


def _has_strong_dedupe_signal(sale: AuctionSale) -> bool:
    # City + date + price can describe several independent auction lots.
    # A content hash is not an identity proof without a precise street address.
    return bool(_address_dedupe_keys(sale))


def _normalize_street_text(value: str) -> str:
    ascii_text = unicodedata.normalize("NFKD", value).encode("ascii", "ignore").decode("ascii").lower()
    ascii_text = re.sub(r"\bfrance\b", " ", ascii_text)
    ascii_text = re.sub(r"\bcedex\b\s*\d*", " ", ascii_text)
    ascii_text = re.sub(r"\b(?:n|no|numero)\s+(\d+)\b", r"\1", ascii_text)
    ascii_text = re.sub(r"[^a-z0-9]+", " ", ascii_text)
    for pattern, replacement in STREET_TOKEN_REPLACEMENTS:
        ascii_text = re.sub(pattern, replacement, ascii_text)
    ascii_text = FRENCH_ADDRESS_PARTICLES_RE.sub(" ", ascii_text)
    return re.sub(r"\s+", " ", ascii_text).strip()


def _address_dedupe_keys(sale: AuctionSale) -> list[str]:
    address = clean_text(sale.address)
    if not address:
        return []
    street = address
    postal_code = clean_text(sale.postal_code) or _postal_code_from_text(address)
    city = clean_text(sale.city) or _city_from_address(address, postal_code)
    department = clean_text(sale.department)
    if department:
        street = re.sub(rf"(?:,|\()\s*{re.escape(department)}\s*\)?\s*$", " ", street, flags=re.I)
    for token in (postal_code, city):
        if token:
            street = re.sub(re.escape(token), " ", street, flags=re.IGNORECASE)
    street = re.sub(r"\b\d{5}\b", " ", street)
    street_key = _normalize_street_text(street)
    # Exiger une adresse précise (numéro de voie) : sans numéro on risquerait de
    # fusionner des biens distincts d'une même commune (ex. « 33000 Bordeaux »).
    if not _STREET_NUMBER_RE.search(street_key) or not re.search(r'[a-z]', street_key) or len(street_key) < 6:
        return []

    localities: list[str] = []
    if postal_code:
        localities.append(postal_code.lower())
    if city:
        localities.append(_normalize_street_text(city))
    return [f"{street_key}|{locality}" for locality in _unique_values(localities) if locality]


_ARRONDISSEMENT_RE = re.compile(r"\b\d{1,2}\s?(?:er|ere|e|eme)\b|\barrondissement\b")
_STREET_WORD_RE = re.compile(
    r"\b(?:rue|avenue|boulevard|chemin|route|impasse|allee|place|quai|cours|faubourg|passage|square|voie|"
    r"lotissement|hameau|lieu dit|lieudit|residence|domaine|villa|cite|clos|sentier|rond point|parvis|esplanade|"
    r"mail|port|cote|ruelle|traverse|chaussee|promenade|zone|za|zi|zac)\b"
)


def _street_remainder(sale: AuctionSale) -> str:
    """Ce qui reste de l'adresse une fois retirés code postal, commune, département et Cedex (normalisé)."""
    address = clean_text(sale.address)
    if not address:
        return ""
    postal_code = clean_text(sale.postal_code) or _postal_code_from_text(address)
    city = clean_text(sale.city) or _city_from_address(address, postal_code)
    street = _TRAILING_DEPARTMENT_RE.sub(" ", address)
    department = clean_text(sale.department)
    if department:
        street = re.sub(rf"(?:,|\()\s*{re.escape(department)}\s*\)?\s*$", " ", street, flags=re.I)
    for token in (postal_code, city):
        if token:
            street = re.sub(re.escape(token), " ", street, flags=re.IGNORECASE)
    street = re.sub(r"\b\d{5}\b", " ", street)
    remainder = _normalize_street_text(street)
    if city:
        # Accents et ponctuation différents entre l'adresse et la commune (« Nimes » / « Nîmes »).
        city_key = _normalize_street_text(city)
        if city_key:
            remainder = re.sub(rf"\b{re.escape(city_key)}\b", " ", remainder)
    remainder = _ARRONDISSEMENT_RE.sub(" ", remainder)
    return re.sub(r"\s+", " ", remainder).strip()


def street_class(sale: AuctionSale) -> str:
    """``street`` (voie reconnue), ``none`` (ni voie ni lieu-dit : la commune seule) ou ``other`` (doute).

    Seule la classe ``none`` peut être absorbée par la règle des annonces sans voie : tout reste d'adresse
    qui n'est pas une voie reconnue (un lieu-dit, un nom de résidence) classe la vente en ``other``, pour ne
    jamais perdre cette information.
    """
    if _address_dedupe_keys(sale):
        return "street"
    remainder = _street_remainder(sale)
    if not remainder or not re.search(r"[a-z]", remainder):
        return "none"
    return "street" if _STREET_WORD_RE.search(remainder) else "other"


def _postal_code_from_text(value: str) -> str | None:
    match = _POSTAL_CODE_RE.search(value)
    return match.group(1) if match else None


def _city_from_address(address: str, postal_code: str | None) -> str | None:
    if not postal_code:
        return None
    match = re.search(rf"\b{re.escape(postal_code)}\s+([^,\n()]+)", address)
    if not match:
        return None
    return clean_text(match.group(1).replace("France", "").strip(" ,"))


def _prices_close(first: Any, second: Any, tolerance: float = 0.02) -> bool:
    try:
        left = float(first)
        right = float(second)
    except (TypeError, ValueError):
        return False
    if left <= 0 or right <= 0:
        return False
    return abs(left - right) <= tolerance * max(left, right)


def _same_property(first: AuctionSale, second: AuctionSale) -> bool:
    if first.source_name == second.source_name and first.source_url != second.source_url:
        # Separate listings from one publisher can be separate lots in the same building.
        return False
    if _distinct_shared_listings(first, second):
        return False
    for key in ("lot_number", "lot_id"):
        first_lot, second_lot = first.raw_payload.get(key), second.raw_payload.get(key)
        if first_lot and second_lot and str(first_lot) != str(second_lot):
            return False
    first_surface = first.app_surface_m2 or first.habitable_surface_m2 or first.carrez_surface_m2
    second_surface = second.app_surface_m2 or second.habitable_surface_m2 or second.carrez_surface_m2
    if first_surface and second_surface and abs(first_surface - second_surface) / max(first_surface, second_surface) > 0.2:
        return False
    # Même adresse précise ne suffit pas : un immeuble contient plusieurs lots et un
    # bien peut être remis en vente (surenchère, folle enchère). Deux dates d'audience
    # (jour civil de Paris) ou deux prix connus et différents ne fusionnent jamais ;
    # il faut ensuite date ET prix identiques, ou une même surface.
    first_day, second_day = _civil_day(first.sale_date), _civil_day(second.sale_date)
    if first_day and second_day and first_day != second_day:
        return False
    first_price, second_price = _whole_euros(first.starting_price_eur), _whole_euros(second.starting_price_eur)
    if first_price is not None and second_price is not None and first_price != second_price:
        return False
    if first_day and second_day and first_price is not None and second_price is not None:
        return True
    return bool(first_surface and second_surface and round(first_surface, 1) == round(second_surface, 1))


def _civil_day(value: datetime | None) -> date | None:
    if value is None:
        return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=UTC)
    return value.astimezone(PARIS).date()


def _whole_euros(value: Any) -> int | None:
    try:
        euros = round(float(value))
    except (TypeError, ValueError):
        return None
    return euros if euros > 0 else None


def _merge_by_address(sales: list[AuctionSale]) -> list[AuctionSale]:
    by_address: dict[str, list[AuctionSale]] = {}
    passthrough: list[AuctionSale] = []
    survivors: list[AuctionSale] = []
    for sale in sales:
        keys = _address_dedupe_keys(sale)
        if not keys:
            passthrough.append(sale)
            continue
        existing = _find_address_match(by_address, keys, sale)
        if existing is None:
            survivors.append(sale)
            _register_address_candidate(by_address, keys, sale)
            continue
        preferred = _choose_primary(existing, sale)
        secondary = sale if preferred is existing else existing
        _merge_into(preferred, secondary, confidence="address")
        if preferred is sale:
            _replace_identity(survivors, existing, sale)
            _replace_address_candidate(by_address, existing, sale)
        _register_address_candidate(by_address, [*_address_dedupe_keys(preferred), *keys], preferred)
    return [*survivors, *passthrough]


_LISTING_ID_PATTERNS = {
    # https://www.vench.fr/vente-166526-une-maison-ondres.html
    "vench": re.compile(r"/vente-(\d+)-"),
    # https://www.petitesaffiches.fr/encheres-immobilieres/vente/immobiliere/j/une-maison-a-x-166526.html
    "petites_affiches": re.compile(r"-(\d+)\.html(?:$|[?#])"),
}
_LISTING_ID_HOSTS = {"vench": "vench.fr/", "petites_affiches": "petitesaffiches.fr/"}
_LISTING_ID_SOURCES = frozenset(_LISTING_ID_PATTERNS)


def _listing_ids(sale: AuctionSale) -> frozenset[str]:
    """Identifiants d'annonce Vench / Petites Affiches de toutes les URL d'une ligne, fusionnées comprises.

    Le motif d'une source ne s'applique qu'aux URL de son site : « -123.html » est courant ailleurs.
    """
    ids: set[str] = set()
    for url in {sale.source_url, *sale.source_urls}:
        for source, pattern in _LISTING_ID_PATTERNS.items():
            if url and _LISTING_ID_HOSTS[source] in url and (match := pattern.search(url)):
                ids.add(match.group(1))
    return frozenset(ids)


def _distinct_shared_listings(first: AuctionSale, second: AuctionSale) -> bool:
    """Vrai si chaque ligne porte des numéros d'annonce Vench / Petites Affiches, sans aucun numéro commun.

    Ce sont alors deux annonces, donc deux lots : même adresse, même jour et même mise à prix (lots d'un même
    immeuble) ne suffisent pas à les fusionner.
    """
    first_ids, second_ids = _listing_ids(first), _listing_ids(second)
    return bool(first_ids and second_ids and first_ids.isdisjoint(second_ids))


def shared_listing_id(sale: AuctionSale) -> str | None:
    """Identifiant d'annonce que Vench et Petites Affiches (qui reprend Vench) publient dans leur URL."""
    pattern = _LISTING_ID_PATTERNS.get(sale.source_name)
    if pattern is None:
        return None
    match = pattern.search(sale.source_url or "")
    return match.group(1) if match else None


def _locality(sale: AuctionSale) -> tuple[str | None, str | None]:
    """Code postal et commune normalisée connus d'une vente (champs, sinon adresse)."""
    address = clean_text(sale.address)
    postal_code = clean_text(sale.postal_code) or (_postal_code_from_text(address) if address else None)
    city = clean_text(sale.city) or (_city_from_address(address, postal_code) if address else None)
    # Petites Affiches écrit « Ondres (40) » : le département entre parenthèses n'est pas la commune.
    city = _TRAILING_DEPARTMENT_RE.sub("", city) if city else city
    return postal_code, (_normalize_street_text(city) if city else None) or None


def _same_locality_known_on_both_sides(first: AuctionSale, second: AuctionSale) -> bool:
    """Même code postal ou même commune normalisée, connus des deux côtés (sinon faux)."""
    (first_postal, first_city), (second_postal, second_city) = _locality(first), _locality(second)
    if first_postal and second_postal and first_postal == second_postal:
        return True
    return bool(first_city and second_city and first_city == second_city)


def same_shared_listing(first: AuctionSale, second: AuctionSale) -> bool:
    """Même annonce Vench / Petites Affiches : même identifiant, même lieu, un fait en commun.

    L'identifiant seul n'est pas une preuve suffisante : le balayage supprime la ligne secondaire,
    et deux numéros d'annonce peuvent coïncider entre deux biens (Ondres 40440 et Lyon 69003 ont
    déjà été fusionnés). On exige donc, en plus de l'identifiant et de sources différentes :
    - même code postal ou même commune normalisée, connus des deux côtés ;
    - au moins un fait corroborant connu des deux côtés et identique : même jour civil à Paris, ou
      même mise à prix à l'euro près ;
    - aucun fait connu des deux côtés (numéro de lot, jour, mise à prix) qui se contredise.
    Un lieu ou un fait inconnu d'un côté ne prouve rien : la paire est refusée, jamais devinée.
    """
    if first.source_name == second.source_name or {first.source_name, second.source_name} != _LISTING_ID_SOURCES:
        return False
    first_id, second_id = shared_listing_id(first), shared_listing_id(second)
    if not first_id or first_id != second_id:
        return False
    if not _same_locality_known_on_both_sides(first, second):
        return False
    for key in ("lot_number", "lot_id"):
        first_lot, second_lot = first.raw_payload.get(key), second.raw_payload.get(key)
        if first_lot and second_lot and str(first_lot) != str(second_lot):
            return False
    first_day, second_day = _civil_day(first.sale_date), _civil_day(second.sale_date)
    if first_day and second_day and first_day != second_day:
        return False
    first_price, second_price = _whole_euros(first.starting_price_eur), _whole_euros(second.starting_price_eur)
    if first_price is not None and second_price is not None and first_price != second_price:
        return False
    same_day = bool(first_day and second_day)
    same_price = first_price is not None and second_price is not None
    return same_day or same_price


def _merge_by_shared_listing_id(sales: list[AuctionSale]) -> list[AuctionSale]:
    """Fusionne les paires Vench / Petites Affiches de même numéro d'annonce, lot par lot.

    Chaque lot d'une vente à plusieurs lots est une annonce à part, avec son numéro : les paires se font DANS
    un numéro, jamais d'un numéro à l'autre, quelle que soit l'adresse, le jour ou la mise à prix partagés.
    Si plusieurs lignes d'une même source portent le même numéro (variantes d'URL, lots que rien ne distingue),
    la paire n'est faite que si les deux côtés n'ont qu'un seul partenaire possible : on ne devine pas quel lot
    est lequel.
    """
    by_id: dict[str, list[AuctionSale]] = {}
    for sale in sales:
        if listing_id := shared_listing_id(sale):
            by_id.setdefault(listing_id, []).append(sale)
    merged_away: set[int] = set()
    replacements: dict[int, AuctionSale] = {}
    for bucket in by_id.values():
        if len(bucket) < 2:
            continue
        partners = {id(sale): [other for other in bucket if same_shared_listing(sale, other)] for sale in bucket}
        for sale in bucket:
            matches = partners[id(sale)]
            if id(sale) in merged_away or len(matches) != 1:
                continue
            other = matches[0]
            if id(other) in merged_away or len(partners[id(other)]) != 1:
                continue
            preferred = _choose_primary(sale, other)
            secondary = other if preferred is sale else sale
            _merge_into(preferred, secondary, confidence="listing_id")
            merged_away.add(id(secondary))
            replacements[id(sale)] = replacements[id(other)] = preferred
    return [replacements.get(id(sale), sale) for sale in sales if id(sale) not in merged_away]


_STRICT_SURFACE_TOLERANCE = 0.05
_GENERIC_PROPERTY_TYPES = frozenset({"", "other", "unknown", "autre"})


def _is_multi_lot(sale: AuctionSale) -> bool:
    payload = sale.raw_payload if isinstance(sale.raw_payload, dict) else {}
    lots = payload.get("source_lots")
    lot_count = payload.get("lot_count")
    return (
        "multi_lot_sale" in sale.quality_flags
        or (isinstance(lots, list) and len(lots) > 1)
        or (isinstance(lot_count, int) and lot_count > 1)
    )


def _court_keys(sale: AuctionSale) -> set[str]:
    keys: set[str] = set()
    if sale.tribunal_code:
        keys.add(f"court:{sale.tribunal_code}")
    geocode = sale.raw_payload.get("geocode") if isinstance(sale.raw_payload, dict) else None
    if isinstance(geocode, dict) and geocode.get("accepted") is True and geocode.get("citycode"):
        keys.add(f"insee:{str(geocode['citycode']).upper()}")
    return keys


def _surface_for_comparison(sale: AuctionSale):
    return sale.app_surface_m2 or sale.habitable_surface_m2 or sale.carrez_surface_m2 or sale.surface_m2


def _same_commune(first: AuctionSale, second: AuctionSale) -> bool:
    first_postal, second_postal = clean_text(first.postal_code), clean_text(second.postal_code)
    if first_postal and second_postal:
        return first_postal == second_postal
    first_city, second_city = _normalize_street_text(first.city or ""), _normalize_street_text(second.city or "")
    return bool(first_city) and first_city == second_city


def strict_duplicate_key_match(first: AuctionSale, second: AuctionSale) -> bool:
    """Clé de repli stricte : même tribunal (ou code INSEE), même jour, même prix, et un signal fort.

    Toutes les conditions sont nécessaires ; un seul désaccord connu écarte la paire :
    - deux sources différentes (deux lots d'une même source ne sont jamais fusionnés) ;
    - aucune des deux annonces n'est multi-lots, aucun numéro de lot ne diffère ;
    - même jour civil à Paris et même mise à prix à l'euro près ;
    - même tribunal rattaché au référentiel, ou même code INSEE géocodé ;
    - signal fort : surfaces à ±5 %, ou même type de bien (précis) ET même commune ; deux surfaces
      connues qui divergent de plus de 5 % ou deux adresses numérotées différentes écartent la paire.
    """
    if first.source_name == second.source_name:
        return False
    if _distinct_shared_listings(first, second):
        return False
    if _is_multi_lot(first) or _is_multi_lot(second):
        return False
    for key in ("lot_number", "lot_id"):
        first_lot, second_lot = first.raw_payload.get(key), second.raw_payload.get(key)
        if first_lot and second_lot and str(first_lot) != str(second_lot):
            return False
    first_day, second_day = _civil_day(first.sale_date), _civil_day(second.sale_date)
    if not first_day or first_day != second_day:
        return False
    first_price, second_price = _whole_euros(first.starting_price_eur), _whole_euros(second.starting_price_eur)
    if first_price is None or first_price != second_price:
        return False
    if not _court_keys(first) & _court_keys(second):
        return False
    first_keys, second_keys = set(_address_dedupe_keys(first)), set(_address_dedupe_keys(second))
    if first_keys and second_keys and not first_keys & second_keys:
        return False
    first_surface, second_surface = _surface_for_comparison(first), _surface_for_comparison(second)
    if first_surface and second_surface:
        gap = abs(float(first_surface) - float(second_surface)) / max(float(first_surface), float(second_surface))
        return gap <= _STRICT_SURFACE_TOLERANCE
    first_type, second_type = (first.property_type or "").lower(), (second.property_type or "").lower()
    return (
        first_type == second_type
        and first_type not in _GENERIC_PROPERTY_TYPES
        and _same_commune(first, second)
    )


def _merge_by_strict_key(
    sales: list[AuctionSale],
    *,
    excluded_sources: frozenset[str] = frozenset(),
    max_group: int | None = None,
) -> list[AuctionSale]:
    """Fusionne les paires que la clé stricte désigne sans ambiguïté, de part et d'autre.

    Si une annonce a deux partenaires possibles (deux lots de même prix le même jour), rien n'est
    fusionné : on ne peut pas savoir quel lot est lequel.

    ``excluded_sources`` : les annonces de ces sources ne sont jamais rapprochées par cette clé.
    ``max_group`` : un (jour, prix) partagé par plus d'annonces (toutes sources comptées, y compris les
    sources exclues) est ignoré en entier : ce sont des lots distincts mis à prix pareil.
    """
    partners: dict[int, list[AuctionSale]] = {id(sale): [] for sale in sales}
    buckets: dict[tuple[date, int], list[AuctionSale]] = {}
    for sale in sales:
        day, price = _civil_day(sale.sale_date), _whole_euros(sale.starting_price_eur)
        if day is not None and price is not None:
            buckets.setdefault((day, price), []).append(sale)
    for full_bucket in buckets.values():
        if max_group is not None and len(full_bucket) > max_group:
            continue
        bucket = [sale for sale in full_bucket if sale.source_name not in excluded_sources]
        for index, first in enumerate(bucket):
            for second in bucket[index + 1 :]:
                if strict_duplicate_key_match(first, second):
                    partners[id(first)].append(second)
                    partners[id(second)].append(first)
    merged_away: set[int] = set()
    replacements: dict[int, AuctionSale] = {}
    for sale in sales:
        if id(sale) in merged_away or id(sale) in replacements:
            continue
        matches = partners[id(sale)]
        if len(matches) != 1:
            continue
        other = matches[0]
        if len(partners[id(other)]) != 1 or id(other) in merged_away:
            continue
        preferred = _choose_primary(sale, other)
        secondary = other if preferred is sale else sale
        _merge_into(preferred, secondary, confidence="strict_key")
        merged_away.add(id(secondary))
        replacements[id(sale)] = replacements[id(other)] = preferred
    return [replacements.get(id(sale), sale) for sale in sales if id(sale) not in merged_away]


def _find_address_match(
    by_address: dict[str, list[AuctionSale]],
    keys: list[str],
    sale: AuctionSale,
) -> AuctionSale | None:
    for key in keys:
        for existing in by_address.get(key, []):
            if _same_property(existing, sale):
                return existing
    return None


def _register_address_candidate(
    by_address: dict[str, list[AuctionSale]],
    keys: list[str],
    sale: AuctionSale,
) -> None:
    for key in _unique_values(keys):
        bucket = by_address.setdefault(key, [])
        if not any(item is sale for item in bucket):
            bucket.append(sale)


def _replace_address_candidate(
    by_address: dict[str, list[AuctionSale]],
    old: AuctionSale,
    new: AuctionSale,
) -> None:
    for bucket in by_address.values():
        _replace_identity(bucket, old, new)


def _replace_identity(items: list[AuctionSale], old: AuctionSale, new: AuctionSale) -> None:
    for index, item in enumerate(items):
        if item is old:
            items[index] = new


def _unique_values(values: Iterable[str]) -> list[str]:
    unique: list[str] = []
    seen: set[str] = set()
    for value in values:
        if not value or value in seen:
            continue
        seen.add(value)
        unique.append(value)
    return unique


def _mergeable_fields() -> tuple[str, ...]:
    return (
        "tribunal",
        "tribunal_code",
        "department",
        "city",
        "address",
        "postal_code",
        "property_type",
        "title",
        "description",
        "surface_m2",
        "habitable_surface_m2",
        "land_surface_m2",
        "carrez_surface_m2",
        "app_surface_m2",
        "app_surface_kind",
        "surface_scope",
        "surface_source",
        "surface_confidence",
        "surface_evidence",
        "rooms_count",
        "bedrooms_count",
        "bathrooms_count",
        "parking_count",
        "has_garden",
        "has_terrace",
        "has_garage",
        "has_pool",
        "has_air_conditioning",
        "has_double_glazing",
        "starting_price_eur",
        "sale_date",
        "visit_dates",
        "lawyer_name",
        "lawyer_contact",
        "status",
        "adjudication_price_eur",
        "documents",
        "latitude",
        "longitude",
        "occupancy_status",
        "risk_notes",
        "investment_score",
        "investment_summary",
        "score_version",
        "score_confidence",
        "score_factors",
        "quality_flags",
        "raw_payload",
    )


def _is_empty(value: Any) -> bool:
    return value is None or value == [] or value == {} or value == ""


def _merge_lists(first: list[Any], second: list[Any]) -> list[Any]:
    merged: list[Any] = []
    seen: set[str] = set()
    for item in [*first, *second]:
        marker = repr(item)
        if marker in seen:
            continue
        seen.add(marker)
        merged.append(item)
    return merged


def _merge_score_factors(first: list[Any], second: list[Any]) -> list[Any]:
    merged: list[Any] = []
    seen: set[str] = set()
    for item in [*first, *second]:
        if not isinstance(item, dict):
            marker = repr(item)
        else:
            marker = str(item.get("factor_key") or item.get("name") or repr(item))
        if marker in seen:
            continue
        seen.add(marker)
        merged.append(item)
    return merged
