"""Noms de départements français et lecture sûre d'un département dans un libellé.

Un nom de département n'est jamais cherché comme simple sous-chaîne : « Orglandes » contient
« landes » et « Tribunal de Vienne (Isère) » contient « vienne ». Les fonctions de ce module
comparent des noms entiers (``slug``) ou cherchent un mot entier, et renoncent quand la lecture
est ambiguë.
"""

from __future__ import annotations

import re
import unicodedata
from urllib.parse import urlparse

DEPARTMENT_NAMES: dict[str, str] = {
    "01": "Ain",
    "02": "Aisne",
    "03": "Allier",
    "04": "Alpes-de-Haute-Provence",
    "05": "Hautes-Alpes",
    "06": "Alpes-Maritimes",
    "07": "Ardèche",
    "08": "Ardennes",
    "09": "Ariège",
    "10": "Aube",
    "11": "Aude",
    "12": "Aveyron",
    "13": "Bouches-du-Rhône",
    "14": "Calvados",
    "15": "Cantal",
    "16": "Charente",
    "17": "Charente-Maritime",
    "18": "Cher",
    "19": "Corrèze",
    "2A": "Corse-du-Sud",
    "2B": "Haute-Corse",
    "21": "Côte-d'Or",
    "22": "Côtes-d'Armor",
    "23": "Creuse",
    "24": "Dordogne",
    "25": "Doubs",
    "26": "Drôme",
    "27": "Eure",
    "28": "Eure-et-Loir",
    "29": "Finistère",
    "30": "Gard",
    "31": "Haute-Garonne",
    "32": "Gers",
    "33": "Gironde",
    "34": "Hérault",
    "35": "Ille-et-Vilaine",
    "36": "Indre",
    "37": "Indre-et-Loire",
    "38": "Isère",
    "39": "Jura",
    "40": "Landes",
    "41": "Loir-et-Cher",
    "42": "Loire",
    "43": "Haute-Loire",
    "44": "Loire-Atlantique",
    "45": "Loiret",
    "46": "Lot",
    "47": "Lot-et-Garonne",
    "48": "Lozère",
    "49": "Maine-et-Loire",
    "50": "Manche",
    "51": "Marne",
    "52": "Haute-Marne",
    "53": "Mayenne",
    "54": "Meurthe-et-Moselle",
    "55": "Meuse",
    "56": "Morbihan",
    "57": "Moselle",
    "58": "Nièvre",
    "59": "Nord",
    "60": "Oise",
    "61": "Orne",
    "62": "Pas-de-Calais",
    "63": "Puy-de-Dôme",
    "64": "Pyrénées-Atlantiques",
    "65": "Hautes-Pyrénées",
    "66": "Pyrénées-Orientales",
    "67": "Bas-Rhin",
    "68": "Haut-Rhin",
    "69": "Rhône",
    "70": "Haute-Saône",
    "71": "Saône-et-Loire",
    "72": "Sarthe",
    "73": "Savoie",
    "74": "Haute-Savoie",
    "75": "Paris",
    "76": "Seine-Maritime",
    "77": "Seine-et-Marne",
    "78": "Yvelines",
    "79": "Deux-Sèvres",
    "80": "Somme",
    "81": "Tarn",
    "82": "Tarn-et-Garonne",
    "83": "Var",
    "84": "Vaucluse",
    "85": "Vendée",
    "86": "Vienne",
    "87": "Haute-Vienne",
    "88": "Vosges",
    "89": "Yonne",
    "90": "Territoire de Belfort",
    "91": "Essonne",
    "92": "Hauts-de-Seine",
    "93": "Seine-Saint-Denis",
    "94": "Val-de-Marne",
    "95": "Val-d'Oise",
    "971": "Guadeloupe",
    "972": "Martinique",
    "973": "Guyane",
    "974": "La Réunion",
    "976": "Mayotte",
}


def department_slug(value: object | None) -> str:
    """``"Val-d'Oise"`` et ``"val-d-oise"`` donnent ``"val-d-oise"``."""
    text = unicodedata.normalize("NFKD", str(value or ""))
    text = "".join(char for char in text if not unicodedata.combining(char))
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")


_CODE_BY_SLUG: dict[str, str] = {department_slug(name): code for code, name in DEPARTMENT_NAMES.items()}
# Variantes de graphie rencontrées dans les URL et les en-têtes.
_CODE_BY_SLUG.update(
    {
        "cote-d-or": "21",
        "corse": "2A",
        "reunion": "974",
        "territoire-de-belfort": "90",
    }
)


def department_from_name(value: object | None) -> str | None:
    """Code du département dont ``value`` est exactement le nom (accents, tirets et casse ignorés)."""
    return _CODE_BY_SLUG.get(department_slug(value))


def department_from_licitor_url(source_url: object | None) -> str | None:
    """Département écrit dans l'URL d'une annonce Licitor.

    ``/annonce/10/86/25/vente-aux-encheres/une-maison/merignac/gironde/108625.html`` : le
    dernier segment avant l'identifiant est le département, à condition que l'URL contienne bien
    le type du bien, la commune puis le département. Avec deux segments seulement, le dernier est
    une commune (``vienne``) et ne dit rien du département.
    """
    if not source_url:
        return None
    segments = [segment for segment in urlparse(str(source_url)).path.split("/") if segment]
    if "vente-aux-encheres" not in segments:
        return None
    tail = segments[segments.index("vente-aux-encheres") + 1 :]
    if len(tail) != 4 or not re.fullmatch(r"\d+\.html", tail[3]):
        return None
    return department_from_name(tail[2])


# Mots qui, collés à un nom de département, désignent autre chose : « Haute-Vienne », « Vienne »
# dans « Tribunal de Vienne » (c'est ce dernier cas que le contrôle d'ambiguïté écarte).
_WORD_BOUNDARY_BEFORE = r"(?<![\w'’-])"
_WORD_BOUNDARY_AFTER = r"(?![\w-])"


_FOLLOWING_PARENTHESIS = re.compile(r"\s*\(\s*([^()]{2,40}?)\s*\)")


def departments_named_in_text(text: object | None, codes: tuple[str, ...]) -> list[str]:
    """Codes parmi ``codes`` dont le nom apparaît comme mot entier dans ``text``.

    ``Orglandes`` ne nomme pas les Landes ; ``Haute-Vienne`` ne nomme pas la Vienne ;
    ``Vienne (Isère)`` est une commune de l'Isère, pas le département de la Vienne : un nom
    suivi d'une parenthèse qui nomme un autre département est ignoré.
    """
    lowered = str(text or "").lower()
    found: list[str] = []
    for code in codes:
        name = DEPARTMENT_NAMES[code].lower()
        pattern = _WORD_BOUNDARY_BEFORE + re.escape(name).replace(r"\-", "[- ]") + _WORD_BOUNDARY_AFTER
        for match in re.finditer(pattern, lowered):
            following = _FOLLOWING_PARENTHESIS.match(lowered, match.end())
            other = department_from_name(following.group(1)) if following else None
            if other is not None and other != code:
                continue
            found.append(code)
            break
    return found
