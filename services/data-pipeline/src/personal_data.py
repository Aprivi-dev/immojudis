"""Filtre déterministe des noms de personnes physiques dans les textes d'annonces.

Les annonces judiciaires nomment parfois un occupant, un locataire, un propriétaire ou un
créancier particulier (« occupés par Monsieur X suivant bail », « À la requête de Madame Y, née le
… à …, demeurant … »). Ces données n'ont rien à faire dans un texte affiché : ce module remplace le
nom, la date et le lieu de naissance et l'adresse personnelle par un rôle générique.

Les règles sont décrites par les cas de `tests/fixtures/personal_data_filter_cases.json`, partagés
avec le miroir TypeScript `src/lib/personal-data-filter.ts`. Toute évolution se fait des deux côtés,
avec les mêmes cas.

- Le filtre ne se déclenche qu'après une formule : « occupé(e)(s) par », « locataire », « bail
  consenti à », « loué à », « à la requête de », « appartenant à », « propriété de », « né(e) le … »,
  « demeurant / domicilié / résidant », « époux / épouse », « divorcé(e) », « veuf / veuve »,
  « née », « consorts », « héritiers de », « succession de ».
- Il ne retire jamais une commune, une rue, un tribunal, une étude notariale ni une société (SCI,
  SARL…) : un nom n'est reconnu qu'après une civilité (Monsieur, Mme, M.…) ou sous la forme
  « Prénom NOM » ou « NOM Prénom » (« DUPONT Pierre » : le prénom doit figurer dans la liste
  `_FIRST_NAMES`, sans quoi « EDF Collectivités » ou « BNP Paribas » seraient pris pour des noms).
- Après un rôle (« le débiteur », « propriétaire », « vendeur »… suivi de `:`, d'une virgule ou
  d'un espace), le nom est retiré avec ou sans civilité (« Le saisi, Paul ROY, occupe… »), sauf si
  le mot qui suit est « Me », « Maître » ou un nom de bien (« propriétaire Local COMMERCIAL »).
- « À la requête de : Madame X » (deux-points) et « À la requête de la Mme X » sont reconnus.
- Le statut n'est jamais déduit : « occupé(e)(s) par <nom> » devient toujours « un occupant ». « Un
  locataire » n'apparaît que si la formule source le dit (« loué à <nom> », « bail consenti à <nom> »,
  « locataire <nom> » : on remplace le nom, pas le rôle).
- Après « loué à » et « bail consenti à » seulement, un « Prénom Nom » en casse mixte est reconnu.
- Les contacts professionnels (« Me X, avocat, demeurant … ») ne sont pas touchés ; ils restent
  régis par les règles existantes (`scrub_public_text`).
- Idempotent : filtrer un texte déjà filtré ne le change pas.
"""

from __future__ import annotations

import re
import unicodedata
from collections.abc import Callable
from typing import Any

# --- Briques de motifs (identiques dans le miroir TypeScript) -------------------------------------
_UP = "A-ZÀ-ÖØ-ÞŒ"
_LOW = "a-zß-öø-ÿœ"
_L = "A-Za-zÀ-ÖØ-öø-ÿŒœ"
_SP = r"[^\S\r\n]"  # espace sans retour à la ligne
_APOS = "['’]"
# Mots en capitales qui terminent un nom écrit tout en capitales (« DUPONT PIERRE SUIVANT BAIL »).
_STOP_UP = (
    "SUIVANT|SELON|EN|AUX|AU|ET|OU|QUI|DONT|POUR|PAR|SUR|DANS|AVEC|SANS|BAIL|LOCATAIRE|LOCATAIRES"
    "|PROPRIETAIRE|PROPRIÉTAIRE|DEMEURANT|NE|NÉ|NEE|NÉE|DIVORCE|DIVORCÉ|DIVORCEE|DIVORCÉE|EPOUSE|ÉPOUSE"
    "|EPOUX|ÉPOUX|VEUF|VEUVE|OCCUPE|OCCUPÉ|OCCUPES|OCCUPÉS|DEPUIS|ACTUELLEMENT|DOMICILIE|DOMICILIÉ"
)
_NOT_STOP = rf"(?!(?:{_STOP_UP})(?![{_L}]))"
_CAPW = rf"(?:[dDlLO]{_APOS})?[{_UP}][{_LOW}]+(?:[-'’][{_UP}]?[{_LOW}]+)*(?![{_L}])"
_UPW = rf"(?:[dDlLO]{_APOS})?[{_UP}]{{2,}}(?:[-'’][{_UP}]{{2,}})*(?![{_L}])"
_TOKEN = rf"(?:{_UPW}|{_CAPW})"
_NOT_SENTENCE_START = rf"(?!(?:Le|La|Les|Un|Une|Il|Elle|Dans|Pour|Sur|Et|Ce|Cette)(?![{_L}]))"
# Mot suivant d'un nom : « Le Gall » est un nom, « Le bien est » commence une phrase.
_NEXT = rf"(?:(?:Le|La|Les){_SP}+{_NOT_STOP}{_TOKEN}|{_NOT_SENTENCE_START}{_NOT_STOP}{_TOKEN})"
_PARTICLE = rf"(?:de{_SP}+la|de|du|des|d{_APOS}|van|von|der|den|ben|el|al|di|da|dos|del|della)"
_INITIAL = rf"[{_UP}]\.{_SP}*"
# Prénoms usuels (liste partagée mot pour mot avec `FIRST_NAMES` du miroir TypeScript ; un test compare
# les deux). Sert uniquement à reconnaître « NOM Prénom » (« DUPONT Pierre ») sans civilité : sans
# liste, tout « SIGLE Mot » (« EDF Collectivités », « BNP Paribas ») serait pris pour une personne.
# Un prénom absent de la liste n'est pas reconnu sans civilité ; il l'est après « Monsieur », « Mme »…
_FIRST_NAMES = (
    "Marie Nathalie Isabelle Sylvie Catherine Françoise Martine Christine Monique Valérie "
    "Sandrine Patricia Brigitte Nicole Véronique Annie Jacqueline Stéphanie Céline Chantal "
    "Julie Sophie Anne Laurence Corinne Michèle Dominique Claire Florence Marguerite Danielle "
    "Hélène Pascale Karine Béatrice Christiane Thérèse Odile Fabienne Sabrina Virginie "
    "Aurélie Émilie Laetitia Nadia Samira Fatima Léa Camille Chloé Manon Emma Inès Sarah "
    "Laura Lucie Marine Pauline Mélanie Delphine Agnès Colette Josette Paulette Yvette "
    "Ginette Odette Simone Suzanne Denise Geneviève Évelyne Josiane Régine Maryse Muriel "
    "Cécile Élodie Charlotte Audrey Alice Eva Lina Anaïs Juliette Mathilde Louise Jeanne "
    "Madeleine Yvonne Raymonde Andrée Arlette Bernadette Liliane Gisèle Huguette Nadine Sonia "
    "Amandine Magali Ghislaine Roselyne Rose Maud Élisabeth Lydie Carole Cathy Jessica Élise "
    "Aline Alexandra Angélique Adeline Estelle Gaëlle Armelle Solange Mireille Marlène Noémie "
    "Margaux Clémence Océane Morgane Lisa Anna Clara Zoé Jade Mona Leïla Yasmine Khadija "
    "Aïcha Malika Naima Latifa Samia Houria Karima Rachida Ana Maria Carmen Rosa Isabel "
    "Marion Roxane Justine Johanna Séverine Stella Vanessa Wendy Tiphaine Sylviane Reine Jean "
    "Pierre Michel André Philippe René Louis Alain Jacques Bernard Marcel Daniel Roger Robert "
    "Paul Claude Christian Henri Georges Nicolas François Patrick Gérard Christophe Joseph "
    "Yves Éric Frédéric Laurent Stéphane David Pascal Olivier Thierry Sébastien Julien "
    "Alexandre Maxime Thomas Antoine Mathieu Guillaume Romain Kevin Jérôme Franck Didier "
    "Denis Gilles Serge Bruno Marc Luc Hervé Raymond Lucien Maurice Albert Fernand Gaston "
    "Émile Roland Rémy Rémi Vincent Anthony Benoît Cédric Damien Fabrice Fabien Gaël Grégory "
    "Jonathan Lionel Ludovic Mickaël Nathan Hugo Lucas Théo Enzo Ahmed Mohamed Mohammed Karim "
    "Youssef Rachid Abdel Samir Hassan Omar Ali Mehdi Nabil Saïd Farid Manuel José Antonio "
    "Carlos Miguel João Jorge Luis Paulo Giuseppe Mario Marco Stefano Gabriel Adrien Arnaud "
    "Baptiste Bastien Clément Corentin Dylan Étienne Florian Jordan Léo Loïc Mathis Nolan "
    "Quentin Raphaël Sylvain Tristan Valentin Victor Xavier Yann Yannick Régis Rodolphe "
    "Gilbert Gérald Jocelyn Aimé Auguste Édouard Eugène Félix Léon Armand Alfred Noël Max Sam "
    "Tom Jules Hubert Guy Francis Joël Jacky Jackie Thibault Thibaut Cyril Cyrille Dimitri "
    "Mathias Matthieu Ibrahim Moussa Mamadou Abdelkader Mustapha Brahim Idriss Anis Amine "
    "Bilal Yanis Bertrand Gaétan Géraud Josselin Maël Ronan Tanguy Erwan Gwenaël Hugues "
    "Ludwig Sacha Ulysse Marius Aurélien Pierrick Johan Steven Teddy Stan Rodrigue Léopold "
    "Basile"
)


def _first_name_forms() -> str:
    forms: set[str] = set()
    for name in _FIRST_NAMES.split(" "):
        plain = "".join(c for c in unicodedata.normalize("NFD", name) if not unicodedata.combining(c))
        for form in (name, plain):
            forms.add(form)
            forms.add(form.upper())
    return "|".join(sorted(forms, key=lambda form: (-len(form), form)))


_FIRST_NAME_FORMS = _first_name_forms()
# Un ou plusieurs prénoms de la liste, composés avec un trait d'union : « Jean-Pierre », « MARIE-CLAIRE ».
_FIRST_NAME = rf"(?:{_FIRST_NAME_FORMS})(?:-(?:{_FIRST_NAME_FORMS}))*(?![{_L}])"
# Prénom(s) puis NOM(S) en capitales : « Jean-Pierre DUPONT ».
_BARE_FORENAME_FIRST = (
    rf"{_CAPW}(?:{_SP}+{_CAPW}){{0,2}}{_SP}+{_NOT_STOP}{_UPW}"
    rf"(?:{_SP}+(?:{_PARTICLE}{_SP}*)?{_NOT_STOP}{_UPW}){{0,2}}"
)
# NOM(S) en capitales puis prénom(s) de la liste : « DUPONT Pierre », « DE LA FONTAINE Claire »,
# « DUPONT PIERRE ».
_BARE_SURNAME_FIRST = (
    rf"{_NOT_STOP}{_UPW}(?:{_SP}+(?:{_PARTICLE}{_SP}*)?{_NOT_STOP}{_UPW}){{0,2}}"
    rf"{_SP}+{_FIRST_NAME}(?:{_SP}+{_FIRST_NAME}){{0,2}}"
)
_BARE = rf"(?:{_BARE_FORENAME_FIRST}|{_BARE_SURNAME_FIRST})"
_NAMESEQ = rf"(?:{_INITIAL})*{_TOKEN}(?:{_SP}+(?:{_PARTICLE}{_SP}+)?{_NEXT}){{0,4}}"
_NAME_SINGLE = rf"{_TOKEN}(?:{_SP}+(?:{_PARTICLE}{_SP}+)?{_NEXT}){{0,2}}"
# « Pierre Martin » en casse mixte, sans civilité : deux à trois mots, jamais un début de phrase.
# N'est utilisé qu'après « loué à » et « bail consenti à » (`_lease`).
_NAME_MIXED = rf"{_NOT_SENTENCE_START}{_NOT_STOP}{_TOKEN}(?:{_SP}+(?:{_PARTICLE}{_SP}+)?{_NEXT}){{1,2}}"
_CIV = (
    r"(?:(?:Monsieur|Madame|MONSIEUR|MADAME|M\.|Mme)" + _SP + r"+(?:et|ou|ET|OU)" + _SP + r"+)?"
    r"(?:(?:Monsieur|Madame|Mademoiselle|Messieurs|Mesdames|MONSIEUR|MADAME|MADEMOISELLE|MESSIEURS|MESDAMES"
    rf"|Mmes|Mme|MME|Mlle|MLLE|Melle|Mr|MM?){_SP}+|MM?\.{_SP}*)"
)
_PERSON_CIV = re.compile(rf"{_CIV}{_NAMESEQ}")
_PERSON_BARE = re.compile(_BARE)
_PERSON_SINGLE = re.compile(_NAME_SINGLE)
_PERSON_MIXED = re.compile(_NAME_MIXED)
_CIV_PREFIX = re.compile(rf"^{_CIV}")
_ALIAS = re.compile(
    rf"(?:{_SP}*,)?{_SP}*(?:née|épouse|époux|veuve|veuf|divorcée|divorcé)(?![{_L}]){_SP}+"
    rf"(?:(?:de|d{_APOS}|du){_SP}*)?"
)
_SEPARATOR = re.compile(
    rf"(?:{_SP}*,{_SP}*|{_SP}+(?:et|ou|ainsi{_SP}+que){_SP}+(?:(?:de|d{_APOS}){_SP}*)?)(?:(?:son|sa|ses|leurs?)"
    rf"{_SP}+(?:épouse|époux|compagne|compagnon|conjoint|conjointe){_SP}+)?"
)
_LIST_SEPARATOR = re.compile(rf"(?:{_SP}*,{_SP}*|{_SP}+et{_SP}+)")

# Premiers mots qui ne commencent jamais un nom de personne (début de phrase, voies, saints…).
_STOP_FIRST = frozenset(
    "Un Une Ce Cette Ces Dans Pour Sur Et Il Elle Son Sa Ses Aux Au Du De Des Les Rue Avenue Boulevard Place "
    "Impasse Chemin Route Allée Quai Cours Square Passage Saint Sainte Mont Port Grand Grande Val Ville Parc "
    "Résidence Lotissement Bâtiment Hameau Immeuble Copropriété Cabinet Étude Maître Tribunal".split()
)
_STOP_FIRST_SINGLE = _STOP_FIRST - {"Du", "De", "Des"}
_ORG_RE = re.compile(
    rf"(?<![{_L}])(?:sci|sarl|sas|sasu|eurl|sa|snc|scp|selarl|selas|scm|sccv|sc|société|societe|banque|caisse"
    r"|crédit|credit|syndicat|association|commune|mairie|ville|département|departement|région|region|état|etat"
    r"|trésor|tresor|fonds|compagnie|mutuelle|cabinet|étude|etude|agence|foncière|fonciere|immobilière"
    r"|immobiliere|groupe|union|fédération|federation|communauté|communaute|métropole|metropole|office|centre"
    r"|établissement|etablissement|hôpital|hopital|copropriété|copropriete|copropriétaires|syndic|tribunal"
    r"|préfecture|prefecture|ministère|ministere|direction|service|services|administration|domaine|domaines"
    r"|finances|publiques|impôts|impots|urssaf|habitat|logement|logements|patrimoine|gestion|résidence"
    rf"|residence|hotel|hôtel|restaurant|pharmacie|garage|france)(?![{_L}])",
    re.IGNORECASE,
)
_TITLE_RE = re.compile(
    rf"^(?:(?:le|la|les|du|des){_SP}+|l{_APOS})(?:maire|préfet|préfète|prefet|procureur|directeur|directrice"
    r"|président|présidente|president|ministre|juge|syndic|receveur|trésorier|tresorier|comptable|notaire"
    r"|greffier|commissaire|huissier|liquidateur|mandataire|administrateur|gérant|gérante|gerant"
    r"|représentant|responsable|chef|délégué|delegue|conservateur|bâtonnier|secrétaire)"
    rf"(?![{_L}])",
    re.IGNORECASE,
)

_QUICK = re.compile(
    r"occup|locataire|bail|requête|requete|appartenant|appartien|propriété|propriete|\bné|demeur|domicili"
    r"|résida|residan|époux|épouse|epou|divorc|veuf|veuve|\bnée|consort|héritier|heritier|succession|loué|loue"
    r"|d[ée]biteur|saisi|propri[ée]taire|vendeur|bailleur|cr[ée]ancier|poursuivant|d[ée]fendeur|demandeur"
    r"|requ[ée]rant|int[ée]ress|indivisaire",
    re.IGNORECASE,
)

_MONTHS = (
    "janvier|février|fevrier|mars|avril|mai|juin|juillet|août|aout|septembre|octobre|novembre|décembre|decembre"
)
_DATE = rf"(?:\d{{1,2}}(?:er)?{_SP}+(?:{_MONTHS}){_SP}+\d{{4}}|\d{{1,2}}[/.\-]\d{{1,2}}[/.\-]\d{{2,4}})"
_PLACE = re.compile(
    rf"{_SP}+(?:à|a|au|en){_SP}+(?:(?:Le|La|Les){_SP}+|L{_APOS})?{_TOKEN}"
    rf"(?:(?:{_SP}+|-)(?:(?:de|du|des|sur|sous|en|lès|aux|la|le|les)(?:{_SP}+|-)|d{_APOS})?"
    rf"{_NOT_STOP}{_NOT_SENTENCE_START}{_TOKEN}){{0,4}}"
    rf"(?:{_SP}+\d{{1,2}}(?:er|e|ème))?(?:{_SP}*\([^)\n]{{1,20}}\))?"
)
_PROFESSIONAL = re.compile(
    rf"(?<![{_L}])(?:ma[iî]tre|me|avocats?|notaires?|huissiers?|scp|selarl|cabinet|étude|etude)(?![{_L}])",
    re.IGNORECASE,
)
_STREET_WORDS = (
    "rue|avenue|av|boulevard|bd|bld|chemin|ch|impasse|imp|route|rte|allée|allee|place|pl|quai|cours|passage"
    "|square|lotissement|résidence|residence|hameau|lieu-dit|lieudit|bâtiment|batiment|bât|bat|appartement"
    "|app|apt|étage|etage|escalier|esc|villa|cité|cite|domaine|faubourg|fg|mail|parvis|sentier|traverse"
    "|zone|zac|cedex|bp|chez|clos|rond-point|esplanade|promenade|ruelle|venelle"
)
_ABBREVIATIONS = "av|bd|bld|bvd|ch|imp|rte|pl|app|apt|esc|fg|bât|bat|st|ste|dr|pr"
_ADDRESS_FILLER = re.compile(rf"(?:ensemble|actuellement|également|egalement|toujours|alors){_SP}+")
_ADDRESS_CONNECTOR = re.compile(rf"(?:de|du|des|la|le|les|sur|sous|en|aux|au|à)(?![{_L}\d])")
_ADDRESS_TOKEN = re.compile(
    rf"(?:\d+(?:[-/]\d+)*(?:er|ère|ème|e|bis|ter|quater|[A-Za-z])?(?![{_L}\d])|[nN]°|[A-Z](?![{_L}\d])"
    rf"|(?:{_ABBREVIATIONS})\.|(?:{_STREET_WORDS})(?![{_L}])|{_TOKEN}|\([^)\n]{{1,25}}\))"
)
_ADDRESS_SEPARATOR = re.compile(rf"(?:{_SP}*,{_SP}*|{_SP}+|-)")
_MAX_ADDRESS_TOKENS = 30

_NO_BEFORE = rf"(?<![{_L}\d])"
# « À LA REQUETE DE : Madame X » (deux-points) et « à la requête de la Mme X » (article devant la
# civilité) : le « la » n'est consommé que devant une civilité.
_REQUETE = re.compile(
    rf"{_NO_BEFORE}([àa]{_SP}+la{_SP}+requ[êe]te)({_SP}+(?:des|de|du|d{_APOS}))(?:{_SP}*:)?{_SP}*"
    rf"(?:(?:la|le){_SP}+(?={_CIV}))?",
    re.IGNORECASE,
)
_OCCUPIED = re.compile(rf"{_NO_BEFORE}occup[ée](?:e|s|es)?{_SP}+par{_SP}+", re.IGNORECASE)
# « le locataire en place, Madame X » : le qualificatif reste, le nom part.
_ROLE_QUALIFIER = rf"(?:{_SP}+(?:en{_SP}+place|en{_SP}+titre|actuel(?:le)?s?|principa(?:l|le|ux|les)))?"
_TENANT = re.compile(
    rf"{_NO_BEFORE}(locataires?)({_ROLE_QUALIFIER})({_SP}*[:,\-–]{_SP}*|{_SP}+)", re.IGNORECASE
)
_LEASE = re.compile(
    rf"{_NO_BEFORE}(?:bail(?:{_SP}+[{_L}'’-]+){{0,4}}?{_SP}+consenti(?:e|s|es)?{_SP}+(?:à|a|au|aux)"
    rf"|lou[ée](?:e|s|es)?{_SP}+(?:à|a)){_SP}+",
    re.IGNORECASE,
)
_OWNER_AT = re.compile(rf"{_NO_BEFORE}appartien(?:t|nent)|{_NO_BEFORE}appartenant", re.IGNORECASE)
_OWNER_AT_TAIL = re.compile(rf"{_SP}+(?:à|a|aux){_SP}+", re.IGNORECASE)
_PROPERTY = re.compile(
    rf"{_NO_BEFORE}(propri[ée]t[ée])({_SP}+(?:des|de|du)|{_SP}+d{_APOS}){_SP}*", re.IGNORECASE
)
_HEIRS = re.compile(
    rf"{_NO_BEFORE}(h[ée]ritiers?|succession)({_SP}+(?:de|d{_APOS}|du){_SP}*)"
    rf"(?:(?:feu|d[ée]funt|regrett[ée]){_SP}+)?",
    re.IGNORECASE,
)
_CONSORTS = re.compile(rf"{_NO_BEFORE}(consorts?){_SP}+", re.IGNORECASE)
_MARITAL = re.compile(
    rf"{_NO_BEFORE}([ée]pouses?|[ée]poux|veuf|veuve|divorc[ée]e?s?|n[ée]e)(?![{_L}])", re.IGNORECASE
)
_ROLE = re.compile(
    rf"{_NO_BEFORE}(débiteurs?|saisis?|saisies?|occupants?|occupantes?|propriétaires?|vendeurs?|bailleurs?"
    rf"|créanciers?|poursuivants?|défendeurs?|demandeurs?|requérants?|intéressés?|indivisaires?"
    rf"|copropriétaires?)({_ROLE_QUALIFIER})({_SP}*[:,]{_SP}*|{_SP}+)",
    re.IGNORECASE,
)
_MARITAL_LINK = re.compile(rf"{_SP}+(?:(?:de|d{_APOS}|du){_SP}*)?")
# Ces deux motifs commencent par leur mot-clé : un préfixe d'espaces non ancré (`SP*,?SP*`) serait
# quadratique sur une longue suite d'espaces. L'espace et la virgule qui précèdent le mot-clé sont
# rattachés ensuite, en remontant (`_with_leading_separator`).
_BIRTH = re.compile(
    rf"(?<![{_L}])n[ée](?:e|\(e\))?(?![{_L}]){_SP}+(?:le{_SP}+{_DATE}|en{_SP}+\d{{4}})",
    re.IGNORECASE,
)
_RESIDENCE = re.compile(
    rf"{_NO_BEFORE}(?:demeurant|demeurante|demeurants|domicili[ée](?:e|s|es)?"
    rf"|r[ée]sidant|r[ée]sidante)(?![{_L}])",
    re.IGNORECASE,
)
_SP_CHAR = re.compile(_SP)

_Edit = tuple[int, int, str]


def _substitute(text: str, pattern: re.Pattern[str], handler: Callable[[str, re.Match[str]], _Edit | None]) -> str:
    out: list[str] = []
    cursor = 0
    for match in pattern.finditer(text):
        if match.start() < cursor:
            continue
        edit = handler(text, match)
        if edit is None:
            continue
        start, end, replacement = edit
        out.append(text[cursor:start])
        out.append(replacement)
        cursor = end
    out.append(text[cursor:])
    return "".join(out)


def _skip_spaces_back(text: str, index: int) -> int:
    while index > 0 and _SP_CHAR.match(text, index - 1):
        index -= 1
    return index


def _with_leading_separator(text: str, index: int) -> int:
    """Début de `(?:SP*,)?SP*` juste avant `index`, en temps linéaire."""
    start = _skip_spaces_back(text, index)
    if start > 0 and text[start - 1] == ",":
        start = _skip_spaces_back(text, start - 1)
    return start


# --- Reconnaissance d'une personne --------------------------------------------------------------
def _acceptable(span: str, kind: str) -> bool:
    """`kind` : « civ » (après une civilité), « bare » (Prénom NOM) ou « single » (un nom isolé)."""
    if _ORG_RE.search(span):
        return False
    if kind == "civ":
        return not _TITLE_RE.match(_CIV_PREFIX.sub("", span, count=1))
    if _CIV_PREFIX.match(span):
        return False  # « Madame Le MAIRE » : la civilité écartée ne doit pas devenir un prénom
    first = re.split(r"[\s'’-]", span.strip(), maxsplit=1)[0]
    return first not in (_STOP_FIRST_SINGLE if kind == "single" else _STOP_FIRST)


def _one_person(text: str, pos: int, *, single: bool = False, mixed: bool = False) -> int | None:
    match = _PERSON_CIV.match(text, pos)
    if match and _acceptable(match.group(0), "civ"):
        return match.end()
    match = _PERSON_BARE.match(text, pos)
    if match and _acceptable(match.group(0), "bare"):
        return match.end()
    if single:
        match = _PERSON_SINGLE.match(text, pos)
        if match and _acceptable(match.group(0), "single"):
            return match.end()
    if mixed:
        match = _PERSON_MIXED.match(text, pos)
        if match and _acceptable(match.group(0), "bare"):
            return match.end()
    return None


def _person_end(text: str, pos: int, *, mixed: bool = False) -> int | None:
    """Fin d'une ou plusieurs personnes (« M. X et Mme Y, née Z ») commençant en `pos`."""
    end = _one_person(text, pos, mixed=mixed)
    if end is None:
        return None
    while True:
        extended = False
        alias = _ALIAS.match(text, end)
        if alias:
            after = _one_person(text, alias.end(), single=True)
            if after is not None:
                end, extended = after, True
        separator = _SEPARATOR.match(text, end)
        if separator:
            after = _one_person(text, separator.end(), mixed=mixed)
            if after is not None:
                end, extended = after, True
        if not extended:
            return end


# --- Règles -------------------------------------------------------------------------------------
def _requete(text: str, match: re.Match[str]) -> _Edit | None:
    end = _person_end(text, match.end())
    if end is None:
        return None
    return match.start() + len(match.group(1)), end, " du créancier poursuivant"


def _occupied(text: str, match: re.Match[str]) -> _Edit | None:
    end = _person_end(text, match.end())
    if end is None:
        return None
    # Le statut (locataire, occupant sans titre, ancien locataire…) n'est jamais déduit du voisinage.
    return match.end(), end, "un occupant"


# Après un rôle sans civilité, ces mots ne commencent pas un nom (avocat, bien décrit en capitales).
_ROLE_NOT_A_NAME = frozenset(
    (
        "me maître maitre mtre appartement maison local locaux lot lots bien biens terrain studio garage "
        "parking cave villa pavillon entrepôt entrepot bâtiment batiment commerce parcelle logement fonds"
    ).split(" ")
)


def _role(text: str, match: re.Match[str]) -> _Edit | None:
    civil = _PERSON_CIV.match(text, match.end())
    if civil:
        if not _acceptable(civil.group(0), "civ"):
            return None
    else:
        # Sans civilité : « Le saisi, Paul ROY », « propriétaire : DUPONT Pierre ».
        bare = _PERSON_BARE.match(text, match.end())
        if not bare or not _acceptable(bare.group(0), "bare"):
            return None
        if re.split(r"[\s'’-]", bare.group(0), maxsplit=1)[0].lower() in _ROLE_NOT_A_NAME:
            return None
    end = _person_end(text, match.end())
    if end is None:
        return None
    return match.start() + len(match.group(1)) + len(match.group(2)), end, ""


def _tenant(text: str, match: re.Match[str]) -> _Edit | None:
    end = _person_end(text, match.end())
    if end is None:
        return None
    return match.start() + len(match.group(1)) + len(match.group(2)), end, ""


def _lease(text: str, match: re.Match[str]) -> _Edit | None:
    end = _person_end(text, match.end(), mixed=True)
    if end is None:
        return None
    return match.end(), end, "un locataire"


def _owner_at(text: str, match: re.Match[str]) -> _Edit | None:
    tail = _OWNER_AT_TAIL.match(text, match.end())
    if not tail:
        return None
    end = _person_end(text, tail.end())
    if end is None:
        return None
    return tail.end(), end, "un particulier"


def _property(text: str, match: re.Match[str]) -> _Edit | None:
    end = _person_end(text, match.end())
    if end is None:
        return None
    return match.start() + len(match.group(1)), end, " d'un particulier"


def _heirs(text: str, match: re.Match[str]) -> _Edit | None:
    end = _person_end(text, match.end())
    if end is None:
        return None
    return match.start() + len(match.group(1)), end, " du défunt"


def _consorts(text: str, match: re.Match[str]) -> _Edit | None:
    first = _PERSON_SINGLE.match(text, match.end())
    if not first or not _acceptable(first.group(0), "single"):
        return None
    end = first.end()
    while True:
        separator = _LIST_SEPARATOR.match(text, end)
        following = _PERSON_SINGLE.match(text, separator.end()) if separator else None
        if not following or not _acceptable(following.group(0), "single"):
            break
        end = following.end()
    return match.start() + len(match.group(1)), end, ""


def _marital(text: str, match: re.Match[str]) -> _Edit | None:
    link = _MARITAL_LINK.match(text, match.end())
    if not link:
        return None
    end = _one_person(text, link.end(), single=True)
    if end is None:
        return None
    word = match.group(1)
    if word.lower() in ("née", "nee"):
        # « , née DURAND » : le mot lui-même n'a plus d'objet.
        start = match.start()
        while start > 0 and text[start - 1] in " \t\u00a0":
            start -= 1
        if start > 0 and text[start - 1] == ",":
            start -= 1
        return start, end, ""
    return match.start() + len(word), end, ""


def _birth(text: str, match: re.Match[str]) -> _Edit | None:
    place = _PLACE.match(text, match.end())
    return _with_leading_separator(text, match.start()), place.end() if place else match.end(), ""


def _address_end(text: str, pos: int) -> int | None:
    """Fin de l'adresse qui suit « demeurant » : jeton par jeton, sans manger la suite de la phrase."""
    cursor = pos
    filler = _ADDRESS_FILLER.match(text, _skip_separators(text, cursor))
    if filler:
        cursor = filler.end()
    end: int | None = None
    for _ in range(_MAX_ADDRESS_TOKENS):
        cursor = _skip_separators(text, cursor)
        token = _ADDRESS_TOKEN.match(text, cursor)
        if token:
            cursor = token.end()
            end = cursor
            continue
        connector = _ADDRESS_CONNECTOR.match(text, cursor)
        if connector:
            cursor = connector.end()  # n'est conservé que si un jeton d'adresse le suit
            continue
        break
    return end


def _skip_separators(text: str, pos: int) -> int:
    separator = _ADDRESS_SEPARATOR.match(text, pos)
    return separator.end() if separator else pos


def _clause_window(text: str, index: int) -> str:
    before = text[max(0, index - 60) : index]
    boundary = max(before.rfind("."), before.rfind(";"), before.rfind("\n"))
    return before[boundary + 1 :]


def _has_subject(text: str, index: int) -> bool:
    """« demeurant » doit qualifier quelqu'un : pas en début de phrase."""
    before = text[:index].rstrip()
    return bool(before) and before[-1] not in ".:;!?"


def _residence(text: str, match: re.Match[str]) -> _Edit | None:
    start = _with_leading_separator(text, match.start())
    if not _has_subject(text, start) or _PROFESSIONAL.search(_clause_window(text, start)):
        return None
    end = _address_end(text, match.end())
    if end is None:
        return None
    return start, end, ""


_RULES: tuple[tuple[re.Pattern[str], Callable[[str, re.Match[str]], _Edit | None]], ...] = (
    (_REQUETE, _requete),
    (_OCCUPIED, _occupied),
    (_TENANT, _tenant),
    (_ROLE, _role),
    (_LEASE, _lease),
    (_OWNER_AT, _owner_at),
    (_PROPERTY, _property),
    (_HEIRS, _heirs),
    (_CONSORTS, _consorts),
    (_MARITAL, _marital),
    (_BIRTH, _birth),
    (_RESIDENCE, _residence),
)


def redact_personal_text(text: str | None) -> str | None:
    """Remplace par un rôle générique le nom d'une personne physique dans un texte libre."""
    if not isinstance(text, str) or not text or not _QUICK.search(text):
        return text
    for pattern, handler in _RULES:
        text = _substitute(text, pattern, handler)
    return text


def redact_personal_data(value: Any, *, _depth: int = 0) -> Any:
    """Applique le filtre à toutes les chaînes d'une valeur JSON (liste, dict, chaîne)."""
    if _depth > 12:
        return value
    if isinstance(value, str):
        return redact_personal_text(value)
    if isinstance(value, list):
        return [redact_personal_data(item, _depth=_depth + 1) for item in value]
    if isinstance(value, dict):
        return {key: redact_personal_data(item, _depth=_depth + 1) for key, item in value.items()}
    return value


# Colonnes texte d'une ligne `auction_sales` lisibles par un compte connecté.
SALE_TEXT_COLUMNS = ("description", "risk_notes", "investment_summary", "surface_evidence")
# Clés de `raw_payload` qui portent du texte affiché ou produit par l'IA. Les preuves (empreintes,
# citations de surface, analyses de pièces) ne sont pas touchées : leur vérification exige le texte exact.
PAYLOAD_TEXT_KEYS = (
    "description",
    "source_description",
    "llm_display_description",
    "llm_display_source_constraints",
    "source_blocks",
    "source_conflicts",
    "llm_extraction",
    "llm_fact_extraction",
)


def redact_payload(payload: Any) -> Any:
    """Filtre les clés texte d'un `raw_payload` ou d'une observation."""
    if not isinstance(payload, dict):
        return payload
    redacted = dict(payload)
    for key in PAYLOAD_TEXT_KEYS:
        if key in redacted:
            redacted[key] = redact_personal_data(redacted[key])
    return redacted


def _redact_observation(observation: Any) -> Any:
    if not isinstance(observation, dict):
        return observation
    redacted = redact_payload(observation)
    if isinstance(redacted.get("raw_payload"), dict):
        redacted["raw_payload"] = redact_payload(redacted["raw_payload"])
    return redacted


def redact_storage_row(row: dict[str, Any]) -> dict[str, Any]:
    """Filtre, en place, une ligne destinée à `auction_sales` (ou à ses copies normalisées)."""
    for column in SALE_TEXT_COLUMNS:
        if isinstance(row.get(column), str):
            row[column] = redact_personal_text(row[column])
    if isinstance(row.get("raw_payload"), dict):
        row["raw_payload"] = redact_payload(row["raw_payload"])
    if isinstance(row.get("observations"), list):
        row["observations"] = [_redact_observation(item) for item in row["observations"]]
    return row
