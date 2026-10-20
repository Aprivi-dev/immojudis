"""Nature du prix publié comme « prix de départ » d'une annonce de notaires : mise à prix ou première offre possible.

Une vente notariale interactive (VNI) ne publie pas de mise à prix : « première offre possible » (``premierPrix``,
``premiereOffrePossible``, à défaut ``prixMin``) est le plus bas montant qu'on peut proposer, pas un prix fixé par la
procédure. Le collecteur range pourtant ce montant dans ``starting_price_eur`` (même ordre de repli) : sans autre
indication, il s'affiche comme une mise à prix. ``starting_price_nature`` le dit :

* ``mise_a_prix`` : ``miseAPrix`` (fiche détaillée) ;
* ``displayed_price`` : ``prixAffiche`` (liste), dont la nature n'est pas précisée par la source ;
* ``first_offer_possible`` : première offre possible (ou prix minimum), à ne pas présenter comme une mise à prix.

Côté interface (non modifiée ici) : où la fiche et les listes écrivent « Mise à prix », lire
``raw_payload.starting_price_nature`` et écrire « Première offre possible » quand il vaut ``first_offer_possible``
(aussi dans le PDF, l'e-mail d'alerte et les rapports) ; le champ ``starting_price_eur`` reste le même montant.
"""

from __future__ import annotations

FIRST_OFFER_NATURE = "first_offer_possible"


def starting_price_nature(
    primary: object, first_offer: object, minimum: object = None, *, primary_nature: str = "mise_a_prix"
) -> dict[str, str]:
    """``{"starting_price_nature": …}`` ou ``{}`` : le prix annoncé l'emporte, sinon la première offre."""
    if primary not in (None, "", 0, "0"):
        return {"starting_price_nature": primary_nature}
    if any(value not in (None, "", 0, "0") for value in (first_offer, minimum)):
        return {"starting_price_nature": FIRST_OFFER_NATURE}
    return {}
