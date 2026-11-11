"""Fins de passe pdf de la file qui ne sont ni une lecture terminée ni un échec (lot R6, 11/11/2026).

Deux reports, sans essai consommé, décidés par ``queued_runner`` :

* **rien à lire** : le manifeste enregistré est complet, ses vérifications HTTP sont fraîches, et le texte
  n'est pas restaurable sur ce worker parce que la règle de restauration l'interdit (manifeste avec une URL
  écartée : 404, robots, pièce vide). La passe ne choisit alors aucune pièce. Elle reconstruisait un manifeste
  vide, le point d'étape était refusé ``no_progress_entries`` et la tâche échouait quatre fois, puis était
  réarmée chaque jour (62 tâches en échec le 11/11/2026, dont 57 sur un manifeste déjà complet) ;
* **écriture écartée** : ``upsert_sales_to_supabase`` n'a rien écrit (retour 0) et la tâche était quand même
  marquée terminée, sans que la lecture soit enregistrée.

``document_backlog`` lit ces messages : il n'enchaîne pas une passe identique sur une tâche qui attend.
"""

from __future__ import annotations

import copy
from datetime import UTC, datetime, timedelta

from src.admission import catalogue_write_rejection, closes_expired_offer_deadline
from src.models import AuctionSale
from src.pdf_progress import manifest_is_complete, persisted_revalidation_due_at
from src.pipeline_usage import QueueJobDeferred

NOTHING_DUE_DEFERRAL = "PDF pass deferred: the persisted manifest is complete and no document is due for revalidation"
WRITE_DISCARDED_DEFERRAL = "PDF pass deferred: the final catalogue write was discarded"
# Un refus d'admission (vente expirée, ni prix ni surface) est un état de la vente, pas un aléa : le même essai
# trente minutes plus tard serait écarté de même. Même attente que les autres états stables (source_withdrawal).
ADMISSION_REFUSAL_DELAY = timedelta(hours=24)


def complete_manifest_without_restorable_text(sale: AuctionSale) -> dict[str, object] | None:
    """Avant la passe : copie du manifeste enregistré s'il est complet et que sa restauration est interdite par règle.

    ``None`` dans les autres cas, dont celui d'un manifeste complet que la règle permet de restaurer : si son
    texte manque quand même sur ce worker, c'est une perte (ligne d'extraction absente ou altérée), qui doit
    rester un échec visible et non un report.
    """
    analysis = sale.raw_payload.get("document_analysis") if isinstance(sale.raw_payload, dict) else None
    if not isinstance(analysis, dict) or not manifest_is_complete(analysis, sale.documents):
        return None
    from src.storage.supabase_client import _validated_persisted_pdf_manifest

    if _validated_persisted_pdf_manifest(sale) is not None:
        return None
    return copy.deepcopy(analysis)


def nothing_due_deferral(
    persisted_manifest: dict[str, object] | None,
    sale: AuctionSale,
    stats: object,
) -> QueueJobDeferred | None:
    """Report d'une passe qui n'avait rien à lire, jusqu'à l'expiration de la première vérification persistée.

    ``persisted_manifest`` vient de ``complete_manifest_without_restorable_text``, pris avant la passe. Le report
    ne vaut que si la passe n'a traité aucune pièce (ni fichier, ni constat robots ou 404) et que toutes les
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


def write_discarded_deferral(sale: AuctionSale) -> QueueJobDeferred:
    """Report de la tâche pdf dont l'écriture de fin de passe a été écartée, avec le motif quand il est connu."""
    reason = None if closes_expired_offer_deadline(sale) else catalogue_write_rejection(sale)
    if reason:
        return QueueJobDeferred.after(f"{WRITE_DISCARDED_DEFERRAL} ({reason})", ADMISSION_REFUSAL_DELAY)
    # Hors refus d'admission, l'écriture n'est écartée que par la garde de révision : la ligne a changé pendant
    # la passe. L'essai suivant repart de la ligne à jour (report par défaut, 30 minutes).
    return QueueJobDeferred(f"{WRITE_DISCARDED_DEFERRAL} (the sale changed during the pass)")


def waits_for_its_deadline(last_error: str) -> bool:
    """La tâche attend une échéance : une nouvelle passe tout de suite donnerait le même résultat."""
    return NOTHING_DUE_DEFERRAL in last_error or WRITE_DISCARDED_DEFERRAL in last_error
