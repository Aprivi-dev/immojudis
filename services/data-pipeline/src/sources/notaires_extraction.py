"""Lecture structurée d'une annonce immobilier.notaires.fr / Immo-Interactif.

L'API publique de détail (``/pub-services/inotr-www-annonces/v1/annonces/{id}``)
publie bien plus que ce que la fiche affiche d'emblée : conditions de la vente
(nature de la mise à prix, faculté de baisse, modalités de consignation,
honoraires), équipements, proximités, surfaces annexes, copropriété, inventaire
des pièces du dossier, visite virtuelle. Ce module, sans accès réseau, en tire :

* les faits typés de ``source_property_features`` (clés anglaises stables) ;
* le bloc d'affichage ``source_blocks.caracteristiques_bien`` (même contrat que
  les cessions de l'État, lu par ``src/lib/property-characteristics.ts``) ;
* quelques blocs plats en français (``source_blocks``) utiles aux preuves.

La page Immo-Interactif (``www.immo-interactif.fr``) d'une vente interactive
embarque en JSON (``__NUXT_DATA__``) l'inventaire des pièces déposées par l'office
et le barème d'honoraires : :func:`parse_immo_interactif_page` le décode sans
exécuter de JavaScript.

Les pièces elles-mêmes ne sont pas publiques : le site ne les délivre qu'à un
compte connecté, agréé par l'office et ayant visité le bien. Seul leur
inventaire (type, nombre) est donc conservé ; aucune URL n'est inventée.
Le prix minimum (``prixMin``) et le prix total que l'API expose ne sont jamais
repris : la fiche publique ne les affiche pas (prix de réserve du vendeur).
"""

from __future__ import annotations

import json
import re
from datetime import date
from typing import Any
from urllib.parse import urlsplit

from src.cadastre_references import ParcelRef, designation, ref_label, references_signature
from src.normalize import clean_text, parse_surface

FEATURES_SCHEMA_VERSION = "notaires_features_v2"
DISPLAY_SCHEMA_VERSION = "property_characteristics_v1"
DOCUMENTS_ACCESS_NOTE = (
    "Pièces consultables sur le site de la vente après connexion, agrément de l'office notarial et visite du bien."
)

GROUPS = {
    "identification": "Identification",
    "surfaces": "Surfaces",
    "batiment": "Bâtiment",
    "equipements": "Équipements",
    "situation": "Situation et occupation",
    "copropriete": "Copropriété",
    "proximite": "Proximités",
    "urbanisme": "Urbanisme et terrain",
    "diagnostics": "Diagnostics",
    "divers": "Autres informations",
}

# Libellés officiels du site (I18n_inotr_www_fr.json, octobre 2026).
TYPE_LABELS = {
    "APP": "Appartement",
    "MAI": "Maison / villa",
    "IMM": "Immeuble",
    "IMB": "Immeuble",
    "AGR": "Bien agricole",
    "VIG": "Bien viticole",
    "DIV": "Local divers",
    "LAC": "Local d'activités",
    "LOC": "Local commercial",
    "TER": "Terrain",
    "COM": "Fonds de commerce",
    "GAR": "Garage / parking",
    "PKG": "Garage / parking",
    "AUT": "Autre",
}
EPOQUE_LABELS = {
    "A": "Avant 1850",
    "B": "De 1850 à 1913",
    "C": "De 1914 à 1947",
    "D": "De 1948 à 1969",
    "E": "De 1970 à 1980",
    "F": "De 1981 à 1991",
    "G": "De 1992 à 2000",
    "H": "De 2001 à 2010",
    "I": "De 2011 à 2020",
    "J": "Après 2020",
}
ETAT_LABELS = {"BON": "Bon état", "RENOVER": "À rénover", "RAFRAICHIR": "À rafraîchir", "NEUF": "Neuf"}
EXPOSITION_LABELS = {
    "N": "Nord", "NE": "Nord-Est", "E": "Est", "SE": "Sud-Est",
    "S": "Sud", "SW": "Sud-Ouest", "W": "Ouest", "NW": "Nord-Ouest",
}
SITUATION_LABELS = {"LIBRE": "Libre", "LOUE": "Loué", "OCCUPE": "Occupé"}
CUISINE_LABELS = {"AMERICAINE": "Américaine (ouverte)", "SEPAREE": "Séparée", "INDEPENDANTE": "Indépendante"}
CHAUFFAGE_LABELS = {"INDIVIDUEL": "Individuel", "COLLECTIF": "Collectif", "CENTRAL": "Central"}
ANCIEN_NEUF_LABELS = {"ANCIEN": "Ancien", "NEUF": "Neuf"}
NATURE_MISE_A_PRIX_LABELS = {
    "APRES_FACULTE_BAISSE": "Après faculté de baisse",
    "MISE_A_PRIX": "Mise à prix",
    "SURENCHERE": "Sur surenchère",
    "FACULTE_BAISSE": "Avec faculté de baisse",
    "RESERVE_SANS_DEPART": "Vente avec prix de réserve sans point de départ des enchères",
    "RESERVE_AVEC_DEPART": "Vente avec prix de réserve",
    "BOUQUET": "Sur le bouquet",
    "RENTE": "Sur la rente",
}
MODE_VENTE_LABELS = {"BOUGIE": "à la bougie", "CHRONOMETRE": "au chronomètre"}
TYPE_ADJUDICATION_LABELS = {"VOLONTAIRE": "volontaire", "JUDICIAIRE": "judiciaire"}
ORIGINE_LABELS = {"ADJUDICATION": "Adjudication", "LICITATION": "Licitation", "SAISIE": "Saisie immobilière"}
PAIEMENT_LABELS = {"VIREMENT": "Virement bancaire", "CHEQUE_BANQUE": "Chèque de banque", "CHEQUE": "Chèque"}
PAYER_LABELS = {"ACQUEREUR": "À la charge de l'acquéreur", "VENDEUR": "À la charge du vendeur"}
PROXIMITY_DISTANCE_LABELS = {"DIST300": "à moins de 300 m", "DIST500": "à moins de 500 m", "DIST1000": "à plus de 500 m"}
PROXIMITY_LABELS = {
    "bus": "Bus", "metro": "Métro", "tram": "Tramway", "gare": "Gare", "aeroport": "Aéroport",
    "ecole": "École", "commerce": "Commerces", "pistes": "Pistes de ski", "vueMer": "Vue mer",
}
AMENITY_LABELS = {
    # clé API : (clé stable, libellé, groupe)
    "balcon": ("balcony", "Balcon", "equipements"),
    "terrasse": ("terrace", "Terrasse", "equipements"),
    "jardin": ("garden", "Jardin", "equipements"),
    "cave": ("cellar", "Cave", "equipements"),
    "piscine": ("pool", "Piscine", "equipements"),
    "stationnement": ("parking", "Stationnement", "equipements"),
    "boxFerme": ("closed_box", "Box fermé", "equipements"),
    "cuisine": ("equipped_kitchen", "Cuisine équipée", "equipements"),
    "climatisation": ("air_conditioning", "Climatisation", "equipements"),
    "cheminee": ("fireplace", "Cheminée", "equipements"),
    "doubleVitrage": ("double_glazing", "Double vitrage", "equipements"),
    "parquet": ("parquet", "Parquet", "equipements"),
    "moulures": ("mouldings", "Moulures", "equipements"),
    "spa": ("spa", "Spa", "equipements"),
    "courtTennis": ("tennis_court", "Court de tennis", "equipements"),
    "dependances": ("outbuildings", "Dépendances", "equipements"),
    "dependancesAgricoles": ("farm_outbuildings", "Dépendances agricoles", "equipements"),
    "ecurie": ("stable", "Écurie", "equipements"),
    "salleReception": ("reception_room", "Salle de réception", "equipements"),
    "chambreService": ("service_room", "Chambre de service", "equipements"),
    "maisonAmis": ("guest_house", "Maison d'amis", "equipements"),
    "maisonGardien": ("caretaker_house", "Maison de gardien", "equipements"),
    "parcPaysager": ("landscaped_park", "Parc paysager", "equipements"),
    "ascenseur": ("elevator", "Ascenseur", "batiment"),
    "accesHandicapes": ("accessibility", "Accès handicapés", "batiment"),
    "basseConsommation": ("low_energy_building", "Bâtiment basse consommation", "batiment"),
    "residenceFermee": ("gated_residence", "Résidence fermée", "batiment"),
    "contemporain": ("contemporary", "Architecture contemporaine", "batiment"),
    "architecte": ("architect_designed", "Maison d'architecte", "batiment"),
    "monumentHistorique": ("historic_monument", "Monument historique", "batiment"),
    "sansVisAVis": ("no_overlooking", "Sans vis-à-vis", "situation"),
    "bordMer": ("seaside", "Bord de mer", "situation"),
    "piedsDansEau": ("waterfront", "Pieds dans l'eau", "situation"),
    "pleineCampagne": ("countryside", "En pleine campagne", "situation"),
    "belleVue": ("nice_view", "Belle vue", "situation"),
    "vuePanoramique": ("panoramic_view", "Vue panoramique", "situation"),
    "procheMontagne": ("near_mountains", "Proche montagne", "situation"),
    "procheGolf": ("near_golf", "Proche golf", "situation"),
    "domaineChasse": ("hunting_estate", "Domaine de chasse", "situation"),
}
SURFACE_LABELS = {
    "surfaceCarrez": ("carrez_m2", "Surface Carrez"),
    "surfaceSejour": ("living_room_m2", "Surface du séjour"),
    "surfaceUtile": ("usable_m2", "Surface utile"),
    "surfacePlancher": ("floor_area_m2", "Surface de plancher"),
    "surfaceVente": ("sales_area_m2", "Surface de vente"),
    "surfaceReserve": ("storage_area_m2", "Surface de réserve"),
    "surfaceExploitation": ("operating_area_m2", "Surface d'exploitation"),
    "superficie": ("plot_area_m2", "Superficie"),
}
# Types des pièces : API notaires (enum typeDocuments du module « doc administratif »)
# et page Immo-Interactif (documentType).
DOCUMENT_TYPES: dict[str, tuple[str, str]] = {
    "VNI_CONDITIONS": ("conditions", "Conditions de la vente"),
    "VNI_AGREMENT": ("conditions", "Dossier de demande d'agrément"),
    "DEMANDE_AGREMENT": ("conditions", "Dossier de demande d'agrément"),
    "VNI_ACHAT": ("conditions", "Formulaire d'offre d'achat"),
    "CONDITIONS_VENTE": ("conditions", "Conditions de la vente"),
    "CAHIER_CONDITIONS_VENTE": ("conditions", "Cahier des conditions de vente"),
    "COPRO_SYNTHETIQUE": ("copropriete", "Fiche synthétique de la copropriété"),
    "COPRO_REGLEMENT": ("copropriete", "Règlement de copropriété"),
    "COPRO_DIAG_TECH": ("copropriete", "Diagnostic technique global de la copropriété"),
    "ENTRETIEN_IMM": ("copropriete", "Carnet d'entretien de l'immeuble"),
    "PROCES_VERBAUX_AG": ("copropriete", "Procès-verbaux d'assemblée générale"),
    "DECOMPTE_CHARGES": ("copropriete", "Décompte de charges"),
    "APPELS_FONDS": ("copropriete", "Appels de fonds"),
    "ETAT_IMPAYES_CHARGES": ("copropriete", "État des impayés de charges"),
    "PRE_ETAT_DATE": ("copropriete", "Pré-état daté"),
    "DIAG_TECHNIQUE": ("diagnostics", "Dossier de diagnostic technique"),
    "DOSSIER_DIAGNOSTIC_TECHNIQUE": ("diagnostics", "Dossier de diagnostic technique"),
    "DIAG_DPE": ("diagnostics", "Diagnostic de performance énergétique"),
    "PERFORMANCE_ENERGETIQUE": ("diagnostics", "Diagnostic de performance énergétique"),
    "DIAG_AMIANTE": ("diagnostics", "Diagnostic amiante"),
    "AMIANTE": ("diagnostics", "Diagnostic amiante"),
    "DIAG_PLOMB": ("diagnostics", "Constat de risque d'exposition au plomb"),
    "PLOMB": ("diagnostics", "Constat de risque d'exposition au plomb"),
    "DIAG_TERMITES": ("diagnostics", "État relatif aux termites"),
    "TERMITES": ("diagnostics", "État relatif aux termites"),
    "DIAG_MERULE": ("diagnostics", "Information mérule"),
    "MERULE": ("diagnostics", "Information mérule"),
    "DIAG_GAZ": ("diagnostics", "Diagnostic gaz"),
    "GAZ": ("diagnostics", "Diagnostic gaz"),
    "DIAG_ELECTRICITE": ("diagnostics", "Diagnostic électricité"),
    "ELECTRICITE": ("diagnostics", "Diagnostic électricité"),
    "ERNT": ("diagnostics", "État des risques"),
    "ETAT_DES_RISQUES_ET_POLLUTIONS": ("diagnostics", "État des risques et pollutions"),
    "ETAT_DES_RISQUES_NATURELS_ET_TECHNOLOGIQUES": ("diagnostics", "État des risques naturels et technologiques"),
    "ETAT_NUISANCES_SONORES": ("diagnostics", "État des nuisances sonores aériennes"),
    "ETAT_DES_NUISANCES_SONORES_AERIENNES": ("diagnostics", "État des nuisances sonores aériennes"),
    "MESURAGE": ("diagnostics", "Mesurage (surface)"),
    "CARREZ": ("diagnostics", "Mesurage loi Carrez"),
    "ASSAINISSEMENT": ("diagnostics", "Diagnostic assainissement"),
    "AUTRE_DIAGNOSTIC": ("diagnostics", "Autre diagnostic"),
    "AUTRE": ("autre", "Autre document"),
}
DOCUMENT_CATEGORY_LABELS = {
    "conditions": "Conditions de la vente",
    "copropriete": "Copropriété",
    "diagnostics": "Diagnostics",
    "autre": "Autres documents",
}
# Visites virtuelles citées dans les descriptifs (hébergeurs de visites 360°).
VIRTUAL_TOUR_HOSTS = (
    "view.ricoh360.com", "my.matterport.com", "matterport.com", "nodalview.com", "my.nodalview.com",
    "kuula.co", "visite.immo", "previsite.com", "my.previsite.com", "envisite.fr", "visiterlebien.com",
)
_URL_RE = re.compile(r"https?://[^\s<>\"')\]]+", re.I)
_SECTION_STOPWORDS = {"DE", "DU", "EN", "ET", "AU", "UN", "LE", "LA", "A", "Y"}
_NUMBER_WORD =r"(?:(?i:n(?:°|o|os|º)s?\.?|num[ée]ros?)\s*:?\s*)?"
_PARCEL_RE = re.compile(
    r"(?:\b(?i:section)\s+|\b(?i:cadastr[ée]e?s?)\s+)(?P<section>[A-Z]{1,2}|0[A-Z])\s*" + _NUMBER_WORD
    + r"(?P<numbers>\d{1,4}(?:\s*(?:,|et|&)\s*" + _NUMBER_WORD + r"\d{1,4})*)\b",
)
_FLOOR_PRICE_RE = re.compile(
    r"jusqu['’]\s*(?:à|a)\s+(?:atteindre\s+)?(?:un\s+prix\s+(?:minimum\s+)?de\s+)?"
    r"(\d{1,3}(?:[ .  ]\d{3})+|\d+)\s*(?:€|euros?)",
    re.I,
)


def known(value: object | None) -> str | None:
    text = clean_text(value)
    if not text or text.upper() in {"INCONNU", "NC", "N/A", "NON COMMUNIQUE", "Z"}:
        return None
    return text


def yes_no(value: object | None) -> bool | None:
    text = (clean_text(value) or "").upper()
    if text == "OUI":
        return True
    if text == "NON":
        return False
    return None


def number(value: object | None) -> int | float | None:
    parsed = parse_surface(value)
    if parsed is None or parsed < 0:
        return None
    return int(parsed) if parsed == parsed.to_integral_value() else float(parsed)


def humanize_code(value: object | None) -> str | None:
    text = known(value)
    if not text:
        return None
    if text.isupper() or "_" in text:
        text = text.replace("_", " ").lower()
        return text[:1].upper() + text[1:]
    return text


def label_for(table: dict[str, str], value: object | None) -> str | None:
    text = known(value)
    if not text:
        return None
    return table.get(text.upper()) or humanize_code(text)


def energy_class(value: object | None) -> tuple[str | None, str | None]:
    """Classe A–G publiée, ou statut (« non soumis », « non disponible ») pour Z/Y."""
    text = (clean_text(value) or "").upper()
    if re.fullmatch(r"[A-G]", text):
        return text, None
    if text == "Z":
        return None, "Non soumis"
    if text == "Y":
        return None, "Non disponible"
    return None, None


def iso_date(value: object | None) -> str | None:
    text = clean_text(value)
    if not text:
        return None
    match = re.match(r"(\d{4}-\d{2}-\d{2})", text)
    if not match:
        return None
    try:
        date.fromisoformat(match.group(1))
    except ValueError:
        return None
    return match.group(1)


def _money(value: object | None) -> str | None:
    amount = number(value)
    if amount is None or amount <= 0:
        return None
    return f"{amount:,.0f} €".replace(",", " ")


def _surface_text(value: object | None) -> str | None:
    amount = number(value)
    if amount is None or amount <= 0:
        return None
    text = f"{amount:,.2f}".rstrip("0").rstrip(".").replace(",", " ").replace(".", ",")
    return f"{text} m²"


def floor_price_from_text(value: object | None) -> int | None:
    """Prix plancher d'une faculté de baisse (« … jusqu'à 1 250 000 euros »)."""
    match = _FLOOR_PRICE_RE.search(clean_text(value) or "")
    if not match:
        return None
    digits = re.sub(r"\D", "", match.group(1))
    return int(digits) if digits else None


def virtual_tours(*values: object | None) -> list[str]:
    urls: list[str] = []
    for value in values:
        if isinstance(value, list):
            urls.extend(virtual_tours(*value))
            continue
        text = clean_text(value)
        if not text:
            continue
        candidates = _URL_RE.findall(text) if not text.lower().startswith(("http://", "https://")) else [text]
        for url in candidates:
            url = url.rstrip(".,;")
            host = (urlsplit(url).hostname or "").lower()
            explicit = isinstance(value, str) and text == url
            if explicit or any(host == item or host.endswith(f".{item}") for item in VIRTUAL_TOUR_HOSTS):
                if url not in urls and urlsplit(url).scheme in {"http", "https"}:
                    urls.append(url)
    return urls


def document_inventory(rows: object | None, *, origin: str) -> list[dict[str, Any]]:
    """Pièces annoncées (type, catégorie, libellé) ; aucune URL : leur accès est réservé."""
    if not isinstance(rows, list):
        return []
    inventory: list[dict[str, Any]] = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        code = clean_text(row.get("typeDocument") or row.get("documentType"))
        category, label = DOCUMENT_TYPES.get((code or "").upper(), ("autre", humanize_code(code) or "Document"))
        item: dict[str, Any] = {"type": code, "category": category, "label": label, "origin": origin}
        name = clean_text(row.get("nomDocument"))
        if name:
            item["name"] = name
        size = number(row.get("size"))
        if size:
            item["size_bytes"] = size
        inventory.append(item)
    return inventory


def merge_inventories(*inventories: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Une pièce par type et rang : la page et l'API décrivent le même dossier."""
    merged: list[dict[str, Any]] = []
    for inventory in inventories:
        counts: dict[str, int] = {}
        for item in inventory:
            # Le libellé est commun aux deux vocabulaires (« DIAG_AMIANTE » / « AMIANTE »).
            key = str(item.get("label") or item.get("type"))
            counts[key] = counts.get(key, 0) + 1
            existing = [entry for entry in merged if str(entry.get("label") or entry.get("type")) == key]
            if len(existing) < counts[key]:
                merged.append(item)
    return merged


def cadastral_parcels(text: object | None) -> list[ParcelRef]:
    """Parcelles explicitement citées (« Section BI n° 5 », « section AB n°12 et 13 »)."""
    value = clean_text(text) or ""
    if not re.search(r"cadastr", value, re.I):
        return []
    refs: list[ParcelRef] = []
    for match in _PARCEL_RE.finditer(value):
        section = match.group("section").upper()
        if section in _SECTION_STOPWORDS and match.group(0)[:1].lower() == "c":
            continue  # « cadastrée DE … » : un mot, pas une section
        for digits in re.findall(r"\d{1,4}", match.group("numbers")):
            ref = ParcelRef(section, str(int(digits)))
            if int(digits) > 0 and ref not in refs:
                refs.append(ref)
    return refs[:40]


def cadastre_location(description: object | None, insee_code: object | None, city: str | None) -> dict[str, Any] | None:
    refs = cadastral_parcels(description)
    insee = (clean_text(insee_code) or "").upper()
    if not refs or not re.fullmatch(r"\d[\dAB]\d{3}", insee):
        return None
    labels = [ref_label(ref) for ref in refs]
    return {
        "insee_code": insee,
        "candidates": [{"source_label": "Descriptif de l'annonce", "raw": " ; ".join(labels), "parcels": labels}],
        "designation": designation(refs, city),
        "published_surface_m2": None,
        "signature": references_signature(insee, refs),
    }


def _proximities(block: dict[str, Any]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for key, label in PROXIMITY_LABELS.items():
        check = yes_no(block.get(f"check{key[:1].upper()}{key[1:]}"))
        detail = known(block.get(key))
        if check is False or (check is None and not detail):
            continue
        distance = PROXIMITY_DISTANCE_LABELS.get((detail or "").upper(), detail)
        rows.append({"key": key, "label": label, "present": True, "detail": distance})
    return rows


def _amenities(block: dict[str, Any]) -> dict[str, bool]:
    found: dict[str, bool] = {}
    for api_key, (key, _label, _group) in AMENITY_LABELS.items():
        flag = yes_no(block.get(api_key))
        if flag is not None:
            found[key] = flag
    return found


def _extra_surfaces(block: dict[str, Any]) -> dict[str, int | float]:
    surfaces: dict[str, int | float] = {}
    for api_key, (key, _label) in SURFACE_LABELS.items():
        value = number(block.get(api_key))
        if value:
            surfaces[key] = value
    return surfaces


def _status_label(transaction: dict[str, Any]) -> str | None:
    if yes_no(transaction.get("bienVendu")):
        return "Vendu"
    if yes_no(transaction.get("bienRetire")):
        return "Retiré de la vente"
    if yes_no(transaction.get("venteReportee")):
        return "Vente reportée"
    if yes_no(transaction.get("bienNonVenduCarence")) or yes_no(transaction.get("bienNonVenduReserve")):
        return "Non vendu"
    return None


def sale_conditions(transaction_type: str | None, transaction: dict[str, Any]) -> dict[str, Any]:
    """Conditions publiques de la vente (jamais le prix minimum ni le prix total)."""
    kind = (transaction_type or "").upper()
    conditions: dict[str, Any] = {"transaction_type": kind or None}
    if kind == "VAE":
        nature = known(transaction.get("natureMiseAPrix"))
        conditions.update({
            "procedure": "notarial_auction",
            "adjudication_type": known(transaction.get("typeAdjudication")),
            "origin": known(transaction.get("origineJudiciaire")),
            "auction_mode": known(transaction.get("modeVente")),
            "starting_price_eur": number(transaction.get("miseAPrix")),
            "starting_price_nature": nature,
            "price_reduction": clean_text(transaction.get("detailFaculteBaisse")),
            "floor_price_eur": floor_price_from_text(transaction.get("detailFaculteBaisse")),
            "deposit_eur": number(transaction.get("consignation")),
            "deposit_payment": known(transaction.get("seancePaiement")),
            "deposit_transfer_terms": clean_text(transaction.get("detailVirement")),
            "deposit_deadline_time": clean_text(transaction.get("seanceHeureDepot")),
            "overbid_allowed": yes_no(transaction.get("surenchere")),
            "session_at": clean_text(transaction.get("seanceDate")),
            "adjudication_price_eur": number(transaction.get("prixAdjudication")),
        })
    elif kind == "VNI":
        conditions.update({
            "procedure": "online_tender",
            "auction_system": known(transaction.get("systemeEncheres")),
            "first_offer_eur": number(transaction.get("premierPrix")),
            "last_offer_eur": number(transaction.get("derniereOffrePossible")),
            "offer_step_eur": number(transaction.get("pasOffres")),
            "opens_at": clean_text(transaction.get("dateDebutEncheres")),
            "closes_at": clean_text(transaction.get("dateFinEncheres")),
            "negotiation_fee_payer": known(transaction.get("redevableEmoluments")),
            "advertising_fees_eur": number(transaction.get("fraisPub")) or None,
            "private_sale": yes_no(transaction.get("ventePrivee")),
            "adjudication_price_eur": number(transaction.get("prixAdjudication")),
        })
        fees = number(transaction.get("emolumentsNegociation"))
        reference = number(transaction.get("prixMin"))
        if fees and reference:
            # Seul le taux est repris : le montant permettrait de retrouver le prix de réserve.
            conditions["negotiation_fee_rate"] = round(float(fees) / float(reference), 4)
    conditions["result"] = _status_label(transaction)
    return {key: value for key, value in conditions.items() if value not in (None, "", [], {})}


def build_features(
    *,
    data: dict[str, Any],
    transaction_type: str | None,
    transaction: dict[str, Any],
    property_block: dict[str, Any],
    coproperty: dict[str, Any],
    contact: dict[str, Any],
    description: str | None,
    images: list[str],
) -> dict[str, Any]:
    """Faits supplémentaires (fusionnés dans ``source_property_features``)."""
    multimedias = transaction.get("multimedias") if isinstance(transaction.get("multimedias"), list) else []
    plans = sum(
        1 for item in multimedias
        if isinstance(item, dict) and re.search(r"\bplans?\b", clean_text(item.get("nomDocument")) or "", re.I)
    )
    dpe_class, dpe_status = energy_class(property_block.get("consommationClasse"))
    ges_class, ges_status = energy_class(property_block.get("emissionGesClasse"))
    tours = virtual_tours(transaction.get("visiteVirtuelle"), description)
    features: dict[str, Any] = {
        "schema_version": FEATURES_SCHEMA_VERSION,
        "property_kind": {
            "type_code": known(property_block.get("typeBien") or (data.get("bien") or {}).get("typeBien")),
            "subtype": known(property_block.get("sousType")),
            "old_or_new": known(property_block.get("ancienNeuf")),
            "prestige": yes_no(property_block.get("prestige")),
            "use": known(property_block.get("utilisation")),
        },
        "construction_period": EPOQUE_LABELS.get((clean_text(property_block.get("epoqueConstruction")) or "").upper()),
        "amenities": _amenities(property_block),
        "proximity": _proximities(property_block),
        "surfaces_published": _extra_surfaces(property_block),
        "urban_planning_source": {
            "easement": known(property_block.get("servitude")),
            "serviced_land": known(property_block.get("viabilisation")),
            "buildings_to_demolish": yes_no(property_block.get("batimentDemolir")),
            "future_use": known(property_block.get("usageFutur")),
        },
        "income": {
            "annual_rent_eur": number(property_block.get("revenusAnnuel")),
            "housing_tax_eur": number(property_block.get("taxeHabitation")),
        },
        "neighbourhood": known(property_block.get("quartierNom")),
        "insee_code": known(property_block.get("inseeCommune")),
        "energy_status": {"dpe": dpe_status, "ges": ges_status},
        "energy_classes": {"dpe": dpe_class, "ges": ges_class},
        "coownership_works_eur": number(coproperty.get("montantTravaux")),
        "sale_conditions": sale_conditions(transaction_type, transaction),
        "virtual_tours": tours,
        "plans_count": plans,
        "photos_count": len(images),
        "documents_inventory": document_inventory(transaction.get("documents"), origin="notaires_api"),
        "listing": {
            "reference": clean_text(transaction.get("reference")),
            "published_on": iso_date(transaction.get("dateActivation") or transaction.get("dateCreation")),
            "updated_on": iso_date(transaction.get("dateMaj")),
            "office_crpcen": clean_text(transaction.get("crpcen") or data.get("crpcen")),
        },
    }
    return _compact(features)


def _compact(value: Any) -> Any:
    if isinstance(value, dict):
        result = {key: _compact(item) for key, item in value.items()}
        return {key: item for key, item in result.items() if item not in (None, "", [], {})}
    if isinstance(value, list):
        return [item for item in (_compact(entry) for entry in value) if item not in (None, "", [], {})]
    return value


def _item(key: str, label: str, value: object | None, group: str) -> dict[str, str] | None:
    if isinstance(value, bool):
        text = "Oui" if value else "Non"
    else:
        text = clean_text(value)
    if not text:
        return None
    return {"key": key, "label": label, "value": text, "group": group}


def _method_label(conditions: dict[str, Any]) -> str | None:
    kind = conditions.get("transaction_type")
    if kind == "VAE":
        adjudication = TYPE_ADJUDICATION_LABELS.get(str(conditions.get("adjudication_type") or "").upper())
        mode = MODE_VENTE_LABELS.get(str(conditions.get("auction_mode") or "").upper())
        label = "Adjudication notariale"
        if adjudication:
            label += f" {adjudication}"
        return f"{label} {mode}" if mode else label
    if kind == "VNI":
        descending = str(conditions.get("auction_system") or "").upper() == "DESCENDANTES"
        return "Vente Immo-Interactif® " + ("à la baisse" if descending else "à la hausse") + " (offres en ligne)"
    return None


def build_display(
    *,
    property_block: dict[str, Any],
    coproperty: dict[str, Any],
    features: dict[str, Any],
    visit_dates: list[str],
    contact: dict[str, Any],
    office: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Bloc ``caracteristiques_bien`` (contrat ``property_characteristics_v1``)."""
    kind = features.get("property_kind") or {}
    type_code = str(kind.get("type_code") or "").upper()
    sub_type = known(property_block.get("sousType"))
    items: list[dict[str, str] | None] = [
        _item("type", "Type de bien", TYPE_LABELS.get(type_code) or humanize_code(type_code), "identification"),
        _item("subtype", "Sous-type", humanize_code(sub_type), "identification"),
        _item("old_or_new", "Ancien / neuf", label_for(ANCIEN_NEUF_LABELS, property_block.get("ancienNeuf")), "identification"),
        _item("prestige", "Bien de prestige", kind.get("prestige") if kind.get("prestige") else None, "identification"),
        _item("neighbourhood", "Quartier", features.get("neighbourhood"), "identification"),
        _item("rooms", "Pièces", number(property_block.get("nbPieces")), "identification"),
        _item("bedrooms", "Chambres", number(property_block.get("nbChambres")), "identification"),
        _item("bathrooms", "Salles de bain", number(property_block.get("nbSdb")), "identification"),
        _item("parking_spaces", "Places de stationnement", number(property_block.get("nbStationnements")) or None, "equipements"),
    ]
    for api_key, (key, label) in SURFACE_LABELS.items():
        items.append(_item(key, label, _surface_text(property_block.get(api_key)), "surfaces"))
    items.extend([
        _item("floor", "Étage", number(property_block.get("etage")), "batiment"),
        _item("building_floors", "Nombre d'étages", number(property_block.get("nbEtages")), "batiment"),
        _item("construction_period", "Époque de construction", features.get("construction_period"), "batiment"),
        _item("condition", "État", label_for(ETAT_LABELS, property_block.get("etat")), "batiment"),
        _item("heating", "Chauffage", label_for(CHAUFFAGE_LABELS, property_block.get("chauffage")), "equipements"),
        _item("energy", "Énergie de chauffage", humanize_code(property_block.get("energie")), "equipements"),
        _item("kitchen", "Cuisine", label_for(CUISINE_LABELS, property_block.get("typeCuisine")), "equipements"),
        _item("occupancy", "Situation locative", label_for(SITUATION_LABELS, property_block.get("situationLocative")), "situation"),
        _item("orientation", "Exposition", label_for(EXPOSITION_LABELS, property_block.get("exposition")), "situation"),
    ])
    amenities = features.get("amenities") or {}
    for api_key, (key, label, group) in AMENITY_LABELS.items():
        if key in amenities and api_key not in {"stationnement"}:
            items.append(_item(key, label, amenities[key], group))
    if "parking" in amenities and not number(property_block.get("nbStationnements")):
        items.append(_item("parking", "Stationnement", amenities["parking"], "equipements"))
    for row in features.get("proximity") or []:
        value = row.get("detail") or ("Oui" if row.get("present") else None)
        items.append(_item(f"proximity_{row['key']}", str(row["label"]), value, "proximite"))
    copro = yes_no(coproperty.get("copropriete"))
    items.extend([
        _item("coownership", "Bien en copropriété", copro, "copropriete"),
        _item("coownership_lots", "Nombre de lots", number(coproperty.get("nbLots")), "copropriete"),
        _item("coownership_charges", "Charges annuelles", _money(coproperty.get("montantChargesAnnuelles")), "copropriete"),
        _item("coownership_works", "Travaux votés", _money(coproperty.get("montantTravaux")), "copropriete"),
        _item("coownership_safeguard", "Procédure de sauvegarde", yes_no(coproperty.get("planSauvegarde")), "copropriete"),
        _item("coownership_administrator", "Administrateur provisoire", yes_no(coproperty.get("adminProvisoire")), "copropriete"),
        _item("coownership_syndic", "Syndic", known(coproperty.get("coordonneesSyndic")), "copropriete"),
    ])
    planning = features.get("urban_planning_source") or {}
    items.extend([
        _item("easement", "Servitude", _flag_or_text(planning.get("easement")), "urbanisme"),
        _item("serviced_land", "Viabilisation", _flag_or_text(planning.get("serviced_land")), "urbanisme"),
        _item("buildings_to_demolish", "Bâtiment à démolir", planning.get("buildings_to_demolish"), "urbanisme"),
    ])
    energy_status = features.get("energy_status") or {}
    dpe_value = number(property_block.get("consommation"))
    ges_value = number(property_block.get("emissionGes"))
    cost_min = number(property_block.get("depensesEnergieMin"))
    cost_max = number(property_block.get("depensesEnergieMax"))
    cost_year = number(property_block.get("depensesEnergieAnnee"))
    costs = None
    if cost_min and cost_max:
        costs = f"entre {_money(cost_min)} et {_money(cost_max)} par an"
    elif cost_max:
        costs = f"jusqu'à {_money(cost_max)} par an"
    if costs and cost_year:
        costs += f" (prix {cost_year})"
    items.extend([
        _item("dpe_status", "DPE", energy_status.get("dpe"), "diagnostics"),
        _item("ges_status", "GES", energy_status.get("ges") if energy_status.get("ges") != energy_status.get("dpe") else None, "diagnostics"),
        _item("dpe_value", "Consommation énergétique", f"{dpe_value} kWh/m²/an" if dpe_value else None, "diagnostics"),
        _item("ges_value", "Émissions de GES", f"{ges_value} kg CO₂/m²/an" if ges_value else None, "diagnostics"),
        _item("dpe_date", "Date du DPE", iso_date(property_block.get("dateRealisationDpe")), "diagnostics"),
        _item("energy_costs", "Dépenses énergétiques estimées", costs, "diagnostics"),
        _item("property_tax", "Taxe foncière", _money(property_block.get("taxeFonciere")), "divers"),
        _item("annual_rent", "Revenus locatifs annuels", _money(property_block.get("revenusAnnuel")), "divers"),
    ])

    conditions = features.get("sale_conditions") or {}
    prices: dict[str, Any] = {}
    for source_key, target_key in (
        ("starting_price_eur", "starting_price_eur"),
        ("first_offer_eur", "first_offer_eur"),
        ("last_offer_eur", "last_offer_eur"),
        ("floor_price_eur", "floor_price_eur"),
        ("deposit_eur", "deposit_eur"),
        ("offer_step_eur", "bid_increment_eur"),
        ("adjudication_price_eur", "adjudication_price_eur"),
    ):
        if conditions.get(source_key):
            prices[target_key] = conditions[source_key]
    tax = number(property_block.get("taxeFonciere"))
    if tax:
        prices["property_tax_eur"] = tax
    procedure: dict[str, Any] = {"method_label": _method_label(conditions), "prices": prices, "visits": visit_dates[:4]}
    if conditions.get("transaction_type") == "VAE" and conditions.get("session_at"):
        procedure["deadline"] = {"at": conditions["session_at"], "kind": "adjudication"}
    elif conditions.get("closes_at"):
        procedure["deadline"] = {"at": conditions["closes_at"], "kind": "sale_window_close"}
        if conditions.get("opens_at"):
            procedure["window"] = {"opens_at": conditions.get("opens_at"), "closes_at": conditions["closes_at"]}
    terms = [
        _item("starting_price_nature", "Nature de la mise à prix",
              label_for(NATURE_MISE_A_PRIX_LABELS, conditions.get("starting_price_nature")), "procedure"),
        _item("price_reduction", "Faculté de baisse", conditions.get("price_reduction"), "procedure"),
        _item("deposit_payment", "Paiement de la consignation", label_for(PAIEMENT_LABELS, conditions.get("deposit_payment")), "procedure"),
        _item("deposit_transfer_terms", "Délai de la consignation", conditions.get("deposit_transfer_terms"), "procedure"),
        _item("deposit_deadline_time", "Dépôt des consignations", conditions.get("deposit_deadline_time"), "procedure"),
        _item("overbid", "Surenchère", "Possible" if conditions.get("overbid_allowed") else None, "procedure"),
        _item("origin", "Origine de la vente", label_for(ORIGINE_LABELS, conditions.get("origin")), "procedure"),
        _item("negotiation_fee", "Honoraires de négociation", _fee_text(conditions), "procedure"),
        _item("advertising_fees", "Frais de publicité", _money(conditions.get("advertising_fees_eur")), "procedure"),
        _item("result", "Résultat", conditions.get("result"), "procedure"),
    ]
    procedure["terms"] = [item for item in terms if item]
    procedure = {key: value for key, value in procedure.items() if value not in (None, "", [], {})}
    # Les conditions de vente figurent aussi parmi les tuiles (groupe dédié).
    groups = dict(GROUPS)
    terms = procedure.pop("terms", None)
    if terms:
        groups["vente"] = "Conditions de la vente"
        items.extend({**item, "group": "vente"} for item in terms)

    inventory = features.get("documents_inventory") or []
    attachments = [
        {"label": item.get("label"), "kind": item.get("category"),
         "kind_label": item.get("label"), "category_label": DOCUMENT_CATEGORY_LABELS.get(str(item.get("category")))}
        for item in inventory if item.get("label")
    ]
    media = {"photos": features.get("photos_count") or 0, "plans": features.get("plans_count") or 0,
             "virtual_tours": len(features.get("virtual_tours") or [])}
    listing = features.get("listing") or {}
    office = office or {}
    service = clean_text(office.get("title") or office.get("name")) or known(contact.get("nom"))
    display: dict[str, Any] = {
        "schema_version": DISPLAY_SCHEMA_VERSION,
        "source": "notaires",
        "nature": [{"label": TYPE_LABELS.get(type_code) or type_code, "code": type_code,
                    "display": TYPE_LABELS.get(type_code) or humanize_code(type_code)}] if type_code else [],
        "groups": groups,
        "items": [item for item in items if item],
        "surfaces": _display_surfaces(property_block),
        "energy": {f"{key}_class": value for key, value in (features.get("energy_classes") or {}).items() if value},
        "media": {key: value for key, value in media.items() if value},
        "attachments": attachments,
        "procedure": procedure,
        "dates": {key: value for key, value in (("published_on", listing.get("published_on")),
                                                ("modified_on", listing.get("updated_on"))) if value},
    }
    if attachments:
        display["attachments_access"] = {"restricted": True, "note": DOCUMENTS_ACCESS_NOTE}
    # Aucune adresse e-mail dans le bloc d'affichage : leur collecte n'est pas décidée.
    if service:
        display["manager"] = {"service": service,
                              "heading": "Office notarial"}
    if features.get("cadastre_designation"):
        display["location"] = {"designation": features["cadastre_designation"],
                               **({"insee_code": features.get("insee_code")} if features.get("insee_code") else {})}
    rates = (office.get("rate_schedule") or {}) if isinstance(office.get("rate_schedule"), dict) else {}
    if rates.get("brackets"):
        groups["honoraires"] = "Barème d'honoraires de l'office"
        for index, bracket in enumerate(rates["brackets"]):
            text = _bracket_text(bracket)
            if text:
                display["items"].append({"key": f"fee_bracket_{index + 1}", "label": text[0], "value": text[1],
                                         "group": "honoraires"})
    # Seuls les intitulés utilisés : un titre vide (« Copropriété ») ne doit pas devenir un indice textuel.
    used = {item["group"] for item in display["items"]}
    display["groups"] = {key: title for key, title in groups.items() if key in used}
    return {key: value for key, value in display.items() if value not in (None, "", [], {})}


def _yes_no_label(value: object | None) -> str | None:
    flag = _flag_or_text(value)
    return ("Oui" if flag else "Non") if isinstance(flag, bool) else flag


def _flag_or_text(value: object | None) -> bool | str | None:
    flag = yes_no(value)
    return flag if flag is not None else humanize_code(value)


def _fee_text(conditions: dict[str, Any]) -> str | None:
    payer = PAYER_LABELS.get(str(conditions.get("negotiation_fee_payer") or "").upper())
    rate = conditions.get("negotiation_fee_rate")
    rate_text = f"{float(rate) * 100:.2f} %".replace(".", ",") if isinstance(rate, (int, float)) and rate > 0 else None
    parts = [part for part in (rate_text, payer.lower() if payer and rate_text else payer) if part]
    return " ".join(parts) if parts else None


def _bracket_text(bracket: object) -> tuple[str, str] | None:
    if not isinstance(bracket, dict):
        return None
    low, high = number(bracket.get("min")), number(bracket.get("max"))
    if high:
        label = f"De {_money(low) or '0 €'} à {_money(high)}"
    elif low:
        label = f"Au-delà de {_money(low)}"
    else:
        return None
    if bracket.get("flatRate"):
        value = f"{_money(bracket['flatRate'])} TTC (forfait)"
    elif bracket.get("percentageRate") is not None:
        value = f"{str(bracket['percentageRate']).replace('.', ',')} % TTC"
    else:
        return None
    return label, value


def _display_surfaces(property_block: dict[str, Any]) -> dict[str, str]:
    surfaces: dict[str, str] = {}
    built = number(property_block.get("surfaceHabitable")) or number(property_block.get("surface"))
    land = number(property_block.get("surfaceTerrain"))
    if built and built > 0:
        surfaces["built_surface_m2"] = str(built)
    if land and land > 0:
        surfaces["land_surface_m2"] = str(land)
    return surfaces


# --- Page Immo-Interactif (__NUXT_DATA__) -------------------------------------------------

_NUXT_RE = re.compile(r'<script[^>]+id="__NUXT_DATA__"[^>]*>(.*?)</script>', re.S)
_WRAPPERS = {"Reactive", "ShallowReactive", "Ref", "ShallowRef"}


def _revive(table: list[Any], index: int, depth: int = 0) -> Any:
    """Décodage « devalue » (format de Nuxt) : chaque valeur renvoie à un indice du tableau."""
    if depth > 60 or not isinstance(index, int) or index < 0 or index >= len(table):
        return None
    value = table[index]
    if isinstance(value, list):
        if value and isinstance(value[0], str):
            tag = value[0]
            if tag in _WRAPPERS:
                return _revive(table, value[1], depth + 1) if len(value) > 1 else None
            if tag in {"EmptyRef", "EmptyShallowRef", "undefined"}:
                return None
            if tag == "Date":
                return value[1] if len(value) > 1 else None
            if tag in {"Set", "Map", "RegExp", "BigInt", "NuxtError", "Error"}:
                return None
        return [_revive(table, item, depth + 1) for item in value]
    if isinstance(value, dict):
        return {key: _revive(table, item, depth + 1) for key, item in value.items()}
    return value


def parse_immo_interactif_page(html: str, expected_id: str | int) -> dict[str, Any]:
    """Inventaire des pièces, office et barème d'honoraires d'une page Immo-Interactif.

    Retourne ``{}`` si la page ne porte pas l'annonce attendue.
    """
    match = _NUXT_RE.search(html or "")
    if not match:
        return {}
    try:
        table = json.loads(match.group(1))
    except ValueError:
        return {}
    if not isinstance(table, list) or not table:
        return {}
    root = _revive(table, 0)
    data = root.get("data") if isinstance(root, dict) else None
    ad = data.get("fetchPropertyAd") if isinstance(data, dict) else None
    if not isinstance(ad, dict) or str(ad.get("inotrAnnonceId") or ad.get("id")) != str(expected_id):
        return {}
    office = ad.get("office") if isinstance(ad.get("office"), dict) else {}
    contact = ad.get("shortContact") if isinstance(ad.get("shortContact"), dict) else {}
    seller = ad.get("seller") if isinstance(ad.get("seller"), dict) else {}
    schedule = office.get("rateSchedule") if isinstance(office.get("rateSchedule"), dict) else {}
    brackets = [
        {key: bracket.get(key) for key in ("min", "max", "flatRate", "percentageRate", "cumulativeBase")
         if bracket.get(key) is not None}
        for bracket in schedule.get("brackets") or [] if isinstance(bracket, dict)
    ] if schedule.get("active") is not False else []
    fee_rate = ad.get("negotiationFeeRate")
    result = {
        "documents_inventory": document_inventory(ad.get("documents"), origin="immo_interactif_page"),
        "office": _compact({
            "name": clean_text(contact.get("overrideOfficeName")),
            "title": clean_text(office.get("title")),
            "rate_schedule": {"cumulative": schedule.get("cumulative"), "brackets": brackets} if brackets else None,
        }),
        "seller_type": clean_text(seller.get("type")),
        "negotiation_fee_rate": round(float(fee_rate), 4) if isinstance(fee_rate, (int, float)) and fee_rate > 0 else None,
        "negotiation_fee_payer": clean_text(ad.get("negotiationFeeOwner")),
        "photos_count": len([item for item in ad.get("pictures") or [] if isinstance(item, dict) and item.get("fileUrl")]),
    }
    return _compact(result)


def merge_operator_page(features: dict[str, Any], page: dict[str, Any] | None) -> dict[str, Any]:
    """Ajoute aux faits de l'API la lecture de la page Immo-Interactif (pure)."""
    if not page:
        return features
    merged = dict(features)
    inventory = merge_inventories(features.get("documents_inventory") or [], page.get("documents_inventory") or [])
    if inventory:
        merged["documents_inventory"] = inventory
    if page.get("office"):
        merged["office"] = {**(features.get("office") or {}), **page["office"]}
    if page.get("seller_type"):
        merged["seller_type"] = page["seller_type"]
    conditions = dict(features.get("sale_conditions") or {})
    if page.get("negotiation_fee_rate"):
        conditions["negotiation_fee_rate"] = page["negotiation_fee_rate"]
    if conditions:
        merged["sale_conditions"] = conditions
    merged["operator_page"] = "immo_interactif"
    return merged


def flat_blocks(features: dict[str, Any], property_block: dict[str, Any]) -> dict[str, Any]:
    """Blocs plats en français (preuves, recherche plein texte, revue IA)."""
    conditions = features.get("sale_conditions") or {}
    amenities = features.get("amenities") or {}
    labels = {key: label for _api, (key, label, _group) in AMENITY_LABELS.items()}
    present = [labels[key] for key, flag in amenities.items() if flag and key in labels]
    proximity = [
        f"{row['label']} {row['detail']}" if row.get("detail") else str(row["label"])
        for row in features.get("proximity") or [] if row.get("present")
    ]
    inventory = features.get("documents_inventory") or []
    blocks = {
        "nature_mise_a_prix": label_for(NATURE_MISE_A_PRIX_LABELS, conditions.get("starting_price_nature")),
        "faculte_baisse": conditions.get("price_reduction"),
        "prix_plancher_eur": conditions.get("floor_price_eur"),
        "modalites_consignation": conditions.get("deposit_transfer_terms"),
        "systeme_encheres": humanize_code(conditions.get("auction_system")),
        "pas_offres_eur": conditions.get("offer_step_eur"),
        "honoraires_negociation": _fee_text(conditions),
        "resultat_vente": conditions.get("result"),
        "prix_adjudication_eur": conditions.get("adjudication_price_eur"),
        "equipements": " ; ".join(present) or None,
        "proximites": " ; ".join(proximity) or None,
        "quartier": features.get("neighbourhood"),
        "servitude": _yes_no_label((features.get("urban_planning_source") or {}).get("easement")),
        "surface_sejour": number(property_block.get("surfaceSejour")),
        "surface_utile": number(property_block.get("surfaceUtile")),
        "surface_plancher": number(property_block.get("surfacePlancher")),
        "visite_virtuelle": " ; ".join(features.get("virtual_tours") or []) or None,
        "nombre_photos": features.get("photos_count") or None,
        "nombre_plans": features.get("plans_count") or None,
        "pieces_dossier": " ; ".join(str(item.get("label")) for item in inventory) or None,
        "acces_pieces_dossier": DOCUMENTS_ACCESS_NOTE if inventory else None,
        "dpe_statut": (features.get("energy_status") or {}).get("dpe"),
        "ges_statut": (features.get("energy_status") or {}).get("ges"),
        "epoque_construction_libelle": features.get("construction_period"),
        "date_publication": (features.get("listing") or {}).get("published_on"),
        "designation_cadastrale": features.get("cadastre_designation"),
        "office_notarial": " – ".join(
            part for part in ((features.get("office") or {}).get("name"), (features.get("office") or {}).get("title"))
            if part
        ) or None,
    }
    return {key: value for key, value in blocks.items() if value not in (None, "", [], {})}


# --- Faits historiques de l'API (déplacés de notaires.py, contrat inchangé) ---------------------


def _integer(value: object | None) -> int | None:
    parsed = number(value)
    if parsed is None:
        return None
    try:
        return int(parsed)
    except (TypeError, ValueError, OverflowError):
        return None


def _known_value(value: object | None) -> str | None:
    text = clean_text(value)
    if not text or text.upper() in {"INCONNU", "NC", "N/A", "NON COMMUNIQUE"}:
        return None
    return text


def legacy_property_features(
    *,
    property_block: dict[str, Any],
    coproperty: dict[str, Any],
    transaction: dict[str, Any],
    contact: dict[str, Any],
    description_features: dict[str, Any],
    surface_features: dict[str, Any],
    source_images: list[str],
) -> dict[str, Any]:
    dpe_value = number(property_block.get("consommation"))
    ges_value = number(property_block.get("emissionGes"))
    energy = {
        "dpe": {
            "class": energy_class(property_block.get("consommationClasse"))[0],
            "value": dpe_value,
            "unit": "kWh/m²/an" if dpe_value is not None else None,
            "date": clean_text(property_block.get("dateRealisationDpe")),
        },
        "ges": {
            "class": energy_class(property_block.get("emissionGesClasse"))[0],
            "value": ges_value,
            "unit": "kgCO2/m²/an" if ges_value is not None else None,
            "date": clean_text(property_block.get("dateRealisationDpe")),
        },
        "estimated_cost": {
            "min_eur": number(property_block.get("depensesEnergieMin")),
            "max_eur": number(property_block.get("depensesEnergieMax")),
            "year": _integer(property_block.get("depensesEnergieAnnee")),
        },
    }
    coownership = {
        "is_coownership": yes_no(coproperty.get("copropriete")),
        "annual_charges_eur": number(coproperty.get("montantChargesAnnuelles")),
        "lot_count": _integer(coproperty.get("nbLots")),
        "syndic": _known_value(coproperty.get("coordonneesSyndic")),
        "administrator_status": _known_value(coproperty.get("adminProvisoire")),
        "safeguard_plan": _known_value(coproperty.get("planSauvegarde")),
    }
    technical = dict(description_features.get("technical") or {})
    technical.update(
        {
            "heating_api": _known_value(property_block.get("chauffage")),
            "energy_api": _known_value(property_block.get("energie")),
            "elevator": yes_no(property_block.get("ascenseur")),
            "accessibility": yes_no(property_block.get("accesHandicapes")),
            "double_glazing": yes_no(property_block.get("doubleVitrage")),
        }
    )
    return {
        "floor": number(property_block.get("etage")),
        "building_floors_count": _integer(property_block.get("nbEtages")),
        "energy": energy,
        "property_tax": {
            "amount_eur": number(property_block.get("taxeFonciere")),
            "year": None,
        },
        "coownership": coownership,
        "technical": technical,
        "annexes": description_features.get("annexes") or {},
        "works_to_plan": description_features.get("works_to_plan"),
        "surfaces": surface_features,
        "contact": {
            "name": _known_value(contact.get("nom")),
            "phone": _known_value(contact.get("telephone")),
            "email": _known_value(contact.get("mail")),
        },
        "sale": {
            "first_offer_eur": number(
                transaction.get("premierPrix") or transaction.get("prixMin")
            ),
            "offer_step_eur": number(transaction.get("pasOffres")),
        },
        "media": {"image_count": len(source_images), "images": list(source_images)},
    }


def legacy_source_evidence(
    *,
    property_block: dict[str, Any],
    transaction: dict[str, Any],
    coproperty: dict[str, Any],
    description_features: dict[str, Any],
    surface_features: dict[str, Any],
    aggregate_carrez_evidence: str | None,
) -> dict[str, Any]:
    evidence: dict[str, Any] = {
        "floor": {"source": "notaires_detail_api", "field": "etage", "value": property_block.get("etage")},
        "building_floors_count": {
            "source": "notaires_detail_api",
            "field": "nbEtages",
            "value": property_block.get("nbEtages"),
        },
        "dpe": {
            "source": "notaires_detail_api",
            "class": property_block.get("consommationClasse"),
            "value": property_block.get("consommation"),
            "date": property_block.get("dateRealisationDpe"),
        },
        "ges": {
            "source": "notaires_detail_api",
            "class": property_block.get("emissionGesClasse"),
            "value": property_block.get("emissionGes"),
            "date": property_block.get("dateRealisationDpe"),
        },
        "property_tax": {
            "source": "notaires_detail_api",
            "field": "taxeFonciere",
            "value": property_block.get("taxeFonciere"),
        },
        "coownership_charges": {
            "source": "notaires_detail_api",
            "field": "montantChargesAnnuelles",
            "value": coproperty.get("montantChargesAnnuelles"),
        },
        "surfaces": {
            "source": "notaires.description",
            "aggregate_quote": aggregate_carrez_evidence,
            "assets": surface_features.get("assets", []),
            "sum_check": surface_features.get("sum_check"),
        },
    }
    if description_features.get("evidence"):
        evidence["description_features"] = description_features["evidence"]
    return evidence
