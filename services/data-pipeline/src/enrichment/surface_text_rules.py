"""Règles de lecture qui décident si une valeur en m² appartient bien au libellé qui la précède.

Audit du 03/11/2026 : des surfaces fausses étaient affichées parce qu'un libellé était rattaché à une
valeur qui ne le concernait pas :

* « une chambre, un bureau/chambre, présentant une superficie de 75,34 m² » lu comme une chambre de
  75,34 m², puis la même phrase, recopiée dans la description, le texte de la page et la description de
  la source, additionnée trois fois (226,02 m²) ;
* « Surface habitable Bureau n°1 ROC 13,450 m2 » (en-tête d'un tableau de pièces) lu comme la surface
  habitable du bien ;
* « surface habitable totale, 158,82 m² de surface au sol totale » : la surface au sol prise pour la
  surface habitable ;
* « 63,36 m² Loi Carrez (77,56 m² surface au sol) » : la surface au sol prise pour la Carrez.

Une valeur manquante est acceptable, une valeur fausse ne l'est pas : dans le doute, la valeur est écartée.
"""

from __future__ import annotations

import re
from decimal import Decimal

from src.text_folding import ascii_alnum_words, to_ascii

# Ce qui sépare une pièce de la valeur qui suit : fin de phrase, nouvel élément d'une énumération
# (« , un bureau », « , présentant »), ou un mot qui désigne le bien entier ou un autre local.
_MEASUREMENT_GAP_BREAK_RE = re.compile(
    r"[;!?]|\.(?=\s)"
    r"|,\s*(?:un|une|des|deux|trois|quatre|le|la|les|l['’]|et|pr[ée]sent\w*|d['’]une?|soit|pour|ainsi|outre)\b"
    r"|\b(?:biens?|tout|ensemble|lots?|logements?|appartements?|maisons?|villas?|local|locaux|entrep[ôo]ts?"
    r"|immeubles?|b[âa]timents?|propri[ée]t[ée]s?|pr[ée]sent\w*|totale?s?|superficies?\s+(?:de|d['’])"
    r"|surfaces?\s+(?:de|d['’])\s|pavillons?|studios?|habitation|unit[ée]s?)\b",
    re.I,
)
MAX_MEASUREMENT_GAP_CHARS = 60

# Après la valeur : une surface « au sol » (hauteur sous plafond < 1,80 m comprise) n'est ni une Carrez ni
# une surface habitable.
_GROUND_AREA_AFTER_RE = re.compile(
    r"^\s*(?:m\s*(?:2|²))?\s*(?:\)\s*)?(?:de\s+)?(?:la\s+)?(?:surface|superficie)?\s*(?:totale\s+)?au\s+sol\b",
    re.I,
)
# Entre un libellé (« surface habitable totale ») et sa valeur : pas de virgule (la valeur appartient alors à
# l'élément suivant de l'énumération) ni de nom de pièce (en-tête de tableau suivi d'une ligne de pièce).
_LABEL_GAP_ROOM_RE = re.compile(
    r"\b(?:bureaux?|chambres?|s[ée]jour|salon|cuisine|entr[ée]e|wc|w\.c|toilettes?|salle|d[ée]gagement|couloir"
    r"|palier|cellier|buanderie|dressing|garage|caves?|grenier|combles?|studio|v[ée]randa|loggia|balcon|terrasse"
    r"|pi[eè]ce|local|lot)\b",
    re.I,
)
_EXCLUDED_SPACE_RE = re.compile(
    r"\b(?:hors|sans|hormis|except[ée]e?s?|non\s+compris(?:e|es|s)?)\s+(?:(?:d[eu]s?|les?|la|l['’])\s*)?[\w-]+",
    re.I,
)


# Terrain ou annexe nommé entre le bien et sa valeur : « une maison … construite sur un terrain de forme
# rectangulaire de 207 m² », « une maison avec un jardin de 500 m² » (audit du 03/11/2026, e34acc33, db4a22d3).
_LAND_OBJECT_RE = re.compile(r"\b(?:terrains?|parcelles?|jardins?|contenance|cadastr\w*)\b", re.I)
# Une annexe ne reçoit la valeur que si elle est ajoutée au bien (« avec un garage de 25 m² ») : « une maison sur
# cave partielle de 152,64 m² » (89179e7a) mesure la maison.
_ANNEX_OBJECT_RE = re.compile(
    r"\b(?:avec|et|plus|outre|ainsi\s+que|dont)\s+(?:(?:un|une|le|la|les|l['’]|des|son|sa|ses|deux|trois)\s+)?"
    r"(?:garages?|caves?|parkings?|box|terrasses?|balcons?|piscines?|greniers?|combles?|d[ée]pendances?|annexes?"
    r"|granges?|remises?|hangars?|abris?|celliers?)\b",
    re.I,
)
_DWELLING_NOUN_RE = re.compile(
    r"\b(?:appartement|maison|villa|immeuble|b[âa]timent|local|logement|pavillon|studio|habitation)s?\b", re.I
)


def value_belongs_to_other_object(gap: str, value: Decimal | None = None) -> bool:
    """Vrai quand, entre le nom du bien et la valeur, un terrain ou une annexe reçoit cette valeur.

    Seul le dernier objet nommé compte, et seulement s'il n'est séparé de la valeur ni par une virgule ni par
    un nouveau nom de logement : « maison avec jardin, d'une surface de 90 m² » reste la surface de la maison.
    Une contenance est un nombre entier de m² : « … et terrain attenant d'une superficie de 202,96 m2 » (afc981e0,
    terrain de 37 a 92 ca) est une surface mesurée du bâti.
    """
    land_value = value is None or value == value.to_integral_value()
    others = [*(_LAND_OBJECT_RE.finditer(gap) if land_value else ()), *_ANNEX_OBJECT_RE.finditer(gap)]
    if not others:
        return False
    tail = gap[max(item.end() for item in others) :]
    return not ("," in tail or _DWELLING_NOUN_RE.search(tail))


def measurement_gap_is_broken(gap: str) -> bool:
    """Vrai quand le texte entre le nom d'une pièce et la valeur montre qu'elle ne mesure pas cette pièce."""
    if len(gap) > MAX_MEASUREMENT_GAP_CHARS:
        return True
    return bool(_MEASUREMENT_GAP_BREAK_RE.search(gap))


def value_is_ground_area(text_after_value: str) -> bool:
    """« 77,56 m² surface au sol », « 158,82 m² de surface au sol totale », « (146 m² au sol) »."""
    return bool(_GROUND_AREA_AFTER_RE.match(text_after_value[:40]))


def label_gap_is_broken(gap: str) -> bool:
    """Le libellé ne qualifie pas la valeur : « habitable totale, 158,82 » ou « habitable Bureau n°1 13,45 »."""
    # « habitable totale (Loi Carrez hors garage) : 98,06 m² » : une pièce exclue ne remplace pas le libellé.
    gap = _EXCLUDED_SPACE_RE.sub(" ", gap)
    return "," in gap or bool(_LABEL_GAP_ROOM_RE.search(gap))


_ROOM_NAME_RE = re.compile(
    r"\b(?:bureaux?|chambres?|s[ée]jour|salon|cuisine|entr[ée]e|wc|w\.c|toilettes?|salle\s+(?:d['’]eau|de\s+bains?|[àa]\s+manger)"
    r"|d[ée]gagement|couloir|palier|cellier|buanderie|dressing|garage|caves?|grenier|v[ée]randa|loggia|balcon"
    r"|terrasse|pi[eè]ce)\b",
    re.I,
)
_STRONG_SURFACE_LABEL_RE = re.compile(
    r"habitable|carrez|privative|totale?\b|r[ée]f[ée]rence|appartement|maison|villa|logement|immeuble", re.I
)


def room_measurement_before(text: str, label_start: int, matched: str) -> bool:
    """« PREMIERE CHAMBRE ANGLE NORD-EST Surface: 10,5m2 » : surface d'une pièce, pas du bien.

    Seul un libellé générique (« Surface : ») est concerné ; « surface habitable », « Carrez », « totale »
    qualifient le bien.
    """
    if _STRONG_SURFACE_LABEL_RE.search(matched):
        return False
    prefix = text[max(0, label_start - MAX_MEASUREMENT_GAP_CHARS) : label_start]
    rooms = list(_ROOM_NAME_RE.finditer(prefix))
    if not rooms:
        return False
    return not measurement_gap_is_broken(prefix[rooms[-1].end() :])


def passage_key(text: str, value_start: int, value: object) -> str:
    """Clé d'un passage répété : la valeur et les 40 caractères qui la précèdent, normalisés.

    La même phrase recopiée dans la description, le texte de la page et la description de la source
    donne la même clé ; deux pièces différentes de même surface n'ont pas le même libellé juste avant.
    """
    lead = text[max(0, value_start - 40) : value_start]
    lead = ascii_alnum_words(to_ascii(lead).lower())
    return f"{value}|{lead}"


def base_space_label(label: str) -> str:
    """« chambre 3 » -> « chambre » (le numéro d'occurrence ajouté par l'extracteur)."""
    return re.sub(r"\s+\d+$", "", label.strip().lower())
