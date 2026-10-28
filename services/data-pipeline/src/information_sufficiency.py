"""Résolveur d'adresses email de l'agent d'information, registre de refus et porte « minimum d'une annonce ».

La règle de minimum n'est écrite qu'à UN endroit : ``src/listing_minimum.py`` (règle du propriétaire, 28/10/2026 :
voie ou lieu-dit, OU adresse email de contact, OU pièce, OU autre source). Ce module la sert au reste du pipeline :

* ``sufficient_information`` applique la règle à une vente (sans accès base) ; l'ancienne règle du 12/10/2026
  (adresse OU superficie OU email OU téléphone, la commune suffisant) est retirée : la superficie, la commune seule
  et le téléphone ne comptent plus ;
* ``publication_gate`` y ajoute l'interrupteur d'urgence ``IMMOJUDIS_INFORMATION_SUFFICIENCY_GATE`` et le registre
  de refus de l'agent ; elle est appelée à l'écriture de la vente, là où l'on sait si elle se rattache à une ligne
  existante (``publication_identity.resolve_publication_identities``), pas à l'admission.

Ce qui reste ici est le MIROIR du résolveur de contacts de l'agent (``discoverInformationAgentContacts`` dans
``src/lib/information-agent.ts``) : un contact ne compte que s'il est une adresse email que l'agent peut solliciter,
car l'agent ne travaille que par email.

* **e-mail exploitable** = une adresse que le résolveur de l'agent trouve dans la vente, et qui n'est pas refusée
  (opposition, rebond permanent). Le résolveur n'existe qu'en TypeScript : ce module en est un MIROIR, gardé
  identique par les cas partagés de ``tests/fixtures/information_agent_contact_cases.json``, exécutés des deux côtés
  (pytest et vitest). Toute évolution du résolveur doit mettre à jour ces cas.

Aucune donnée personnelle n'est journalisée : seuls des codes et des compteurs.
"""

from __future__ import annotations

import logging
import os
import re
from collections import Counter
from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field
from typing import Any

from src.models import AuctionSale

LOGGER = logging.getLogger(__name__)

GATE_ENV = "IMMOJUDIS_INFORMATION_SUFFICIENCY_GATE"

# --------------------------------------------------------------------------
# Miroir du résolveur de contacts de l'agent (src/lib/information-agent.ts)
# --------------------------------------------------------------------------
# extractEmails : findEmailsInText (src/lib/information-agent/email-in-text.ts) puis
# normalizedEmail : trim + lowerCase + z.string().email() (zod 3.25).
# Le motif est sensible à la casse, comme le TypeScript : le texte collecté colle souvent le mot suivant à
# l'adresse (« maitre@x.frTél »), et une extension insensible à la casse absorberait sa majuscule (« …frT ») :
# - extension en minuscules (ou capitalisée) : elle s'arrête au premier caractère qui ne peut pas la
#   prolonger (majuscule, chiffre, point, barre) ;
# - extension en capitales : elle n'emporte jamais la capitale d'un mot capitalisé (« FRTél » donne « FR ») ;
#   ``(?![a-z…])`` est l'équivalent Python du ``(?!\p{Ll})`` du TypeScript (minuscules latines, accentuées
#   comprises, que ``re`` ne sait pas désigner par propriété Unicode) ;
# - au plus 24 lettres (``.immobilier``, ``.notaires`` passent) ; une suite plus longue n'est pas une adresse.
_EXTRACT_EMAIL_RE = re.compile(
    r"[A-Za-z0-9._%+-]+@(?:[A-Za-z0-9-]+\.)+(?:[A-Z]{2,24}(?![a-zß-öø-ÿœ])|[A-Za-z][a-z]{1,23}(?![a-z]))"
)
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
    source (``raw_payload.source_description``) et la description. Les adresses internes de la vente
    (``internal_contacts``, décodées de Licitor, conservées dans le registre) ne comptent pas : le
    miroir TypeScript ne les voit pas dans la vente publiée, et le verdict reste stable d'un run à
    l'autre (avant ce décodage ces ventes n'avaient pas d'e-mail non plus).
    """
    emails: set[str] = set()
    for text in _contact_texts(sale):
        emails |= extract_emails(text)
    return {email for email in emails if excluded_contact_reason(email) is None}


def _contact_texts(sale: AuctionSale) -> list[object]:
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
    return texts


_COURT_REGISTRY_DOMAIN_RE = re.compile(r"(?:^|\.)justice\.(?:fr|gouv\.fr)$")
_RPVA_DOMAIN_RE = re.compile(r"(?:^|\.)avocat-conseil\.fr$")
_BAR_OR_CARPA_DOMAIN_RE = re.compile(
    r"^(?:www\.)?(?:(?:ordre|barreau|batonnat|batonnier|carpa)(?:[.-]|$)|ordredesavocats)"
)
_BAR_OR_CARPA_LOCAL_RE = re.compile(r"^(?:ordre|barreau|batonnat|batonnier|carpa)(?:[._+-]|$)")
_TECHNICAL_LOCAL_RE = re.compile(r"^(?:no[._-]?reply|do[._-]?not[._-]?reply|dpo|rgpd)(?:[._+-]|$)")


def excluded_contact_reason(email: str) -> str | None:
    """Raison pour laquelle l'agent ne sollicite jamais cette adresse, ou ``None``.

    Miroir de ``informationAgentExcludedAddressReason``
    (``src/lib/information-agent/excluded-addresses.ts``) : juridictions (``court``),
    messagerie RPVA ``@avocat-conseil.fr`` (``rpva``), Ordre, barreau et CARPA
    (``bar_or_carpa``), adresses ``noreply``, ``dpo`` et ``rgpd`` (``technical``).
    """
    normalized = email.strip().lower()
    local, separator, domain = normalized.rpartition("@")
    if not separator:
        local, domain = normalized, ""
    if _COURT_REGISTRY_DOMAIN_RE.search(domain):
        return "court"
    if _RPVA_DOMAIN_RE.search(domain):
        return "rpva"
    if _BAR_OR_CARPA_DOMAIN_RE.search(domain) or _BAR_OR_CARPA_LOCAL_RE.search(local):
        return "bar_or_carpa"
    if _TECHNICAL_LOCAL_RE.search(local):
        return "technical"
    return None


def is_court_registry_email(email: str) -> bool:
    """Adresse d'une juridiction (greffe, accueil du tribunal), jamais sollicitée par l'agent.

    Miroir de ``isCourtRegistryEmail`` (``src/lib/information-agent/excluded-addresses.ts``).
    """
    return excluded_contact_reason(email) == "court"


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
# Verdict : la règle est celle de src/listing_minimum.py
# --------------------------------------------------------------------------
@dataclass(frozen=True)
class SufficiencyVerdict:
    sufficient: bool
    #: Preuves trouvées (``street``, ``email``, ``documents``, ``other_source``) ; vide : refusée.
    basis: tuple[str, ...] = ()
    #: Code du refus (``insufficient_listing`` ou ``detail_unread``), ``None`` si suffisante.
    reason: str | None = None
    #: Interrupteur coupé : aucune règle appliquée.
    exemption: str | None = None

    @property
    def reasons(self) -> tuple[str, ...]:
        return (self.reason,) if self.reason else ()

    @property
    def reason_code(self) -> str:
        """Motif court pour le journal et le résumé de run (sans donnée personnelle)."""
        return self.reason or ""


def sufficient_information(
    sale: AuctionSale,
    *,
    blocklist: ContactBlocklist = NO_BLOCKLIST,
) -> SufficiencyVerdict:
    """Applique la règle de minimum à une vente normalisée (pure, sans accès base)."""
    from src.listing_minimum import assess  # import tardif : listing_minimum lit ce module

    verdict = assess(sale, blocklist=blocklist)
    return SufficiencyVerdict(verdict.ok, verdict.basis, verdict.reason)


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


def active_blocklist() -> ContactBlocklist:
    return _ACTIVE_BLOCKLIST


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
