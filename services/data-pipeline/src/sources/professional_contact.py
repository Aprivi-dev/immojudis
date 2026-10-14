"""Briques communes de lecture du professionnel de la vente (avocat poursuivant, cabinet, notaire).

Seul le professionnel est lu : jamais une partie saisie, un occupant ni un créancier particulier.
Le filtre de données personnelles (:mod:`src.personal_data`) sert de garde-fou : une valeur que le
filtre réécrit nomme une personne physique et n'est pas conservée.

Les adresses masquées par Cloudflare (« [email protected] », ``data-cfemail``) ne sont ni décodées ni
reprises : seule une adresse publiée en clair est lue.
"""

from __future__ import annotations

import re
import unicodedata

from src.normalize import clean_text
from src.personal_data import redact_personal_text

_EMAIL_RE = re.compile(r"(?<![\w.+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}(?![\w-])")
_IMAGE_SUFFIXES = (".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp")
_PHONE_RE = re.compile(r"(?<![\d.])(?:\+33\s?(?:\(0\)\s?)?|0)[1-9](?:[\s.-]?\d{2}){4}(?!\d)")
_LABELLED_PHONE_RE = re.compile(r"\bT[ée]l(?:[ée]phone)?\.?\s*:?\s*(?P<phone>(?:\+33|0)[\s\d.()-]{8,17}\d)", re.I)
# Marque d'un professionnel de la vente en tête d'un nom : on n'en retient pas d'autre (« Monsieur X »).
PROFESSIONAL_PREFIX_RE = re.compile(
    r"^(?:ma[îi]tre|me|scp|selarl|selas|selurl|selafa|aarpi|a\.a\.r\.p\.i\.?|cabinet|[ée]tude|office|sas|sarl|eurl)\b",
    re.I,
)
_GENERIC_WORDS = frozenset(
    "maitre avocat avocats associes associe selarl scp selas selurl selafa aarpi cabinet etude office societe "
    "sas sarl eurl barreau".split()
)
_BAR_CONNECTORS = frozenset({"de", "du", "des", "la", "le", "les", "en", "sur", "sous", "l", "d"})
_BAR_STOP_WORDS = frozenset(
    "tel telephone mail email fax adresse cabinet maitre me avocat avocats rue avenue boulevard bd place chemin "
    "impasse allee quai route cours square residence immeuble batiment bat zone za zac bp vente".split()
)
_BAR_RE = re.compile(r"\bbarreau\s+(?:de\s+la\s+|de\s+l['’]\s*|d['’]\s*|des\s+|du\s+|de\s+)?(?P<tail>.*)", re.I | re.S)
_WORD_RE = re.compile(r"[A-Za-zÀ-ÖØ-öø-ÿ][A-Za-zÀ-ÖØ-öø-ÿ'’-]*")


def fold(value: object | None) -> str:
    text = unicodedata.normalize("NFKD", str(value or "")).encode("ascii", "ignore").decode("ascii")
    return re.sub(r"\s+", " ", text).strip().lower()


def keep_professional(value: object | None) -> str | None:
    """Texte nettoyé, ou ``None`` si le filtre de données personnelles y reconnaît une personne physique."""
    text = clean_text(value)
    if not text or redact_personal_text(text) != text:
        return None
    return text


def clear_email(value: object | None) -> str | None:
    """Première adresse publiée en clair ; une adresse masquée (« [email protected] ») n'en est pas une."""
    for match in _EMAIL_RE.finditer(str(value or "")):
        address = match.group(0).strip(".")
        if not address.lower().endswith(_IMAGE_SUFFIXES):
            return address
    return None


def french_phone(value: object | None) -> str | None:
    match = _PHONE_RE.search(str(value or ""))
    return clean_text(match.group(0)) if match else None


def labelled_phone(value: object | None) -> str | None:
    """Téléphone précédé de « Tél » (texte libre : on évite d'attraper un autre numéro)."""
    match = _LABELLED_PHONE_RE.search(str(value or ""))
    return french_phone(match.group("phone")) if match else None


def bar_name(value: object | None) -> str | None:
    """Barreau cité (« avocat au barreau de Paris », « Barreau du LOT 1 boulevard… » -> « LOT »)."""
    match = _BAR_RE.search(str(value or ""))
    if not match:
        return None
    words: list[str] = []
    pending: list[str] = []
    for token in re.split(r"\s+", match.group("tail").strip()):
        word = _WORD_RE.fullmatch(token.strip(".,;:()"))
        if word is None:
            break
        text = word.group(0)
        folded = fold(text)
        if folded in _BAR_STOP_WORDS:
            break
        if folded in _BAR_CONNECTORS and text[0].islower():
            pending.append(text)
            continue
        if not text[0].isupper():
            break
        words.extend([*pending, text])
        pending = []
        if len(words) >= 6 or token.endswith((".", ",", ";")):
            break
    return clean_text(" ".join(words)) or None


def same_professional(first: object | None, second: object | None) -> bool:
    """Deux libellés désignent-ils le même professionnel (un mot distinctif en commun) ?"""

    def words(value: object | None) -> set[str]:
        return {word for word in re.findall(r"[a-z]{3,}", fold(value)) if word not in _GENERIC_WORDS}

    return bool(words(first) & words(second))
