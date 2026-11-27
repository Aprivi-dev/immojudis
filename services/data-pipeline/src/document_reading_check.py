"""« Check » d'un point de la lecture des pièces : ce qu'il reste à vérifier (versions qui le lisent, v5).

Le texte est écrit par le modèle. Il ne s'affiche que s'il passe :func:`checked_check`, branché sur un profil de
lecture par ``ReadingProfile.check_rule`` ; les règles sur les coordonnées, les chiffres et le vocabulaire sont
celles du titre et de l'explication d'un point (``document_reading``).
"""

from __future__ import annotations

import re

from src import document_reading as reading

# What a « check » never says: whether to buy or bid, and anything that reads as advice on the decision.
_CHECK_ADVICE = re.compile(
    r"\b(?:(?:sur)?ench[ée]rir|acheter|acqu[ée]rir|renoncer|[ée]viter|n[ée]gocier|"
    r"d[ée]conseill\w*|conseill\w*|recommand\w*)\b",
    re.I,
)


# A « check » starts with a verb in the infinitive (« Regarder », « Lire », « Faire préciser ») and says what to
# look at: « Vérifier ce point » fits every dossier and says nothing.
_CHECK_INFINITIVE = re.compile(r"^[^\W\d_]+(?:er|ir|re)\b", re.I)
_CHECK_GENERIC = re.compile(
    r"^(?:v[ée]rifier|contr[ôo]ler|confirmer|faire\s+(?:v[ée]rifier|confirmer))\s+"
    r"(?:ce|cet|cette|ces|le|la|les)\s+(?:points?|[ée]l[ée]ments?|informations?|sujets?)\W*$",
    re.I,
)
MIN_CHECK_WORDS = 4


def checked_check(check: str | None, page_text: str, quote: str) -> str | None:
    """What remains to check for a point, as the model wrote it, or None when it cannot be shown.

    One short sentence about what the document leaves open (« Regarder le plafond de la cuisine lors de la
    visite »). It is dropped whole, and the point stays, when it carries a contact, a figure the page does not
    write, a promotional word, a sentence addressed to the reader (imperative, « veuillez »), an instruction
    addressed to a model, or a word about buying or bidding: the reading states what to verify, never what to
    decide. A sentence that does not start with an infinitive, or that fits any dossier (« Vérifier ce point »),
    is dropped too.
    """
    if not check:
        return None
    if len(check.split()) < MIN_CHECK_WORDS or not _CHECK_INFINITIVE.match(check) or _CHECK_GENERIC.match(check):
        return None
    if reading._has_contact(check) or not reading._figures_proven(check, page_text, reading.page_figures(page_text)):
        return None
    if reading._promotes(check, quote) or _CHECK_ADVICE.search(check):
        return None
    if any(pattern.search(check) for _, pattern in reading._TITLE_FORBIDDEN):
        return None
    return check
