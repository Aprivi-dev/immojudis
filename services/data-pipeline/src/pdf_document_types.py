"""Document type classification shared by the PDF extraction pipeline."""

from __future__ import annotations

import re
import unicodedata

from src.normalize import clean_text

DOCUMENT_TYPE_ALIASES = {
    "pv_descriptif": "pv_huissier",
    "proces_verbal_descriptif": "pv_huissier",
    "proces_verbal_de_description": "pv_huissier",
    "proces_verbal_de_constat": "pv_huissier",
    "pvd": "pv_huissier",
    "diagnostic": "diagnostics_techniques",
    "diagnostics": "diagnostics_techniques",
    "diagnostic_technique": "diagnostics_techniques",
    "cahier_conditions": "cahier_conditions_vente",
    "cahier_des_conditions": "cahier_conditions_vente",
    "cahier_des_conditions_de_vente": "cahier_conditions_vente",
    "ccv": "cahier_conditions_vente",
}

GENERIC_DOCUMENT_TYPES = {"document", "documents", "file", "fichier", "pdf", "piece_jointe", "pieces_jointes"}


def classify_document_type(label: str | None, url: str | None = None) -> str:
    raw = _normalize_document_classifier_text(f"{label or ''} {url or ''}")
    # Underscores, hyphens and dots separate words in file names
    # ("8_Certificat_durbanisme_240550005.pdf"); match on plain words.
    text = _words(raw)
    # Short abbreviations are only trusted in the label: they are too
    # ambiguous inside URL paths.
    label_text = _words(_normalize_document_classifier_text(label))
    if any(pattern in text for pattern in ("diagnostic", "dpe", "erp", "amiante", "plomb", "termites", "crep")):
        return "diagnostics_techniques"
    if re.search(r"\bdiags?\b", text):
        return "diagnostics_techniques"
    if re.search(r"\bddt\b|\bdti\b", label_text):
        return "diagnostics_techniques"
    # Attestation / certificat de superficie (mesurage Carrez ou surface habitable) :
    # un diagnostic technique, même quand l'URL contient « /annonce/ » (Licitor).
    if re.search(
        r"\b(?:attestation|certificat|metrage|mesurage)s? (?:de )?(?:la )?(?:superficie|surface)"
        r"|\bmesurage\b|\bcarrez\b|\bargiles?\b|\betat des risques\b|\bprevention des risques\b|\bgeorisques\b",
        text,
    ):
        return "diagnostics_techniques"
    if any(
        pattern in text
        for pattern in (
            "cahier",
            "cahier des conditions",
            "cahier des charges",
            "ccv",
            "dossier de consultation",
            "dossier de presentation",
            "reglement de consultation",
        )
    ):
        return "cahier_conditions_vente"
    if "descriptif" not in text and (
        re.search(r"\burbanisme\b|\bdurbanisme\b", text) or re.search(r"\bcu\b|\bplu\b", label_text)
    ):
        return "cadastre"
    # A « dire » or an « additif » amends the cahier des conditions de vente.
    if re.search(r"\bdires?\b|\badditifs?\b", label_text):
        return "cahier_conditions_vente"
    if any(
        pattern in text
        for pattern in (
            "conditions de vente",
            "reglement de vente",
            "reglement des ventes",
            "reglement vente",
            "modalites de vente",
            "modele d offre",
            "modele doffre",
            "clause interessement",
            "clause d interessement",
        )
    ):
        return "conditions_vente"
    if re.search(r"\btitre de propriete\b|\bacte (?:de propriete|d acquisition|de vente)\b", text):
        return "titre_propriete"
    if any(pattern in text for pattern in ("pv notaire", "notaire", "notarie")):
        return "pv_notaire"
    if any(
        pattern in text
        for pattern in (
            "pv descriptif",
            "pv description",
            "pvd",
            "descriptif",
            "proces verbal de constat",
            "commissaire de justice",
            "huissier",
        )
    ):
        return "pv_huissier"
    if re.search(r"\bproces verbal\b.*\b(?:description|descriptif|constat)\b", text):
        return "pv_huissier"
    if re.search(r"\bdossier (?:de )?(?:diagnostics? )?techniques?\b", text):
        return "diagnostics_techniques"
    # Minutes of a co-ownership general meeting are not a procès-verbal
    # descriptif of the property.
    if re.search(
        r"copropriete|\bsyndic\b|\bassemblee generale\b|\betat date\b"
        r"|\bcarnet d entretien\b",
        text,
    ) or re.search(r"\b(?:pv|proces verbal) (?:de l |d )?ag[eos]?\b|\brcp\b", label_text):
        return "copropriete"
    if re.search(r"\bpv\b", text):
        return "pv_huissier"
    if re.search(r"\bproces verbal\b", text):
        return "proces_verbal"
    if re.search(r"\bactes? (?:de (?:la )?)?procedure\b", text):
        return "procedure_saisie"
    if any(
        pattern in text
        for pattern in (
            "avis",
            "simplifie",
            "affiche",
            "insertion",
            "annonce",
            "placard",
            "publicite",
            "texte complet",
        )
    ) or re.search(r"\bpub\b|\bvae\b", label_text):
        return "annonce_vente"
    if "bail" in text or "location" in text:
        return "bail"
    if any(pattern in text for pattern in ("hypothecaire", "commandement")):
        return "procedure_saisie"
    if any(pattern in text for pattern in ("cadastr", "plan", "parcelle")):
        return "cadastre"
    if ".pdf" in raw:
        return "pdf"
    return "other"


def _normalize_document_classifier_text(value: object | None) -> str:
    text = clean_text(value) or ""
    normalized = unicodedata.normalize("NFKD", text)
    without_accents = "".join(char for char in normalized if not unicodedata.combining(char))
    return without_accents.lower()


def _words(normalized: str) -> str:
    return " ".join(re.findall(r"[a-z0-9]+", normalized))


# Titles printed at the top of the first page. Used only when the label and
# URL say nothing ("Document PDF"): the earliest title on the page wins.
_CONTENT_TITLES = (
    ("cahier_conditions_vente", r"cahier des conditions de (?:la )?vente|cahier des charges"),
    (
        "pv_huissier",
        r"proces verbal (?:de )?(?:description|descriptif|constat)|pv (?:de )?(?:description|descriptif)",
    ),
    (
        "diagnostics_techniques",
        r"dossier (?:de )?diagnostics? techniques?|diagnostic de performance energetique"
        r"|rapport de (?:mission de )?reperage|constat de risque d exposition au plomb|etat des risques"
        r"|etat de l installation interieure|etat relatif a la presence de termites"
        r"|(?:attestation|certificat) de (?:superficie|surface|mesurage)|loi carrez",
    ),
    (
        "cadastre",
        r"certificat d urbanisme|renseignements d urbanisme|plan local d urbanisme|extrait (?:du )?(?:plan )?cadastral",
    ),
    (
        "copropriete",
        r"reglement de copropriete|assemblee generale (?:ordinaire|extraordinaire|des coproprietaires)|etat date",
    ),
    ("annonce_vente", r"avis de vente|vente aux encheres publiques|vente sur (?:saisie|licitation)"),
)
_CONTENT_WINDOW_CHARS = 1500
GENERIC_CLASSIFIED_TYPES = frozenset({"pdf", "other"})


def classify_document_content(text: object | None) -> str | None:
    """Document type from the title of its first page, or None."""
    window = _words(_normalize_document_classifier_text(text))[:_CONTENT_WINDOW_CHARS]
    best: tuple[int, str] | None = None
    for document_type, pattern in _CONTENT_TITLES:
        match = re.search(rf"\b(?:{pattern})\b", window)
        if match and (best is None or match.start() < best[0]):
            best = (match.start(), document_type)
    return best[1] if best else None


def _first_page_text(payload: object) -> str:
    if not isinstance(payload, dict):
        return ""
    pages = payload.get("pages")
    if isinstance(pages, list):
        texts = [str(page.get("text") or "") for page in pages[:3] if isinstance(page, dict)]
        # A cover page with a few words only: read the next one too.
        for index, text in enumerate(texts):
            if len(text.strip()) >= 200:
                return " ".join(texts[: index + 1])
        return " ".join(texts)
    return str(payload.get("text") or "")


def document_type_with_content(label: object | None, url: object | None, payload: object | None) -> str:
    """Label/URL classification, refined from the extracted text when generic."""
    classified = classify_document_type(clean_text(label), clean_text(url))
    if classified in GENERIC_CLASSIFIED_TYPES:
        return classify_document_content(_first_page_text(payload)) or classified
    return classified


def refined_document_type(payload: dict[str, object]) -> str:
    """Type of an extracted document: its known type, its label, then its text."""
    canonical = _canonical_document_type(
        payload.get("document_type") or payload.get("type"),
        label=payload.get("label"),
        url=payload.get("url"),
    )
    if canonical in GENERIC_CLASSIFIED_TYPES:
        return classify_document_content(_first_page_text(payload)) or canonical
    return canonical


def with_content_document_types(payloads: list[dict[str, object]]) -> list[dict[str, object]]:
    for payload in payloads:
        if isinstance(payload, dict):
            payload["document_type"] = refined_document_type(payload)
    return payloads


def _canonical_document_type(
    document_type: object | None,
    *,
    label: object | None = None,
    url: object | None = None,
) -> str:
    classified = classify_document_type(clean_text(label), clean_text(url))
    raw = clean_text(document_type)
    if raw:
        normalized = _normalize_document_classifier_text(raw).replace("-", "_").replace(" ", "_")
        normalized = re.sub(r"_+", "_", normalized).strip("_")
        alias = DOCUMENT_TYPE_ALIASES.get(normalized)
        if alias:
            return alias
        if normalized in GENERIC_DOCUMENT_TYPES and classified != "other":
            return classified
        if normalized not in {"other", "unknown"}:
            return normalized
    return classified


PDF_DESCRIPTION_GROUP = frozenset({"pv_huissier", "pv_notaire", "proces_verbal"})

PDF_DIAGNOSTICS_GROUP = frozenset({"diagnostics_techniques"})

PDF_CONDITIONS_GROUP = frozenset({"cahier_conditions_vente", "conditions_vente"})

PDF_ANNOUNCE_GROUP = frozenset({"annonce_vente"})

PDF_BAIL_GROUP = frozenset({"bail"})

PDF_CADASTRE_GROUP = frozenset({"cadastre"})

DEFAULT_DOCUMENT_GROUPS = (
    PDF_DESCRIPTION_GROUP,
    PDF_DIAGNOSTICS_GROUP,
    PDF_CONDITIONS_GROUP,
    PDF_ANNOUNCE_GROUP,
    PDF_BAIL_GROUP,
    PDF_CADASTRE_GROUP,
)
