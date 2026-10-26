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
    if evidence is not None:
        codes = commune_codes(evidence.get("citycode"))
        if codes is not None:
            commune, arrondissement = codes
            source = "reference_communes" if evidence.get("provider") == MUNICIPALITY_PROVIDER else "geocode"
            return {
                "insee": commune,
                "arrondissement_insee": arrondissement
                or _arrondissement_from_postal_code(commune, sale.postal_code),
                "source": source,
            }
    found = find_commune(sale.city, sale.postal_code, sale.department)
    if found is None:
        return None
    codes = commune_codes(found.get("code_insee"))
    if codes is None:
        return None
    commune, arrondissement = codes
    return {
        "insee": commune,
        "arrondissement_insee": arrondissement or _arrondissement_from_postal_code(commune, sale.postal_code),
        "source": "reference_communes",
    }


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
