"""Localisation d'un bien par ses références cadastrales (API Carto IGN).

Les fiches des cessions de l'État ne publient pas d'adresse postale, mais le
code INSEE de la commune et les références cadastrales (« AM 346 349 352 »,
« section ZD parcelles n° 323 et 328 », « 826 AE 188 »…). Ce module :

* lit ces références (fonction pure, :func:`parse_cadastral_references`) ;
* interroge l'API Carto « cadastre/parcelle » par groupe de parcelles d'une même
  section (une requête pour plusieurs numéros), avec un délai entre requêtes, des
  reprises bornées et un cache (mémoire, fichier facultatif, et la résolution
  déjà stockée dans la vente, réutilisée tant que les références ne changent pas) ;
* déduit un centroïde (moyenne des centroïdes pondérée par la contenance), la
  surface cadastrale totale et une désignation lisible
  (« Parcelles AM 346, 349… à Pessines »).

Aucune donnée personnelle n'est manipulée ; les journaux ne contiennent que
l'URL publique de l'annonce et des compteurs.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import threading
import time
import unicodedata
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from pathlib import Path
from typing import Any

import httpx

from src.cadastre import geometry_centroid
from src.config import DEFAULT_USER_AGENT, ROOT_DIR

LOGGER = logging.getLogger(__name__)
API_URL = "https://apicarto.ign.fr/api/cadastre/parcelle"
PROVIDER = "ign_apicarto_cadastre"
RESOLUTION_VERSION = "cadastre_reference_v1"
MAX_PARCELS = 40
MAX_RANGE = 40
REQUEST_DELAY_SECONDS = 0.25
RETRY_BACKOFF_SECONDS = (1.0, 3.0)
CACHE_TTL = timedelta(days=30)
# Conservé entre deux exécutions GitHub Actions par le cache du workflow data-pipeline.
DEFAULT_CACHE_PATH = ROOT_DIR / "data" / "processed" / "cadastre_references" / "parcels.json"
_STOPWORDS = {"ET", "DE", "DU", "LA", "LE", "LES", "EN", "AU", "AUX", "DES", "SUR", "PAR", "AVEC", "DONT", "OU"}
_SECTION = r"(?:[A-Z]{1,2}|0[A-Z]|[A-Z]\d)"
_COMBINED = re.compile(rf"^(?P<prefix>\d{{3}})?(?P<section>{_SECTION})(?P<number>\d{{1,4}})$")
_SECTION_ONLY = re.compile(rf"^{_SECTION}$")
_LOCK = threading.Lock()
_FILE_LOCK = threading.Lock()
_MEMORY: dict[str, dict[str, Any] | None] = {}
_LAST_REQUEST = [0.0]
# Coupe-circuit : après quelques échecs consécutifs (API indisponible), plus aucune
# requête dans ce processus ; la localisation existante est conservée.
MAX_CONSECUTIVE_FAILURES = 3
_FAILURES = [0]


@dataclass(frozen=True, order=True)
class ParcelRef:
    section: str
    number: str
    prefix: str = "000"

    @property
    def api_section(self) -> str:
        return self.section if len(self.section) == 2 else f"0{self.section}"

    @property
    def api_number(self) -> str:
        return self.number.zfill(4)

    def label(self) -> str:
        return f"{self.section} {int(self.number)}"

    def key(self, insee: str) -> str:
        return f"{insee}{self.prefix}{self.api_section}{self.api_number}"


def parse_cadastral_references(value: object | None) -> list[ParcelRef]:
    """Parcelles citées dans une référence cadastrale libre (ordre conservé, sans doublon)."""
    text = str(value or "")
    if not text.strip():
        return []
    text = re.sub(r"\([^)]*\)", " ", text)
    text = re.split(r"\b(?:issue?s?\s+de|ex\b|pour\b|surface\b|soit\b|lots?\b|lieu[- ]?dit)", text, maxsplit=1, flags=re.I)[0]
    text = re.sub(r"\s+(?:à|a|au)\s+(?=\d)", " TO ", text)
    text = re.sub(r"n\s*[°º]|\bno\b|\bn\.", " ", text, flags=re.I)
    text = re.sub(r"\b(?:sections?|parcelles?|cadastr[ée]e?s?|cadastre|commune|feuille)\b", " ", text, flags=re.I)
    tokens = [token for token in re.split(r"[\s,;/+&.:\-–]+", text.upper()) if token and token not in _STOPWORDS]
    refs: list[ParcelRef] = []
    section: str | None = None
    prefix = "000"
    last_number: int | None = None
    for index, token in enumerate(tokens):
        following = tokens[index + 1] if index + 1 < len(tokens) else ""
        if token == "TO":
            continue
        combined = _COMBINED.match(token)
        if combined and not token.isdigit():
            prefix = combined.group("prefix") or (prefix if combined.group("section") == section else "000")
            section = combined.group("section")
            last_number = int(combined.group("number"))
            _append(refs, ParcelRef(section, str(last_number), prefix))
            continue
        if re.fullmatch(r"\d{3}", token) and _SECTION_ONLY.match(following) and (
            section is None or token == prefix or token == "000"
        ):
            prefix = token
            continue
        if _SECTION_ONLY.match(token):
            if token != section:
                prefix = prefix if section is None else "000"
            section = token
            last_number = None
            continue
        if re.fullmatch(r"\d{1,4}", token) and section:
            number = int(token)
            if index > 0 and tokens[index - 1] == "TO" and last_number is not None and 0 < number - last_number <= MAX_RANGE:
                for value_number in range(last_number + 1, number + 1):
                    _append(refs, ParcelRef(section, str(value_number), prefix))
            elif number > 0:
                _append(refs, ParcelRef(section, str(number), prefix))
            last_number = number
            continue
    return refs[:MAX_PARCELS]


def _append(refs: list[ParcelRef], ref: ParcelRef) -> None:
    if int(ref.number) > 0 and ref not in refs:
        refs.append(ref)


def designation(refs: Iterable[ParcelRef], city: str | None, *, limit: int = 4) -> str | None:
    """« Parcelle AR 236 à Dissay », « Parcelles AM 346, 349, 352… à Pessines »."""
    items = list(refs)
    if not items:
        return None
    parts: list[str] = []
    previous_section: str | None = None
    for ref in items[:limit]:
        parts.append(str(int(ref.number)) if ref.section == previous_section else ref.label())
        previous_section = ref.section
    text = ", ".join(parts) + ("…" if len(items) > limit else "")
    noun = "Parcelle" if len(items) == 1 else "Parcelles"
    return f"{noun} {text}" + (f" à {city}" if city else "")


def references_signature(insee: str | None, refs: Iterable[ParcelRef]) -> str:
    material = json.dumps([insee, [ref.key(insee or "") for ref in refs]], sort_keys=True)
    return hashlib.sha256(material.encode()).hexdigest()[:24]


def _cache_path() -> Path | None:
    raw = os.getenv("CADASTRE_REFERENCE_CACHE_PATH")
    if raw is None:
        return DEFAULT_CACHE_PATH
    return Path(raw.strip()) if raw.strip() else None


def _file_cache() -> dict[str, Any]:
    path = _cache_path()
    if path is None or not path.is_file():
        return {}
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return payload if isinstance(payload, dict) else {}


def _store_file_cache(updates: dict[str, Any]) -> None:
    path = _cache_path()
    if path is None or not updates:
        return
    with _FILE_LOCK:
        try:
            cache = _file_cache()
            cache.update(updates)
            path.parent.mkdir(parents=True, exist_ok=True)
            temporary = path.with_suffix(".tmp")
            temporary.write_text(json.dumps(cache, separators=(",", ":")), encoding="utf-8")
            temporary.replace(path)
        except OSError as exc:
            LOGGER.warning("Cadastre reference cache not written: %s", exc)


def _fresh(entry: Any) -> bool:
    if not isinstance(entry, dict):
        return False
    try:
        fetched = datetime.fromisoformat(str(entry.get("fetched_at")))
    except ValueError:
        return False
    return datetime.now(UTC) - fetched <= CACHE_TTL


def _polite_get(client: httpx.Client, params: list[tuple[str, str]]) -> dict[str, Any] | None:
    for attempt in range(len(RETRY_BACKOFF_SECONDS) + 1):
        with _LOCK:
            wait = REQUEST_DELAY_SECONDS - (time.monotonic() - _LAST_REQUEST[0])
            if wait > 0:
                time.sleep(wait)
            _LAST_REQUEST[0] = time.monotonic()
        try:
            response = client.get(API_URL, params=params)
        except httpx.HTTPError:
            response = None
        if response is not None and response.status_code == 200:
            payload = response.json()
            return payload if isinstance(payload, dict) else None
        if response is not None and 400 <= response.status_code < 500 and response.status_code != 429:
            return {"features": []}  # référence refusée par l'API (format) : introuvable, pas une panne
        if response is not None and response.status_code not in {429, 500, 502, 503, 504}:
            return None
        if attempt < len(RETRY_BACKOFF_SECONDS):
            time.sleep(RETRY_BACKOFF_SECONDS[attempt])
    return None


def fetch_parcels(
    insee: str,
    refs: list[ParcelRef],
    *,
    client: httpx.Client | None = None,
    timeout_seconds: float = 10.0,
    user_agent: str = DEFAULT_USER_AGENT,
) -> tuple[dict[str, dict[str, Any] | None], int]:
    """Entités GeoJSON des parcelles (clé IDU -> entité, ``None`` si introuvable) et nombre de requêtes."""
    results: dict[str, dict[str, Any] | None] = {}
    missing: dict[tuple[str, str], list[ParcelRef]] = {}
    file_cache = _file_cache()
    for ref in refs:
        key = ref.key(insee)
        if key in _MEMORY:
            results[key] = _MEMORY[key]
        elif _fresh(file_cache.get(key)):
            results[key] = file_cache[key].get("feature")
            _MEMORY[key] = results[key]
        else:
            missing.setdefault((ref.prefix, ref.api_section), []).append(ref)
    if not missing or _FAILURES[0] >= MAX_CONSECUTIVE_FAILURES:
        return results, 0
    owns_client = client is None
    http = client or httpx.Client(timeout=timeout_seconds, headers={"User-Agent": user_agent})
    requests = 0
    updates: dict[str, Any] = {}
    try:
        for (prefix, section), group in missing.items():
            for start in range(0, len(group), 10):
                chunk = group[start : start + 10]
                params = [("code_insee", insee), ("section", section), ("source_ign", "PCI")]
                if prefix != "000":
                    params.append(("com_abs", prefix))
                params.extend(("numero", ref.api_number) for ref in chunk)
                if _FAILURES[0] >= MAX_CONSECUTIVE_FAILURES:
                    break
                payload = _polite_get(http, params)
                requests += 1
                if payload is None:
                    _FAILURES[0] += 1
                    continue  # échec réseau : rien n'est mis en cache, la prochaine exécution réessaie
                _FAILURES[0] = 0
                found = {
                    str((feature.get("properties") or {}).get("idu")): feature
                    for feature in payload.get("features") or []
                    if isinstance(feature, dict)
                }
                for ref in chunk:
                    key = ref.key(insee)
                    feature = found.get(key)
                    results[key] = feature
                    _MEMORY[key] = feature
                    updates[key] = {"feature": feature, "fetched_at": datetime.now(UTC).isoformat()}
    finally:
        if owns_client:
            http.close()
    _store_file_cache(updates)
    return results, requests


def _contenance(feature: dict[str, Any] | None) -> int | None:
    try:
        value = int((feature or {}).get("properties", {}).get("contenance"))
    except (TypeError, ValueError):
        return None
    return value if value > 0 else None


def summarize(insee: str, refs: list[ParcelRef], features: dict[str, dict[str, Any] | None]) -> dict[str, Any]:
    """Résumé stockable (sans géométrie) : parcelles trouvées, surface et centroïde pondéré."""
    parcels: list[dict[str, Any]] = []
    weighted = [Decimal(0), Decimal(0), Decimal(0)]
    for ref in refs:
        feature = features.get(ref.key(insee))
        if not feature:
            parcels.append({"reference": ref.label(), "idu": ref.key(insee), "found": False})
            continue
        lng, lat = geometry_centroid(feature.get("geometry") or {})
        area = _contenance(feature)
        parcels.append({
            "reference": ref.label(),
            "idu": ref.key(insee),
            "found": True,
            "contenance_m2": area,
            **({"centroid": [lat, lng]} if lat is not None and lng is not None else {}),
        })
        if lat is not None and lng is not None:
            weight = Decimal(area or 1)
            weighted[0] += Decimal(str(lat)) * weight
            weighted[1] += Decimal(str(lng)) * weight
            weighted[2] += weight
    found = [parcel for parcel in parcels if parcel["found"]]
    summary: dict[str, Any] = {
        "parcels": parcels,
        "requested": len(refs),
        "resolved": len(found),
        "surface_m2": sum(parcel.get("contenance_m2") or 0 for parcel in found) or None,
    }
    if weighted[2] > 0:
        summary["latitude"] = float(round(weighted[0] / weighted[2], 7))
        summary["longitude"] = float(round(weighted[1] / weighted[2], 7))
    return summary


def choose_candidate(candidates: list[dict[str, Any]], published_surface: Decimal | None) -> dict[str, Any] | None:
    """Parmi plusieurs lectures des références, garde celle qui résout le plus de parcelles
    et dont la surface cadastrale est la plus proche de la surface publiée."""
    usable = [candidate for candidate in candidates if candidate.get("resolved")]
    if not usable:
        return None

    def score(candidate: dict[str, Any]) -> tuple[float, float]:
        ratio = candidate["resolved"] / max(1, candidate["requested"])
        surface = candidate.get("surface_m2")
        if published_surface and surface:
            distance = abs(float(surface) - float(published_surface)) / max(float(published_surface), 1.0)
        else:
            distance = 1.0
        return (-min(ratio, 1.0) + distance, distance)

    return min(usable, key=score)


def resolve_sale_cadastre(sale: Any, *, settings: dict[str, Any] | None = None, network: bool = True) -> bool:
    """Place la vente au centroïde de ses parcelles cadastrales ; ``True`` si appliqué.

    Lit ``raw_payload["cadastre_location"]`` (préparé sans réseau par l'extracteur
    de la source). Une résolution déjà stockée pour les mêmes références est
    réutilisée telle quelle ; sinon, si ``network`` est vrai, l'API est interrogée.
    """
    payload = sale.raw_payload if isinstance(getattr(sale, "raw_payload", None), dict) else None
    location = payload.get("cadastre_location") if payload else None
    if not isinstance(location, dict):
        return False
    signature = str(location.get("signature") or "")
    resolution = location.get("resolution")
    reusable = (
        isinstance(resolution, dict)
        and resolution.get("version") == RESOLUTION_VERSION
        and resolution.get("signature") == signature
        and resolution.get("status") in {"resolved", "unresolved"}
    )
    if not reusable:
        insee = str(location.get("insee_code") or "") or _citycode_from_geocode(
            payload, getattr(sale, "city", None), getattr(sale, "department", None)
        )
        candidates = [item for item in location.get("candidates") or [] if isinstance(item, dict)]
        if not network or not re.fullmatch(r"\d[\dAB]\d{3}", insee) or not candidates:
            return False
        if not location.get("insee_code"):
            location["insee_code"] = insee
            location["insee_source"] = "ban_citycode"
        try:
            resolution = _resolve(insee, candidates, location, settings or {})
        except Exception as exc:  # réseau ou réponse inattendue : la vente garde sa localisation
            LOGGER.warning("Cadastre reference resolution failed for %s: %s", getattr(sale, "source_url", None), exc)
            return False
        if resolution is None:
            return False
        resolution["signature"] = signature
        location["resolution"] = resolution
    if not isinstance(resolution, dict) or resolution.get("status") != "resolved" or resolution.get("latitude") is None:
        return False
    latitude = Decimal(str(resolution["latitude"]))
    longitude = Decimal(str(resolution["longitude"]))
    sale.latitude = latitude
    sale.longitude = longitude
    previous = payload.get("geocode")
    if isinstance(previous, dict) and previous.get("provider") == "ban_geoplateforme" and previous.get("accepted"):
        payload["geocode_ban"] = previous
    payload["geo_precision"] = "parcel"
    payload["geocode"] = {
        "provider": PROVIDER,
        "accepted": True,
        "type": "parcel",
        "label": location.get("designation"),
        "citycode": location.get("insee_code"),
        "latitude": float(latitude),
        "longitude": float(longitude),
        "parcels_resolved": resolution.get("resolved"),
        "parcels_requested": resolution.get("requested"),
        "attempted_at": resolution.get("resolved_at"),
    }
    payload.pop("location_inferred_from_city", None)
    return True


def _fold_city(value: object) -> str:
    text = unicodedata.normalize("NFKD", str(value or "")).encode("ascii", "ignore").decode("ascii").lower()
    return re.sub(r"[^a-z0-9]+", " ", text).strip()


def _citycode_from_geocode(payload: dict[str, Any], city: object, department: object) -> str:
    """Code commune d'un géocodage BAN accepté pour la même commune et le même département.

    Sert aux fiches anciennes qui ne publient pas de code INSEE. Le nom seul ne
    suffit pas (Saint-André existe dans plusieurs départements).
    """
    wanted = _fold_city(city)
    department_code = str(department or "").strip().upper()
    if not wanted or not department_code:
        return ""
    for key in ("geocode", "geocode_ban"):
        evidence = payload.get(key)
        if not (
            isinstance(evidence, dict)
            and evidence.get("provider") == "ban_geoplateforme"
            and evidence.get("accepted") is True
            and _fold_city(evidence.get("city")) == wanted
        ):
            continue
        citycode = str(evidence.get("citycode") or "").upper()
        if citycode[:3 if citycode.startswith("97") else 2] == department_code.zfill(2):
            return citycode
    return ""


def _resolve(
    insee: str, candidates: list[dict[str, Any]], location: dict[str, Any], settings: dict[str, Any]
) -> dict[str, Any] | None:
    published = location.get("published_surface_m2")
    published_surface = Decimal(str(published)) if published not in (None, "") else None
    summaries: list[dict[str, Any]] = []
    total_requests = 0
    complete = True
    for candidate in candidates:
        refs = [ref for ref in (ref_from_label(label) for label in candidate.get("parcels") or []) if ref]
        if not refs:
            continue
        features, requests = fetch_parcels(
            insee,
            refs,
            timeout_seconds=float(settings.get("cadastre_timeout_seconds") or 10),
            user_agent=str(settings.get("user_agent") or DEFAULT_USER_AGENT),
        )
        total_requests += requests
        if any(ref.key(insee) not in features for ref in refs):
            complete = False
        summary = summarize(insee, refs, features)
        summary["source_label"] = candidate.get("source_label")
        summaries.append(summary)
    chosen = choose_candidate(summaries, published_surface)
    if chosen is None and not complete:
        return None  # l'API n'a pas répondu : on réessaiera, rien n'est figé
    now = datetime.now(UTC).isoformat()
    if chosen is None:
        return {"version": RESOLUTION_VERSION, "status": "unresolved", "resolved": 0,
                "requested": sum(item["requested"] for item in summaries), "resolved_at": now}
    return {
        "version": RESOLUTION_VERSION,
        "status": "resolved",
        "resolved_at": now,
        "source_label": chosen.get("source_label"),
        "requested": chosen["requested"],
        "resolved": chosen["resolved"],
        "surface_m2": chosen.get("surface_m2"),
        "latitude": chosen.get("latitude"),
        "longitude": chosen.get("longitude"),
        "parcels": chosen["parcels"],
        "requests": total_requests,
    }


def ref_label(ref: ParcelRef) -> str:
    """Forme stockée d'une parcelle (« AM 346 » ou « 826 AE 188 »), relue par :func:`ref_from_label`."""
    return ref.label() if ref.prefix == "000" else f"{ref.prefix} {ref.label()}"


def ref_from_label(value: object) -> ParcelRef | None:
    match = re.fullmatch(r"(?:(\d{3}) )?([A-Z0-9]{1,2}) (\d{1,4})", str(value or ""))
    if not match:
        return None
    return ParcelRef(match.group(2), str(int(match.group(3))), match.group(1) or "000")


def source_reference_features(sale: Any) -> list[dict[str, Any]]:
    """Entités GeoJSON des parcelles retenues (cache mémoire de l'exécution, sans requête)."""
    payload = sale.raw_payload if isinstance(getattr(sale, "raw_payload", None), dict) else {}
    location = payload.get("cadastre_location")
    resolution = location.get("resolution") if isinstance(location, dict) else None
    if not isinstance(resolution, dict) or resolution.get("status") != "resolved":
        return []
    features: list[dict[str, Any]] = []
    for parcel in resolution.get("parcels") or []:
        feature = _MEMORY.get(str(parcel.get("idu"))) if isinstance(parcel, dict) else None
        if feature:
            features.append(feature)
    return features
