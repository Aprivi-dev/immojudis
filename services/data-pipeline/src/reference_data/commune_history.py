"""Passages de code commune (fusions, changements de code), depuis le fichier des mouvements de communes de l'INSEE.

Le fichier ``v_mvt_commune_AAAA.csv`` du code officiel géographique (COG) porte une ligne par commune et par
événement depuis 1943 (``MOD`` : la modalité de l'événement). On n'en garde que les changements de code de la
commune, vers une commune (``TYPECOM_AP = COM``), entre ``since`` et le dernier millésime :

* 31 à 35 : fusions et créations de communes nouvelles (le code d'une commune absorbée devient celui de la commune
  nouvelle ; les communes déléguées ou associées ``COMD``/``COMA`` y sont aussi) ;
* 41 : changement de code dû à un changement de département ; 50 : transfert de chef-lieu.

Les créations (20), rétablissements (21), suppressions (30), changements de nom (10) et les lignes dont le code ne
change pas sont ignorés. Les arrondissements (``ARM``) aussi.

La table ``app_private.commune_code_history`` (migration 20261108120200) en est le résultat ; la lecture des loyers
(``src/lib/rent-reference.server.ts``) y cherche l'autre code d'une commune quand la ligne ANIL manque. Le chargeur
n'est lancé qu'à la main : ``python -m src.reference_data commune_history`` (hors de ``all``, la table devant exister).

Ce module n'ouvre aucune connexion : il lit un fichier déjà téléchargé.
"""

from __future__ import annotations

import csv
import io
import re
from dataclasses import dataclass
from datetime import date
from pathlib import Path

from src.reference_data.rents import decode_csv

# Publié chaque année avec le COG (https://www.insee.fr/fr/information/8740222) : l'identifiant de la page et le
# millésime du nom changent ; à mettre à jour avec le COG des communes (voir docs/operations/…).
MOVEMENTS_URL = "https://www.insee.fr/fr/statistiques/fichier/8740222/v_mvt_commune_2026.csv"
MOVEMENTS_SOURCE_URL = "https://www.insee.fr/fr/information/8740222"
# Le fichier remonte à 1943 : avant cette date, un code a pu être réutilisé pour une autre commune.
DEFAULT_SINCE = date(2015, 1, 1)
CODE_CHANGE_MODALITIES = frozenset({"31", "32", "33", "34", "35", "41", "50"})
_BEFORE_TYPES = frozenset({"COM", "COMA", "COMD"})
_COMMUNE_CODE = re.compile(r"^[0-9][0-9AB][0-9]{3}$")
_REQUIRED_COLUMNS = ("MOD", "DATE_EFF", "TYPECOM_AV", "COM_AV", "TYPECOM_AP", "COM_AP")


@dataclass
class MovementStats:
    lines: int = 0
    kept: int = 0
    duplicates: int = 0
    rejected: int = 0


def parse_movements(
    text: str, since: date = DEFAULT_SINCE
) -> tuple[list[dict[str, object]], MovementStats]:
    """Les passages de code de ``text`` depuis ``since``, sans doublon ; refuse un fichier aux colonnes inattendues."""
    delimiter = ";" if text.split("\n", 1)[0].count(";") > text.split("\n", 1)[0].count(",") else ","
    reader = csv.DictReader(io.StringIO(text, newline=""), delimiter=delimiter)
    header = [str(name).strip() for name in reader.fieldnames or []]
    missing = [column for column in _REQUIRED_COLUMNS if column not in header]
    if missing:
        raise RuntimeError(f"INSEE commune movements file lacks the columns: {', '.join(missing)}")
    stats = MovementStats()
    rows: dict[tuple[str, str, date], dict[str, object]] = {}
    for raw_row in reader:
        stats.lines += 1
        row = {str(key).strip(): (value or "").strip() for key, value in raw_row.items() if key}
        if row["MOD"] not in CODE_CHANGE_MODALITIES or row["TYPECOM_AP"] != "COM":
            continue
        old_code, new_code = row["COM_AV"].upper(), row["COM_AP"].upper()
        if row["TYPECOM_AV"] not in _BEFORE_TYPES or old_code == new_code:
            continue
        try:
            effective_on = date.fromisoformat(row["DATE_EFF"])
        except ValueError:
            stats.rejected += 1
            continue
        if effective_on < since:
            continue
        if not _COMMUNE_CODE.match(old_code) or not _COMMUNE_CODE.match(new_code):
            stats.rejected += 1
            continue
        key = (old_code, new_code, effective_on)
        if key in rows:
            stats.duplicates += 1
            continue
        rows[key] = {
            "old_code": old_code,
            "new_code": new_code,
            "effective_on": effective_on,
            "modality": row["MOD"],
        }
    stats.kept = len(rows)
    return list(rows.values()), stats


def parse_movements_file(path: Path, since: date = DEFAULT_SINCE) -> tuple[list[dict[str, object]], MovementStats]:
    return parse_movements(decode_csv(path.read_bytes()), since)
