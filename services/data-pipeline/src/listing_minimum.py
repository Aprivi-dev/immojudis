"""Minimum d'une annonce pour entrer en base (règle du propriétaire, 28/10/2026).

Une annonce qui n'a NI adresse de voie ou de lieu-dit, NI email de contact, NI pièce, NI autre source
n'apporte rien : elle n'est pas écrite. Les fonctions de ce module sont pures (aucun réseau, aucune base) ;
``assess`` lit une vente normalisée, après l'extraction de sa page de détail.

Cinq preuves, une seule suffit (``ListingMinimum.basis``) :

* ``street`` : une voie ou un lieu-dit dans ``address``. La voie est celle du géocodage
  (``position_quality.street_name_tokens(..., require_street_type=True)``), le lieu-dit celui de
  ``listing_location.classify_address``. Une commune seule (« 75006 PARIS ») ne suffit pas, pas plus qu'un
  nom de commune qui ressemble à un lieu-dit (« 02400 CHÂTEAU-THIERRY ») : la commune est retirée avant lecture ;
* ``email`` : une adresse email de contact (avocat, cabinet, notaire ou étude) dans ``lawyer_contact`` ou dans un bloc
  source de contact (clé contenant avocat, contact, mail, notaire, gestionnaire, étude ou cabinet). L'agent d'information ne travaille que par email : un nom d'avocat seul
  ou un téléphone seul ne suffit pas. Même lecture et mêmes exclusions que l'agent
  (``information_sufficiency.extract_emails`` et ``excluded_contact_reason`` : juridiction, RPVA, Ordre, CARPA,
  adresses techniques ne comptent pas) ;
* ``cadastre`` : une ou plusieurs parcelles lisibles (``cadastre_location`` de la fiche ou de
  ``source_property_features``, sous les trois formes que les sources écrivent ; référence cadastrale publiée dans un
  bloc source, comme celles de ``cessions_etat`` et des notaires ; adresse qui EST une référence cadastrale) : la
  vente est localisable à la parcelle. En base, les parcelles trouvées (``auction_cadastre_parcels``) comptent aussi
  (règle SQL) ;
* ``documents`` : au moins une pièce (``documents``) ;
* ``other_source`` : la vente est rattachée à une autre source (au moins deux hôtes parmi ses URL, ou deux sources
  dans ses observations). Le rattachement à une vente DÉJÀ EN BASE ne se lit pas ici : il se décide à
  l'écriture, dans la transaction de publication, par ``publication_identity.resolve_publication_identities``
  (voir ``refuse``).

C'est LA règle de minimum du pipeline : ``information_sufficiency.sufficient_information`` / ``publication_gate``
(interrupteur d'urgence, registre de refus de l'agent) n'en sont que l'accès, et plus aucune autre règle
(superficie, commune seule, téléphone) ne subsiste.

Où la règle s'applique, et pourquoi là : à l'écriture de la vente (``resolve_publication_identities``), pas à
l'admission ni à la collecte. Le collecteur continue de remonter et d'enregistrer toutes les annonces découvertes
(``auction_collection_items``) : l'inventaire complet d'une source, son ratio de fraîcheur et la base de
comparaison de l'alerte ``pipeline.source.<source>.drop`` (qui compte toutes les décisions du run) ne changent
pas. Une annonce refusée reçoit la décision ``excluded`` (motif ``insufficient_listing``), qui ne bloque ni la
publication complète ni ne compte comme un échec.

Une annonce DÉJÀ EN BASE (même URL, ou rattachée à une vente existante) n'est jamais refusée : si elle perd son
minimum (email retiré de la fiche, par exemple), elle reste, continue de se rafraîchir et n'est pas supprimée.
Seule la réparation ``supabase/repairs/20261108202100_delete_empty_listings.sql`` nettoie l'existant, une fois.

Limite connue : une annonce sans voie (Vench, Petites Affiches) dont la vente jumelle (Licitor...) est déjà en base
n'est pas rattachée à l'écriture (la correspondance « sans voie » de ``dedupe_streetless`` exige de charger et de
verrouiller les ventes du même jour, ce que la requête de ``resolve_publication_identities`` ne fait pas) : elle est
refusée, puis rattachée par le balayage de dédoublonnage quand les deux lignes sont en base. Ce balayage (rapport
``candidates``, puis application) passe AVANT la réparation des annonces vides.

Une annonce dont la page de détail n'a pas pu être lue (échec réseau) n'est pas jugée : elle n'est pas écrite
non plus (``detail_unread``) et se relit au passage suivant. Elle est comptée à part.

Aucune donnée personnelle n'est journalisée : la source, l'URL publique de l'annonce et un code.
"""

from __future__ import annotations

import logging
import re
from collections import Counter
from collections.abc import Iterable, Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
from threading import Lock
from typing import Any
from urllib.parse import urlsplit

from src.information_sufficiency import (
    ContactBlocklist,
    active_blocklist,
    excluded_contact_reason,
    extract_emails,
)
from src.information_sufficiency import _string_leaves as string_leaves
from src.listing_location import _is_named_place_before_commune as is_named_place_before_commune
from src.listing_location import classify_address
from src.models import AuctionSale
from src.position_quality import street_name_tokens
from src.rejected_listings import is_skipped
from src.source_withdrawal import sale_source_names

LOGGER = logging.getLogger(__name__)

#: Motif enregistré avec la décision ``excluded`` (code, jamais une donnée de la vente).
REASON = "insufficient_listing"
#: Annonce dont la page de détail n'a pas été lue : ni jugée ni écrite, relue au passage suivant.
REASON_DETAIL_UNREAD = "detail_unread"
#: Annonce déjà refusée depuis moins de 7 jours dont la fiche n'a pas été relue (src/rejected_listings.py).
REASON_SKIPPED = "skipped_recently_rejected"
#: Nombre d'URL d'exemple gardées par source dans le résumé du passage et dans les journaux.
EXAMPLES_PER_SOURCE = 5

BASIS_STREET = "street"
BASIS_EMAIL = "email"
BASIS_CADASTRE = "cadastre"
BASIS_DOCUMENTS = "documents"
BASIS_OTHER_SOURCE = "other_source"

_EXPLOITABLE_LEVELS = frozenset({"street", "lieu_dit"})


@dataclass(frozen=True)
class ListingMinimum:
    """Verdict de la règle : les preuves trouvées, ou ``detail_unread`` quand la fiche n'a pas été lue."""

    basis: tuple[str, ...] = ()
    detail_unread: bool = False

    @property
    def ok(self) -> bool:
        return bool(self.basis)

    @property
    def reason(self) -> str | None:
        if self.ok:
            return None
        return REASON_DETAIL_UNREAD if self.detail_unread else REASON


# --------------------------------------------------------------------------
# Les quatre preuves
# --------------------------------------------------------------------------
def _remove_commune(address: str, city: str | None) -> str:
    """Adresse sans le nom de la commune (« 02400 CHÂTEAU-THIERRY » ne contient plus de mot-clé de lieu-dit)."""
    name = (city or "").strip()
    if len(name) < 2:
        return address
    return re.sub(rf"(?<![\w]){re.escape(name)}(?![\w])", " ", address, flags=re.IGNORECASE)


def has_street_or_lieu_dit(address: str | None, city: str | None = None) -> bool:
    """Vrai si ``address`` désigne une voie ou un lieu-dit (jamais la seule commune)."""
    text = (address or "").strip()
    if not text:
        return False
    if street_name_tokens(text, require_street_type=True) is not None:
        return True
    # Lu AVANT le retrait de la commune : « Le Prieuré, Sossais » sans la commune n'a plus de partie après la virgule.
    if is_named_place_before_commune(text, city):
        return True
    return classify_address(_remove_commune(text, city), city) in _EXPLOITABLE_LEVELS


#: Blocs source qui portent le contact du professionnel de la vente (avocat, cabinet, notaire, étude, gestionnaire),
#: en plus de ``lawyer_contact`` : ``contact_avocat`` (Vench, Petites Affiches), ``gestionnaire_email`` (cessions de
#: l'État)... Jamais les blocs de texte de la page (``page_text``, ``description``), qui contiennent aussi des adresses du
#: site ou de tiers.
_CONTACT_BLOCK_KEY = re.compile(r"avocat|contact|mail|notaire|gestionnaire|[ée]tude|cabinet", re.IGNORECASE)


def contact_email_texts(sale: AuctionSale) -> list[object]:
    """``lawyer_contact`` et les textes des blocs de contact, blocs imbriqués (dict, liste) parcourus comme l'agent.

    Une valeur chaîne est lue telle quelle ; un dict ou une liste est parcouru par ``_string_leaves`` (les chaînes
    qui sont la valeur d'une clé), comme ``contact_emails`` de l'agent d'information.
    """
    payload = sale.raw_payload if isinstance(sale.raw_payload, dict) else {}
    blocks = payload.get("source_blocks") if isinstance(payload.get("source_blocks"), dict) else {}
    texts: list[object] = [sale.lawyer_contact]
    for key, value in blocks.items():
        if _CONTACT_BLOCK_KEY.search(str(key)):
            texts.extend([value] if isinstance(value, str) else string_leaves(value))
    return texts


def has_contact_email(sale: AuctionSale, blocklist: ContactBlocklist | None = None) -> bool:
    """Une adresse email que l'agent d'information peut solliciter.

    Syntaxe valide, ni adresse exclue (juridiction, RPVA, Ordre, CARPA, technique), ni refusée par son registre
    (opposition, rebond permanent) : ``blocklist`` vaut le registre du passage quand il n'est pas donné.
    """
    refused = active_blocklist() if blocklist is None else blocklist
    return any(
        excluded_contact_reason(email) is None and not refused.blocks(email, sale.id)
        for text in contact_email_texts(sale)
        for email in extract_emails(text)
    )


_CADASTRE_BLOCK_KEYS = ("reference_cadastrale", "references_cadastrales")
#: Clés des formes plates de ``cadastre_location`` : ``parcels`` (Avoventes), ``references`` (Info-Enchères).
_FLAT_PARCEL_KEYS = ("parcels", "references")


def _has_parcels(location: object) -> bool:
    """``cadastre_location`` : au moins une parcelle, sous l'une des trois formes que les sources écrivent.

    * ``{candidates: [{parcels: [...]}], ...}`` : cessions de l'État, notaires, Petites Affiches ;
    * ``{insee_code, parcels: [{section, number, ...}], designation}`` : Avoventes (``sources/avoventes_extraction.py``) ;
    * ``{references: [...], designation, raw}`` : Info-Enchères (``sources/info_encheres_extraction.py``).

    Miroir de ``app_private.listing_location_has_parcels`` (SQL) : la même lecture des deux côtés.
    """
    if not isinstance(location, dict):
        return False
    candidates = location.get("candidates")
    if isinstance(candidates, list) and any(
        isinstance(candidate, dict) and candidate.get("parcels") for candidate in candidates
    ):
        return True
    return any(
        isinstance(location.get(key), list) and any(location[key]) for key in _FLAT_PARCEL_KEYS
    )


def has_cadastral_reference(sale: AuctionSale) -> bool:
    """Une ou plusieurs parcelles lisibles : la vente se localise à la parcelle, sans voie."""
    payload = sale.raw_payload if isinstance(sale.raw_payload, dict) else {}
    features = payload.get("source_property_features")
    if _has_parcels(payload.get("cadastre_location")) or (
        isinstance(features, dict) and _has_parcels(features.get("cadastre_location"))
    ):
        return True
    blocks = payload.get("source_blocks") if isinstance(payload.get("source_blocks"), dict) else {}
    texts = [blocks.get(key) for key in _CADASTRE_BLOCK_KEYS] + [sale.address]
    return any(classify_address(str(text), sale.city) == "parcel" for text in texts if text)


def has_documents(sale: AuctionSale) -> bool:
    return bool(sale.documents)


def _host(url: object) -> str | None:
    if not isinstance(url, str) or not url.strip():
        return None
    try:
        host = (urlsplit(url.strip()).hostname or "").rstrip(".").lower()
    except ValueError:
        return None
    return host.removeprefix("www.") or None


def has_other_source(sale: AuctionSale) -> bool:
    """Deux sources dans la vente : deux hôtes parmi ses URL, ou deux sources dans ses observations."""
    hosts = {host for host in map(_host, [sale.source_url, *(sale.source_urls or [])]) if host}
    return len(hosts) > 1 or len(sale_source_names(sale.source_name, sale.observations)) > 1


def detail_unread(sale: AuctionSale) -> bool:
    payload = sale.raw_payload if isinstance(sale.raw_payload, dict) else {}
    return bool(payload.get("_detail_fetch_failed")) or payload.get("source_detail_status") == "failed"


def assess(sale: AuctionSale, blocklist: ContactBlocklist | None = None) -> ListingMinimum:
    """Les preuves que la vente porte déjà ; vide : elle n'a pas le minimum."""
    basis = tuple(
        name
        for name, found in (
            (BASIS_STREET, has_street_or_lieu_dit(sale.address, sale.city)),
            (BASIS_EMAIL, has_contact_email(sale, blocklist)),
            (BASIS_CADASTRE, has_cadastral_reference(sale)),
            (BASIS_DOCUMENTS, has_documents(sale)),
            (BASIS_OTHER_SOURCE, has_other_source(sale)),
        )
        if found
    )
    return ListingMinimum(basis=basis, detail_unread=not basis and detail_unread(sale))


def has_listing_minimum(sale: AuctionSale, blocklist: ContactBlocklist | None = None) -> bool:
    return assess(sale, blocklist).ok


# --------------------------------------------------------------------------
# Refus d'une écriture : collecteur du publieur, compteurs du passage
# --------------------------------------------------------------------------
#: Liste où ``refuse`` dépose les ventes refusées ; ``None`` hors de ``publish_batch``.
_REJECTED: ContextVar[list | None] = ContextVar("listing_minimum_rejected", default=None)


@contextmanager
def collecting() -> Iterator[list]:
    """Recueille les ventes refusées à l'écriture (``publish_batch`` les retire ensuite de la liste du run)."""
    rejected: list = []
    token = _REJECTED.set(rejected)
    try:
        yield rejected
    finally:
        _REJECTED.reset(token)


class _Tally:
    """Annonces refusées pendant le passage, comptées une fois par URL (une annonce traverse plusieurs écritures)."""

    def __init__(self) -> None:
        self._lock = Lock()
        self.reset()

    def reset(self) -> None:
        with self._lock:
            self._seen: set[tuple[str, str]] = set()
            reasons = (REASON, REASON_DETAIL_UNREAD, REASON_SKIPPED)
            self._counts: dict[str, Counter[str]] = {reason: Counter() for reason in reasons}
            self._examples: dict[str, dict[str, list[str]]] = {reason: {} for reason in reasons}

    def add(self, source: str, url: str, reason: str) -> bool:
        """Compte l'annonce ; vrai si elle est nouvelle pour ce passage ET garde une place parmi les exemples."""
        with self._lock:
            if (reason, url) in self._seen:
                return False
            self._seen.add((reason, url))
            self._counts[reason][source] += 1
            examples = self._examples[reason].setdefault(source, [])
            if len(examples) >= EXAMPLES_PER_SOURCE:
                return False
            examples.append(url)
            return True

    def summary(self) -> dict[str, Any]:
        with self._lock:
            rejected, unread = self._counts[REASON], self._counts[REASON_DETAIL_UNREAD]
            skipped = self._counts[REASON_SKIPPED]
            return {
                "total": sum(rejected.values()),
                "by_source": dict(sorted(rejected.items())),
                "examples": {source: list(urls) for source, urls in sorted(self._examples[REASON].items())},
                "detail_unread_not_written": dict(sorted(unread.items())),
                "skipped_recently_rejected": dict(sorted(skipped.items())),
            }


TALLY = _Tally()


def reset_tally() -> None:
    """Début d'un passage : repart de zéro."""
    TALLY.reset()


def summary() -> dict[str, Any]:
    """``rejected_insufficient_listing`` du résumé du passage : total, par source, quelques URL d'exemple."""
    return TALLY.summary()


def _source_of(sale: AuctionSale) -> str:
    return str(sale.primary_source or sale.source_name or "unknown")


def refuse(sales: Iterable[AuctionSale]) -> list[AuctionSale]:
    """Compte, journalise et dépose dans le collecteur du publieur des ventes que la règle refuse d'écrire.

    À n'appeler que pour des ventes NOUVELLES en base (aucune ligne de même URL, aucun rapprochement avec une vente
    existante) : voir ``publication_identity.resolve_publication_identities``. Chaque refus est compté une fois par
    passage ; les cinq premiers de chaque source sont journalisés (source, URL publique, motif).
    """
    refused = list(sales)
    for sale in refused:
        verdict = assess(sale)
        source, url = _source_of(sale), str(sale.source_url)
        reason = REASON_SKIPPED if is_skipped(sale.raw_payload) else verdict.reason or REASON
        if TALLY.add(source, url, reason):  # les premières seulement : l'effectif complet est dans le résumé
            LOGGER.info("Listing not written source=%s url=%s reason=%s", source, url, reason)
    collector = _REJECTED.get()
    if collector is not None:
        collector.extend(refused)
    return refused


def decision_groups(sales: Iterable[AuctionSale]) -> dict[str | None, list[AuctionSale]]:
    """Ventes refusées regroupées par passage (``last_run_id``) pour écrire leur décision."""
    groups: dict[str | None, list[AuctionSale]] = {}
    for sale in sales:
        groups.setdefault(getattr(sale, "last_run_id", None), []).append(sale)
    return groups
