"""Canaux (téléphone, email) d'un contact écrit en texte libre, par exemple « 01 40 00 00 00 · cabinet@exemple.test »."""

from __future__ import annotations

import re

_EMAIL_MARK_RE = re.compile(r"@[A-Za-z0-9][^\s@]*")
_EMAIL_RE = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}")
_PHONE_RE = re.compile(r"(?<!\w)\+?\d[\d .()/-]{5,}\d(?!\w)")


def contact_channels(text: str) -> dict[str, str]:
    """Canaux d'un contact scalaire déjà nettoyé.

    - téléphone et email ensemble (un site éventuel reste dans la colonne seule) : un canal chacun, de sorte
      que le téléphone ne disparaisse pas du canal ``phone`` et que l'email ne soit pas comparé à toute la chaîne ;
    - un seul canal reconnu : ``{canal: texte}`` (comportement historique, email avant téléphone) ;
    - aucun : ``{}``.
    """
    email = _EMAIL_RE.search(text)
    if email:
        phone = _PHONE_RE.search(re.sub(r"https?://\S+", " ", text.replace(email.group(0), " ")))
        if phone:
            return {"phone": phone.group(0).strip(), "email": email.group(0)}
    if _EMAIL_MARK_RE.search(text):
        return {"email": text}
    return {"phone": text} if _PHONE_RE.search(text) else {}
