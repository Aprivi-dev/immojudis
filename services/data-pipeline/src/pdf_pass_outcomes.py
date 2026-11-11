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
  annule la tâche en ``review_required``, que le vidage ne réveille pas avant ``REVIEW_HOLD_DAYS``.

``document_backlog`` lit le premier message : il n'enchaîne pas une passe identique sur une tâche qui attend.
"""

from __future__ import annotations

import copy
from datetime import UTC, datetime, timedelta

from src.admission import catalogue_write_rejection, closes_expired_offer_deadline
from src.models import AuctionSale
from src.pdf_progress import document_url, manifest_is_complete, persisted_revalidation_due_at
from src.pipeline_usage import QueueJobDeferred

NOTHING_DUE_DEFERRAL = "PDF pass deferred: the persisted manifest is complete and no document is due for revalidation"
WRITE_DISCARDED_ERROR = "PDF pass not recorded: the final catalogue write was discarded"
# Dernier essai d'une écriture refusée à l'admission : la tâche est annulée avec ce message et le code du refus.
WRITE_REFUSED_REVIEW = "review_required: final catalogue write refused"
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
        return {"succeeded": False, "cancelled": True, "error_message": f"{WRITE_REFUSED_REVIEW} ({reason})"}
    return {
        "succeeded": False,
        "error_message": f"{WRITE_DISCARDED_ERROR} ({reason})",
        "retry_not_before": datetime.now(UTC) + ADMISSION_REFUSAL_DELAY,
    }


def waits_for_its_deadline(last_error: str) -> bool:
    """La tâche attend une échéance : une nouvelle passe tout de suite donnerait le même résultat."""
    return NOTHING_DUE_DEFERRAL in last_error
