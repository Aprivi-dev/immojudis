"""Briques communes de lecture du professionnel de la vente (avocat poursuivant, cabinet, notaire).

Seul le professionnel est lu : jamais une partie saisie, un occupant ni un créancier particulier.
Le garde-fou contre une personne physique est :data:`PROFESSIONAL_PREFIX_RE` : un nom n'est retenu que
s'il commence par une marque de professionnel (Maître, SCP, SELARL, cabinet, étude…), jamais par
« Monsieur X ». Le filtre de données personnelles (:mod:`src.personal_data`) s'y ajoute en seconde
ligne : il ne réécrit un nom qu'après une formule (« demeurant », « née le », « locataire »…) ; il ne
reconnaît donc pas à lui seul un « Prénom NOM » isolé.

Les adresses masquées par Cloudflare (« [email protected] », ``data-cfemail``) ne sont ni décodées ni
reprises : seule une adresse publiée en clair est lue.
"""

from __future__ import annotations

import re
import unicodedata
from urllib.parse import unquote

from src.normalize import clean_text
from src.personal_data import redact_personal_text

_EMAIL_RE = re.compile(r"(?<![\w.+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}(?![\w-])")
_IMAGE_SUFFIXES = (".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp")
_RPVA_DOMAIN = "@avocat-conseil.fr"
_FAX_BEFORE_RE = re.compile(r"(?:\bfax|\bt[ée]l[ée]copie|\bt[ée]l[ée]c\.?)\s*(?:n[°ºo]\s*)?[:.]?\s*$", re.I)
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
    """Texte nettoyé, ou ``None`` si le filtre de données personnelles le réécrit.

    Ce n'est pas le garde-fou contre une personne physique : le filtre ne réécrit un nom qu'après une
    formule (« demeurant », « née le »…). Le vrai garde-fou est :data:`PROFESSIONAL_PREFIX_RE`, que
    l'appelant applique au nom (Petites Affiches : ``_lawyer_name``).
    """
    text = clean_text(value)
    if not text or redact_personal_text(text) != text:
        return None
    return text


def clear_email(value: object | None) -> str | None:
    """Première adresse publiée en clair ; une adresse masquée (« [email protected] ») n'en est pas une.

    Les adresses RPVA (``@avocat-conseil.fr``) sont écartées : ce canal est réservé à la procédure.
    """
    for match in _EMAIL_RE.finditer(str(value or "")):
        address = match.group(0).strip(".")
        if address.lower().endswith(_IMAGE_SUFFIXES) or address.lower().endswith(_RPVA_DOMAIN):
            continue
        return address
    return None


def mailto_address(href: object | None) -> str | None:
    """Adresse d'un lien ``mailto:`` : décodée (``%40``), sans ses paramètres (``?subject=…``)."""
    target = str(href or "").strip()
    if target[:7].lower() != "mailto:":
        return None
    return clear_email(unquote(target[7:]).split("?", 1)[0])


def french_phone(value: object | None) -> str | None:
    """Premier numéro français du texte, hors numéro de fax (« Fax : 01… », « Télécopie 01… »)."""
    text = str(value or "")
    for match in _PHONE_RE.finditer(text):
        if not _FAX_BEFORE_RE.search(text[max(0, match.start() - 20) : match.start()]):
            return clean_text(match.group(0))
    return None


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


def _surnames(value: object | None) -> set[str]:
    """Nom(s) de famille d'un libellé : les mots en capitales, à défaut le dernier mot distinctif."""
    text = str(value or "")
    caps = {
        word
        for token in re.findall(r"\b[A-ZÀ-ÖØ-Þ]{2,}(?:[-'’][A-ZÀ-ÖØ-Þ]{2,})*\b", text)
        for word in re.findall(r"[a-z]{3,}", fold(token))
    } - _GENERIC_WORDS
    if caps:
        return caps
    words = [word for word in re.findall(r"[a-z]{3,}", fold(text)) if word not in _GENERIC_WORDS]
    return set(words[-1:])


def same_professional(first: object | None, second: object | None) -> bool:
    """Deux libellés désignent-ils le même professionnel (même nom de famille ou de cabinet) ?

    Un prénom commun ne suffit pas (« Maître Pierre MARTIN » et « Maître Pierre LEROY » sont deux avocats).
    """
    return bool(_surnames(first) & _surnames(second))


# --- Phrase du professionnel -----------------------------------------------------------------------------
_SENTENCE_END_RE = re.compile(r"\.\s+(?=[A-ZÀ-ÖØ-Þ])")
_CONTACT_LABEL_RE = re.compile(r"(?:t[ée]l|t[ée]l[ée]phone|mail|e-?mail|courriel|fax|barreau)\b", re.I)
_ABBREVIATIONS = frozenset(
    "me m mme mmes mlle mm dr pr st ste cie av bd bp tel fax n no vve".split()
)


def professional_sentence(text: object | None) -> str:
    """Texte jusqu'à la fin de la phrase du professionnel (premier point suivi d'une espace et d'une majuscule).

    Ne coupent pas : une initiale (« Jean M. DUPONT »), une abréviation (« Me. », « M. », « Tél. »)
    et un point suivi d'une rubrique de coordonnées (« Barreau de Paris. Tél : 01… »).
    """
    value = str(text or "")
    for match in _SENTENCE_END_RE.finditer(value):
        previous = re.search(r"([A-Za-zÀ-ÿ]+)$", value[: match.start()])
        word = previous.group(1) if previous else ""
        if len(word) == 1 or fold(word) in _ABBREVIATIONS:
            continue
        if _CONTACT_LABEL_RE.match(value, match.end()):
            continue
        return value[: match.start() + 1]
    return value
