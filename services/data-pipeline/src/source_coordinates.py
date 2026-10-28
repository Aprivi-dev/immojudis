"""Coordonnées publiées par la source, vérifiées : une précision que l'application sait lire.

Pourquoi : une vente dont le point vient de la source (Licitor, Notaires, Enchères immobilières, Avoventes…) et que
la BAN n'a pas remplacé n'avait aucune précision (``raw_payload.geo_precision`` absent). L'application la classe alors
« approximative » (``classifyFloodPosition`` de ``src/lib/flood-risk.ts``) : aucun contrôle d'inondation au point.
Or ces points sont presque tous distincts les uns des autres, et seuls quelques-uns tombent près du centre de leur
commune (mesure du 28/10/2026 : 7 sur 209 à moins de 150 m) : ce sont de vrais points.

Règle (``promote_source_coordinates``, appelée par ``src.geocode.verify_source_coordinates``) : un point de la source
est promu quand

* l'adresse de la vente contient une voie ou un lieu-dit (``has_street_or_place``). Une vente dont l'adresse se réduit
  à la commune garde une position approximative, quelle que soit la distance : un point publié par la source pour une
  commune seule n'est pas la preuve d'une adresse ;
* il a passé le contrôle de cohérence (dans le département de la vente, à moins de 12 km du centre de sa commune) ;
* aucun résultat BAN ni parcelle ne le remplace (aucune preuve acceptée), et aucun drapeau de position douteuse ;
* il est à plus de ``MIN_DISTANCE_FROM_COMMUNE_M`` mètres du centre de sa commune (``reference_communes``). Plus près,
  la source a probablement publié le centre de la commune : la position reste approximative.

Le point reçoit alors ``geo_precision = "address"`` (la valeur que la vue SQL ``location_precision`` expose, comme
une adresse BAN) et sa preuve est écrite dans ``raw_payload.geocode`` (fournisseur ``source_coordinates``,
``accepted`` vrai). Cette preuve n'est pas une vérification BAN : ``coordinates_are_verified`` ne l'accepte pas, la
BAN peut donc encore la remplacer. La trace d'une tentative BAN sans résultat y reste (``ban_query``,
``ban_attempted_at``, ``ban_rejection_reason``) : le cache négatif de 14 jours continue de fonctionner.

La preuve n'a pas de date : elle ne change pas tant que le point ne bouge pas (aucune réécriture inutile).

La promotion est recalculée à chaque contrôle : elle disparaît si le point de la source change de place (trop loin,
trop près, hors département).
"""

from __future__ import annotations

from typing import Any

from src.geocode_query import has_street_or_place
from src.models import AuctionSale
from src.position_quality import POSITION_FLAGS

PROVIDER = "source_coordinates"
PROMOTED_PRECISION = "address"
MIN_DISTANCE_FROM_COMMUNE_M = 150.0
_BAN_PROVIDER = "ban_geoplateforme"


def is_source_coordinates_evidence(evidence: object) -> bool:
    return isinstance(evidence, dict) and evidence.get("provider") == PROVIDER


def ban_attempt_view(evidence: object) -> dict[str, Any] | None:
    """La tentative BAN sans résultat portée par une preuve ``source_coordinates``, sous la forme d'un cache négatif."""
    if not is_source_coordinates_evidence(evidence) or not evidence.get("ban_attempted_at"):
        return None
    return {
        "provider": _BAN_PROVIDER,
        "query": evidence.get("ban_query"),
        "accepted": False,
        "attempted_at": evidence.get("ban_attempted_at"),
        "rejection_reason": evidence.get("ban_rejection_reason"),
    }


def reset_source_promotion(sale: AuctionSale) -> None:
    """Retire la précision et la preuve d'une promotion passée (elles sont recalculées juste après)."""
    payload = sale.raw_payload
    if not isinstance(payload, dict):
        return
    evidence = payload.get("geocode")
    if not is_source_coordinates_evidence(evidence):
        return
    if payload.get("geo_precision") == evidence.get("precision"):
        payload.pop("geo_precision", None)
    attempt = ban_attempt_view(evidence)
    if attempt is not None:
        payload["geocode"] = attempt
    else:
        payload.pop("geocode", None)


def promote_source_coordinates(sale: AuctionSale, *, distance_km: float, commune_code: object = None) -> bool:
    """Donne la précision ``address`` à un point de la source déjà vérifié ; vrai si la vente a été promue.

    ``distance_km`` : distance du point au centre de sa commune (``reference_communes``).
    """
    payload = sale.raw_payload
    if sale.latitude is None or sale.longitude is None or not isinstance(payload, dict):
        return False
    if distance_km * 1000 <= MIN_DISTANCE_FROM_COMMUNE_M or payload.get("geo_precision"):
        return False
    if not has_street_or_place(sale.address):
        return False
    if any(flag in POSITION_FLAGS for flag in sale.quality_flags):
        return False
    evidence = payload.get("geocode")
    ban_attempt: dict[str, Any] = {}
    if isinstance(evidence, dict):
        # Un résultat accepté (BAN, parcelle, centre de commune) n'est pas un point brut de la source.
        if evidence.get("accepted") is True:
            return False
        if evidence.get("provider") == _BAN_PROVIDER:
            if evidence.get("rejection_reason") == "outside_department":
                return False
            ban_attempt = {
                "ban_query": evidence.get("query"),
                "ban_attempted_at": evidence.get("attempted_at"),
                "ban_rejection_reason": evidence.get("rejection_reason"),
            }
    payload["geo_precision"] = PROMOTED_PRECISION
    payload["geocode"] = {
        "provider": PROVIDER,
        "accepted": True,
        "precision": PROMOTED_PRECISION,
        "latitude": float(sale.latitude),
        "longitude": float(sale.longitude),
        "distance_to_commune_m": round(distance_km * 1000),
        "commune_code": commune_code,
        **ban_attempt,
    }
    return True
