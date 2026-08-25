from __future__ import annotations

import re
import unicodedata

from src.court_competence import resolve_competent_court, verified_sale_insee_code
from src.models import AuctionSale
from src.normalize import clean_text

CITY_TO_TRIBUNAL = {
    "bordeaux": "TJ Bordeaux",
    "floirac": "TJ Bordeaux",
    "biganos": "TJ Bordeaux",
    "la brede": "TJ Bordeaux",
    "cenon": "TJ Bordeaux",
    "carbon blanc": "TJ Bordeaux",
    "saint jean d illac": "TJ Bordeaux",
    "saint yzan de soudiac": "TJ Bordeaux",
    "merignac": "TJ Bordeaux",
    "sadirac": "TJ Bordeaux",
    "perigueux": "TJ Périgueux",
    "mensignac": "TJ Périgueux",
    "riberac": "TJ Périgueux",
    "losse": "TJ Mont-de-Marsan",
    "aire sur l adour": "TJ Mont-de-Marsan",
    "ondres": "TJ Dax",
    "dax": "TJ Dax",
    "mont de marsan": "TJ Mont-de-Marsan",
    "bayonne": "TJ Bayonne",
    "pau": "TJ Pau",
    "montardon": "TJ Pau",
    "urrugne": "TJ Bayonne",
    "agen": "TJ Agen",
    "marmande": "TJ Marmande",
    "bergerac": "TJ Bergerac",
    "libourne": "TJ Libourne",
}

TRIBUNAL_CODES = {
    "TJ Bordeaux": "bordeaux",
    "TJ Libourne": "libourne",
    "TJ Bayonne": "bayonne",
    "TJ Pau": "pau",
    "TJ Dax": "dax",
    "TJ Mont-de-Marsan": "mont_de_marsan",
    "TJ Périgueux": "perigueux",
    "TJ Bergerac": "bergerac",
    "TJ Agen": "agen",
    "TJ Marmande": "marmande",
}

FINGERPRINT_TO_TRIBUNAL = {
    _key: tribunal
    for tribunal, keys in {
        "TJ Bordeaux": ("tj bordeaux", "tribunal judiciaire de bordeaux", "bordeaux"),
        "TJ Libourne": ("tj libourne", "tribunal judiciaire de libourne", "libourne"),
        "TJ Bayonne": ("tj bayonne", "tribunal judiciaire de bayonne", "bayonne"),
        "TJ Pau": ("tj pau", "tribunal judiciaire de pau", "pau"),
        "TJ Dax": ("tj dax", "tribunal judiciaire de dax", "dax"),
        "TJ Mont-de-Marsan": ("tj mont de marsan", "tribunal judiciaire de mont de marsan", "mont de marsan"),
        "TJ Périgueux": ("tj perigueux", "tribunal judiciaire de perigueux", "perigueux"),
        "TJ Bergerac": ("tj bergerac", "tribunal judiciaire de bergerac", "bergerac"),
        "TJ Agen": ("tj agen", "tribunal judiciaire de agen", "agen"),
        "TJ Marmande": ("tj marmande", "tribunal judiciaire de marmande", "marmande"),
    }.items()
    for _key in keys
}

AQUITAINE_TRIBUNALS = {
    "TJ Bordeaux",
    "TJ Libourne",
    "TJ Bayonne",
    "TJ Pau",
    "TJ Dax",
    "TJ Mont-de-Marsan",
    "TJ Périgueux",
    "TJ Bergerac",
    "TJ Agen",
    "TJ Marmande",
}

DEPARTMENT_TRIBUNALS = {
    "33": {"TJ Bordeaux", "TJ Libourne"},
    "24": {"TJ Périgueux", "TJ Bergerac"},
    "40": {"TJ Dax", "TJ Mont-de-Marsan"},
    "47": {"TJ Agen", "TJ Marmande"},
    "64": {"TJ Bayonne", "TJ Pau"},
}


def infer_tribunal(sale: AuctionSale) -> str | None:
    explicit = _extract_explicit_tribunal(sale.raw_text)
    if explicit:
        return explicit
    if _is_non_judicial_sale_context(sale):
        return None

    raw_text = _fingerprint(sale.raw_text)
    if _fingerprint(sale.city) == "ondres":
        if "bayonne" in raw_text:
            return "TJ Bayonne"
        if "dax" in raw_text:
            return "TJ Dax"

    city_key = _fingerprint(sale.city)
    if city_key in CITY_TO_TRIBUNAL:
        return CITY_TO_TRIBUNAL[city_key]

    return None


def fill_tribunal(sale: AuctionSale) -> AuctionSale:
    if _is_non_judicial_sale_context(sale) and not _extract_explicit_tribunal(sale.raw_text):
        sale.tribunal = None
        sale.tribunal_code = None
        _add_quality_flag(sale, "non_judicial_sale_context")
        return sale

    verified_insee_code = verified_sale_insee_code(sale)
    competent_court = resolve_competent_court(sale)
    if competent_court is not None:
        sale.tribunal = competent_court.court_name
        sale.tribunal_code = competent_court.court_code
        sale.raw_payload["tribunal_assignment"] = competent_court.evidence()
        _remove_quality_flag(sale, "tribunal_inconsistent")
        _remove_quality_flag(sale, "tribunal_competence_unresolved")
        _remove_quality_flag(sale, "tribunal_competence_unverified")
        return sale
    if verified_insee_code is not None:
        # A verified commune without a valid Ministry reference must never
        # fall through to a city list or a department-wide default.
        sale.tribunal = None
        sale.tribunal_code = None
        sale.raw_payload.pop("tribunal_assignment", None)
        _add_quality_flag(sale, "tribunal_competence_unresolved")
        return sale

    canonical = canonicalize_tribunal(sale.tribunal)
    if canonical:
        sale.tribunal = canonical
        sale.tribunal_code = TRIBUNAL_CODES.get(canonical)
        validate_tribunal(sale)
        _add_quality_flag(sale, "tribunal_competence_unverified")
        return sale
    if clean_text(sale.tribunal):
        _add_quality_flag(sale, "tribunal_inconsistent")
        had_invalid_source_tribunal = True
    else:
        had_invalid_source_tribunal = False
    sale.tribunal = infer_tribunal(sale)
    sale.tribunal_code = TRIBUNAL_CODES.get(sale.tribunal or "")
    validate_tribunal(sale)
    if sale.tribunal:
        _add_quality_flag(sale, "tribunal_competence_unverified")
    if had_invalid_source_tribunal:
        _add_quality_flag(sale, "tribunal_inconsistent")
    return sale


def validate_tribunal(sale: AuctionSale) -> AuctionSale:
    if _is_non_judicial_sale_context(sale) and not _extract_explicit_tribunal(sale.raw_text):
        sale.tribunal = None
        sale.tribunal_code = None
        _add_quality_flag(sale, "non_judicial_sale_context")
        return sale
    if sale.department not in DEPARTMENT_TRIBUNALS or not sale.tribunal:
        return sale
    sale.tribunal = canonicalize_tribunal(sale.tribunal) or sale.tribunal
    sale.tribunal_code = TRIBUNAL_CODES.get(sale.tribunal or "")
    if sale.tribunal not in AQUITAINE_TRIBUNALS:
        _add_quality_flag(sale, "tribunal_inconsistent")
        return sale
    if sale.tribunal not in DEPARTMENT_TRIBUNALS[sale.department]:
        _add_quality_flag(sale, "tribunal_inconsistent")
    else:
        _remove_quality_flag(sale, "tribunal_inconsistent")
    return sale


def _extract_explicit_tribunal(raw_text: str | None) -> str | None:
    text = clean_text(raw_text)
    if not text:
        return None
    match = re.search(r"\bTribunal\s+Judiciaire\s+de\s+([A-Za-zÀ-ÿ' -]+)", text, re.I)
    if match:
        city = clean_text(match.group(1).split("(")[0])
        return f"TJ {city}" if city else None
    match = re.search(r"\bTJ\s+([A-Za-zÀ-ÿ' -]+)", text, re.I)
    if match:
        city = clean_text(match.group(1).split("(")[0])
        return f"TJ {city}" if city else None
    return None


def _is_non_judicial_sale_context(sale: AuctionSale) -> bool:
    text = clean_text(
        " ".join(
            filter(
                None,
                [
                    sale.title,
                    sale.description,
                    sale.raw_text,
                    sale.lawyer_name,
                    sale.source_name,
                ],
            )
        )
    )
    if not text:
        return False
    if re.search(r"\btribunal\s+judiciaire\b|\bsaisie\s+immobili[èe]re\b|\bcahier\s+des\s+conditions\s+de\s+vente\b", text, re.I):
        return False
    return bool(
        re.search(
            r"\bvente\s+volontaire\b|\bvente\s+notariale\b|\bvente\s+notariale\s+interactive\b|"
            r"\bimmo[-\s]?interactif\b|\boffice\s+notarial\b|\bnotaire\b",
            text,
            re.I,
        )
    )


def canonicalize_tribunal(value: object | None) -> str | None:
    text = clean_text(value)
    if not text:
        return None
    fp = _fingerprint(text)
    if fp in FINGERPRINT_TO_TRIBUNAL:
        return FINGERPRINT_TO_TRIBUNAL[fp]
    for key, tribunal in FINGERPRINT_TO_TRIBUNAL.items():
        if key and key in fp:
            return tribunal
    generic = _generic_tribunal_name(text)
    if generic:
        return generic
    return None


def _generic_tribunal_name(text: str) -> str | None:
    match = re.search(r"\bTribunal\s+Judiciaire\s+de\s+([A-Za-zÀ-ÿ' -]{2,60})\b", text, re.I)
    if not match:
        match = re.search(r"\bTJ\s+([A-Za-zÀ-ÿ' -]{2,60})\b", text, re.I)
    if not match:
        return None
    city = clean_text(re.split(r"[,.;:\n(]", match.group(1), maxsplit=1)[0])
    city = clean_text(re.sub(r"^(?:de|d')\s+", "", city or "", flags=re.I))
    return f"TJ {city.title()}" if city else None


def _fingerprint(value: object | None) -> str:
    text = clean_text(value) or ""
    text = "".join(
        char for char in unicodedata.normalize("NFKD", text) if not unicodedata.combining(char)
    )
    return re.sub(r"[^a-z0-9]+", " ", text.lower()).strip()


def _add_quality_flag(sale: AuctionSale, flag: str) -> None:
    if flag not in sale.quality_flags:
        sale.quality_flags.append(flag)


def _remove_quality_flag(sale: AuctionSale, flag: str) -> None:
    sale.quality_flags = [item for item in sale.quality_flags if item != flag]
