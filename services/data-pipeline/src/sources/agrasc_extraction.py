"""Lecture structurée des fiches opérateur des ventes AGRASC (fonctions pures).

Les biens confisqués vendus par l'AGRASC sont commercialisés sur Agorastore
(enchères en ligne). La fiche produit publie ses caractéristiques sous forme de
paires libellé/valeur (``descriptifs``), l'état de la vente (``saleState`` :
frais acheteur, pas d'enchère, enchères glissantes) et une liste de pièces
jointes. Ce module, sans accès réseau, en tire :

* le type documentaire de chaque pièce (modalités de vente, diagnostics,
  bornage…) pour ``auction_documents`` ;
* les faits utiles à l'investisseur écrits en clair dans « Points clés »
  (occupation, loyer, taxe foncière) ;
* le bloc ``source_blocks.caracteristiques_bien`` (contrat
  ``property_characteristics_v1``, comme les cessions de l'État).

:func:`refresh_agrasc_raw_sale` rejoue cette lecture sur une vente stockée
(``source_blocks.operator_fields``), sans requête.
"""

from __future__ import annotations

import re
import unicodedata
from typing import Any

from src.normalize import clean_text

DISPLAY_SCHEMA_VERSION = "property_characteristics_v1"
AGORASTORE_LABEL = "Agorastore (commercialisateur pour l'AGRASC)"
FEATURES_SCHEMA_VERSION = "agrasc_operator_features_v1"
GROUPS = {
    "identification": "Identification",
    "surfaces": "Surfaces",
    "batiment": "Bâtiment",
    "equipements": "Équipements",
    "situation": "Situation et occupation",
    "copropriete": "Copropriété",
    "urbanisme": "Urbanisme et terrain",
    "diagnostics": "Diagnostics",
    "vente": "Conditions de la vente",
    "divers": "Autres informations",
}
# Libellé publié (replié) -> groupe d'affichage.
FIELD_GROUPS = {
    "type de bien": "identification",
    "destination": "identification",
    "adresse": "identification",
    "surface habitable": "surfaces",
    "surface carrez": "surfaces",
    "surface terrain": "surfaces",
    "surface parcelle": "surfaces",
    "surface utile": "surfaces",
    "etat general": "batiment",
    "etage et distribution": "batiment",
    "etages et distribution": "batiment",
    "etage": "batiment",
    "annee de construction": "batiment",
    "chauffage": "equipements",
    "equipements techniques": "equipements",
    "copropriete": "copropriete",
    "charges de copropriete": "copropriete",
    "references cadastrales": "urbanisme",
    "zonage": "urbanisme",
    "reglement applicable": "urbanisme",
    "bonne accessibilite": "situation",
    "localisation exceptionnelle": "situation",
    "bien d'exception": "situation",
    "bien rare sur son secteur": "situation",
    "points cles": "situation",
    "important": "vente",
}
DOCUMENT_TYPE_LABELS = {
    "conditions_vente": "Modalités de vente",
    "diagnostics_techniques": "Diagnostics",
    "annonce_vente": "Fiche descriptive et urbanisme",
    "cadastre": "Bornage / plan",
    "cahier_conditions_vente": "Règlement de la consultation",
}


def fold(value: object | None) -> str:
    text = unicodedata.normalize("NFKD", str(value or "")).encode("ascii", "ignore").decode("ascii")
    text = text.replace("’", "'").lower()
    return re.sub(r"\s+", " ", text).strip(" :.-")


def classify_operator_document(label: object | None, url: object | None = None) -> str | None:
    """Type documentaire d'une pièce opérateur ; ``None`` laisse le classement générique."""
    text = fold(f"{label or ''}")
    if not text:
        return None
    if re.search(r"\bmodalites? de vente\b|\bconditions? (?:generales? )?de vente\b", text):
        return "conditions_vente"
    if re.search(r"\breglement (?:de|du) (?:la )?consultation\b|\bconsultation rules\b|\bcahier des charges\b", text):
        return "cahier_conditions_vente"
    if re.search(r"\breglement du service\b", text):
        return None  # règlement municipal (assainissement…) : document d'information générale
    if re.search(
        r"^dia[-_ ]|\bdiag(?:nostic)?s?\b|\bdpe\b|\berp\b|\bamiante\b|\bplomb\b|\btermites?\b|\baudit\b"
        r"|\bmesurage\b|\bcarrez\b|^assainissement$|\bdiagnostic assainissement\b|\belectricite\b|\bgaz\b",
        text,
    ):
        return "diagnostics_techniques"
    if re.search(r"\bbornage\b|\bplan cadastral\b|\bgeometre\b", text):
        return "cadastre"
    if re.search(r"^descriptif\b|\bdescriptif et urbanisme\b", text):
        return "annonce_vente"
    return None


_PERSON_IN_LABEL_RE = re.compile(r"[\s_,;-]*(?<![a-z])(?:madame|monsieur|mme|mlle|m\.)[\s_]+.*$", re.I)


def public_document_label(label: object | None) -> str | None:
    """Libellé de pièce sans le nom d'une personne (« …_Dossier_AGRASC,_Madame_X » -> « …_Dossier_AGRASC »)."""
    text = clean_text(label)
    if not text:
        return None
    return _PERSON_IN_LABEL_RE.sub("", text).strip(" _,;-") or text


def type_operator_documents(documents: object | None) -> list[dict[str, Any]]:
    """Ajoute ``document_type`` aux pièces dont le libellé est explicite (sans écraser)."""
    typed: list[dict[str, Any]] = []
    for document in documents if isinstance(documents, list) else []:
        if not isinstance(document, dict):
            continue
        item = dict(document)
        if item.get("label"):
            item["label"] = public_document_label(item["label"])
        kind = classify_operator_document(item.get("label"), item.get("url"))
        if kind and not item.get("document_type"):
            item["document_type"] = kind
        if re.search(r"\bconsultation rules\b", fold(item.get("label"))):
            item["language"] = "en"
        typed.append(item)
    return typed


_AMOUNT = r"(\d{1,3}(?:[  .]\d{3})*(?:,\d{1,2})?|\d+(?:,\d{1,2})?)\s*(?:€|euros?)"


def _amount(text: str) -> float | None:
    digits = re.sub(r"[  .]", "", text).replace(",", ".")
    try:
        value = float(digits)
    except ValueError:
        return None
    return value if value > 0 else None


def points_cles_facts(text: object | None) -> dict[str, Any]:
    """Occupation, loyer et taxe foncière écrits en clair dans « Points clés »."""
    value = clean_text(text) or ""
    facts: dict[str, Any] = {}
    occupation = re.search(r"[ée]tat d['’]occupation\s*:\s*([^\n]+?)(?:\.\s|\n|$)", value, re.I)
    if occupation:
        statement = occupation.group(1).strip()
        facts["occupancy_text"] = statement[:300]
        if re.search(r"\blibre\b", statement, re.I):
            facts["occupancy"] = "vacant"
        elif re.search(r"\blou[ée]e?\b|\bbail\b", statement, re.I):
            facts["occupancy"] = "rented"
        elif re.search(r"\boccup[ée]e?\b", statement, re.I):
            facts["occupancy"] = "occupied"
    rent = re.search(
        rf"\bloyer(?:\s+(?:initial|mensuel))?\s+(?:de\s+)?{_AMOUNT}\s*(HC|CC|hors charges|charges comprises)?"
        rf"(?:\s*(?:/|par)\s*mois|.{{0,60}}?/\s*mois)?",
        value,
        re.I,
    )
    if rent:
        facts["rent_monthly_eur"] = _amount(rent.group(1))
        basis = (rent.group(2) or "").lower()
        if basis:
            facts["rent_basis"] = "hors charges" if basis in {"hc", "hors charges"} else "charges comprises"
    charges = re.search(rf"(\bdont\s+)?\b{_AMOUNT}\s*(?:/\s*mois\s*)?de charges\b", value, re.I)
    if charges and rent:
        facts["rent_charges_monthly_eur"] = _amount(charges.group(2))
        if charges.group(1) and not facts.get("rent_basis"):
            facts["rent_basis"] = "charges comprises"
    tax = re.search(
        rf"\btaxe fonci[èe]re(?:\s+(?P<year1>20\d{{2}}))?\s*:\s*{_AMOUNT}(?:\s*pour l['’]ann[ée]e\s+(?P<year2>20\d{{2}}))?",
        value,
        re.I,
    )
    if tax:
        facts["property_tax_eur"] = _amount(tax.group(2))
        year = tax.group("year1") or tax.group("year2")
        if year:
            facts["property_tax_year"] = int(year)
    return {key: item for key, item in facts.items() if item not in (None, "")}


def _money(value: object | None) -> str | None:
    try:
        amount = float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None
    if amount <= 0:
        return None
    return f"{amount:,.0f} €".replace(",", " ")


def sale_state_terms(sale_state: dict[str, Any] | None) -> dict[str, Any]:
    """Conditions publiques de l'enchère Agorastore (``saleState``)."""
    state = sale_state if isinstance(sale_state, dict) else {}
    terms: dict[str, Any] = {}
    for source_key, key in (
        ("tauxFraisAcheteur", "buyer_fee_rate_pct"),
        ("bidStep", "bid_increment_eur"),
        ("initialPrice", "starting_price_eur"),
        ("postponedTime", "extension_minutes"),
    ):
        raw = state.get(source_key)
        if isinstance(raw, (int, float)) and not isinstance(raw, bool) and raw > 0:
            terms[key] = raw
    if state.get("isEnchereGlissante") is True:
        terms["sliding_auction"] = True
    if state.get("requireProductAuthorization") is True:
        terms["authorization_required"] = True
    if state.get("isTtc") is True:
        terms["prices_include_tax"] = True
    return terms


def build_operator_display(
    fields: list[tuple[str, str]] | list[list[str]],
    *,
    documents: list[dict[str, Any]] | None = None,
    photos: int = 0,
    terms: dict[str, Any] | None = None,
    operator_label: str | None = None,
    visit_dates: list[str] | None = None,
    facts: dict[str, Any] | None = None,
) -> dict[str, Any] | None:
    """Bloc ``caracteristiques_bien`` d'une fiche Agorastore."""
    items: list[dict[str, str]] = []
    seen: set[tuple[str, str]] = set()
    for pair in fields or []:
        if not isinstance(pair, (list, tuple)) or len(pair) != 2:
            continue
        label, value = clean_text(pair[0]), clean_text(pair[1])
        if not label or not value:
            continue
        key = fold(label)
        group = FIELD_GROUPS.get(key, "divers")
        # « Etage » publié avec un montant de charges (saisie opérateur) : rangé avec la copropriété.
        if key == "etage" and re.search(r"€|\btrimestre\b|\bcharges?\b", value, re.I):
            label, group = "Charges de copropriété (publiées sous « Étage »)", "copropriete"
        if (label, value) in seen:
            continue
        seen.add((label, value))
        items.append({"key": re.sub(r"[^a-z0-9]+", "_", key).strip("_"), "label": label, "value": value, "group": group})
    facts = facts or {}
    if facts.get("rent_monthly_eur"):
        basis = f" {facts['rent_basis']}" if facts.get("rent_basis") else ""
        items.append({"key": "rent_monthly", "label": "Loyer mensuel", "value": f"{_money(facts['rent_monthly_eur'])}{basis}",
                      "group": "situation"})
    if facts.get("property_tax_eur"):
        year = f" ({facts['property_tax_year']})" if facts.get("property_tax_year") else ""
        items.append({"key": "property_tax", "label": "Taxe foncière", "value": f"{_money(facts['property_tax_eur'])}{year}",
                      "group": "divers"})
    terms = terms or {}
    if terms.get("buyer_fee_rate_pct"):
        rate = str(terms["buyer_fee_rate_pct"]).replace(".", ",")
        items.append({"key": "buyer_fee", "label": "Frais acheteur", "value": f"{rate} % TTC du prix d'adjudication",
                      "group": "vente"})
    if terms.get("sliding_auction"):
        extension = f" de {terms['extension_minutes']} min" if terms.get("extension_minutes") else ""
        items.append({"key": "sliding_auction", "label": "Enchères glissantes",
                      "value": f"Oui (prolongation{extension} en cas d'offre en fin de vente)", "group": "vente"})
    if terms.get("authorization_required"):
        items.append({"key": "authorization", "label": "Participation", "value": "Soumise à l'autorisation du vendeur",
                      "group": "vente"})
    if not items:
        return None
    attachments = [
        {"label": clean_text(document.get("label")) or "Pièce jointe",
         "kind": document.get("document_type") or "pdf",
         "kind_label": DOCUMENT_TYPE_LABELS.get(str(document.get("document_type") or ""), "Autre document")}
        for document in documents or [] if isinstance(document, dict) and document.get("url")
    ]
    prices = {key: terms[key] for key in ("starting_price_eur", "bid_increment_eur") if terms.get(key)}
    procedure: dict[str, Any] = {"method_label": "Enchères en ligne Agorastore"}
    if prices:
        procedure["prices"] = prices
    if visit_dates:
        procedure["visits"] = [_visit_text(item) for item in list(visit_dates)[:4]]
    display: dict[str, Any] = {
        "schema_version": DISPLAY_SCHEMA_VERSION,
        "source": "agrasc",
        "groups": {key: title for key, title in GROUPS.items() if key in {item["group"] for item in items}},
        "items": items,
        "media": {"photos": photos} if photos else {},
        "attachments": attachments,
        "procedure": procedure,
    }
    if operator_label:
        display["manager"] = {"service": operator_label,
                              "heading": "Contact de la vente"}
    return {key: value for key, value in display.items() if value not in (None, "", [], {})}


def _visit_text(value: str) -> str:
    match = re.match(r"(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})", value or "")
    if not match:
        return value
    year, month, day, hour, minute = match.groups()
    return f"Dernière visite le {day}/{month}/{year} à {hour}h{minute}"


def operator_fields_from_blocks(blocks: dict[str, Any]) -> list[tuple[str, str]]:
    fields = blocks.get("operator_fields") if isinstance(blocks, dict) else None
    pairs: list[tuple[str, str]] = []
    for pair in fields if isinstance(fields, list) else []:
        if isinstance(pair, (list, tuple)) and len(pair) == 2:
            pairs.append((str(pair[0] or ""), str(pair[1] or "")))
    return pairs


def points_cles_text(fields: list[tuple[str, str]]) -> str:
    return "\n".join(value for label, value in fields if fold(label) == "points cles")


def refresh_agrasc_raw_sale(raw_sale: dict[str, Any]) -> bool:
    """Rejoue la lecture Agorastore sur ``source_blocks.operator_fields`` stocké (sans réseau)."""
    if str(raw_sale.get("source_name") or "") != "agrasc":
        return False
    blocks = raw_sale.get("source_blocks") if isinstance(raw_sale.get("source_blocks"), dict) else {}
    fields = operator_fields_from_blocks(blocks)
    documents = type_operator_documents(raw_sale.get("documents"))
    changed = documents != (raw_sale.get("documents") or [])
    if documents:
        raw_sale["documents"] = documents
    if not fields:
        return changed
    facts = points_cles_facts(points_cles_text(fields))
    images = raw_sale.get("source_images") if isinstance(raw_sale.get("source_images"), list) else []
    stored_terms = (raw_sale.get("source_property_features") or {}).get("operator_sale_terms") \
        if isinstance(raw_sale.get("source_property_features"), dict) else None
    display = build_operator_display(
        fields,
        documents=documents,
        photos=len(images),
        terms=stored_terms if isinstance(stored_terms, dict) else None,
        operator_label=AGORASTORE_LABEL,
        visit_dates=[item for item in raw_sale.get("visit_dates") or [] if isinstance(item, str)],
        facts=facts,
    )
    if display:
        raw_sale["source_blocks"] = {**blocks, "caracteristiques_bien": display, **flat_operator_blocks(facts)}
    apply_points_cles_facts(raw_sale, facts)
    return True


def flat_operator_blocks(facts: dict[str, Any], terms: dict[str, Any] | None = None) -> dict[str, Any]:
    terms = terms or {}
    blocks = {
        "occupation_operateur": facts.get("occupancy_text"),
        "loyer_mensuel_eur": facts.get("rent_monthly_eur"),
        "taxe_fonciere_eur": facts.get("property_tax_eur"),
        "taxe_fonciere_annee": facts.get("property_tax_year"),
        "frais_acheteur_pct": terms.get("buyer_fee_rate_pct"),
        "pas_enchere_eur": terms.get("bid_increment_eur"),
    }
    return {key: value for key, value in blocks.items() if value not in (None, "")}


def apply_points_cles_facts(raw_sale: dict[str, Any], facts: dict[str, Any]) -> None:
    """Occupation explicite des « Points clés » : ne remplace qu'une valeur absente ou inconnue."""
    occupancy = facts.get("occupancy")
    if occupancy and str(raw_sale.get("occupancy_status") or "unknown") in {"", "unknown", "None"}:
        raw_sale["occupancy_status"] = occupancy
    features = raw_sale.get("source_property_features") if isinstance(raw_sale.get("source_property_features"), dict) else {}
    if facts:
        raw_sale["source_property_features"] = {**features, "operator_key_points": facts,
                                                "operator_schema_version": FEATURES_SCHEMA_VERSION}
