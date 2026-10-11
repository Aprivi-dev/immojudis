"""Données structurées d'une fiche « Enchères Immobilières » (objet ``vente``).

La fiche est une page Next.js : le HTML rendu ne montre que l'onglet actif
(« Description ») ; l'objet ``vente`` transmis au navigateur dans le flux
``self.__next_f`` porte en plus les pièces jointes (texte complet de l'annonce,
cahier des conditions de vente, PV de description, diagnostics…), la galerie,
les visites horodatées, les coordonnées, l'avocat poursuivant, le tribunal, la
référence du cahier des conditions (date de dépôt et numéro RG), la parution et
le résultat. Les URL suivent celles du site : ``/documents/{vente}/{fichier}``
pour les pièces et ``/images/photos/{fichier}`` pour la galerie.

Fonctions pures, sans réseau : :func:`extract_vente_payload` lit l'objet,
:func:`vente_fields` en déduit les champs bruts, les blocs et les
caractéristiques (même contrat que les cessions de l'État).
"""

from __future__ import annotations

import json
import re
from datetime import datetime
from typing import Any
from zoneinfo import ZoneInfo

from bs4 import BeautifulSoup

from src.normalize import clean_text

BASE_URL = "https://encheresimmobilieres.fr"
DOCUMENTS_URL = f"{BASE_URL}/documents"
PHOTOS_URL = f"{BASE_URL}/images/photos"
FEATURES_SCHEMA_VERSION = "encheres_immobilieres_features_v1"
DISPLAY_SCHEMA_VERSION = "property_characteristics_v1"
PARIS = ZoneInfo("Europe/Paris")
# Libellés publiés par le site (fonction ``documentLabel`` de la page).
DOCUMENT_LABELS = {
    "texte_complet": "Texte complet",
    "ccv": "Cahier des conditions des ventes",
    "pv_descriptif": "PV de description",
    "diagnostic": "Diagnostic et urbanisme",
    "autres": "Autres",
}
# Types compris par la classification des pièces (``pdf_document_types``).
DOCUMENT_TYPES = {
    "texte_complet": "annonce_vente",
    "ccv": "cahier_conditions",
    "pv_descriptif": "pv_descriptif",
    "diagnostic": "diagnostic",
    "autres": "document",
}
STATUS_LABELS = {"en_cours": "Vente à venir", "resultat": "Résultat publié", "archive": "Archivée"}
_FLIGHT_CHUNK_RE = re.compile(r'self\.__next_f\.push\(\[1,"((?:[^"\\]|\\.)*)"\]\)', re.S)
_MONTHS = (
    "janvier", "février", "mars", "avril", "mai", "juin",
    "juillet", "août", "septembre", "octobre", "novembre", "décembre",
)
_WEEKDAYS = ("lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi", "dimanche")


def _flight(html: str) -> str:
    parts: list[str] = []
    for chunk in _FLIGHT_CHUNK_RE.findall(html or ""):
        try:
            parts.append(json.loads(f'"{chunk}"'))
        except json.JSONDecodeError:
            continue
    return "".join(parts)


def _object_at(text: str, start: int) -> str | None:
    depth = 0
    in_string = escaped = False
    for index in range(start, len(text)):
        char = text[index]
        if escaped:
            escaped = False
        elif char == "\\":
            escaped = True
        elif char == '"':
            in_string = not in_string
        elif not in_string and char == "{":
            depth += 1
        elif not in_string and char == "}":
            depth -= 1
            if depth == 0:
                return text[start : index + 1]
    return None


def _text_chunk(flight: str, reference: str) -> str | None:
    """Résout une référence ``$54`` vers le bloc texte ``54:T<taille>,<contenu>``."""
    match = re.fullmatch(r"\$([0-9a-f]+)", reference or "")
    if not match:
        return None
    raw = flight.encode("utf-8")
    marker = re.search(rb"(?:^|\n|\])" + match.group(1).encode() + rb":T([0-9a-f]+),", raw)
    if not marker:
        return None
    size = int(marker.group(1), 16)
    return raw[marker.end() : marker.end() + size].decode("utf-8", errors="ignore")


def extract_vente_payload(html: str, vente_id: str | None = None) -> dict[str, Any] | None:
    """Objet ``vente`` de la fiche (``None`` si absent ou d'une autre vente)."""
    flight = _flight(html)
    position = flight.find('"vente":{')
    while position != -1:
        candidate = _object_at(flight, position + len('"vente":'))
        try:
            vente = json.loads(candidate) if candidate else None
        except json.JSONDecodeError:
            vente = None
        if isinstance(vente, dict) and vente.get("id") is not None and (
            vente_id is None or str(vente.get("id")) == str(vente_id)
        ):
            description = vente.get("description")
            if isinstance(description, str) and description.startswith("$"):
                vente["description"] = _text_chunk(flight, description)
            return vente
        position = flight.find('"vente":{', position + 1)
    return None


def _date(value: object) -> datetime | None:
    text = clean_text(value)
    if not text:
        return None
    text = text[2:] if text.startswith("$D") else text
    # Le site enregistre l'heure locale affichée suivie d'un « Z » : « 2026-11-19T09:00:00.000Z »
    # s'affiche « jeudi 19 novembre 2026 à 09h00 ». L'heure est donc lue comme heure de Paris.
    text = re.sub(r"(?:Z|[+-]00:?00)$", "", text)
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    return parsed.astimezone(PARIS) if parsed.tzinfo else parsed.replace(tzinfo=PARIS)


def _hour(value: datetime) -> str:
    return f"{value.hour:02d}h{value.minute:02d}"


def _day_label(value: datetime) -> str:
    return f"{_WEEKDAYS[value.weekday()]} {value.day} {_MONTHS[value.month - 1]} {value.year}"


def _html_text(value: object) -> str | None:
    text = clean_text(value)
    if not text:
        return None
    soup = BeautifulSoup(text, "html.parser")
    lines = [clean_text(line) for line in soup.get_text("\n", strip=True).splitlines()]
    return clean_text(" ".join(line for line in lines if line))


def _contact(record: object) -> dict[str, str]:
    if not isinstance(record, dict):
        return {}
    address = ", ".join(
        part for part in (
            clean_text(record.get("adresse")),
            " ".join(filter(None, (clean_text(record.get("codePostal")), clean_text(record.get("ville"))))),
        ) if part
    )
    values = {
        "name": clean_text(record.get("nom")),
        "address": address or None,
        "phone": clean_text(record.get("tel")) or clean_text(record.get("telBis")),
        "email": clean_text(record.get("email") or record.get("mail")),
        "details": _html_text(record.get("complement")),
    }
    return {key: value for key, value in values.items() if value}


def vente_documents(vente: dict[str, Any]) -> list[dict[str, str]]:
    """Pièces jointes publiées, avec le libellé du site (« Cahier des conditions des ventes (2) »)."""
    documents: list[dict[str, str]] = []
    counts: dict[str, int] = {}
    for item in vente.get("documents") or []:
        if not isinstance(item, dict) or not clean_text(item.get("name")):
            continue
        kind = clean_text(item.get("type")) or "autres"
        counts[kind] = counts.get(kind, 0) + 1
        label = DOCUMENT_LABELS.get(kind, clean_text(item.get("type")) or "Document")
        if kind == "ccv" and counts[kind] > 1:
            label = f"{label} ({counts[kind]})"
        documents.append({
            "label": label,
            "url": f"{DOCUMENTS_URL}/{vente['id']}/{clean_text(item['name'])}",
            "type": DOCUMENT_TYPES.get(kind, "document"),
        })
    return documents


def vente_photos(vente: dict[str, Any]) -> list[str]:
    photos = [item for item in vente.get("photos") or [] if isinstance(item, dict) and clean_text(item.get("name"))]
    photos.sort(key=lambda item: (item.get("position") is None, item.get("position") or 0))
    return list(dict.fromkeys(f"{PHOTOS_URL}/{clean_text(item['name'])}" for item in photos))


def vente_visits(vente: dict[str, Any]) -> list[str]:
    visits: list[str] = []
    for item in vente.get("visites") or []:
        if not isinstance(item, dict):
            continue
        start, end = _date(item.get("start")), _date(item.get("end"))
        if start is None:
            continue
        label = f"{_day_label(start)} de {_hour(start)}"
        if end and end.date() == start.date():
            label += f" à {_hour(end)}"
        complement = clean_text(item.get("complement"))
        if complement:
            label += f" ({complement})"
        if label not in visits:
            visits.append(label)
    return visits


def vente_lots(vente: dict[str, Any]) -> list[dict[str, Any]]:
    """Lots d'une vente en plusieurs lots : désignation, complément, mise à prix, adjudication."""
    lots: list[dict[str, Any]] = []
    for item in vente.get("lots") or []:
        if not isinstance(item, dict):
            continue
        designation = clean_text(str(item.get("designation") or "").lstrip("•· "))
        lot = {
            "designation": designation,
            "details": _html_text(item.get("complement")),
            "starting_price_eur": _amount(item.get("prix")),
            "adjudication_price_eur": _amount(item.get("adjudication")),
            "outcome": clean_text(item.get("resultatAdjudication")),
        }
        lot = {key: value for key, value in lot.items() if value not in (None, "")}
        if lot.get("designation"):
            lots.append(lot)
    return lots[:20]


def _lot_label(lot: dict[str, Any]) -> str:
    parts = [lot["designation"]]
    if lot.get("details"):
        parts.append(lot["details"])
    if lot.get("starting_price_eur"):
        parts.append(f"mise à prix {int(lot['starting_price_eur']):,} €".replace(",", " "))
    if lot.get("adjudication_price_eur"):
        parts.append(f"adjugé {int(lot['adjudication_price_eur']):,} €".replace(",", " "))
    return " — ".join(parts)


def _conditions_reference(value: object) -> dict[str, str]:
    text = clean_text(value) or ""
    deposit = re.search(r"\b(\d{2}/\d{2}/\d{4})\b", text)
    rg = re.search(r"\bRG\s*:?\s*(\d{2}/\d{3,6})\b", text, re.I)
    return {key: value for key, value in (("deposit_date", deposit and deposit.group(1)), ("rg", rg and rg.group(1)), ("raw", text or None)) if value}


def _amount(value: object) -> float | None:
    try:
        amount = float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None
    return amount if amount > 0 else None


def vente_fields(vente: dict[str, Any]) -> dict[str, Any]:
    """Champs bruts, blocs et caractéristiques déduits de l'objet ``vente``."""
    documents = vente_documents(vente)
    photos = vente_photos(vente)
    visits = vente_visits(vente)
    sale_at = _date(vente.get("dateVente"))
    published = _date(vente.get("dateParution"))
    postponed = _date(vente.get("dateReportAdjudication"))
    lawyer = _contact(vente.get("avocat"))
    # L'adresse électronique publiée pour le tribunal est nominative (greffe) : non reprise.
    court = {key: value for key, value in _contact(vente.get("tgi")).items() if key != "email"}
    winning_lawyer = _contact(vente.get("avocatAdjudication"))
    trustee = _contact(vente.get("mandataire"))
    conditions = _conditions_reference(vente.get("ccv"))
    lots_text = _html_text(vente.get("complement"))
    description = _html_text(vente.get("description"))
    kinds = [
        clean_text((item.get("type") or {}).get("label"))
        for item in vente.get("typesBiens") or []
        if isinstance(item, dict) and isinstance(item.get("type"), dict)
    ]
    kinds = [kind for kind in kinds if kind]
    journal = vente.get("journal") if isinstance(vente.get("journal"), dict) else {}
    journal_name = clean_text(journal.get("journal") or journal.get("nom") or journal.get("titre"))
    lots = vente_lots(vente)
    adjudication = _amount(vente.get("prixAdjudication"))
    starting = _amount(vente.get("prix"))
    address = ", ".join(
        part for part in (
            clean_text(vente.get("adresse")),
            " ".join(filter(None, (clean_text(vente.get("codePostal")), clean_text(vente.get("ville"))))),
        ) if part
    ) or None
    sale_type = clean_text(vente.get("typeVente"))
    auction_type = clean_text(vente.get("typeEnchere"))
    status = clean_text(vente.get("statut"))
    fields: dict[str, Any] = {
        "external_id": str(vente.get("id")),
        "address": address,
        "postal_code": clean_text(vente.get("codePostal")),
        "department": clean_text(vente.get("departement")),
        "starting_price_eur": starting,
        "adjudication_price_eur": adjudication,
        "sale_date": sale_at.isoformat() if sale_at else None,
        "visit_dates": visits,
        "lawyer_name": lawyer.get("name"),
        "lawyer_contact": lawyer.get("phone") or lawyer.get("email"),
        "tribunal": court.get("name"),
        "latitude": vente.get("latitude"),
        "longitude": vente.get("longitude"),
        "documents": documents,
        "source_images": photos,
        "description_html_text": description,
    }
    items = [
        ("numero_vente", "Vente n°", vente.get("id"), "identification"),
        ("type_vente", "Type de vente", sale_type and sale_type.capitalize(), "identification"),
        ("type_enchere", "Type d'enchère", auction_type if auction_type and auction_type != "normal" else None, "identification"),
        ("lots", "Lots", lots_text, "batiment"),
        *[(f"lot_{index}", f"Lot {index}", _lot_label(lot), "batiment") for index, lot in enumerate(lots, start=1)],
        ("adresses_multiples", "Adresses multiples", "Oui" if vente.get("adressesMultiples") else None, "situation"),
        ("cahier_conditions", "Cahier des conditions de vente",
         " — ".join(filter(None, (conditions.get("rg") and f"RG {conditions['rg']}",
                                 conditions.get("deposit_date") and f"déposé le {conditions['deposit_date']}"))) or None,
         "divers"),
        ("parution", "Parution", journal_name, "divers"),
        ("avocat_poursuivant", "Avocat poursuivant",
         " — ".join(filter(None, (lawyer.get("name"), lawyer.get("details"), lawyer.get("address")))) or None, "divers"),
        ("lieu_vente", "Lieu de l'audience", " — ".join(filter(None, (court.get("name"), court.get("address")))) or None, "divers"),
        ("visites_organisation", "Organisation des visites", clean_text(vente.get("complementVisite")), "divers"),
        ("mandataire", "Mandataire", trustee.get("name"), "divers"),
        ("statut", "Statut de la fiche", STATUS_LABELS.get(status or "", status), "divers"),
        ("avocat_adjudicataire", "Avocat de l'adjudicataire", winning_lawyer.get("name"), "divers"),
    ]
    procedure: dict[str, Any] = {}
    if sale_type:
        procedure["method_label"] = {"judiciaire": "Vente judiciaire", "notariale": "Vente notariale"}.get(
            sale_type.lower(), sale_type.capitalize()
        )
    if sale_at:
        procedure["deadline"] = {"at": sale_at.isoformat(), "kind": "adjudication"}
    if starting:
        procedure["prices"] = {"starting_price_eur": starting}
    if visits:
        procedure["visits"] = visits
    if adjudication and sale_at:
        procedure["sold_on"] = sale_at.date().isoformat()
    display = {
        "schema_version": DISPLAY_SCHEMA_VERSION,
        "source": "encheres_immobilieres",
        "nature": [{"label": kind, "display": kind} for kind in kinds],
        "category": None,
        "items": [
            {"key": key, "label": label, "value": str(value), "group": group}
            for key, label, value, group in items
            if value not in (None, "")
        ],
        "surfaces": {},
        "media": {"photos": len(photos)} if photos else {},
        "attachments": [
            {"label": document["label"], "kind": document["type"], "kind_label": document["label"], "format": "PDF"}
            for document in documents
        ],
        "procedure": procedure,
        "dates": {"published_on": published.date().isoformat()} if published else {},
    }
    blocks = {
        "numero_vente": str(vente.get("id")),
        "type_vente": sale_type,
        "type_enchere": auction_type,
        "lots": lots_text,
        "lots_vente": " | ".join(_lot_label(lot) for lot in lots) or None,
        "entete_avocat": clean_text(vente.get("entete")),
        "cahier_conditions_reference": conditions.get("raw"),
        "numero_rg": conditions.get("rg"),
        "date_depot_cahier": conditions.get("deposit_date"),
        "parution_journal": journal_name,
        "date_parution": published.date().isoformat() if published else None,
        "organisation_visites": clean_text(vente.get("complementVisite")),
        "avocat_poursuivant_adresse": lawyer.get("address"),
        "avocat_poursuivant_email": lawyer.get("email"),
        "lieu_vente_adresse": court.get("address"),
        "statut_fiche": status,
        "prix_adjudication": adjudication,
        "avocat_adjudicataire": winning_lawyer.get("name"),
        "mandataire": trustee.get("name"),
        "pieces_jointes": "; ".join(document["label"] for document in documents) or None,
        "nombre_photos": len(photos) or None,
        "caracteristiques_bien": display,
    }
    features = {
        "schema_version": FEATURES_SCHEMA_VERSION,
        "listing": {
            "id": vente.get("id"),
            "status": status,
            "sale_type": sale_type,
            "auction_type": auction_type,
            "property_types": kinds,
            "multiple_addresses": bool(vente.get("adressesMultiples")),
            "lots_text": lots_text,
            "lots": lots,
        },
        "conditions": conditions,
        "publication": {"journal": journal_name, "date": published.date().isoformat() if published else None},
        "lawyer": lawyer,
        "court": court,
        "trustee": trustee,
        "result": {
            "adjudication_price_eur": adjudication,
            "winning_lawyer": winning_lawyer.get("name"),
            "postponed_to": postponed.isoformat() if postponed else None,
            "outcome": clean_text(vente.get("resultatAdjudication")),
        },
        "visits": {"slots": visits, "organisation": clean_text(vente.get("complementVisite")),
                   "free_access": bool(vente.get("visiteLibre"))},
        "media": {"photo_count": len(photos), "attachment_count": len(documents),
                  "attachments": [{"label": item["label"], "type": item["type"]} for item in documents]},
    }
    return {
        "fields": fields,
        "source_blocks": {key: value for key, value in blocks.items() if value not in (None, "", [], {})},
        "source_property_features": _prune(features),
    }


def _prune(value: Any) -> Any:
    if isinstance(value, dict):
        pruned = {key: _prune(item) for key, item in value.items()}
        return {key: item for key, item in pruned.items() if item not in (None, "", [], {}, False)}
    if isinstance(value, list):
        return [_prune(item) for item in value]
    return value
