"""Champs d'une vente « Cessions de l'État » déduits du texte de sa fiche détail.

Point d'entrée unique pour la collecte (texte de la page téléchargée) et pour
le recalcul sur l'existant (``source_blocks.page_text`` stocké), sans nouvelle
requête au site : :func:`extract_cessions_fields` produit les champs bruts que
``normalize_sale`` lit, et :func:`refresh_cessions_raw_sale` les applique à une
vente relue en base.
"""

from __future__ import annotations

import re
from datetime import UTC, date, datetime
from decimal import Decimal, InvalidOperation
from typing import Any

from src.cadastre_references import designation, parse_cadastral_references, ref_label, references_signature
from src.sources.cessions_etat_labels import (
    CATEGORY_TYPES,
    GROUPS,
    NATURE_LABELS,
    TYPE_PRIORITY,
    decimal_text,
    fold,
    lookup_nature,
    parse_bool,
    parse_count,
    parse_surface,
    parse_year,
)
from src.sources.cessions_etat_page import CessionsPage, Characteristic, direction_email, parse_cessions_page
from src.sources.cessions_etat_procedure import (
    analyse_procedure,
    attach_adjudication_time,
    countdown_end,
    published_price,
    select_schedule,
)

FEATURES_SCHEMA_VERSION = "cessions_etat_features_v2"
DISPLAY_SCHEMA_VERSION = "property_characteristics_v1"
_LAND_NATURES = {"terrain_nu", "terrain_agricole", "foret", "terrain_bati_a_demolir", "etendue_eau", "vigne_verger"}
_VACANT_RE = re.compile(r"\b(?:libre|vacant|inoccup|imm[ée]diat)", re.I)
_DESCRIPTION_SURFACE_RE = re.compile(
    r"(?P<value>\d{1,3}(?:[  .]\d{3})+(?:,\d+)?|\d+(?:\s?[,.]\s?\d+)?)\s*m\s*(?:²|2)(?![\w³])", re.I
)
_LAND_CUE_RE = re.compile(
    r"terrain|parcelle|jardin|emprise|contenance|cadastral|foncier|tenement|\bcour\b|lande|\bbois|\bpres?\b|\bha\b"
)
_ANNEX_CUE_RE = re.compile(r"terrasse|balcon|cave|garage|dependance|grenier|combles|abri|box|hangar de|volume")
_BUILT_CUE_RE = re.compile(
    r"habitable|utile|plancher|sdp|shon|maison|appartement|logement|bureaux?|immeuble|locaux?|batiment|bati\b|"
    r"plateaux?|carrez|construction|villa|pavillon"
)
_SERVICE_NAME_RE = re.compile(r"\b(?:service|p[oô]le|prie|direction|ddfip|drfip|dgfip|division|bureau|sgami)\b", re.I)


def parse_observed_at(value: object | None) -> datetime | None:
    try:
        parsed = datetime.fromisoformat(str(value or "").replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)


def _natures(page: CessionsPage) -> list[tuple[str, str, str]]:
    found: list[tuple[str, str, str]] = []
    for label in page.natures:
        match = lookup_nature(label)
        if match:
            found.append((label, match[0], match[1]))
    return found


def property_type_for(page: CessionsPage) -> str | None:
    types = [item[2] for item in _natures(page)]
    built_types = {kind for kind in types if kind not in {"land", "other"}}
    if len(built_types) > 1:
        return "mixed"  # maisons + immeubles : chaque nature publie sa propre surface
    if built_types == {"house"} and re.search(r"\bimmeubles?\b", fold((page.description or "")[:90])):
        # « Maisons » est parfois coché pour un immeuble (« Ancien immeuble de bureaux en R+2 ») :
        # le sujet de la première phrase du descriptif l'emporte.
        return "building"
    for candidate in TYPE_PRIORITY:
        if candidate in types:
            return candidate
    return CATEGORY_TYPES.get(fold(page.category)) if page.category else None


def _typed_value(kind: str, value: str) -> Any:
    if kind == "bool":
        return parse_bool(value)
    if kind == "count":
        count = parse_count(value)
        return count if count is not None else value
    if kind == "year":
        return parse_year(value) or value
    if kind == "surface":
        surface = parse_surface(value)
        return decimal_text(surface) if surface is not None else value
    if kind == "bool_text":
        # « oui » -> True ; « non constructible » -> {present: False, text} ; texte libre -> texte.
        flag = parse_bool(value)
        if flag is None:
            return value
        return flag if fold(value) in {"oui", "non"} else {"present": flag, "text": value}
    return value


def description_surfaces(description: str | None) -> list[tuple[Decimal, str]]:
    """Surfaces citées dans le descriptif, avec leur portée d'après les mots qui précèdent."""
    found: list[tuple[Decimal, str]] = []
    text = str(description or "")
    previous_end = 0
    for match in _DESCRIPTION_SURFACE_RE.finditer(text):
        raw = re.sub(r"[\s .](?=\d{3}\b)", "", match.group("value")).replace(" ", "").replace(",", ".")
        # Les mots qui portent sur la surface précédente (« emprise de 1938 m² avec ») ne qualifient pas celle-ci.
        before = fold(text[max(previous_end, match.start() - 45) : match.start()])
        previous_end = match.end()
        try:
            value = Decimal(raw)
        except InvalidOperation:
            continue
        if _LAND_CUE_RE.search(before):
            scope = "land"
        elif _ANNEX_CUE_RE.search(before):
            scope = "annex"
        elif _BUILT_CUE_RE.search(before):
            scope = "built"
        else:
            scope = "neutral"
        found.append((value, scope))
    return found


def _tile_scope(value: Decimal, nature_type: str | None, page: CessionsPage, described: list[tuple[Decimal, str]]) -> str:
    """Portée d'une tuile « Surface en m² » d'un bien bâti : le site y met tantôt le bâti, tantôt la contenance."""
    near = [scope for number, scope in described if abs(number - value) <= 1]
    if "land" in near:
        return "land"
    if "built" in near:
        return "built"
    land_tile = parse_surface(page.value("land_surface_m2"))
    if land_tile is not None and abs(land_tile - value) > 1:
        return "built"
    built_numbers = {number for number, scope in described if scope == "built"}
    if len(built_numbers) == 1:
        return "unscoped"
    if nature_type in {"house", "apartment"} and value >= 600:
        return "unscoped"
    return "built"


def _refine(value: Decimal, described: list[tuple[Decimal, str]]) -> Decimal:
    """Le site arrondit la tuile ; le descriptif donne parfois la décimale (« 92,95 m² »)."""
    for number, _ in described:
        if number != number.to_integral_value() and abs(number - value) < 1:
            return number
    return value


def _surfaces(page: CessionsPage, natures: list[tuple[str, str, str]]) -> dict[str, str]:
    """Surfaces par portée : terrain, bâti, dépendances ; jamais d'unités ni de portées confondues.

    Plusieurs natures bâties (hangar + bâtiment d'élevage) s'additionnent ; une tuile
    dont la portée reste ambiguë est conservée à part (``surface_unscoped_m2``).
    """
    nature_types = {label: kind for label, code, kind in natures}
    land_labels = {label for label, code, _ in natures if code in _LAND_NATURES}
    has_built_nature = any(code not in _LAND_NATURES for _, code, _ in natures)
    described = description_surfaces(page.description)
    totals: dict[str, Decimal] = {}
    tiles = [item for item in page.characteristics if item.kind == "surface"]
    if not any(item.key == "surface_m2" for item in tiles) and page.headline_surface:
        headline = parse_surface(page.headline_surface)
        if headline is not None:
            tiles.append(Characteristic("surface_m2", "Surface", page.headline_surface, "surfaces", "surface",
                                        page.natures[0] if page.natures else None))
    for item in tiles:
        value = parse_surface(item.value)
        if value is None:
            continue
        if item.key in {"land_surface_m2", "outbuildings_surface_m2"}:
            totals.setdefault(item.key, value)
            continue
        if item.nature in land_labels or (not has_built_nature and (land_labels or page.category == "Fonciers")):
            scope = "land"
        else:
            scope = _tile_scope(value, nature_types.get(item.nature or ""), page, described)
        key = {"land": "land_surface_m2", "built": "built_surface_m2"}.get(scope, "surface_unscoped_m2")
        if scope == "built":
            value = _refine(value, described)
        if scope == "land" and key in totals and abs(totals[key] - value) <= 1:
            continue  # même contenance publiée deux fois (« Superficie du terrain » et « Surface »)
        totals[key] = totals.get(key, Decimal(0)) + value
    surfaces = {key: decimal_text(value) or "" for key, value in totals.items() if value > 0}
    built_numbers = {number for number, scope in described if scope == "built"}
    if has_built_nature and "built_surface_m2" not in surfaces and len(built_numbers) == 1:
        # La tuile désigne la contenance : la seule surface bâtie citée au descriptif fait foi.
        surfaces["built_surface_m2"] = decimal_text(built_numbers.pop()) or ""
        surfaces["built_surface_source"] = "description"
    return surfaces


def _schedule_fields(page: CessionsPage, procedure: dict[str, Any], observed_at: datetime | None) -> dict[str, Any]:
    """``sale_date``, statut et marqueur d'annonce active.

    * fiche « Expirée » ou « Vendue » : statut ``past`` ; ses dates restent dans le
      profil de procédure (une date passée ferait purger la ligne par la rétention) ;
    * échéance publiée (adjudication, fenêtre d'enchères, date limite) : ``sale_date`` ;
    * sinon l'annonce est active sans échéance (« Procédure à venir », appel d'offres
      dont la date limite est au cahier des charges) : statut ``upcoming`` et marqueur
      ``state_listing``. Le compte à rebours « Fini dans N jours » mesure la fin de
      publication de l'annonce, pas la date limite de dépôt : il n'alimente jamais
      ``sale_date``, seulement la fin de publication estimée du marqueur.
    """
    fields: dict[str, Any] = {
        "sale_date": None,
        "sale_date_kind": None,
        "date_precision": None,
        "source_sale_schedule": None,
        "state_listing": None,
    }
    if page.badge in {"expired", "sold"}:
        fields["status"] = "past"
        return fields
    schedule = select_schedule(procedure)
    if schedule:
        fields["sale_date"] = schedule["at"]
        fields["sale_date_kind"] = schedule["kind"]
        if "T" not in schedule["at"]:
            fields["date_precision"] = "day"
        if schedule["kind"] == "sale_window_close" and schedule.get("has_time"):
            fields["source_sale_schedule"] = {
                "opens_at": schedule["opens_at"],
                "closes_at": schedule["at"],
                "schedule_type": "sale_window",
            }
        fields["status"] = None
        return fields
    end = countdown_end(page.countdown_days, observed_at)
    fields["status"] = "upcoming"
    if observed_at is not None:
        fields["state_listing"] = {
            "active": True,
            "observed_at": observed_at.astimezone(UTC).isoformat(),
            "reason": "procedure_pending" if procedure.get("pending") else "deadline_not_published",
            **({"listing_end_estimate": end.isoformat(), "countdown_days": page.countdown_days} if end else {}),
        }
    return fields


def _cadastre_location(
    page: CessionsPage, city: str | None, published_surface: str | None, insee_fallback: str | None = None
) -> dict[str, Any] | None:
    insee = (page.value("insee_code") or insee_fallback or "").strip().upper()
    candidates: list[dict[str, Any]] = []
    for key, source_label in (("cadastral_references", "Références cadastrales"), ("cadastral_reference", "Référence cadastrale")):
        for raw in page.values(key):
            refs = parse_cadastral_references(raw)
            labels = [ref_label(ref) for ref in refs]
            if labels and all(labels != item["parcels"] for item in candidates):
                candidates.append({"source_label": source_label, "raw": raw[:300], "parcels": labels})
    if not candidates:
        return None
    first_refs = parse_cadastral_references(candidates[0]["raw"])
    all_refs = [ref for item in candidates for ref in parse_cadastral_references(item["raw"])]
    return {
        "insee_code": insee or None,
        "candidates": candidates,
        "designation": designation(first_refs, city),
        "published_surface_m2": published_surface,
        "signature": references_signature(insee, all_refs),
    }


def _display_block(
    page: CessionsPage,
    *,
    natures: list[tuple[str, str, str]],
    surfaces: dict[str, str],
    procedure: dict[str, Any],
    schedule: dict[str, Any],
    location: dict[str, Any] | None,
    manager_email: str | None,
) -> dict[str, Any]:
    items = [
        {"key": item.key, "label": item.label, "value": item.value, "group": item.group,
         **({"nature": item.nature} if item.nature and len(natures) > 1 else {})}
        for item in page.characteristics
        if item.key not in {"surface_m2", "land_surface_m2", "outbuildings_surface_m2"}
    ]
    services = [
        contact.get("name") for contact in page.managers
        if contact.get("name") and _SERVICE_NAME_RE.search(str(contact.get("name")))
    ]
    procedure_view = {
        key: procedure[key]
        for key in ("method", "method_label", "method_source_label", "pending", "visits", "prices", "sold_on")
        if procedure.get(key)
    }
    if schedule.get("sale_date"):
        procedure_view["deadline"] = {"at": schedule["sale_date"], "kind": schedule["sale_date_kind"]}
        if schedule.get("source_sale_schedule"):
            procedure_view["window"] = {
                key: schedule["source_sale_schedule"][key] for key in ("opens_at", "closes_at")
            }
    listing = schedule.get("state_listing")
    if isinstance(listing, dict) and listing.get("listing_end_estimate"):
        procedure_view["listing_end_estimate"] = listing["listing_end_estimate"]
    deadlines = [item for item in procedure.get("deadlines") or [] if item.get("scope") == "procedure"]
    if deadlines:
        procedure_view["offer_deadline"] = max(deadlines, key=lambda item: item["at"][:10])["at"]
    if page.badge:
        procedure_view["listing_state"] = page.badge
    return {
        "schema_version": DISPLAY_SCHEMA_VERSION,
        "source": "cessions_etat",
        "nature": [
            {"label": label, "code": code, "display": NATURE_LABELS.get(code, label)} for label, code, _ in natures
        ],
        "category": page.category,
        "groups": GROUPS,
        "items": items,
        "surfaces": surfaces,
        "energy": {key: value for key, value in page.energy.items() if value},
        "media": dict(page.gallery),
        "attachments": [
            {key: attachment[key] for key in ("label", "kind", "kind_label", "format", "size") if attachment.get(key)}
            for attachment in page.attachments
        ],
        "procedure": procedure_view,
        "dates": {
            key: value.isoformat()
            for key, value in (("published_on", page.published_on), ("modified_on", page.modified_on))
            if value
        },
        **({"location": {key: location[key] for key in ("designation", "insee_code") if location.get(key)}}
           if location else {}),
        **({"manager": {**({"service": services[0]} if services else {}), **({"email": manager_email} if manager_email else {})}}
           if services or manager_email else {}),
    }


def extract_cessions_fields(
    page_text: str | None, *, observed_at: datetime | None = None, insee_fallback: str | None = None
) -> dict[str, Any] | None:
    """Champs bruts d'une vente à partir du texte de la fiche ; ``None`` si la fiche n'est pas structurée."""
    page = parse_cessions_page(page_text)
    if not page.is_structured:
        return None
    reference: date | None = page.modified_on or page.published_on or (observed_at.date() if observed_at else None)
    procedure = analyse_procedure(page.procedure_lines, page.description, reference=reference)
    attach_adjudication_time(procedure, reference)
    natures = _natures(page)
    property_type = property_type_for(page)
    surfaces = _surfaces(page, natures)
    schedule = _schedule_fields(page, procedure, observed_at)
    prices = procedure.get("prices") or {}
    starting_price = published_price(prices)
    manager_email = direction_email(page.managers)
    published_surface = surfaces.get("land_surface_m2") if property_type == "land" else None
    location = _cadastre_location(
        page, page.city, published_surface or surfaces.get("land_surface_m2"), insee_fallback
    )
    typed = {
        item.key: _typed_value(item.kind, item.value) for item in page.characteristics if item.key
    }
    availability = page.value("availability") or ""
    fields: dict[str, Any] = {
        **schedule,
        "property_type": property_type,
        "starting_price_eur": starting_price,
        "dpe_class": page.energy.get("dpe_class"),
        "ges_class": page.energy.get("ges_class"),
        "rooms_count": typed.get("rooms_count") if isinstance(typed.get("rooms_count"), int) else None,
        "bedrooms_count": typed.get("bedrooms_count") if isinstance(typed.get("bedrooms_count"), int) else None,
        "bathrooms_count": typed.get("bathrooms_count") if isinstance(typed.get("bathrooms_count"), int) else None,
        "parking_count": typed.get("parking_spaces") if isinstance(typed.get("parking_spaces"), int) else None,
        "occupancy_status": "libre" if _VACANT_RE.search(availability) else None,
        "visit_dates": list(procedure.get("visits") or []),
    }
    if surfaces.get("built_surface_m2"):
        fields["surface_m2"] = surfaces["built_surface_m2"]
    elif property_type == "land" and surfaces.get("land_surface_m2"):
        fields["surface_m2"] = surfaces["land_surface_m2"]
    elif surfaces.get("surface_unscoped_m2"):
        fields["surface_unscoped_m2"] = surfaces["surface_unscoped_m2"]
    if surfaces.get("land_surface_m2"):
        fields["land_surface_m2"] = surfaces["land_surface_m2"]
    if page.city:
        fields["city"] = page.city
    if page.department:
        fields["department"] = page.department
    display = _display_block(
        page, natures=natures, surfaces=surfaces, procedure=procedure, schedule=schedule,
        location=location, manager_email=manager_email,
    )
    # Rien d'horodaté dans les blocs : ils entrent dans l'empreinte « contenu source »,
    # qui ne doit changer que si la fiche change (sinon chaque passage relancerait l'IA).
    blocks = {
        "categorie": page.category,
        "nature_bien": " ; ".join(label for label, _, _ in natures) or None,
        "code_nature": natures[0][1] if natures else None,
        "date_publication": page.published_on.isoformat() if page.published_on else None,
        "date_modification": page.modified_on.isoformat() if page.modified_on else None,
        "etat_annonce": page.badge,
        "procedure_vente": procedure.get("method_source_label") or ("Procédure à venir" if procedure.get("pending") else None),
        "procedure_commentaire": procedure.get("comment"),
        "gestionnaire_email": manager_email,
        "designation_cadastrale": location.get("designation") if location else None,
        "nombre_photos": page.gallery.get("photos"),
        "pieces_jointes": "; ".join(attachment["label"] for attachment in page.attachments) or None,
        "caracteristiques_bien": display,
        **{f"caracteristique_{item.key}": item.value for item in page.characteristics if item.key},
    }
    features = {
        "schema_version": FEATURES_SCHEMA_VERSION,
        "property_type": property_type,
        "nature": [{"label": label, "code": code, "property_type": kind} for label, code, kind in natures],
        "category": page.category,
        "characteristics": typed,
        "characteristics_raw": [
            {"key": item.key, "label": item.label, "value": item.value, "group": item.group, "nature": item.nature}
            for item in page.characteristics
        ],
        "surface": surfaces,
        "energy": dict(page.energy),
        "procedure": {
            **procedure,
            # ``method`` garde le libellé publié (contrat historique) ; le code normalisé est à part.
            "method": procedure.get("method_source_label") or procedure.get("method_label"),
            "method_code": procedure.get("method"),
            "selected": {k: v for k, v in schedule.items() if v is not None},
        },
        "manager": {
            "managers": page.managers,
            "direction_email": manager_email,
            "manager_name": next((item["name"] for item in page.managers if item.get("name")), None),
            "email": manager_email,
            "phone": next((item["phone"] for item in page.managers if item.get("phone")), None),
        },
        "media": {**{f"{key}_count": value for key, value in page.gallery.items()}, "gallery_files": page.gallery_files[:20],
                  "attachments": page.attachments, "attachment_count": len(page.attachments)},
        "dates": display["dates"],
        "listing": {"badge": page.badge, "countdown_days": page.countdown_days, "reference": page.reference},
        **({"cadastre_location": {k: v for k, v in location.items() if k != "resolution"}} if location else {}),
    }
    return {
        "fields": fields,
        "source_blocks": {key: value for key, value in blocks.items() if value not in (None, "", [], {})},
        "source_property_features": features,
        "cadastre_location": location,
        "observed_at": observed_at,
        "page": page,
    }


def observed_at_for(raw_sale: dict[str, Any]) -> datetime | None:
    """Instant d'observation du texte stocké (pour lire « Fini dans N jours »)."""
    explicit = parse_observed_at(raw_sale.get("source_page_observed_at"))
    if explicit:
        return explicit
    checks = raw_sale.get("source_checks") if isinstance(raw_sale.get("source_checks"), dict) else {}
    check = checks.get(str(raw_sale.get("source_url") or "")) if checks else None
    if isinstance(check, dict) and check.get("detail_status") == "complete":
        return parse_observed_at(check.get("checked_at"))
    return None


REPLACED_FIELDS = (
    "sale_date", "sale_date_kind", "date_precision", "source_sale_schedule", "state_listing", "status",
)


def apply_cessions_fields(raw_sale: dict[str, Any], extracted: dict[str, Any]) -> dict[str, Any]:
    """Applique une extraction à une vente brute (collecte ou relecture en base)."""
    fields = extracted["fields"]
    for key in REPLACED_FIELDS:
        value = fields.get(key)
        if value in (None, "", {}, []):
            raw_sale.pop(key, None)
        else:
            raw_sale[key] = value
    for key, value in fields.items():
        if key in REPLACED_FIELDS or value in (None, "", [], {}):
            continue
        if key == "visit_dates":
            existing = [item for item in raw_sale.get("visit_dates") or [] if isinstance(item, str)]
            raw_sale[key] = list(dict.fromkeys([*value, *existing]))
            continue
        if key == "surface_unscoped_m2":
            # Portée ambiguë (bâti ou contenance) : ne remplace jamais une surface déjà lue.
            if not raw_sale.get("surface_m2"):
                raw_sale["surface_m2"] = value
            continue
        raw_sale[key] = value
    blocks = raw_sale.get("source_blocks") if isinstance(raw_sale.get("source_blocks"), dict) else {}
    blocks = {**blocks, **extracted["source_blocks"]}
    # Les blocs « surface » hérités de la carte (titre « 997 m² ») ne doivent plus
    # supplanter la surface lue par portée.
    for block_key, field_key in (("surface", "surface_m2"), ("surface_terrain", "land_surface_m2")):
        if fields.get(field_key):
            blocks[block_key] = fields[field_key]
    raw_sale["source_blocks"] = blocks
    if extracted.get("observed_at") is not None:
        raw_sale["source_page_observed_at"] = extracted["observed_at"].astimezone(UTC).isoformat()
    previous = raw_sale.get("source_property_features") if isinstance(raw_sale.get("source_property_features"), dict) else {}
    kept = {key: value for key, value in previous.items() if key in {"cadastre", "urban_planning", "building", "postal_code"}}
    media = previous.get("media") if isinstance(previous.get("media"), dict) else {}
    features = {**kept, **extracted["source_property_features"]}
    features["media"] = {**{k: v for k, v in media.items() if k in {"images", "image_count", "documents", "document_count"}},
                         **features["media"]}
    # Contacts lus dans le HTML (attribut ``data-contacts``) : prioritaires sur le texte.
    legacy_manager = previous.get("manager") if isinstance(previous.get("manager"), dict) else {}
    features["manager"] = {
        **features["manager"],
        **{key: value for key, value in legacy_manager.items() if value not in (None, "", [], {})},
    }
    raw_sale["source_property_features"] = features
    location = extracted.get("cadastre_location")
    if location:
        previous_location = raw_sale.get("cadastre_location") if isinstance(raw_sale.get("cadastre_location"), dict) else {}
        if previous_location.get("signature") == location.get("signature") and previous_location.get("resolution"):
            location = {**location, "resolution": previous_location["resolution"]}
        raw_sale["cadastre_location"] = location
    else:
        raw_sale.pop("cadastre_location", None)
    if fields.get("dpe_class") or fields.get("ges_class"):
        blocks = raw_sale["source_blocks"]
        if fields.get("dpe_class"):
            blocks["dpe_classe"] = fields["dpe_class"]
        if fields.get("ges_class"):
            blocks["ges_classe"] = fields["ges_class"]
    return raw_sale


def refresh_cessions_raw_sale(raw_sale: dict[str, Any]) -> bool:
    """Rejoue l'extraction sur le texte stocké d'une vente ``cessions_etat`` (sans réseau)."""
    if str(raw_sale.get("source_name") or "") != "cessions_etat":
        return False
    blocks = raw_sale.get("source_blocks") if isinstance(raw_sale.get("source_blocks"), dict) else {}
    page_text = blocks.get("page_text")
    if not isinstance(page_text, str) or not page_text.strip():
        return False
    extracted = extract_cessions_fields(
        page_text,
        observed_at=observed_at_for(raw_sale),
        # Code INSEE lu à la collecte dans la carte de la fiche (absent du texte stocké).
        insee_fallback=str(blocks.get("code_insee_carte") or "") or None,
    )
    if extracted is None:
        return False
    apply_cessions_fields(raw_sale, extracted)
    return True
