"""Commune risk profiles from the GASPAR base published by Géorisques.

The archive ``https://files.georisques.fr/GASPAR/gaspar.zip`` holds one CSV
per theme, each suffixed with its snapshot date:

* ``ddrm_risq_gaspar_<date>.csv``: risks listed for each commune (DDRM);
* ``catnat_gaspar_<date>.csv``: natural disaster decrees (CatNat);
* ``pprn``/``pprt``/``pprm``: natural, technological and mining prevention plans.
"""

from __future__ import annotations

import csv
import io
import re
import zipfile
from collections import Counter, defaultdict
from collections.abc import Iterator
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path

GASPAR_ARCHIVE_URL = "https://files.georisques.fr/GASPAR/gaspar.zip"
GASPAR_SOURCE_URL = "https://www.georisques.gouv.fr/donnees/bases-de-donnees/base-gaspar"
RECENT_CATNAT_LIMIT = 8
ACTIVE_PLAN_STATES = frozenset({"Opposable", "Prescrit"})
_INSEE = re.compile(r"^[0-9][0-9AB][0-9]{3}$")
_SNAPSHOT = re.compile(r"_(\d{4}-\d{2}-\d{2})\.csv$")


@dataclass
class _CommuneAccumulator:
    name: str | None = None
    risks: dict[str, str] = field(default_factory=dict)
    catnat: dict[tuple[str, str, str], dict[str, object]] = field(default_factory=dict)
    plans: dict[str, dict[str, object]] = field(default_factory=dict)


def build_risk_profiles(archive: Path) -> tuple[list[dict[str, object]], date | None]:
    """Parse the archive into one profile row per commune."""
    communes: dict[str, _CommuneAccumulator] = defaultdict(_CommuneAccumulator)
    snapshot: date | None = None
    with zipfile.ZipFile(archive) as bundle:
        names = bundle.namelist()
        ddrm = _member(names, "ddrm_risq_gaspar_")
        snapshot = _snapshot(ddrm)
        for row in _rows(bundle, ddrm):
            _add_risk(communes, row)
        for row in _rows(bundle, _member(names, "catnat_gaspar_")):
            _add_catnat(communes, row)
        for prefix, family in (("pprn_gaspar_", "PPRN"), ("pprt_gaspar_", "PPRT"), ("pprm_gaspar_", "PPRM")):
            member = _member(names, prefix, required=False)
            if member:
                for row in _rows(bundle, member):
                    _add_plan(communes, row, family)
    profiles = [
        _profile(code, accumulator, snapshot) for code, accumulator in sorted(communes.items()) if accumulator.name
    ]
    return profiles, snapshot


def _member(names: list[str], prefix: str, *, required: bool = True) -> str | None:
    matches = sorted(name for name in names if Path(name).name.startswith(prefix) and name.endswith(".csv"))
    if not matches:
        if required:
            raise RuntimeError(f"GASPAR archive has no {prefix}*.csv file")
        return None
    return matches[-1]


def _snapshot(member: str | None) -> date | None:
    match = _SNAPSHOT.search(member or "")
    return date.fromisoformat(match.group(1)) if match else None


def _rows(bundle: zipfile.ZipFile, member: str | None) -> Iterator[dict[str, str]]:
    if not member:
        return
    with bundle.open(member) as raw:
        text = io.TextIOWrapper(raw, encoding="utf-8-sig", newline="")
        for row in csv.DictReader(text, delimiter=";"):
            yield {str(key).strip(): (value or "").strip() for key, value in row.items() if key}


def repair_mojibake(value: str) -> str:
    """Undo UTF-8 read as Latin-1 (``Ã‰peignÃ©`` -> ``Épeigné``) when present."""
    if "Ã" not in value and "Â" not in value:
        return value
    for encoding in ("cp1252", "latin-1"):
        try:
            return value.encode(encoding).decode("utf-8")
        except (UnicodeEncodeError, UnicodeDecodeError):
            continue
    return value


def _accumulator(communes: dict[str, _CommuneAccumulator], code: str, name: str) -> _CommuneAccumulator | None:
    code = code.strip()
    if not _INSEE.match(code):
        return None
    accumulator = communes[code]
    if not accumulator.name and name:
        accumulator.name = " ".join(repair_mojibake(name).split())
    return accumulator


def _add_risk(communes: dict[str, _CommuneAccumulator], row: dict[str, str]) -> None:
    accumulator = _accumulator(communes, row.get("cod_commune", ""), row.get("lib_commune", ""))
    risk_code = row.get("num_risque", "")
    label = row.get("lib_risque", "")
    if accumulator is not None and risk_code and label:
        accumulator.risks.setdefault(risk_code, label)


def _add_catnat(communes: dict[str, _CommuneAccumulator], row: dict[str, str]) -> None:
    accumulator = _accumulator(communes, row.get("code_commune", ""), row.get("libelle_commune", ""))
    if accumulator is None:
        return
    decree = row.get("id_gaspar", "")
    risk_code = row.get("num_risque_jo", "")
    start = _day(row.get("date_debut"))
    if not decree or not risk_code:
        return
    accumulator.catnat.setdefault(
        (decree, risk_code, start or ""),
        {
            "code": risk_code,
            "label": row.get("lib_risque_jo", "") or risk_code,
            "start": start,
            "end": _day(row.get("date_fin")),
            "decree": _day(row.get("date_signature_arrete")),
            "published": _day(row.get("date_publication_jo")),
        },
    )


def _add_plan(communes: dict[str, _CommuneAccumulator], row: dict[str, str], family: str) -> None:
    if row.get("LIBELLE ETAT") not in ACTIVE_PLAN_STATES:
        return
    accumulator = _accumulator(communes, row.get("CODE INSEE COMMUNE", ""), row.get("NOM COMMUNE", ""))
    procedure = row.get("CODE PROCEDURE", "")
    if accumulator is None or not procedure:
        return
    plan = accumulator.plans.setdefault(
        procedure,
        {
            "family": family,
            "kind": row.get("CODE MODELE") or family,
            "label": row.get("LIBELLE PROCEDURE") or row.get("LIBELLE MODELE") or family,
            "status": row.get("LIBELLE SOUS-ETAT") or row.get("LIBELLE ETAT"),
            "prescribed_on": _day(row.get("PRESCRIPTION")),
            "approved_on": _day(row.get("APPROBATION")),
            "risks": [],
        },
    )
    risk = row.get("LIBELLE RISQUE 3") or row.get("LIBELLE RISQUE 2")
    risks = plan["risks"]
    if risk and isinstance(risks, list) and risk not in risks:
        risks.append(risk)


def _profile(code: str, accumulator: _CommuneAccumulator, snapshot: date | None) -> dict[str, object]:
    events = sorted(
        accumulator.catnat.values(),
        key=lambda event: (str(event.get("start") or ""), str(event.get("decree") or "")),
        reverse=True,
    )
    counts = Counter((str(event["code"]), str(event["label"])) for event in events)
    plans = sorted(
        accumulator.plans.values(),
        key=lambda plan: (str(plan.get("family")), str(plan.get("approved_on") or plan.get("prescribed_on") or "")),
    )
    return {
        "code_insee": code,
        "commune_name": accumulator.name,
        "risks": [
            {"code": risk_code, "label": label}
            for risk_code, label in sorted(accumulator.risks.items(), key=lambda item: _risk_sort_key(item[0]))
        ],
        "catnat_total": len(events),
        "catnat_by_type": [
            {"code": risk_code, "label": label, "count": count}
            for (risk_code, label), count in sorted(counts.items(), key=lambda item: (-item[1], item[0][1]))
        ],
        "catnat_recent": events[:RECENT_CATNAT_LIMIT],
        "prevention_plans": plans,
        "gaspar_snapshot": snapshot,
        "source_url": GASPAR_SOURCE_URL,
    }


def _risk_sort_key(risk_code: str) -> tuple[str, str]:
    # "11" (inondation) is followed by its sub-risks "112", "113"... then "12".
    return (risk_code[:2], risk_code)


def _day(value: str | None) -> str | None:
    text = (value or "").strip()[:10]
    try:
        return date.fromisoformat(text).isoformat() if text else None
    except ValueError:
        return None
