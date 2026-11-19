"""Fins de passe pdf de la file qui ne sont ni une lecture terminée ni un échec ordinaire (lot R6, 11/11/2026).

Décidées par ``queued_runner`` :

* **rien à lire** (report, sans essai consommé) : le manifeste enregistré est complet, il contient une URL
  écartée (lien mort, pièce bloquée par robots, lien non documentaire), ce qui interdit par règle de restaurer
  son texte sur un autre worker, et ses vérifications HTTP sont fraîches. La passe ne choisit alors aucune
  pièce. Elle reconstruisait un manifeste vide, le point d'étape était refusé ``no_progress_entries`` et la
  tâche échouait quatre fois, puis était réarmée chaque jour (62 tâches en échec le 11/11/2026, dont 57 sur un
  manifeste déjà complet) ;
* **écriture écartée** : ``upsert_sales_to_supabase`` n'a rien écrit (retour 0) et la tâche était quand même
  marquée terminée, sans que la lecture soit enregistrée. Elle échoue maintenant avec son motif, donc avec un
  essai consommé : quatre essais au plus, puis le réarmement quotidien du vidage. Un refus d'admission
  (vente expirée, ni prix ni surface) est un état de la vente : ses essais sont espacés d'un jour et le dernier
  annule la tâche en ``review_required``, que le vidage ne réveille pas tout de suite (``REVIEW_HOLD_DAYS``,
  un jour à l'approche de l'audience, et jamais au-delà d'un changement des règles de lecture) ;
* **site indisponible** (report, sans essai consommé ; 18/11/2026) : toutes les erreurs de la passe prouvent que
  l'hôte entier est indisponible (robots.txt en panne passagère ou refusé : ``document_politeness.host_unavailability``)
  et aucune pièce n'a été lue. La tâche échouait quatre fois en « checkpoint was not persisted » sans dire que le
  site ne répondait plus (32 tâches, deux sites, du 15 au 18/11/2026). Elle revient à la sonde suivante de
  robots.txt du site, que la copie commune espace déjà de 60 min à 6 h (``robots_policy_copies.probe_interval``) :
  le site ne reçoit pas plus de requêtes qu'avant. Le report a une fin : au-delà de ``HOST_OUTAGE_DEFERRAL_LIMIT``
  de panne continue, ou sans trace de la panne dans la copie commune, l'essai est consommé (échec espacé) ;
* **erreur réseau de la pièce** (échec espacé, essai consommé) : la pièce répond 429 ou 5xx, ou ne répond pas,
  alors que robots.txt se lit, ou robots.txt est en panne depuis trop longtemps. Rien ne prouve que l'hôte entier
  est en cause : la tâche échoue en nommant l'hôte et la nature de l'erreur, quatre essais au plus comme tout
  échec, mais le suivant attend ``DOCUMENT_NETWORK_RETRY_DELAY`` (ou la sonde de robots.txt) au lieu de 30 min.

* **rien lu, point d'étape refusé** (échec, essai consommé ; 19/11/2026) : le refus ``no_progress_entries`` disait
  seulement que rien n'avait été enregistré. Le message garde son début (``is_refused_checkpoint``) et nomme la
  cause que la file peut établir, comparée à l'analyse enregistrée avant la passe (``nothing_read_message``).

``document_backlog`` lit le premier message : il n'enchaîne pas une passe identique sur une tâche qui attend.
"""

from __future__ import annotations

import copy
import logging
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING

from src.admission import catalogue_write_rejection, closes_expired_offer_deadline
from src.document_facts_version import DOCUMENT_FACTS_VERSION
from src.freshness import document_fingerprint
from src.host_turn import host_of
from src.models import AuctionSale
from src.pdf_progress import (
    document_url,
    manifest_is_complete,
    modern_progress_entries,
    persisted_revalidation_due_at,
    stale_complete_document_urls,
)
from src.pipeline_usage import QueueJobDeferred
from src.sources.robots_policy_copies import PROBE_MAX_INTERVAL
from src.storage.pdf_checkpoint_rules import NO_PROGRESS_ENTRIES, last_checkpoint_refusal, refused_checkpoint_message

if TYPE_CHECKING:
    from src.pdf_enrichment import NetworkFailure, PdfEnrichmentStats

LOGGER = logging.getLogger(__name__)

NOTHING_DUE_DEFERRAL = "PDF pass deferred: the persisted manifest is complete and no document is due for revalidation"
HOST_UNAVAILABLE_DEFERRAL = "PDF pass deferred: document host unavailable"
DOCUMENT_NETWORK_FAILURE = "Document download failed on its host; retry required"
#: Panne continue de robots.txt d'un hôte (estimée par la copie commune, ``RobotsFailure.series_started_at``) au-delà
#: de laquelle ses pièces ne sont plus reportées sans essai : chaque report rafraîchit ``updated_at`` et
#: ``next_attempt_at``, donc ni ``enrichment.exhausted`` (essais épuisés) ni ``enrichment.stalled`` ne voyaient une
#: tâche reportée indéfiniment. Au-delà, l'essai est consommé et la tâche finit en échec visible et compté. Limite
#: connue : si robots.txt de l'hôte se relit avec succès entre deux pannes, la série repart de zéro, mais les pièces
#: sont alors réellement demandées à la passe où robots.txt se lit, ce qui consomme un essai en cas d'échec.
HOST_OUTAGE_DEFERRAL_LIMIT = timedelta(days=7)
#: Attente avant un nouvel essai après des erreurs réseau sur les pièces elles-mêmes (429, 5xx, délai, connexion)
#: alors que robots.txt se lit : à 6 h au lieu des 30 min d'un échec ordinaire, les quatre essais d'une tâche
#: s'étalent sur environ 18 h au lieu d'environ 1 h 30 (puis le réarmement quotidien du vidage).
DOCUMENT_NETWORK_RETRY_DELAY = timedelta(hours=6)
WRITE_DISCARDED_ERROR = "PDF pass not recorded: the final catalogue write was discarded"
# Dernier essai d'une écriture refusée à l'admission : la tâche est annulée avec ce message et le code du refus.
WRITE_REFUSED_REVIEW = "review_required: final catalogue write refused"


def review_message(reason: str, facts_version: str = DOCUMENT_FACTS_VERSION) -> str:
    """Message de la tâche annulée pour revue : le code du refus et les règles de lecture qui l'ont produit.

    La version des règles est dans le message parce que la ligne de la vente ne la porte pas : l'écriture
    qui l'aurait enregistrée est justement celle qui a été refusée. Le vidage la compare à la version
    courante (``document_backlog.CANDIDATES_SQL``) : des règles nouvelles lèvent l'attente.
    """
    return f"{WRITE_REFUSED_REVIEW} ({reason}, {facts_version})"


# Un refus d'admission ne change pas d'un tick à l'autre : même attente que les autres états stables
# (source_withdrawal.SALE_DEFERRAL), mais chaque essai compte, pour que la suite ait une fin.
ADMISSION_REFUSAL_DELAY = timedelta(hours=24)
_EXCLUDED_URL_KEYS = ("blocked_document_urls", "skipped_document_urls", "terminal_document_urls")


def complete_manifest_with_excluded_url(sale: AuctionSale) -> dict[str, object] | None:
    """Avant la passe : copie du manifeste enregistré s'il est complet et contient une URL écartée.

    Une URL bloquée, écartée ou terminale interdit par règle la restauration du texte enregistré
    (``supabase_client._validated_persisted_pdf_manifest``) : c'est le seul cas où un texte absent du worker
    n'est pas une anomalie. ``None`` dans tous les autres : un manifeste complet sans URL écartée dont le
    texte manque (ligne d'extraction absente, preuve altérée) reste un échec visible, jamais un report.
    """
    analysis = sale.raw_payload.get("document_analysis") if isinstance(sale.raw_payload, dict) else None
    if not isinstance(analysis, dict) or not manifest_is_complete(analysis, sale.documents):
        return None
    listed = {document_url(document) for document in sale.documents}
    excluded = {document_url(url) for key in _EXCLUDED_URL_KEYS for url in analysis.get(key) or []}
    if not listed & excluded:
        return None
    return copy.deepcopy(analysis)


def nothing_due_deferral(
    persisted_manifest: dict[str, object] | None,
    sale: AuctionSale,
    stats: object,
) -> QueueJobDeferred | None:
    """Report d'une passe qui n'avait rien à lire, jusqu'à l'expiration de la première vérification persistée.

    ``persisted_manifest`` vient de ``complete_manifest_with_excluded_url``, pris avant la passe. Le report ne
    vaut que si la passe n'a traité aucune pièce (ni fichier, ni constat robots ou 404) et que toutes les
    vérifications enregistrées sont encore fraîches. À l'échéance, les pièces sont périmées : la passe suivante
    les reprend et les relit. Si rien n'est à attendre, ``None`` : la passe suit son cours (point d'étape, échec).
    """
    if persisted_manifest is None:
        return None
    analysis = sale.raw_payload.get("document_analysis") if isinstance(sale.raw_payload, dict) else None
    if not isinstance(analysis, dict) or analysis.get("documents_downloaded") != 0:
        return None
    if getattr(stats, "blocked_document_urls", None) or getattr(stats, "permanent_document_failures", None):
        return None
    due_at = persisted_revalidation_due_at(persisted_manifest, sale.documents)
    if due_at is None or due_at <= datetime.now(UTC):
        return None
    return QueueJobDeferred(NOTHING_DUE_DEFERRAL, retry_after=due_at)


@dataclass(frozen=True)
class PassStart:
    """Ce que la passe pdf trouvait en commençant : l'analyse enregistrée et le texte restauré depuis la base."""

    analysis: dict[str, object] | None
    restored_text: bool

    @classmethod
    def of(cls, sale: AuctionSale, restored: object) -> PassStart:
        """``restored`` : le retour de ``restore_persisted_pdf_progress_for_sale`` (liste vide : rien restauré)."""
        analysis = sale.raw_payload.get("document_analysis") if isinstance(sale.raw_payload, dict) else None
        return cls(copy.deepcopy(analysis) if isinstance(analysis, dict) else None, bool(restored))


#: Causes d'une passe qui n'a rien lu, dans l'ordre où elles sont retenues : de la plus durable à la plus passagère
#: (la liste a changé ; aucune de ses pièces n'a de texte à lire ; ses contrôles ont expiré ; son texte manque).
NOTHING_READ_CAUSES = (
    "documents_changed",
    "all_documents_excluded",
    "http_checks_stale",
    "persisted_text_not_restored",
    "unknown",
)


def nothing_read_cause(start: PassStart, sale: AuctionSale) -> str:
    """Première cause de ``NOTHING_READ_CAUSES`` établie par l'analyse enregistrée avant la passe.

    * ``documents_changed`` : son empreinte n'est pas celle de la liste actuelle des pièces ;
    * ``all_documents_excluded`` : toutes les pièces listées sont terminales, bloquées ou écartées ;
    * ``http_checks_stale`` : une vérification HTTP qu'elle garde est périmée, absente ou déclarée à revalider ;
    * ``persisted_text_not_restored`` : elle porte au moins une pièce lue avec du texte, et rien n'a été restauré ;
    * ``unknown`` : aucune de ces causes (y compris sans analyse enregistrée).
    """
    analysis, documents = start.analysis, sale.documents
    if analysis is None:
        return "unknown"
    if analysis.get("input_fingerprint") != document_fingerprint(documents):
        return "documents_changed"
    listed = {document_url(document) for document in documents if document_url(document)}
    excluded = {document_url(url) for key in _EXCLUDED_URL_KEYS for url in analysis.get(key) or []}
    if listed and listed <= excluded:
        return "all_documents_excluded"
    if stale_complete_document_urls(copy.deepcopy(analysis), documents):
        return "http_checks_stale"
    entries = modern_progress_entries(analysis, documents)
    if not start.restored_text and any(entry.get("extraction_status") == "extracted" for entry in entries.values()):
        return "persisted_text_not_restored"
    return "unknown"


def nothing_read_message(start: PassStart, sale: AuctionSale) -> str:
    """Message d'une passe dont le point d'étape vient d'être refusé : sa cause si le refus dit que rien n'a été lu.

    Un autre motif de refus (révision déplacée, analyse périmée…) est déjà la cause : le message reste celui du refus.
    Ni URL de pièce ni donnée de la vente dans le message, seulement un code.
    """
    message = refused_checkpoint_message()
    if last_checkpoint_refusal() != NO_PROGRESS_ENTRIES:
        return message
    try:
        cause = nothing_read_cause(start, sale)
    except Exception as exc:  # seul attrapé large du lot : un diagnostic ne doit jamais masquer l'échec qu'il nomme
        LOGGER.warning("Cause of a pdf pass that read nothing not established (%s); reported as unknown", type(exc).__name__)
        cause = "unknown"
    return f"{message} (cause: {cause})"


class SpacedPdfFailure(RuntimeError):
    """Échec ordinaire d'une passe pdf (essai consommé) dont le nouvel essai attend ``retry_not_before``."""

    def __init__(self, message: str, *, retry_not_before: datetime) -> None:
        super().__init__(message)
        self.retry_not_before = retry_not_before


def network_failure_ending(stats: PdfEnrichmentStats) -> QueueJobDeferred | SpacedPdfFailure | None:
    """Fin d'une passe arrêtée par le réseau et non par les pièces, sinon ``None`` (échec ordinaire, 30 min).

    Seulement si chaque erreur de la passe est une erreur réseau (``stats.network_failures``) et que la passe n'a
    rien établi d'autre : aucune pièce lue, même depuis le cache, aucun constat robots ou définitif. Une pièce lue ou
    une erreur de lecture (PDF abîmé, OCR) garde l'échec ordinaire.

    * report sans essai (``QueueJobDeferred``) si chaque erreur prouve que son hôte entier est indisponible et que
      la panne dure depuis moins de ``HOST_OUTAGE_DEFERRAL_LIMIT`` ;
    * sinon échec espacé (``SpacedPdfFailure``), essai consommé.

    Échéance : la plus tardive des sondes de robots.txt des hôtes en cause (``PROBE_MAX_INTERVAL`` si elle est
    inconnue), et ``DOCUMENT_NETWORK_RETRY_DELAY`` pour une erreur de la pièce ; aucun hôte n'est redemandé avant.
    """
    failures = stats.network_failures
    if (
        not failures
        or stats.errors != len(failures)
        or stats.documents_processed
        or stats.document_cache_hits
        or stats.blocked_document_urls
        or stats.permanent_document_failures
    ):
        return None
    now = datetime.now(UTC)
    retry_at = max(_retry_at(item, now) for item in failures)
    natures: dict[str, set[str]] = {}
    for item in failures:
        natures.setdefault(host_of(item.origin) or item.origin, set()).add(_described(item, now))
    hosts = "; ".join(f"{host} ({', '.join(sorted(kinds))})" for host, kinds in sorted(natures.items()))
    if all(_outage_is_recent(item, now) for item in failures):
        return QueueJobDeferred(
            f"{HOST_UNAVAILABLE_DEFERRAL}: {hosts}; no document read, next try at {retry_at.isoformat()} "
            "without spending an attempt",
            retry_after=retry_at,
        )
    return SpacedPdfFailure(
        f"{DOCUMENT_NETWORK_FAILURE}: {hosts}; no document read, next try not before {retry_at.isoformat()}",
        retry_not_before=retry_at,
    )


def _retry_at(item: NetworkFailure, now: datetime) -> datetime:
    if not item.host_level:
        return now + DOCUMENT_NETWORK_RETRY_DELAY
    probe = item.robots_failure.probe_not_before() if item.robots_failure is not None else None
    return probe if probe is not None and probe > now else now + PROBE_MAX_INTERVAL


def _outage_is_recent(item: NetworkFailure, now: datetime) -> bool:
    """L'hôte entier est en panne depuis moins de ``HOST_OUTAGE_DEFERRAL_LIMIT``, d'après l'échec que la copie commune
    a rendu au moment même où robots.txt a échoué (``DocumentRobotsUnavailable.robots_failure``).

    Sans copie commune (pas de base, table absente ou injoignable), la durée de la panne est inconnue : pas de
    report, pour que la tâche ne puisse pas attendre sans fin."""
    failure = item.robots_failure
    return item.host_level and failure is not None and now - failure.series_started_at() < HOST_OUTAGE_DEFERRAL_LIMIT


def _described(item: NetworkFailure, now: datetime) -> str:
    if not item.host_level or _outage_is_recent(item, now):
        return item.nature
    if item.robots_failure is None:
        return f"{item.nature}, outage start unknown: shared robots.txt record unavailable"
    return f"{item.nature} since {item.robots_failure.series_started_at().isoformat(timespec='minutes')}"


def pdf_failure_ending(error: BaseException, message: str) -> dict[str, object]:
    """Arguments de ``_finish_job`` pour une tâche pdf en échec : l'attente d'un échec espacé, sinon l'ordinaire."""
    ending: dict[str, object] = {"succeeded": False, "error_message": message}
    if isinstance(error, SpacedPdfFailure):
        ending["retry_not_before"] = error.retry_not_before
    return ending


def facts_wait_for_pdf(pdf_due_at: datetime) -> QueueJobDeferred:
    """Report d'une passe de faits dont la tâche pdf de la vente peut encore avancer, jusqu'à l'échéance de celle-ci.

    Une passe de faits ne lit rien avant les pièces. Reportée de 30 min pendant que la tâche pdf attend son hôte
    (jusqu'à 6 h), elle était reprise et reportée environ 48 fois par jour et par vente, sans rien faire : même
    gaspillage que celui réglé par ``PARTIAL_MANIFEST_DEFERRAL``, réglé ici en s'alignant sur la tâche pdf. Jamais
    moins que l'attente ordinaire d'un report (tâche pdf en cours ou déjà due).
    """
    deferral = QueueJobDeferred(
        f"Fact extraction deferred: PDF text cache is missing or incomplete; PDF job due at {pdf_due_at.isoformat()}"
    )
    deferral.next_attempt_at = max(deferral.next_attempt_at, pdf_due_at)
    return deferral


def final_write_was_discarded(written: object, sale: AuctionSale) -> bool:
    """``upsert_sales_to_supabase`` a rendu 0 sans rien écrire.

    Une vente mise en quarantaine pendant l'écriture est écrite (masquée) et comptée 0 : ce n'est pas un refus.
    """
    return written == 0 and sale.status != "quarantined"


def _is_last_attempt(job: dict[str, object]) -> bool:
    try:
        attempts, allowed = int(job.get("attempt_count") or 0), int(job.get("max_attempts") or 0)
    except (TypeError, ValueError):
        return False
    return allowed > 0 and attempts >= allowed


def discarded_write_ending(sale: AuctionSale, job: dict[str, object]) -> dict[str, object]:
    """Fin de la tâche pdf dont l'écriture de fin de passe a été écartée : les arguments de ``_finish_job``.

    Toujours un essai consommé, jamais un report : reportée sans essai, la tâche rejouait une passe complète à
    chaque visite sans que ni le plafond de relecture ni la garde « essayée depuis moins d'un jour » la voient.

    * garde de révision (la ligne a changé pendant la passe) : échec ordinaire, nouvel essai 30 minutes plus
      tard sur la ligne à jour ;
    * refus d'admission : échec avec le code du refus, nouvel essai un jour plus tard ; au dernier essai, la
      tâche est annulée ``review_required`` avec ce code.
    """
    reason = None if closes_expired_offer_deadline(sale) else catalogue_write_rejection(sale)
    if not reason:
        return {"succeeded": False, "error_message": f"{WRITE_DISCARDED_ERROR} (revision_moved)"}
    if _is_last_attempt(job):
        return {"succeeded": False, "cancelled": True, "error_message": review_message(reason)}
    return {
        "succeeded": False,
        "error_message": f"{WRITE_DISCARDED_ERROR} ({reason})",
        "retry_not_before": datetime.now(UTC) + ADMISSION_REFUSAL_DELAY,
    }


def waits_for_its_deadline(last_error: str) -> bool:
    """La tâche attend une échéance : une nouvelle passe tout de suite donnerait le même résultat."""
    return NOTHING_DUE_DEFERRAL in last_error or last_error.startswith(HOST_UNAVAILABLE_DEFERRAL)
