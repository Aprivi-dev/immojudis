"""Vocabulaire des fiches « Cessions immobilières de l'État » (fonctions pures).

La fiche détail publie ses caractéristiques sous forme de tuiles libellé/valeur,
groupées sous des intertitres : la nature du bien (« Terrains nus »,
« Maisons »…) puis, le cas échéant, « Diagnostic » (DPE et GES). Le site a
changé de gabarit au fil des années : un même champ peut s'appeler
« Nombre de chambres » ou « Nb de chambres ». Ce module rattache chaque
libellé publié à une clé stable, un groupe d'affichage et un type de valeur ;
il ne fait aucun accès réseau.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation


@dataclass(frozen=True)
class FieldSpec:
    key: str
    label: str
    group: str
    kind: str = "text"


# Groupes d'affichage, dans l'ordre de présentation.
GROUPS = {
    "identification": "Identification",
    "surfaces": "Surfaces",
    "urbanisme": "Urbanisme et terrain",
    "batiment": "Bâtiment",
    "equipements": "Équipements",
    "situation": "Situation et occupation",
    "diagnostics": "Diagnostics",
    "divers": "Autres informations",
}


def fold(value: object | None) -> str:
    """Libellé replié : minuscules, sans accents ni ponctuation superflue."""
    text = unicodedata.normalize("NFKD", str(value or "")).encode("ascii", "ignore").decode("ascii")
    text = text.replace("’", "'").lower()
    text = re.sub(r"[\s ]+", " ", text)
    return text.strip(" :.-")


def _specs(*items: tuple[str, str, str, str, tuple[str, ...]]) -> dict[str, FieldSpec]:
    table: dict[str, FieldSpec] = {}
    for key, label, group, kind, aliases in items:
        spec = FieldSpec(key=key, label=label, group=group, kind=kind)
        # Seuls les libellés publiés servent de clé : un libellé d'affichage
        # (« Bureaux ») peut aussi être un intertitre de nature.
        for alias in aliases or (label,):
            table[fold(alias)] = spec
    return table


# Libellés observés sur les 237 fiches de production (octobre 2026), avec leurs variantes.
FIELD_SPECS = _specs(
    ("cadastral_reference", "Référence cadastrale", "identification", "text", ()),
    ("cadastral_references", "Références cadastrales", "identification", "text", ()),
    ("insee_code", "Code INSEE", "identification", "text", ()),
    ("file_number", "Numéro de dossier", "identification", "text", ()),
    ("sale_type", "Type de vente", "identification", "text", ()),
    ("first_listed_year", "Année première inscription", "identification", "year", ()),
    ("cidol_eligible", "Éligible CIDOL", "identification", "bool",
     ("Eligible CIDOL", "Eligible CIDOL (Biens fléchés logement sociaux)")),
    ("surface_m2", "Surface", "surfaces", "surface", ("Surface en m²", "Superficie en m²", "Surface en m2")),
    ("land_surface_m2", "Superficie du terrain", "surfaces", "surface", ()),
    ("outbuildings_surface_m2", "Superficie des dépendances", "surfaces", "surface", ()),
    ("rooms_surface", "Superficie des pièces", "surfaces", "text", ()),
    ("zoning", "Zonage d'urbanisme", "urbanisme", "text", ()),
    ("plu_information", "Informations sur le PLU", "urbanisme", "text", ()),
    ("zone_classification", "Classement de la zone", "urbanisme", "text", ()),
    ("buildability", "Constructibilité", "urbanisme", "bool_text", ()),
    ("easements", "Servitudes", "urbanisme", "bool_text", ("Existence de servitudes",)),
    ("buildings_to_demolish", "Bâtiments à démolir", "urbanisme", "bool_text", ("Présence de bâtiments à démolir",)),
    ("demolition_permit", "Permis de démolition", "urbanisme", "bool_text", ()),
    ("vegetation", "Végétation", "urbanisme", "bool_text",
     ("Présence de végétations", "Présence de végétation")),
    ("soil_type", "Type de sol", "urbanisme", "text", ()),
    ("access_conditions", "Conditions d'accès", "urbanisme", "text",
     ("Condition d'accès", "Condition d'accès (accès direct, terrain en second rideau…)",
      "Condition d'accès (accès direct, terrain en second rideau...)")),
    ("utilities", "Viabilisation", "urbanisme", "bool_text", ("Informations sur la viabilisation du terrain",)),
    ("preemption_rights", "Droits de préemption", "urbanisme", "text",
     ("Informations sur les droits de préemptions applicables",
      "Informations sur les droits de préemption applicables")),
    ("fencing", "Clôture", "urbanisme", "bool_text", ("Présence d'une clôture",)),
    ("has_land", "Terrain attenant", "urbanisme", "bool_text", ("Existence d'un terrain",)),
    ("divisibility", "Divisibilité", "urbanisme", "text", ("Divisibilité", "Information sur la divisibilité")),
    ("historic_monument", "Monument historique", "urbanisme", "text", ("Classé monument historique",)),
    ("condition", "État", "batiment", "text",
     ("Etat", "État (Habitable, travaux à prévoir, etc.)", "Etat (Habitable, travaux à prévoir, etc.)")),
    ("year_built", "Année de construction", "batiment", "year", ("Annee de construction",)),
    ("floor", "Étage", "batiment", "text", ("Etage",)),
    ("building_floors_count", "Étages dans le bâtiment", "batiment", "count",
     ("Nombre d'étages dans le bâtiment", "Nb d'étage dans le bâtiment", "Nb d'étages dans le bâtiment")),
    ("rooms_count", "Pièces", "batiment", "count", ("Nombre de pièces", "Nb de pièces")),
    ("bedrooms_count", "Chambres", "batiment", "count", ("Nombre de chambres", "Nb de chambres")),
    ("bathrooms_count", "Salles de bain", "batiment", "count", ("Nombre de salles de bain", "Nb de salles de bain")),
    ("toilets_count", "Toilettes", "batiment", "count", ("Nombre de toilettes", "Nb de toilettes", "Nombre de WCs")),
    ("offices_count", "Nombre de bureaux", "batiment", "count", ()),
    ("meeting_rooms_count", "Salles de réunion", "batiment", "count", ("Nombre de salles de réunion",)),
    ("flooring", "Revêtement de sol", "batiment", "text", ("Type de materiaux au sol", "Type de matériaux au sol")),
    ("heating", "Chauffage", "equipements", "text", ("Type de chauffage", "Type de chauffage climatisation")),
    ("parking_box", "Parking ou box", "equipements", "bool_text",
     ("Présence d'un parking box", "Présence d'un parking / box")),
    ("parking_type", "Type de parking", "equipements", "text", ()),
    ("parking_spaces", "Places de parking", "equipements", "count_text", ("Nombre de places de parking",)),
    ("cellar", "Cave", "equipements", "bool_text", ("Présence d'une cave",)),
    ("balcony_terrace", "Balcon ou terrasse", "equipements", "bool_text",
     ("Présence de balcons ou terrasses", "Présence d'un balcon ou terrasse")),
    ("pool", "Piscine", "equipements", "bool_text", ("Présence d'une piscine",)),
    ("kitchen", "Cuisine", "equipements", "bool_text", ("Présence d'une cuisine",)),
    ("elevators", "Ascenseur", "equipements", "bool_text", ("Présence d'ascenseurs",)),
    ("archive_room", "Local d'archives", "equipements", "bool_text", ("Présence d'un local d'archives",)),
    ("security_devices", "Dispositifs de sécurité", "equipements", "text", ()),
    ("accessibility", "Accessibilité handicapés", "equipements", "text",
     ("Informations sur l'accessibilité handicapés",)),
    ("availability", "Disponibilité", "situation", "text", ("Disponibilité", "Date de disponibilité")),
    ("property_tax", "Taxe foncière", "situation", "text", ("Montant de la taxe foncière",)),
    ("coownership_charges", "Charges de copropriété", "situation", "text", ("Montant des charges de copropriété",)),
    ("mandatory_diagnostics", "Diagnostics obligatoires", "diagnostics", "text", ()),
    ("risk_statement", "État des risques", "diagnostics", "text",
     ("Etat des risques naturels miniers et technologiques", "Etat des risques GEORISQUES",
      "État des risques naturels miniers et technologiques")),
    ("flood_risk", "Risque inondation", "diagnostics", "text", ()),
    ("soil_pollution_diagnostic", "Pollution des sols", "diagnostics", "text", ("Diagnostic de pollution des sols",)),
    ("pollution", "Pollution", "diagnostics", "text", ()),
    ("miscellaneous", "Divers", "divers", "text", ()),
    ("free_description", "Description libre", "divers", "text", ()),
)

ENERGY_PATTERNS = (
    ("dpe_class", re.compile(r"^performance\s+[ée]nerg[ée]tique\s*:\s*([A-G])?\s*$", re.I)),
    ("ges_class", re.compile(r"^gaz\s+[àa]\s+effet\s+de\s+serre\s*:\s*([A-G])?\s*$", re.I)),
)

# Intertitre « nature » -> (code de nature, type de bien normalisé, libellé).
NATURES: dict[str, tuple[str, str]] = {
    fold(label): (code, property_type)
    for label, code, property_type in (
        ("Terrains nus", "terrain_nu", "land"),
        ("Terrains agricoles", "terrain_agricole", "land"),
        ("Terrain boisé", "foret", "land"),
        ("Terrains boisés", "foret", "land"),
        ("Terrain occupé (présence d'une construction à démolir)", "terrain_bati_a_demolir", "land"),
        ("Etendues d'eau", "etendue_eau", "land"),
        ("Vignes et vergers", "vigne_verger", "land"),
        ("Maisons", "maison", "house"),
        ("Maisons forestières", "maison_forestiere", "house"),
        ("Hôtels particuliers", "hotel_particulier", "building"),
        ("Appartements", "appartement", "apartment"),
        ("Immeubles d'habitation", "immeuble_habitation", "building"),
        ("Immeuble de logements transformés en bureaux", "immeuble_logements_bureaux", "commercial"),
        ("Ensembles immobiliers", "ensemble_immobilier", "building"),
        ("Bureaux", "bureaux", "commercial"),
        ("Immeubles de bureau", "immeuble_bureaux", "commercial"),
        ("Immeubles de bureaux", "immeuble_bureaux", "commercial"),
        ("Locaux commerciaux", "local_commercial", "commercial"),
        ("Locaux industriels", "local_industriel", "commercial"),
        ("Entrepôts", "entrepot", "commercial"),
        ("Hangars", "hangar", "commercial"),
        ("Bâtiments d'élevage (stabulations/ écuries…)", "batiment_agricole", "commercial"),
        ("Bâtiments d'élevage (stabulations/ écuries...)", "batiment_agricole", "commercial"),
        ("Hôtels", "hotel", "commercial"),
        ("Ecoles/ universités/ centre de formation…", "enseignement", "building"),
        ("Ecoles/ universités/ centre de formation...", "enseignement", "building"),
        ("Parkings/box", "parking", "parking"),
        ("Caves", "cave", "other"),
    )
}

# Intertitres structurels (sans valeur propre).
SECTION_HEADINGS = frozenset({fold("Diagnostic")})

# Libellé de nature lisible, à partir du code.
NATURE_LABELS = {
    "terrain_nu": "Terrain nu",
    "terrain_agricole": "Terrain agricole",
    "foret": "Terrain boisé",
    "terrain_bati_a_demolir": "Terrain avec construction à démolir",
    "etendue_eau": "Étendue d'eau",
    "vigne_verger": "Vignes et vergers",
    "maison": "Maison",
    "maison_forestiere": "Maison forestière",
    "hotel_particulier": "Hôtel particulier",
    "appartement": "Appartement",
    "immeuble_habitation": "Immeuble d'habitation",
    "immeuble_logements_bureaux": "Immeuble de logements transformés en bureaux",
    "ensemble_immobilier": "Ensemble immobilier",
    "bureaux": "Bureaux",
    "immeuble_bureaux": "Immeuble de bureaux",
    "local_commercial": "Local commercial",
    "local_industriel": "Local industriel",
    "entrepot": "Entrepôt",
    "hangar": "Hangar",
    "batiment_agricole": "Bâtiment d'élevage",
    "hotel": "Hôtel",
    "enseignement": "Établissement d'enseignement",
    "parking": "Parking ou box",
    "cave": "Cave",
}

# Catégorie de la carte (« Fonciers », « Logements »…) -> type de repli.
CATEGORY_TYPES = {
    fold("Fonciers"): "land",
    fold("Logements"): None,
    fold("Bureaux / Commerces"): "commercial",
    fold("Bâtiments techniques et industriels"): "commercial",
    fold("Autres et atypiques"): None,
}

# Priorité quand une fiche publie plusieurs natures (lot mixte) : le bâti l'emporte.
TYPE_PRIORITY = ("house", "apartment", "building", "commercial", "parking", "land", "other")

_ATTACHMENT_KINDS = (
    ("cahier_des_charges", "Cahier des charges",
     r"cahier des charges|conditions? de vente|reglement de (?:la )?consultation"),
    ("formulaire_offre", "Formulaire d'offre", r"offre de prix|soumission|formulaire"),
    ("diagnostic", "Diagnostic", r"diagnostic|\bdpe\b|amiante|termite|plomb|\berp\b|errial|etat des risques"),
    ("certificat_urbanisme", "Certificat d'urbanisme", r"certificat d ?urbanisme"),
    ("plan_cadastral", "Plan cadastral",
     r"plan cadastral|cadastr|extrait du plan|plan parcellaire|parcelle|geoportail"),
    ("attestation_surfaces", "Attestation de surfaces", r"attestation de surfaces?|mesurage|carrez"),
    ("plan", "Plan", r"\bplans?\b|arpentage|bornage"),
    ("annexe", "Annexe", r"annexe|clause"),
    ("photo", "Photo", r"photo"),
    ("rapport", "Rapport", r"rapport|etude|expertise"),
)


def attachment_kind(filename: str | None) -> tuple[str, str]:
    """Type d'une pièce jointe d'après son nom de fichier publié."""
    spaced = re.sub(r"(?<=[a-z])(?=[A-Z])", " ", str(filename or "")).replace("_", " ")
    text = re.sub(r"\s+", " ", fold(spaced).replace("-", " "))
    for code, label, pattern in _ATTACHMENT_KINDS:
        if re.search(pattern, text, re.I):
            return code, label
    return "document", "Document"


_YES = re.compile(r"^(?:oui|yes|existante?s?|pr[ée]sente?s?|constructibles?|inscrit|class[ée]e?)\b", re.I)
_NO = re.compile(r"^(?:non|no|aucune?s?|n[ée]ant|absence|sans\s+objet|pas\s+de|non\s+constructibles?)\b", re.I)


def parse_bool(value: str | None) -> bool | None:
    text = fold(value)
    if not text:
        return None
    if _NO.search(text):
        return False
    if _YES.search(text):
        return True
    return None


def parse_count(value: str | None) -> int | None:
    """Entier publié seul (« 3 », « 12 ») ; une phrase ou une fourchette reste textuelle."""
    text = fold(value)
    if re.fullmatch(r"\d{1,4}", text):
        return int(text)
    return None


def parse_year(value: str | None) -> int | None:
    match = re.fullmatch(r"\s*((?:18|19|20)\d{2})\s*", str(value or ""))
    return int(match.group(1)) if match else None


_AREA_UNITS = (
    (r"ha|hectares?", Decimal(10000)),
    (r"a|ares?", Decimal(100)),
    (r"ca|centiares?", Decimal(1)),
)


def parse_surface(value: str | None) -> Decimal | None:
    """Surface en m² d'une tuile : « 2609 », « 2882 m2 », « 48 m2 environ », « 1 ha 20 a 5 ca ».

    Une valeur qui mélange plusieurs nombres de m² (« 78 et 124 m² ») n'est pas une
    surface unique : elle reste textuelle.
    """
    text = str(value or "").replace(" ", " ").strip()
    if not text:
        return None
    lowered = fold(text)
    unit_parts = re.findall(r"(\d+(?:[.,]\d+)?)\s*(ha|hectares?|ares?|a|ca|centiares?)\b", lowered)
    if unit_parts and not re.search(r"m\s*(?:2|²)", text):
        total = Decimal(0)
        for number, unit in unit_parts:
            for pattern, factor in _AREA_UNITS:
                if re.fullmatch(pattern, unit):
                    total += Decimal(number.replace(",", ".")) * factor
                    break
        return total.normalize() if total > 0 else None
    match = re.fullmatch(
        r"(?:environ\s+)?(\d{1,3}(?:[ .]\d{3})+|\d+)(?:[,.](\d+))?\s*(?:m\s*(?:2|²))?\s*(?:environ)?",
        lowered,
    )
    if not match:
        return None
    integer = re.sub(r"[ .]", "", match.group(1))
    decimals = match.group(2)
    try:
        number = Decimal(f"{integer}.{decimals}" if decimals else integer)
    except InvalidOperation:
        return None
    return number if number > 0 else None


def decimal_text(value: Decimal | None) -> str | None:
    if value is None:
        return None
    normalized = value.normalize()
    text = format(normalized, "f")
    return text.rstrip("0").rstrip(".") if "." in text else text


def lookup_field(label: str) -> FieldSpec | None:
    return FIELD_SPECS.get(fold(label))


def lookup_nature(label: str) -> tuple[str, str] | None:
    return NATURES.get(fold(label))
