"""Build compact extraction-vs-source evidence for the 2026-10-02 live audit.

The browser harness freezes the public response, DOM inventory and screenshots first.
This script only parses those frozen files with the production adapters and writes
small JSON summaries suitable for review; it never calls a source or Supabase.
"""

from __future__ import annotations

import json
import re
from copy import deepcopy
from pathlib import Path
from typing import Any

from bs4 import BeautifulSoup

from src.asset_normalization import normalize_asset_features
from src.enrichment.surface_reasoning import extract_and_apply_deterministic_surface_reasoning
from src.normalize import clean_text, normalize_sale
from src.sources.cessions_etat import parse_cessions_etat_detail_html
from src.sources.notaires import parse_notaires_detail_json


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "docs/audits/sources-2026-10-02/dynamic"


def compact(value: Any) -> Any:
    if isinstance(value, dict):
        return {str(k): compact(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [compact(v) for v in value]
    if hasattr(value, "isoformat"):
        return value.isoformat()
    if hasattr(value, "as_tuple"):
        return str(value)
    return value


def page_inventory(stem: str) -> dict[str, Any]:
    clean = OUTPUT / "clean" / f"{stem}-inventory.json"
    path = clean if clean.exists() else OUTPUT / f"{stem}-inventory.json"
    return json.loads(path.read_text())


def contains(text: str, *patterns: str) -> bool:
    return all(re.search(pattern, text, re.I | re.S) for pattern in patterns)


def source_field(
    source_present: bool,
    extracted: Any,
    normalized: Any,
    *,
    note: str | None = None,
) -> dict[str, Any]:
    return {
        "source_present": source_present,
        "extracted": compact(extracted),
        "normalized": compact(normalized),
        "gap": bool(source_present and extracted in (None, "", [], {})),
        **({"note": note} if note else {}),
    }


def surface_context(sale: Any) -> str:
    """Build the same deterministic surface context used by the offline audit."""
    raw_payload = sale.raw_payload if isinstance(sale.raw_payload, dict) else {}
    source_blocks = raw_payload.get("source_blocks")
    values = [sale.title, sale.description, sale.raw_text]
    if isinstance(source_blocks, dict):
        values.extend(source_blocks.values())
    return "\n".join(
        dict.fromkeys(
            text
            for value in values
            if (text := clean_text(value))
        )
    )


def deterministic_finalize(sale: Any) -> Any:
    """Replay the final deterministic pipeline after normalize_sale."""
    final = deepcopy(sale)
    extract_and_apply_deterministic_surface_reasoning(final, surface_context(final))
    normalize_asset_features(final)
    return final


def cessions_entry(stem: str, url: str) -> dict[str, Any]:
    response = OUTPUT / "clean" / f"{stem}-response.html"
    html = (response if response.exists() else OUTPUT / f"{stem}-response.html").read_text()
    soup = BeautifulSoup(html, "html.parser")
    raw = parse_cessions_etat_detail_html(html, url)
    normalized_sale = normalize_sale(raw)
    deterministic_sale = deterministic_finalize(normalized_sale)
    normalized = normalized_sale.to_storage_dict(exclude_none=False)
    deterministic_final = deterministic_sale.to_storage_dict(exclude_none=False)
    text = soup.get_text("\n", strip=True)
    source_images = [
        (img.get("data-image-src") or img.get("src"))
        for img in soup.select("img.gallery-modal-img, img.fr-responsive-img")
        if img.get("data-image-src") or img.get("src")
    ]
    source_images = list(dict.fromkeys(source_images))
    documents = [
        {
            "label": link.get_text(" ", strip=True),
            "href": link.get("href"),
        }
        for link in soup.select("a[download], a[href*='.pdf']")
        if link.get("href")
    ]
    fields = {
        "title": source_field(bool(soup.select_one("main h1, h1")), raw.get("title"), normalized.get("title")),
        "description": source_field(bool(re.search(r"Descriptif du bien", text, re.I)), raw.get("description"), normalized.get("description")),
        "city": source_field(bool(re.search(r"\b(?:Saint-junien|Bordeaux)\b", text, re.I)), raw.get("city"), normalized.get("city")),
        "property_type": source_field(bool(re.search(r"\b(?:Fonciers|Logements|Bureaux / Commerces)\b", text, re.I)), raw.get("property_type"), normalized.get("property_type")),
        "address": source_field(bool(re.search(r"Adresse|rue|boulevard|avenue", text, re.I)), raw.get("address"), normalized.get("address"), note="La page expose une adresse de référence cadastrale/carte, pas toujours une adresse de rue."),
        "postal_code": source_field(bool(re.search(r"\b\d{5}\b", text)), raw.get("postal_code"), normalized.get("postal_code")),
        "surface_m2": source_field(bool(re.search(r"Surface en m²", text, re.I)), raw.get("surface_m2"), normalized.get("surface_m2")),
        "land_surface_m2": source_field(bool(re.search(r"terrain|parcelle|surface en m²", text, re.I)), raw.get("land_surface_m2"), normalized.get("land_surface_m2"), note="Pour le lot agricole, la surface est exposée sous le libellé générique Surface en m² ; le parseur la range dans surface_m2."),
        # Do not treat the site's generic word "pièces" (for example in
        # "pièces jointes") as a published room count.  A count needs either
        # the explicit label or a numeric value immediately before the word.
        "rooms_count": source_field(bool(re.search(r"\b(?:nombre[ \t]+de[ \t]+pièces|\d+[ \t]+pièces)\b", text, re.I)), raw.get("rooms_count"), normalized.get("rooms_count")),
        "bedrooms_count": source_field(bool(re.search(r"chambre", text, re.I)), raw.get("bedrooms_count"), normalized.get("bedrooms_count")),
        "floors_count": source_field(bool(re.search(r"Nombre d'étages", text, re.I)), None, None, note="Présent sur Bordeaux (R+2 / Nombre d'étages), sans champ source dans le parseur Cessions."),
        "starting_price_eur": source_field(bool(re.search(r"Mise à prix|prix", text, re.I)), raw.get("starting_price_eur"), normalized.get("starting_price_eur"), note="Les fiches observées sont des appels d'offres ; aucune mise à prix n'est publiée dans le HTML."),
        # Publication/modification dates and "Fini dans N jours" are not a
        # sale date.  Only mark the field as source-present for an explicit
        # sale/adjudication deadline or opening label.
        "sale_date": source_field(bool(re.search(r"\b(?:date d['’]adjudication|date de fin de vente|début de vente|fin de vente|date de clôture|date de la vente)\b", text, re.I)), raw.get("sale_date"), normalized.get("sale_date")),
        "dpe_ges": source_field(bool(raw.get("dpe_class") or raw.get("ges_class")), {"dpe": raw.get("dpe_class"), "ges": raw.get("ges_class")}, {"dpe": None, "ges": None}, note="Un PDF de diagnostic est présent, mais aucune classe DPE/GES n'est dans le HTML source."),
        "manager_contact": source_field(bool(re.search(r"Gestionnaire de l'annonce|Contacter", text, re.I)), None, None, note="Nom, téléphone et email visibles ; le parseur ne les conserve pas dans les champs structurés."),
        "procedure": source_field(bool(re.search(r"Procédure de vente|Type de vente", text, re.I)), None, None, note="La procédure (Appel d'offres) est visible mais n'est pas représentée dans le dictionnaire Cessions."),
        "cadastral_and_plu": source_field(bool(re.search(r"Référence cadastrale|Zonage d'urbanisme|PLU", text, re.I)), None, None, note="Référence cadastrale, INSEE et zonage sont dans le bloc détaillé mais seulement dans raw_text."),
        "source_images": source_field(bool(source_images), raw.get("source_images"), normalized.get("raw_payload", {}).get("source_images") or raw.get("source_images"), note=f"DOM: {len(source_images)} URL(s) distincte(s), parseur propriété: {len(raw.get('source_images') or [])}."),
        "documents": source_field(bool(documents), raw.get("documents"), normalized.get("documents"), note=f"DOM: {len(documents)} lien(s) PDF, parseur: {len(raw.get('documents') or [])}."),
    }
    return {
        "id": stem,
        "source": "cessions_etat",
        "url": url,
        "http_status": 200,
        "inventory": {
            "title": page_inventory(stem).get("title"),
            "text_characters": len(page_inventory(stem).get("text", "")),
            "headings": page_inventory(stem).get("headings", []),
            "blocks": len(page_inventory(stem).get("blocks", [])),
            "images": len(page_inventory(stem).get("images", [])),
            "links": len(page_inventory(stem).get("links", [])),
            "unique_property_images": len(source_images),
            "documents": len(documents),
        },
        "raw": compact(raw),
        "normalized": compact(normalized),
        "deterministic_final": compact(deterministic_final),
        "fields": fields,
    }


def notaires_entry(stem: str, id_: str, public_url: str) -> dict[str, Any]:
    response = OUTPUT / "clean" / f"{stem}-response.html"
    payload = json.loads((response if response.exists() else OUTPUT / f"{stem}-response.html").read_text())
    raw = {
        "source_name": "notaires",
        "source_url": public_url,
        "external_id": id_,
        **parse_notaires_detail_json(json.dumps(payload, ensure_ascii=False)),
    }
    normalized_sale = normalize_sale(raw)
    deterministic_sale = deterministic_finalize(normalized_sale)
    normalized = normalized_sale.to_storage_dict(exclude_none=False)
    deterministic_final = deterministic_sale.to_storage_dict(exclude_none=False)
    transaction = payload.get("vni") or payload.get("vae") or {}
    bien = payload.get("bien") or {}
    type_code = bien.get("typeBien")
    property_block = bien.get({"APP": "appartement", "MAI": "maison", "TER": "terrain"}.get(type_code, ""), {})
    descriptions = transaction.get("descriptions") or []
    description_text = next((d.get("descLongue") for d in descriptions if d.get("langue") == "fr"), None)
    description_short = next((d.get("descCourte") for d in descriptions if d.get("langue") == "fr"), None)
    multimedia = transaction.get("multimedias") or []
    source_blocks = raw.get("source_blocks") or {}
    fields = {
        "title": source_field(bool(description_short), raw.get("title"), normalized.get("title")),
        "description": source_field(bool(description_text), raw.get("description"), normalized.get("description")),
        "address": source_field(bool(property_block.get("adresse4")), raw.get("address"), normalized.get("address")),
        "postal_code": source_field(bool(property_block.get("codePostal")), raw.get("postal_code"), normalized.get("postal_code")),
        "property_type": source_field(bool(type_code), raw.get("property_type"), normalized.get("property_type")),
        "surface_m2": source_field(property_block.get("surfaceHabitable") is not None or property_block.get("surface") is not None, raw.get("surface_m2"), normalized.get("surface_m2")),
        "carrez_surface_m2": source_field(property_block.get("surfaceCarrez") is not None or bool(re.search(r"carrez", description_text or "", re.I)), raw.get("carrez_surface_m2"), normalized.get("carrez_surface_m2")),
        "land_surface_m2": source_field(property_block.get("surfaceTerrain") is not None, raw.get("land_surface_m2"), normalized.get("land_surface_m2")),
        "rooms_count": source_field(property_block.get("nbPieces") is not None, raw.get("rooms_count"), normalized.get("rooms_count")),
        "bedrooms_count": source_field(property_block.get("nbChambres") is not None, raw.get("bedrooms_count"), normalized.get("bedrooms_count")),
        "bathrooms_count": source_field(property_block.get("nbSdb") is not None or bool(re.search(r"salle d'eau|salle de bains", description_text or "", re.I)), raw.get("bathrooms_count"), normalized.get("bathrooms_count")),
        "floor": source_field(property_block.get("etage") is not None, source_blocks.get("etage"), normalized.get("raw_payload", {}).get("etage"), note="etage est dans l'API, mais le parseur ne le copie pas dans source_blocks (seul nb_etages est conservé)."),
        "floors_count": source_field(property_block.get("nbEtages") is not None, source_blocks.get("nb_etages"), normalized.get("raw_payload", {}).get("nb_etages")),
        "starting_price_eur": source_field(transaction.get("premierPrix") is not None or transaction.get("prixMin") is not None, raw.get("starting_price_eur"), normalized.get("starting_price_eur")),
        "sale_window": source_field(transaction.get("dateDebutEncheres") is not None or transaction.get("dateFinEncheres") is not None, raw.get("source_sale_schedule"), normalized.get("sale_date")),
        "visits": source_field(bool((transaction.get("visite") or {}).get("visiteLibre")), raw.get("visit_dates"), normalized.get("visit_dates")),
        "dpe_ges": source_field(property_block.get("consommationClasse") not in (None, "INCONNU") or property_block.get("emissionGesClasse") not in (None, "INCONNU"), {"dpe": property_block.get("consommationClasse"), "ges": property_block.get("emissionGesClasse"), "dpe_value": property_block.get("consommation"), "ges_value": property_block.get("emissionGes")}, {"dpe": source_blocks.get("dpe_classe"), "ges": source_blocks.get("ges_classe"), "dpe_value": None, "ges_value": None}, note="Les classes sont conservées dans source_blocks ; les valeurs kWh/kgCO₂ et la date DPE ne sont pas des champs structurés."),
        "taxe_fonciere": source_field(property_block.get("taxeFonciere") is not None, None, None, note="Présente dans l'API détail, absente du contrat de sortie."),
        "charges": source_field((bien.get("copropriete") or {}).get("montantChargesAnnuelles") is not None, None, None, note="Charges annuelles présentes pour Arcachon, absentes des champs structurés."),
        "contact": source_field(bool(payload.get("contact")), raw.get("lawyer_contact"), normalized.get("lawyer_contact")),
        "source_images": source_field(bool(multimedia), raw.get("source_images"), normalized.get("raw_payload", {}).get("source_images") or raw.get("source_images"), note=f"API détail: {len(multimedia)} média(s), parseur: {len(raw.get('source_images') or [])}."),
        "documents": source_field(False, raw.get("documents"), normalized.get("documents"), note="Aucun document n'est exposé dans les deux détails VNI observés."),
    }
    inventory = page_inventory(stem)
    public_inventory = page_inventory(stem.replace("notaires-", "notaires-public-", 1))
    return {
        "id": stem,
        "source": "notaires",
        "url": public_url,
        "api_url": f"https://www.immobilier.notaires.fr/pub-services/inotr-www-annonces/v1/annonces/{id_}",
        "http_status": 200,
        "inventory": {
            "text_characters": len(inventory.get("text", "")),
            "headings": inventory.get("headings", []),
            "blocks": len(inventory.get("blocks", [])),
            "images": len(inventory.get("images", [])),
            "links": len(inventory.get("links", [])),
            "json_keys": sorted(payload),
            "multimedia": len(multimedia),
        },
        "public_inventory": {
            "text_characters": len(public_inventory.get("text", "")),
            "headings": public_inventory.get("headings", []),
            "blocks": len(public_inventory.get("blocks", [])),
            "images": len(public_inventory.get("images", [])),
            "links": len(public_inventory.get("links", [])),
        },
        "raw": compact(raw),
        "normalized": compact(normalized),
        "deterministic_final": compact(deterministic_final),
        "fields": fields,
    }


def main() -> None:
    entries = [
        cessions_entry(
            "cessions-39823-saint-junien",
            "https://cessions.immobilier-etat.gouv.fr/biens/parcelle-br-ndeg104-saint-junien-87200",
        ),
        cessions_entry(
            "cessions-39632-bordeaux",
            "https://cessions.immobilier-etat.gouv.fr/biens/vendre-hyper-centre-ville-de-bordeaux",
        ),
        notaires_entry(
            "notaires-2083008-arcachon",
            "2083008",
            "https://www.immo-interactif.fr/encheres-en-ligne/appartement/arcachon-33/2083008",
        ),
        notaires_entry(
            "notaires-2074289-bordeaux",
            "2074289",
            "https://www.immo-interactif.fr/encheres-en-ligne/maison/bordeaux-33/2074289",
        ),
    ]
    (OUTPUT / "extraction-audit.json").write_text(json.dumps(compact(entries), ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"entries": len(entries), "output": str(OUTPUT / "extraction-audit.json")}, ensure_ascii=False))


if __name__ == "__main__":
    main()
