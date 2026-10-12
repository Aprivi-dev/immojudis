"""Caractéristiques d'une vente « Enchères Publiques » relues depuis ses blocs.

La fiche du site (état Apollo du lot) est lue par :mod:`src.sources.encheres_publiques`
quand la collecte est autorisée (``ENCHERES_PUBLIQUES_ACCESS_AUTHORIZED``). Ce
module ne fait aucune requête : il relit les blocs déjà retenus (descriptif,
critères, conditions, frais, renseignements, visites, occupation, diagnostics,
type de vente) pour en tirer les informations utiles à un investisseur :

* mode de participation (en ligne, en salle) et cadre (judiciaire, volontaire) ;
* honoraires à la charge de l'acquéreur (pourcentage) ou du vendeur ;
* pas minimal des enchères, barreau des avocats admis à enchérir, prolongation
  anti-dernière-seconde, baisses successives jusqu'à un prix plancher ;
* lieu de consultation du cahier des conditions ;
* occupation déclarée par le critère et par le descriptif (les deux sont gardés
  quand ils divergent) ;
* références cadastrales et lots de copropriété cités au descriptif.

Les pièces jointes du site ne sont pas collectées : le collecteur écarte les
URL de documents (robots.txt du site) et tout accès reste soumis à la même
autorisation que la collecte, non accordée à ce jour. Le bloc l'indique au lieu
d'inventer une liste.
"""

from __future__ import annotations

import re
from typing import Any

from src.cadastre_references import designation, parse_cadastral_references, ref_label
from src.normalize import clean_text

FEATURES_SCHEMA_VERSION = "encheres_publiques_features_v1"
DISPLAY_SCHEMA_VERSION = "property_characteristics_v1"
_SALE_TYPE_RE = re.compile(r"Type de vente\s*:\s*(?P<mode>[^\n-]+?)(?:\s+-\s+(?P<framework>[^\n]+))?$", re.I | re.M)
_FEE_PERCENT_RE = re.compile(r"(?P<payer>acqu[ée]reur|vendeur)[^()\n]{0,40}\((?P<rate>\d{1,2}(?:[.,]\d{1,2})?)\s*%\)", re.I)
_SELLER_FEES_RE = re.compile(r"honoraires\s+[àa]\s+la\s+charge\s+du\s+vendeur", re.I)
_INCREMENT_RE = re.compile(r"ench[èe]res\s+qui\s+ne\s+seront\s+pas\s+inf[ée]rieures\s+[àa]\s+(?P<amount>[\d\s.,]+)\s*€", re.I)
_BAR_RE = re.compile(r"(?:avocat|ministère\s+d['’]un\s+avocat)[^.]{0,40}?\bbarreau\s+(?:de|du|d['’])\s*(?P<bar>[A-Za-zÀ-ÖØ-öø-ÿŒœŸ' -]+?)\s*[.,;]?$", re.I)
_EXTENSION_RE = re.compile(r"d[ée]cal[ée]e?\s+de\s+(?P<minutes>\d{1,2})\s+minutes?", re.I)
_FLOOR_RE = re.compile(r"baisses?\s+successives?\s+jusqu['’]?\s*[àa]\s+(?P<amount>[\d\s.,]+)\s*€", re.I)
_CONSULTATION_RE = re.compile(r"consult[ée]s?\s+(?P<where>au\s+.+?)\.?$", re.I)
_CADASTRE_RE = re.compile(
    r"\bcadastr[ée]e?s?\s+(?:sous\s+(?:le|les)\s+)?(?:section\s+)?[A-Z]{1,2}\s*(?:n\s*[°º]|num[ée]ros?)?\s*\d{1,4}"
    r"(?:\s*(?:,|et|à)\s*(?:n\s*[°º]\s*)?\d{1,4})*",
    re.I,
)
_COPRO_LOT_RE = re.compile(r"\blot\s*n?\s*[°º]?\s*(\d{1,5})\b", re.I)
_OCCUPIED_DESCRIPTION_RE = re.compile(
    r"occupation\s*:\s*(?P<text>[^.;]+)|(?P<inline>(?:lieux|biens?)\s+(?:sont|est)\s+(?:occup|lou|libre)[^.;]*)", re.I,
)


def _amount(value: str | None) -> float | None:
    text = re.sub(r"[\s  ]", "", value or "")
    text = re.sub(r"[.,]00$", "", text).replace(".", "").replace(",", ".")
    try:
        amount = float(text)
    except ValueError:
        return None
    return amount if amount > 0 else None


def _sale_type(raw_text: str) -> tuple[str | None, str | None]:
    match = _SALE_TYPE_RE.search(raw_text or "")
    if not match:
        return None, None
    return clean_text(match.group("mode")), clean_text(match.group("framework"))


def _fees(text: str | None) -> dict[str, Any]:
    value = clean_text(text)
    if not value:
        return {}
    fees: dict[str, Any] = {"text": value}
    match = _FEE_PERCENT_RE.search(value)
    if match:
        payer = "buyer" if match.group("payer").lower().startswith("acqu") else "seller"
        fees[f"{payer}_fee_percent"] = float(match.group("rate").replace(",", "."))
    elif _SELLER_FEES_RE.search(value):
        fees["seller_pays_fees"] = True
    return fees


def _conditions(text: str | None) -> dict[str, Any]:
    value = clean_text(text)
    if not value:
        return {}
    conditions: dict[str, Any] = {"text": value}
    if match := _INCREMENT_RE.search(value):
        conditions["bid_increment_eur"] = _amount(match.group("amount"))
    if match := _BAR_RE.search(value):
        conditions["eligible_bar"] = clean_text(match.group("bar")).title()
    if match := _EXTENSION_RE.search(value):
        conditions["extension_minutes"] = int(match.group("minutes"))
    if match := _FLOOR_RE.search(value):
        conditions["floor_price_eur"] = _amount(match.group("amount"))
    if re.search(r"immo-?interactif", value, re.I):
        conditions["format"] = "Immo-interactif"
    elif re.search(r"au\s+chronom[èe]tre", value, re.I):
        conditions["format"] = "Vente au chronomètre"
    return {key: item for key, item in conditions.items() if item not in (None, "")}


def _cadastre(text: str | None, city: str | None) -> dict[str, Any] | None:
    refs = []
    for match in _CADASTRE_RE.finditer(text or ""):
        fragment = re.sub(r"^cadastr\w*\s+(?:sous\s+(?:le|les)\s+)?", "", match.group(0), flags=re.I)
        for ref in parse_cadastral_references(fragment):
            if ref not in refs:
                refs.append(ref)
    if not refs:
        return None
    return {"parcels": [ref_label(ref) for ref in refs], "designation": designation(refs, city)}


def _occupancy_from_description(text: str | None) -> str | None:
    match = _OCCUPIED_DESCRIPTION_RE.search(text or "")
    if not match:
        return None
    return clean_text(match.group("text") or match.group("inline"))


def extract_encheres_publiques_characteristics(raw_sale: dict[str, Any]) -> dict[str, Any] | None:
    """Bloc ``caracteristiques_bien`` et caractéristiques structurées ; ``None`` sans blocs."""
    blocks = raw_sale.get("source_blocks") if isinstance(raw_sale.get("source_blocks"), dict) else {}
    if not blocks:
        return None
    raw_text = str(raw_sale.get("raw_text") or "")
    description = clean_text(blocks.get("description")) or clean_text(raw_sale.get("description"))
    city = clean_text(raw_sale.get("city"))
    mode, framework = _sale_type(raw_text)
    fees = _fees(blocks.get("frais_de_vente"))
    conditions = _conditions(blocks.get("conditions_de_vente"))
    consultation = None
    if match := _CONSULTATION_RE.search(clean_text(blocks.get("renseignements_de_vente")) or ""):
        consultation = clean_text(match.group("where"))
    occupancy_criterion = clean_text(blocks.get("occupation"))
    occupancy_description = _occupancy_from_description(description)
    cadastre = _cadastre(description, city)
    lots = list(dict.fromkeys(_COPRO_LOT_RE.findall(description or "")))
    images = [url for url in raw_sale.get("source_images") or [] if isinstance(url, str)]
    schedule = raw_sale.get("source_sale_schedule") if isinstance(raw_sale.get("source_sale_schedule"), dict) else {}
    criteria = {
        key.removeprefix("critere_"): clean_text(value)
        for key, value in blocks.items()
        if key.startswith("critere_") and clean_text(value)
    }
    rows = [
        ("mode_participation", "Mode de participation", mode, "identification"),
        ("cadre_vente", "Cadre de la vente", framework, "identification"),
        ("organisateur", "Organisateur", clean_text(blocks.get("organisateur")), "identification"),
        ("occupation_critere", "Occupation (critère publié)", occupancy_criterion, "situation"),
        ("occupation_descriptif", "Occupation (descriptif)",
         occupancy_description if occupancy_description and occupancy_description != occupancy_criterion else None,
         "situation"),
        ("lots_copropriete", "Lots de copropriété cités", ", ".join(lots) or None, "batiment"),
        ("dpe", "DPE", clean_text(blocks.get("dpe")), "diagnostics"),
        ("ges", "GES", clean_text(blocks.get("ges")), "diagnostics"),
        ("diagnostic_date", "Date des diagnostics", clean_text(blocks.get("diagnostic_date")), "diagnostics"),
        *[(f"critere_{key}", key.replace("_", " ").capitalize(), value, "divers") for key, value in criteria.items()],
        ("honoraires_acquereur", "Honoraires à la charge de l'acquéreur",
         f"{fees['buyer_fee_percent']:g} %".replace(".", ",") if fees.get("buyer_fee_percent") else None, "divers"),
        ("honoraires_vendeur", "Honoraires", "À la charge du vendeur" if fees.get("seller_pays_fees") else None, "divers"),
        ("frais", "Frais de vente", fees.get("text"), "divers"),
        ("barreau", "Avocats admis à enchérir", conditions.get("eligible_bar") and f"Barreau de {conditions['eligible_bar']}",
         "divers"),
        ("format_enchere", "Format des enchères", conditions.get("format"), "divers"),
        ("prolongation", "Prolongation en fin d'enchères",
         f"{conditions['extension_minutes']} minutes" if conditions.get("extension_minutes") else None, "divers"),
        ("conditions", "Conditions de vente", conditions.get("text"), "divers"),
        ("consultation_cahier", "Cahier des conditions consultable", consultation, "divers"),
        ("visites_modalites", "Modalités de visite", clean_text(blocks.get("visites")), "divers"),
        ("pieces_jointes", "Pièces jointes", "Non collectées (accès au site soumis à autorisation)", "divers"),
    ]
    procedure: dict[str, Any] = {}
    if framework or mode:
        procedure["method_label"] = " — ".join(filter(None, (framework, mode)))
    prices = {
        key: value for key, value in (
            ("starting_price_eur", _amount(str(raw_sale.get("starting_price_eur") or ""))),
            ("bid_increment_eur", conditions.get("bid_increment_eur")),
            ("floor_price_eur", conditions.get("floor_price_eur")),
        ) if value
    }
    if prices:
        procedure["prices"] = prices
    if schedule.get("opens_at") and schedule.get("closes_at"):
        procedure["window"] = {"opens_at": schedule["opens_at"], "closes_at": schedule["closes_at"]}
        procedure["deadline"] = {"at": schedule["closes_at"], "kind": "sale_window_close"}
    elif raw_sale.get("sale_date"):
        procedure["deadline"] = {"at": str(raw_sale["sale_date"]), "kind": "adjudication"}
    visits = [clean_text(item) for item in raw_sale.get("visit_dates") or [] if clean_text(item)]
    if visits:
        procedure["visits"] = visits
    display = {
        "schema_version": DISPLAY_SCHEMA_VERSION,
        "source": "encheres_publiques",
        "nature": [],
        "category": clean_text(raw_sale.get("property_type")),
        "items": [
            {"key": key, "label": label, "value": str(value), "group": group}
            for key, label, value, group in rows
            if value not in (None, "")
        ],
        "surfaces": {},
        "energy": {key: value for key, value in (("dpe_class", clean_text(blocks.get("dpe"))),
                                                  ("ges_class", clean_text(blocks.get("ges")))) if value},
        "media": {"photos": len(images)} if images else {},
        "attachments": [],
        "procedure": procedure,
        "dates": {},
        **({"location": {"designation": cadastre["designation"]}} if cadastre and cadastre.get("designation") else {}),
    }
    # DPE et GES sont dans ``energy`` : les tuiles en double sont retirées.
    display["items"] = [item for item in display["items"] if item["key"] not in {"dpe", "ges"}]
    features = {
        "schema_version": FEATURES_SCHEMA_VERSION,
        "sale": {"participation_mode": mode, "framework": framework, "organizer": clean_text(blocks.get("organisateur")),
                 "organizer_category": clean_text(blocks.get("organisateur_categorie"))},
        "fees": fees,
        "auction_rules": {key: value for key, value in conditions.items() if key != "text"},
        "conditions": {"consultation": consultation, "attachments_collected": False},
        "occupancy": {"criterion": occupancy_criterion, "description": occupancy_description},
        "criteria": criteria,
        "coownership_lots": lots,
        **({"cadastre_references": cadastre} if cadastre else {}),
        "media": {"photo_count": len(images)},
    }
    blocks_out = {
        "mode_participation": mode,
        "cadre_vente": framework,
        "honoraires_acquereur_pourcent": fees.get("buyer_fee_percent"),
        "pas_enchere_eur": conditions.get("bid_increment_eur"),
        "prix_plancher_eur": conditions.get("floor_price_eur"),
        "barreau_admis": conditions.get("eligible_bar"),
        "prolongation_minutes": conditions.get("extension_minutes"),
        "consultation_cahier_conditions": consultation,
        # Clé sans « descriptif » : elle ne doit pas concourir comme description de la vente.
        "occupation_selon_texte": occupancy_description,
        "designation_cadastrale": cadastre.get("designation") if cadastre else None,
        "caracteristiques_bien": display,
    }
    return {
        "source_blocks": {key: value for key, value in blocks_out.items() if value not in (None, "", [], {})},
        "source_property_features": _prune(features),
    }


def refresh_encheres_publiques_raw_sale(raw_sale: dict[str, Any]) -> bool:
    """Relecture locale des blocs stockés (aucune requête, aucune nouvelle collecte)."""
    if str(raw_sale.get("source_name") or "") != "encheres_publiques":
        return False
    extracted = extract_encheres_publiques_characteristics(raw_sale)
    if extracted is None:
        return False
    blocks = raw_sale.get("source_blocks") if isinstance(raw_sale.get("source_blocks"), dict) else {}
    raw_sale["source_blocks"] = {**blocks, **extracted["source_blocks"]}
    previous = raw_sale.get("source_property_features") if isinstance(raw_sale.get("source_property_features"), dict) else {}
    raw_sale["source_property_features"] = {**previous, **extracted["source_property_features"]}
    return True


def _prune(value: Any) -> Any:
    if isinstance(value, dict):
        pruned = {key: _prune(item) for key, item in value.items()}
        return {key: item for key, item in pruned.items() if item not in (None, "", [], {})}
    if isinstance(value, list):
        return [_prune(item) for item in value]
    return value
