"""Canaux (téléphone, email) d'un contact écrit en texte libre, par exemple « 01 40 00 00 00 · cabinet@exemple.test »."""

from __future__ import annotations

import re

_EMAIL_MARK_RE = re.compile(r"@[A-Za-z0-9][^\s@]*")
_EMAIL_RE = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}")
_PHONE_RE = re.compile(r"(?<!\w)\+?\d[\d .()/-]{5,}\d(?!\w)")
_FAX_BEFORE_RE = re.compile(r"(?:\bfax|\bt[ée]l[ée]copie|\bt[ée]l[ée]c\.?)\s*(?:n[°ºo]\s*)?[:.]?\s*$", re.I)
_LABELLED_PHONE_RE = re.compile(
    r"\b(?:T[ée]l(?:[ée]phone)?\.?|Mobile|Portable|(?:Port|Mob)\.)\s*:?\s*(?P<phone>\+?\d[\d .()/-]{5,}\d)(?!\w)",
    re.I,
)


def contact_channels(text: str) -> dict[str, str]:
    """Canaux d'un contact scalaire déjà nettoyé.

    - téléphone et email ensemble (un site éventuel reste dans la colonne seule) : un canal chacun, de sorte
      que le téléphone ne disparaisse pas du canal ``phone`` et que l'email ne soit pas comparé à toute la chaîne ;
    - un seul canal reconnu : ``{canal: texte}`` (comportement historique, email avant téléphone) ;
    - aucun : ``{}``.
    """
    email = _EMAIL_RE.search(text)
    if email:
        rest = re.sub(r"https?://\S+", " ", text.replace(email.group(0), " "))
        # Un numéro précédé de « Tél », « Mobile », « Portable », « Port. » ou « Mob. » prime (le premier dans l'ordre
        # d'apparition ; un fax n'est pas libellé ainsi) : une adresse postale (« CS 60062 - 86002 Poitiers ») contient
        # des suites de chiffres qui ressemblent à un numéro.
        labelled = _LABELLED_PHONE_RE.search(rest)
        phone = labelled.group("phone") if labelled else None
        if phone is None:
            phone = next(
                (
                    found.group(0)
                    for found in _PHONE_RE.finditer(rest)
                    if not _FAX_BEFORE_RE.search(rest[max(0, found.start() - 20) : found.start()])
                ),
                None,
            )
        if phone:
            return {"phone": phone.strip(), "email": email.group(0)}
    if _EMAIL_MARK_RE.search(text):
        return {"email": text}
    return {"phone": text} if _PHONE_RE.search(text) else {}
