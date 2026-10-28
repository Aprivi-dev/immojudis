"""Code commune (INSEE) d'une vente, posé dans ``raw_payload["commune"]``.

Pourquoi : le code commune n'était pas stocké sur la vente ; il est le prérequis du contrôle d'inondation de la pépite
(Géorisques / GASPAR interroge une COMMUNE) et des loyers de l'ANIL (publiés par commune et, à Paris, Lyon et Marseille,
par arrondissement). Le traitement planifié de l'application recopie ce code dans ``public.auction_sale_communes``
(``src/lib/sale-communes-sync.server.ts``) ; le remplissage initial des ventes existantes est la migration SQL
``20261106100100``. Rien n'est ajouté aux colonnes de ``auction_sales`` : le pipeline n'écrit que ``raw_payload``, déjà
persisté, donc aucune dépendance à l'ordre d'application des migrations.

Forme posée (``raw_payload["commune"]``) :

    {"insee": "75056", "arrondissement_insee": "75108", "source": "geocode"}

* ``insee`` : le code de la COMMUNE au sens de GASPAR. Les arrondissements (751xx, 132xx, 693xx) sont ramenés à
  75056 (Paris), 13055 (Marseille) et 69123 (Lyon).
* ``arrondissement_insee`` : l'arrondissement (751xx, 132xx ou 693xx) quand la vente en a un, sinon ``None``.
  Il est gardé à part : les loyers de l'ANIL en ont besoin.
* ``source`` : ``geocode`` (code du résultat de géocodage accepté, ``raw_payload["geocode"]["citycode"]``) ou
  ``reference_communes`` (repli : commune retrouvée par code postal et nom, ou centre de commune posé sans réseau).

* ``mismatch`` (seulement s'il est vrai) : le code du géocodage n'était ni du département ni de la ville de la vente ;
  il a été écarté et le code vient de ``reference_communes``.

Aucun appel réseau ici : le repli lit ``public.reference_communes`` par le même index mémoire que
``src.municipality_location`` (une commune sans ambiguïté, jamais une supposition).
"""

from __future__ import annotations

import logging
import re
from typing import Any

from src.models import AuctionSale
from src.municipality_location import PROVIDER as MUNICIPALITY_PROVIDER
from src.municipality_location import find_commune
from src.reference_data.names import arrondissement_number, department_from_insee

LOGGER = logging.getLogger(__name__)

COMMUNE_CODE = re.compile(r"^[0-9][0-9AB][0-9]{3}$")

# Arrondissements municipaux : (motif du code, commune parente).
_ARRONDISSEMENTS = (
    (re.compile(r"^751(?:0[1-9]|1[0-9]|20)$"), "75056"),  # Paris
    (re.compile(r"^132(?:0[1-9]|1[0-6])$"), "13055"),  # Marseille
    (re.compile(r"^6938[1-9]$"), "69123"),  # Lyon
)
# Code postal -> arrondissement, pour le repli par code postal (Paris 750NN, Marseille 130NN, Lyon 6900N).
_POSTAL_ARRONDISSEMENTS = (
    (re.compile(r"^750(0[1-9]|1[0-9]|20)$"), "75056", lambda m: f"751{m.group(1)}"),
    # 75116 : second code postal du 16e arrondissement (le web le gère de même, sale-commune-code.ts).
    (re.compile(r"^75116$"), "75056", lambda m: "75116"),
    (re.compile(r"^130(0[1-9]|1[0-6])$"), "13055", lambda m: f"132{m.group(1)}"),
    (re.compile(r"^6900([1-9])$"), "69123", lambda m: f"6938{m.group(1)}"),
)


def commune_codes(code: object) -> tuple[str, str | None] | None:
    """``(commune, arrondissement)`` d'un code INSEE ; ``None`` si le code n'est pas un code commune valide.

    ``commune_codes("75108")`` -> ``("75056", "75108")`` ; ``commune_codes("37261")`` -> ``("37261", None)``.
    """
    value = str(code or "").strip().upper()
    if not COMMUNE_CODE.fullmatch(value):
        return None
    for pattern, parent in _ARRONDISSEMENTS:
        if pattern.fullmatch(value):
            return parent, value
    return value, None


def _arrondissement_from_postal_code(commune: str, postal_code: object) -> str | None:
    postal = str(postal_code or "").strip()
    for pattern, parent, build in _POSTAL_ARRONDISSEMENTS:
        match = pattern.fullmatch(postal)
        if parent == commune and match:
            return build(match)
    return None


# Arrondissements nommés dans la ville (« Marseille 8e ») : (commune parente, nombre d'arrondissements, préfixe).
_ARRONDISSEMENT_BY_CITY = {"75056": (20, "751"), "13055": (16, "132"), "69123": (9, "6938")}


def _arrondissement_from_city(commune: str, city: object) -> str | None:
    limit, prefix = _ARRONDISSEMENT_BY_CITY.get(commune, (0, ""))
    number = arrondissement_number(str(city or "")) if limit else None
    if number is None or not 1 <= number <= limit:
        return None
    return f"{prefix}{number:02d}" if len(prefix) == 3 else f"{prefix}{number}"


def _arrondissement(commune: str, sale: AuctionSale) -> str | None:
    """Arrondissement déduit du code postal, à défaut du nombre écrit dans la ville (« Paris 8ème »)."""
    return _arrondissement_from_postal_code(commune, sale.postal_code) or _arrondissement_from_city(
        commune, sale.city
    )


_DEPARTMENT_CODE = re.compile(r"^(?:\d{2}|2[AB]|97\d)$")


def _same_department(code: str, declared: object) -> bool:
    """Le code commune est dans le département de la vente ; vrai quand celui-ci n'est pas connu."""
    department = str(declared or "").strip().upper()
    if not _DEPARTMENT_CODE.fullmatch(department):
        return True
    actual = department_from_insee(code)
    # « 20 » : l'ancien département de Corse, avant 2A et 2B.
    return actual == department or (department == "20" and actual in ("2A", "2B"))


def _geocode_agrees_with_sale(codes: tuple[str, str | None], sale: AuctionSale) -> bool:
    """Le code du géocodage accepté est celui du département de la vente et, quand elle est sans ambiguïté, de sa ville.

    La BAN peut répondre sans code postal, ou avec une rue homonyme : un code d'un autre département ou d'une autre
    commune que celle de la vente est écarté (la vente retombe sur la table de référence).
    """
    commune, arrondissement = codes
    if not _same_department(commune, sale.department):
        return False
    declared = find_commune(sale.city, sale.postal_code, sale.department)
    declared_codes = commune_codes(declared.get("code_insee")) if declared else None
    return declared_codes is None or declared_codes[0] == commune


def _accepted_evidence(sale: AuctionSale) -> dict[str, Any] | None:
    evidence = sale.raw_payload.get("geocode") if isinstance(sale.raw_payload, dict) else None
    if not isinstance(evidence, dict) or evidence.get("accepted") is not True:
        return None
    return evidence


def resolve_sale_commune(sale: AuctionSale) -> dict[str, Any] | None:
    """Le code commune de la vente, ou ``None`` quand il n'est pas connu sans ambiguïté.

    1. le ``citycode`` du résultat de géocodage accepté (``raw_payload["geocode"]``, BAN ou centre de commune) ;
    2. à défaut, la commune de ``reference_communes`` retrouvée par code postal et nom (ou département et nom sans
       code postal), seulement si elle est unique.
    """
    evidence = _accepted_evidence(sale)
    mismatch = False
    if evidence is not None:
        codes = commune_codes(evidence.get("citycode"))
        if codes is not None and _geocode_agrees_with_sale(codes, sale):
            commune, arrondissement = codes
            source = "reference_communes" if evidence.get("provider") == MUNICIPALITY_PROVIDER else "geocode"
            return {
                "insee": commune,
                "arrondissement_insee": arrondissement or _arrondissement(commune, sale),
                "source": source,
            }
        mismatch = codes is not None
        if mismatch:
            LOGGER.info("Geocoded commune code discarded: not the department or the city of %s", sale.source_url)
    found = find_commune(sale.city, sale.postal_code, sale.department)
    if found is None:
        return None
    codes = commune_codes(found.get("code_insee"))
    if codes is None:
        return None
    commune, arrondissement = codes
    resolved: dict[str, Any] = {
        "insee": commune,
        "arrondissement_insee": arrondissement or _arrondissement(commune, sale),
        "source": "reference_communes",
    }
    if mismatch:
        # Le code du géocodage a été écarté : la trace reste pour qui voudrait ne pas s'y fier ailleurs.
        resolved["mismatch"] = True
    return resolved


def record_sale_commune(sale: AuctionSale) -> bool:
    """Pose ``raw_payload["commune"]`` ; ne lève jamais (le géocodage ne doit pas échouer pour un code commune).

    Un code déjà posé n'est remplacé que par un code résolu : une table de référence momentanément illisible ne
    l'efface jamais. Renvoie vrai si la valeur posée a changé.
    """
    if not isinstance(sale.raw_payload, dict):
        return False
    try:
        resolved = resolve_sale_commune(sale)
    except Exception as exc:  # noqa: BLE001 - jamais bloquant pour la collecte
        LOGGER.warning("Commune code resolution skipped for %s: %s", sale.source_url, type(exc).__name__)
        return False
    if resolved is None or sale.raw_payload.get("commune") == resolved:
        return False
    sale.raw_payload["commune"] = resolved
    return True
