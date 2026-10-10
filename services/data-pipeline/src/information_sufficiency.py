"""Règle de rétention « informations suffisantes » (fonction pure ``sufficient_information``).

Règle du propriétaire : une vente dont on ne sait obtenir ni l'adresse ni la
superficie n'a d'intérêt que si l'agent IA d'information peut interroger un
interlocuteur par e-mail. Donc :

* CONSERVÉE si (adresse exploitable ET superficie) OU un e-mail exploitable existe ;
* NON CONSERVÉE si (adresse exploitable manquante OU superficie manquante) ET
  aucun e-mail exploitable.

Définitions (voir ``docs/audits/2026-10-10-extraction-par-source.md``) :

* **adresse exploitable** = une commune ou un code postal ET une désignation du
  bien : voie, lieu-dit ou parcelle cadastrale. Une commune seule n'est pas
  exploitable (réglage ``IMMOJUDIS_SUFFICIENCY_MIN_ADDRESS=commune`` pour
  l'accepter) ;
* **superficie** = surface bâtie/habitable/Carrez connue ; pour un terrain la
  surface du terrain compte ; un parking/garage n'a pas besoin de superficie ;
* **e-mail exploitable** = une adresse que le résolveur de l'agent
  (``discoverInformationAgentContacts`` dans ``src/lib/information-agent.ts``)
  trouve dans la vente, et qui n'est pas refusée (opposition, rebond permanent).
  Le résolveur n'existe qu'en TypeScript : ce module en est un MIROIR, gardé
  identique par les cas partagés de ``tests/fixtures/information_agent_contact_cases.json``,
  exécutés des deux côtés (pytest et vitest). Toute évolution du résolveur doit
  mettre à jour ces cas.
* **exemptions** : statut terminé (past/adjudicated/cancelled/withdrawn) ou en
  quarantaine : ces lignes servent aux statistiques / à la revue, elles ne sont
  jamais jugées sur la complétude.

Aucune donnée personnelle n'est journalisée : seuls des codes et des compteurs.
"""

from __future__ import annotations

import logging
import os
import re
from collections import Counter
from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field
from decimal import Decimal, InvalidOperation
from typing import Any

from src.listing_location import classify_address, extract_designation
from src.models import AuctionSale

LOGGER = logging.getLogger(__name__)

GATE_ENV = "IMMOJUDIS_INFORMATION_SUFFICIENCY_GATE"
MIN_ADDRESS_ENV = "IMMOJUDIS_SUFFICIENCY_MIN_ADDRESS"

#: Statuts pour lesquels une vente n'est pas jugée (statistiques / revue).
EXEMPT_STATUSES = frozenset({"past", "adjudicated", "cancelled", "withdrawn", "quarantined"})
#: Types de bien sans superficie requise (lots annexes).
SURFACE_OPTIONAL_TYPES = frozenset({"parking"})
#: Types pour lesquels la surface du terrain vaut superficie.
LAND_SURFACE_TYPES = frozenset({"land", "mixed", "other", "unknown"})
#: Sources dont le texte libre est propre au bien (pas de bloc avocat / tribunal / bandeau d'actualités).
PROPERTY_SCOPED_TEXT_SOURCES = frozenset(
    {"cessions_etat", "avoventes", "licitor", "notaires", "agrasc", "encheres_publiques", "info_encheres"}
)
EXPLOITABLE_ADDRESS_LEVELS = frozenset({"street", "lieu_dit", "parcel"})

REASON_MISSING_ADDRESS = "missing_address"
REASON_MISSING_SURFACE = "missing_surface"

# --------------------------------------------------------------------------
# Miroir du résolveur de contacts de l'agent (src/lib/information-agent.ts)
# --------------------------------------------------------------------------
# extractEmails : /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi puis
# normalizedEmail : trim + lowerCase + z.string().email() (zod 3.25).
_EXTRACT_EMAIL_RE = re.compile(r"[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}", re.IGNORECASE | re.ASCII)
_ZOD_EMAIL_RE = re.compile(
    r"(?!\.)(?!.*\.\.)([A-Z0-9_'+\-.]*)[A-Z0-9_+-]@([A-Z0-9][A-Z0-9\-]*\.)+[A-Z]{2,}",
    re.IGNORECASE | re.ASCII,
)


def normalized_email(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    candidate = value.strip().lower()
    return candidate if _ZOD_EMAIL_RE.fullmatch(candidate) else None


def extract_emails(value: object) -> set[str]:
    if not isinstance(value, str):
        return set()
    return {email for email in map(normalized_email, _EXTRACT_EMAIL_RE.findall(value)) if email}


def _string_leaves(value: object) -> Iterable[str]:
    """Chaînes lues par ``collectSourceBlockContacts``.

    Comme le résolveur TypeScript, seules comptent les chaînes qui sont la
    valeur d'une clé d'objet : une chaîne directement contenue dans un tableau
    est ignorée, un objet contenu dans un tableau est parcouru.
    """
    if isinstance(value, Mapping):
        for child in value.values():
            if isinstance(child, str):
                yield child
            else:
                yield from _string_leaves(child)
    elif isinstance(value, list):
        for child in value:
            if not isinstance(child, str):
                yield from _string_leaves(child)


def contact_emails(sale: AuctionSale) -> set[str]:
    """Adresses que ``discoverInformationAgentContacts`` trouverait pour cette vente.

    Même périmètre que le module TypeScript : ``lawyer_contact``, les blocs
    ``source_blocks`` de la vente et de chaque observation, la description
    source (``raw_payload.source_description``) et la description.
    """
    payload = sale.raw_payload if isinstance(sale.raw_payload, dict) else {}
    texts: list[object] = [sale.lawyer_contact, payload.get("source_description"), sale.description]
    primary_blocks = payload.get("source_blocks")
    if isinstance(primary_blocks, dict):
        texts.extend(_string_leaves(primary_blocks))
    for observation in sale.observations or []:
        observation_payload = observation.get("raw_payload") if isinstance(observation, dict) else None
        blocks = observation_payload.get("source_blocks") if isinstance(observation_payload, dict) else None
        if isinstance(blocks, dict):
            texts.extend(_string_leaves(blocks))
    emails: set[str] = set()
    for text in texts:
        emails |= extract_emails(text)
    return emails


@dataclass(frozen=True)
class ContactBlocklist:
    """Registre de refus (``information_agent_contacts``) : opposition ou rebond permanent.

    ``global_emails`` s'applique à toutes les ventes (scope_sale_id nul) ;
    ``by_sale`` ne s'applique qu'à la vente indiquée, comme
    ``isInformationAgentContactBlocked``.
    """

    global_emails: frozenset[str] = frozenset()
    by_sale: Mapping[str, frozenset[str]] = field(default_factory=dict)

    def blocks(self, email: str, sale_id: str | None) -> bool:
        if email in self.global_emails:
            return True
        return bool(sale_id and email in self.by_sale.get(str(sale_id), frozenset()))


NO_BLOCKLIST = ContactBlocklist()


def usable_contact_emails(sale: AuctionSale, blocklist: ContactBlocklist = NO_BLOCKLIST) -> set[str]:
    return {email for email in contact_emails(sale) if not blocklist.blocks(email, sale.id)}


# --------------------------------------------------------------------------
# Adresse et superficie
# --------------------------------------------------------------------------
def _positive(value: object) -> bool:
    if value is None:
        return False
    try:
        number = Decimal(str(value))
    except (InvalidOperation, ValueError):
        return False
    return number.is_finite() and number > 0


def has_surface(sale: AuctionSale) -> bool:
    """Superficie connue (voir les exemptions du module)."""
    if any(_positive(getattr(sale, name, None)) for name in
           ("surface_m2", "habitable_surface_m2", "carrez_surface_m2", "app_surface_m2")):
        return True
    property_type = (sale.property_type or "unknown").lower()
    return property_type in LAND_SURFACE_TYPES and _positive(sale.land_surface_m2)


def _surface_required(sale: AuctionSale) -> bool:
    return (sale.property_type or "").lower() not in SURFACE_OPTIONAL_TYPES


def _commune_context(sale: AuctionSale) -> bool:
    return bool((sale.city or "").strip() or (sale.postal_code or "").strip())


def _property_texts(sale: AuctionSale) -> list[str]:
    payload = sale.raw_payload if isinstance(sale.raw_payload, dict) else {}
    blocks = payload.get("source_blocks") if isinstance(payload.get("source_blocks"), dict) else {}
    values = [sale.title, sale.description, blocks.get("description"), blocks.get("titre_detail")]
    return [value for value in values if isinstance(value, str) and value.strip()]


def address_level(sale: AuctionSale) -> tuple[str | None, str | None]:
    """(niveau, origine) de la meilleure localisation lisible du bien.

    Niveaux : ``street``, ``lieu_dit``, ``parcel``, ``commune``, ``None``.
    L'origine est une étiquette technique (``address``, ``cadastral_reference``,
    ``description``), jamais le texte lui-même.
    """
    level = classify_address(sale.address)
    if level in EXPLOITABLE_ADDRESS_LEVELS and _commune_context(sale):
        return level, "address"
    payload = sale.raw_payload if isinstance(sale.raw_payload, dict) else {}
    blocks = payload.get("source_blocks") if isinstance(payload.get("source_blocks"), dict) else {}
    if _commune_context(sale):
        for key in ("reference_cadastrale", "references_cadastrales"):
            if classify_address(str(blocks.get(key) or "")) == "parcel":
                return "parcel", "cadastral_reference"
        source = (sale.primary_source or sale.source_name or "").lower()
        if source in PROPERTY_SCOPED_TEXT_SOURCES:
            for text in _property_texts(sale):
                designation = extract_designation(text)
                if designation:
                    return designation, "description"
    if level == "commune" or _commune_context(sale):
        return "commune", "address" if level else "city_or_postal_code"
    return None, None


def _min_address_levels() -> frozenset[str]:
    configured = (os.getenv(MIN_ADDRESS_ENV) or "street").strip().lower()
    if configured == "commune":
        return EXPLOITABLE_ADDRESS_LEVELS | {"commune"}
    return EXPLOITABLE_ADDRESS_LEVELS


# --------------------------------------------------------------------------
# Verdict
# --------------------------------------------------------------------------
@dataclass(frozen=True)
class SufficiencyVerdict:
    sufficient: bool
    reasons: tuple[str, ...] = ()
    address_level: str | None = None
    address_basis: str | None = None
    has_surface: bool = False
    contact_count: int = 0
    exemption: str | None = None

    @property
    def reason_code(self) -> str:
        """Motif court pour le journal et le résumé de run (sans donnée personnelle)."""
        return "insufficient_information:" + "+".join(self.reasons) if self.reasons else ""


def sufficient_information(
    sale: AuctionSale,
    *,
    blocklist: ContactBlocklist = NO_BLOCKLIST,
    accepted_address_levels: frozenset[str] | None = None,
) -> SufficiencyVerdict:
    """Applique la règle de rétention à une vente normalisée (pure, sans accès base)."""
    status = (sale.status or "").lower()
    level, basis = address_level(sale)
    surface = has_surface(sale)
    emails = usable_contact_emails(sale, blocklist)
    if status in EXEMPT_STATUSES:
        return SufficiencyVerdict(True, (), level, basis, surface, len(emails), exemption=f"status:{status}")
    accepted = accepted_address_levels or _min_address_levels()
    address_ok = level in accepted
    surface_ok = surface or not _surface_required(sale)
    if (address_ok and surface_ok) or emails:
        return SufficiencyVerdict(True, (), level, basis, surface, len(emails))
    reasons = tuple(
        reason
        for reason, missing in ((REASON_MISSING_ADDRESS, not address_ok), (REASON_MISSING_SURFACE, not surface_ok))
        if missing
    )
    return SufficiencyVerdict(False, reasons, level, basis, surface, 0)


def gate_enabled() -> bool:
    return (os.getenv(GATE_ENV) or "on").strip().lower() not in {"off", "0", "false", "no"}


_ACTIVE_BLOCKLIST: ContactBlocklist = NO_BLOCKLIST


def set_active_blocklist(blocklist: ContactBlocklist) -> None:
    """Registre de refus chargé une fois par run (``_open_run``) et lu par la porte de publication."""
    global _ACTIVE_BLOCKLIST
    _ACTIVE_BLOCKLIST = blocklist


def publication_gate(sale: AuctionSale, *, blocklist: ContactBlocklist | None = None) -> SufficiencyVerdict:
    """Verdict utilisé à la publication ; toujours suffisant si le garde-fou est coupé."""
    if not gate_enabled():
        return SufficiencyVerdict(True, exemption="gate_disabled")
    return sufficient_information(sale, blocklist=_ACTIVE_BLOCKLIST if blocklist is None else blocklist)


def summarize_verdicts(verdicts: Iterable[tuple[str, SufficiencyVerdict]]) -> dict[str, Any]:
    """Compteurs par motif et par source, pour le résumé du run (aucune donnée personnelle)."""
    by_reason: Counter[str] = Counter()
    by_source: Counter[str] = Counter()
    total = 0
    for source, verdict in verdicts:
        if verdict.sufficient:
            continue
        total += 1
        by_reason[verdict.reason_code] += 1
        by_source[source or "unknown"] += 1
    return {"total": total, "by_reason": dict(by_reason), "by_source": dict(by_source)}


# --------------------------------------------------------------------------
# Registre de refus
# --------------------------------------------------------------------------
def build_blocklist(rows: Iterable[Mapping[str, Any]]) -> ContactBlocklist:
    """Construit la liste de refus depuis des lignes ``information_agent_contacts``."""
    global_emails: set[str] = set()
    by_sale: dict[str, set[str]] = {}
    for row in rows:
        if row.get("opposition_status") != "opposed" and row.get("bounce_status") != "permanent":
            continue
        email = normalized_email(row.get("normalized_email") or row.get("email"))
        if not email:
            continue
        scope = row.get("scope_sale_id")
        if scope is None:
            global_emails.add(email)
        else:
            by_sale.setdefault(str(scope), set()).add(email)
    return ContactBlocklist(frozenset(global_emails), {key: frozenset(value) for key, value in by_sale.items()})


def load_contact_blocklist(settings: Mapping[str, Any]) -> ContactBlocklist:
    """Lit le registre de refus ; en cas d'erreur renvoie une liste vide (échec ouvert).

    L'agent échoue « fermé » (aucun contact sans registre) car il ÉCRIT à des
    tiers. Ici la décision est de NE PAS publier / supprimer : une panne du
    registre ne doit jamais faire perdre des ventes, d'où l'échec ouvert.
    """
    import httpx

    url = str(settings.get("supabase_url") or "").rstrip("/")
    key = str(settings.get("supabase_service_role_key") or "")
    if not url or not key:
        return NO_BLOCKLIST
    try:
        response = httpx.get(
            f"{url}/rest/v1/information_agent_contacts",
            params={
                "select": "normalized_email,scope_sale_id,opposition_status,bounce_status",
                "or": "(opposition_status.eq.opposed,bounce_status.eq.permanent)",
                "limit": "10000",
            },
            headers={"apikey": key, "Authorization": f"Bearer {key}", "Accept": "application/json"},
            timeout=30,
        )
        response.raise_for_status()
        rows = response.json()
        return build_blocklist(rows if isinstance(rows, list) else [])
    except Exception as exc:  # noqa: BLE001 - échec ouvert volontaire, voir docstring
        LOGGER.warning("Contact refusal registry unavailable; treating it as empty (%s)", type(exc).__name__)
        return NO_BLOCKLIST
