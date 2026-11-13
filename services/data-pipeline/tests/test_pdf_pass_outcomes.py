"""Fins de passe pdf qui ne sont ni une lecture ni un échec, et motif d'un point d'étape refusé (lot R6, D, G et H).

Les cas de bout en bout sont dans ``test_pdf_queue_ticks.py`` ; ici, les bornes de chaque règle.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import pytest

from src import queued_runner
from src.document_backlog import is_refused_checkpoint
from src.document_facts_version import DOCUMENT_FACTS_VERSION
from src.freshness import document_fingerprint, timestamp_is_fresh
from src.models import AuctionSale
from src.pdf_pass_outcomes import (
    ADMISSION_REFUSAL_DELAY,
    NOTHING_DUE_DEFERRAL,
    WRITE_DISCARDED_ERROR,
    WRITE_REFUSED_REVIEW,
    complete_manifest_with_excluded_url,
    discarded_write_ending,
    final_write_was_discarded,
    nothing_due_deferral,
    waits_for_its_deadline,
)
from src.pdf_progress import (
    HTTP_REVALIDATION_WINDOW,
    PDF_TEXT_CACHE_VERSION,
    manifest_is_complete,
    persisted_revalidation_due_at,
    stale_complete_document_urls,
)
from src.storage import supabase_client
from src.storage.pdf_checkpoint_rules import _refused, last_checkpoint_refusal, reset_checkpoint_refusal

SALE_URL = "https://example.test/fin-de-passe"
READ_URL = f"{SALE_URL}/cahier.pdf"
DEAD_URL = f"{SALE_URL}/lien-mort.pdf"
FILE_SHA = "a" * 64
TEXT_SHA = "b" * 64
PREFIX = "PDF document checkpoint was not persisted; retry required"


def _hours_ago(hours: float) -> str:
    return (datetime.now(UTC) - timedelta(hours=hours)).isoformat()


def _sale(*, dead_link: bool = True, read_hours_ago: float = 2, dead_hours_ago: float = 5) -> AuctionSale:
    """Une vente dont le manifeste enregistré est complet : une pièce lue, et un lien mort si ``dead_link``."""
    urls = [READ_URL, DEAD_URL] if dead_link else [READ_URL]
    sale = AuctionSale(
        source_name="avoventes",
        source_url=SALE_URL,
        starting_price_eur=90_000,
        status="upcoming",
        sale_date=datetime.now(UTC) + timedelta(days=20),
        documents=[{"label": "Cahier des conditions de vente", "url": url} for url in urls],
    )
    entry = {
        "url": READ_URL,
        "cache_version": PDF_TEXT_CACHE_VERSION,
        "complete": True,
        "extraction_status": "extracted",
        "failed_pages": [],
        "sha256": FILE_SHA,
        "text_sha256": TEXT_SHA,
        "text_chars": 120,
        "text_present": True,
    }
    sale.raw_payload["document_analysis"] = {
        "progress_schema_version": 1,
        "input_fingerprint": document_fingerprint(sale.documents),
        "manifest_complete": True,
        "checked_at": _hours_ago(read_hours_ago),
        "failed_documents": 0,
        "blocked_document_urls": [],
        "skipped_document_urls": [],
        "terminal_document_urls": [DEAD_URL] if dead_link else [],
        "http_revalidation_pending_urls": [],
        "http_checked_at_by_url": {DEAD_URL: _hours_ago(dead_hours_ago)} if dead_link else {},
        "document_progress": [entry],
        "profiles": [{**entry, "document_type": "cahier_conditions_vente"}],
        "cache_proof": {
            "version": 1,
            "verified_at": _hours_ago(read_hours_ago),
            "input_fingerprint": document_fingerprint(sale.documents),
            "documents": [{**entry, "http_checked_at": _hours_ago(read_hours_ago)}],
        },
    }
    assert manifest_is_complete(sale.raw_payload["document_analysis"], sale.documents)
    return sale


def _pass_without_any_document(sale: AuctionSale) -> SimpleNamespace:
    """La passe n'a choisi aucune pièce : elle reconstruit un manifeste sans aucune lecture."""
    sale.raw_payload["document_analysis"] = {
        **sale.raw_payload["document_analysis"],
        "manifest_complete": False,
        "documents_downloaded": 0,
        "document_progress": [],
        "pending_document_urls": [READ_URL],
    }
    return SimpleNamespace(errors=0, blocked_document_urls=[], permanent_document_failures=[])


# --- C : la date de la dernière vérification vient du manifeste enregistré


def test_the_revalidation_window_is_the_one_of_the_freshness_rule() -> None:
    checked = datetime.now(UTC) - timedelta(hours=3)

    assert timestamp_is_fresh(checked.isoformat(), now=checked + HTTP_REVALIDATION_WINDOW - timedelta(seconds=1))
    assert not timestamp_is_fresh(checked.isoformat(), now=checked + HTTP_REVALIDATION_WINDOW)


def test_staleness_follows_the_persisted_checks_of_read_and_terminal_urls() -> None:
    fresh = _sale(read_hours_ago=2, dead_hours_ago=5)
    assert stale_complete_document_urls(fresh.raw_payload["document_analysis"], fresh.documents) == set()

    read_expired = _sale(read_hours_ago=25, dead_hours_ago=5)
    assert stale_complete_document_urls(read_expired.raw_payload["document_analysis"], read_expired.documents) == {
        READ_URL
    }

    dead_expired = _sale(read_hours_ago=2, dead_hours_ago=30)
    assert stale_complete_document_urls(dead_expired.raw_payload["document_analysis"], dead_expired.documents) == {
        DEAD_URL
    }


def test_the_wait_ends_when_the_oldest_persisted_check_expires() -> None:
    sale = _sale(read_hours_ago=2, dead_hours_ago=5)

    due_at = persisted_revalidation_due_at(sale.raw_payload["document_analysis"], sale.documents)

    assert due_at is not None
    assert abs(due_at - (datetime.now(UTC) + timedelta(hours=19))) < timedelta(minutes=1)


@pytest.mark.parametrize("dead_link_check", ["absente", "illisible", "périmée"])
def test_nothing_is_awaited_once_a_url_is_already_due(dead_link_check: str) -> None:
    sale = _sale()
    checks = {"absente": {}, "illisible": {DEAD_URL: "pas une date"}, "périmée": {DEAD_URL: _hours_ago(30)}}
    sale.raw_payload["document_analysis"]["http_checked_at_by_url"] = checks[dead_link_check]

    assert persisted_revalidation_due_at(sale.raw_payload["document_analysis"], sale.documents) is None


# --- D : rien à lire sur un manifeste enregistré complet


def test_a_pass_without_anything_to_read_waits_for_the_revalidation() -> None:
    sale = _sale()
    persisted = complete_manifest_with_excluded_url(sale)
    assert persisted is not None
    stats = _pass_without_any_document(sale)

    waiting = nothing_due_deferral(persisted, sale, stats)

    assert waiting is not None and str(waiting) == NOTHING_DUE_DEFERRAL
    assert abs(waiting.next_attempt_at - (datetime.now(UTC) + timedelta(hours=19))) < timedelta(minutes=1)
    assert waits_for_its_deadline(str(waiting))


def test_a_complete_manifest_without_excluded_url_is_not_a_wait() -> None:
    # Sans URL écartée, la règle permet de restaurer le texte : s'il manque quand même, il est perdu.
    sale = _sale(dead_link=False)
    assert supabase_client._validated_persisted_pdf_manifest(sale) is not None

    assert complete_manifest_with_excluded_url(sale) is None
    assert nothing_due_deferral(None, sale, _pass_without_any_document(sale)) is None


def test_an_altered_proof_alone_is_not_a_wait() -> None:
    # La restauration est refusée, mais pas par la règle des URL écartées : c'est une anomalie, pas une attente.
    sale = _sale(dead_link=False)
    sale.raw_payload["document_analysis"]["cache_proof"]["input_fingerprint"] = "autre"
    assert manifest_is_complete(sale.raw_payload["document_analysis"], sale.documents)
    assert supabase_client._validated_persisted_pdf_manifest(sale) is None

    assert complete_manifest_with_excluded_url(sale) is None


@pytest.mark.parametrize("kind", ["blocked_document_urls", "skipped_document_urls", "terminal_document_urls"])
def test_each_kind_of_excluded_url_makes_the_text_unrestorable_by_rule(kind: str) -> None:
    sale = _sale()
    analysis = sale.raw_payload["document_analysis"]
    analysis["terminal_document_urls"] = []
    analysis[kind] = [DEAD_URL]
    assert manifest_is_complete(analysis, sale.documents)

    assert complete_manifest_with_excluded_url(sale) is not None


def test_an_excluded_url_that_is_no_longer_listed_is_not_a_wait() -> None:
    sale = _sale(dead_link=False)
    sale.raw_payload["document_analysis"]["terminal_document_urls"] = [DEAD_URL]  # pièce retirée de la liste
    assert manifest_is_complete(sale.raw_payload["document_analysis"], sale.documents)

    assert complete_manifest_with_excluded_url(sale) is None


def test_a_partial_persisted_manifest_is_not_a_wait() -> None:
    sale = _sale()
    sale.raw_payload["document_analysis"]["manifest_complete"] = False

    assert complete_manifest_with_excluded_url(sale) is None


def test_a_pass_that_handled_a_document_is_not_a_wait() -> None:
    sale = _sale()
    persisted = complete_manifest_with_excluded_url(sale)
    stats = _pass_without_any_document(sale)

    sale.raw_payload["document_analysis"]["documents_downloaded"] = 1
    assert nothing_due_deferral(persisted, sale, stats) is None

    sale.raw_payload["document_analysis"]["documents_downloaded"] = 0
    stats.permanent_document_failures = [{"url": DEAD_URL, "reason": "not_found"}]
    assert nothing_due_deferral(persisted, sale, stats) is None

    stats.permanent_document_failures = []
    stats.blocked_document_urls = [DEAD_URL]
    assert nothing_due_deferral(persisted, sale, stats) is None


def test_expired_checks_are_not_a_wait() -> None:
    # Une pièce périmée que la passe n'a pas pu reprendre : attendre ne changerait rien, l'échec reste visible.
    sale = _sale(read_hours_ago=2, dead_hours_ago=30)
    persisted = complete_manifest_with_excluded_url(sale)
    assert persisted is not None

    assert nothing_due_deferral(persisted, sale, _pass_without_any_document(sale)) is None


def test_the_persisted_manifest_is_a_copy_taken_before_the_pass() -> None:
    sale = _sale()
    persisted = complete_manifest_with_excluded_url(sale)

    _pass_without_any_document(sale)
    sale.raw_payload["document_analysis"]["cache_proof"]["documents"].clear()

    assert persisted is not None and persisted["manifest_complete"] is True
    assert len(persisted["cache_proof"]["documents"]) == 1


# --- G : le motif du refus dans le message de la tâche


def test_the_refusal_reason_follows_the_prefix_the_backlog_reads() -> None:
    reset_checkpoint_refusal()
    assert queued_runner._pdf_checkpoint_failure_message() == PREFIX
    assert queued_runner._pdf_checkpoint_failure_message("OCR budget reached") == f"{PREFIX}: OCR budget reached"

    _refused(SALE_URL, "no_progress_entries", READ_URL)

    assert last_checkpoint_refusal() == "no_progress_entries"  # le motif seul, sans l'URL de la pièce
    nude = queued_runner._pdf_checkpoint_failure_message()
    with_error = queued_runner._pdf_checkpoint_failure_message("Document extraction incomplete; retry required: 2")
    assert nude == f"{PREFIX}: no_progress_entries"
    assert with_error == f"{PREFIX}: no_progress_entries: Document extraction incomplete; retry required: 2"
    assert queued_runner._pdf_checkpoint_failure_message(nude) == nude  # déjà préfixé : inchangé
    assert all(is_refused_checkpoint(message) for message in (PREFIX, nude, with_error))


def test_an_older_refusal_is_not_attributed_to_the_next_checkpoint(monkeypatch) -> None:
    # La restauration qui précède la passe refuse souvent le cache local (« no_local_text_cache ») : ce motif
    # n'explique pas un point d'étape écarté plus tard pour une autre raison.
    _refused(SALE_URL, "no_local_text_cache")
    monkeypatch.setattr(queued_runner, "_persist_pdf_checkpoint_for_sale", lambda _sale, **_kwargs: False)

    assert queued_runner._checkpoint_pdf_progress(_sale()) is False

    assert last_checkpoint_refusal() is None
    assert queued_runner._pdf_checkpoint_failure_message() == PREFIX


def test_a_checkpoint_refused_at_write_time_says_so() -> None:
    sale = _sale()
    sale.updated_at = datetime.now(UTC)

    class _MovedRevision:
        def execute(self, _sql, _parameters=None):
            return self

        def fetchone(self):
            return (sale.updated_at + timedelta(seconds=5),)

    reset_checkpoint_refusal()
    written = supabase_client._persist_pdf_document_checkpoint_with_connection(
        _MovedRevision(), sale, sale.raw_payload["document_analysis"], []
    )

    assert written is False
    assert last_checkpoint_refusal() == "obsolete_revision"


def test_a_checkpoint_whose_update_finds_a_moved_revision_says_so() -> None:
    sale = _sale()
    sale.updated_at = datetime.now(UTC)

    class _MovedBetweenLockAndUpdate:
        def __init__(self) -> None:
            self.rows = [(sale.updated_at,), None]  # la révision lue est la bonne, la mise à jour ne trouve rien

        def execute(self, _sql, _parameters=None):
            return self

        def fetchone(self):
            return self.rows.pop(0)

    reset_checkpoint_refusal()
    written = supabase_client._persist_pdf_document_checkpoint_with_connection(
        _MovedBetweenLockAndUpdate(), sale, sale.raw_payload["document_analysis"], []
    )

    assert written is False
    assert last_checkpoint_refusal() == "revision_moved"


def test_a_checkpoint_without_a_direct_connection_says_so(monkeypatch) -> None:
    sale = _sale()
    monkeypatch.setattr(supabase_client, "load_settings", lambda: {"supabase_db_url": ""})

    reset_checkpoint_refusal()
    written = supabase_client._persist_pdf_document_checkpoint_payload_to_supabase(
        sale, sale.raw_payload["document_analysis"], []
    )

    assert written is False
    assert last_checkpoint_refusal() == "no_direct_connection"


# --- H : écriture de fin de passe écartée


def test_a_written_or_quarantined_sale_is_not_a_discarded_write() -> None:
    sale = _sale()
    assert final_write_was_discarded(0, sale)
    assert not final_write_was_discarded(1, sale)

    sale.status = "quarantined"  # écrite, masquée, comptée 0 par l'écriture
    assert not final_write_was_discarded(0, sale)


def _claimed(attempt_count: int) -> dict[str, object]:
    return {"id": "tache-pdf", "job_type": "pdf", "attempt_count": attempt_count, "max_attempts": 4}


@pytest.mark.parametrize("attempt_count", [1, 4])
def test_a_write_discarded_by_the_revision_guard_fails_the_attempt(attempt_count: int) -> None:
    # Un échec ordinaire : un essai consommé, nouvel essai 30 minutes plus tard, quatre essais au plus.
    assert discarded_write_ending(_sale(), _claimed(attempt_count)) == {
        "succeeded": False,
        "error_message": f"{WRITE_DISCARDED_ERROR} (revision_moved)",
    }
    assert not waits_for_its_deadline(f"{WRITE_DISCARDED_ERROR} (revision_moved)")


def _refused_sale(reason: str) -> AuctionSale:
    sale = _sale()
    if reason == "missing_price_and_surface":
        sale.starting_price_eur = None
    else:
        sale.sale_date, sale.status = datetime.now(UTC) - timedelta(days=3), "past"
    return sale


@pytest.mark.parametrize("reason", ["missing_price_and_surface", "expired"])
def test_a_write_refused_at_admission_fails_the_attempt_and_waits_a_day(reason: str) -> None:
    ending = discarded_write_ending(_refused_sale(reason), _claimed(3))

    assert (ending["succeeded"], ending["error_message"]) == (False, f"{WRITE_DISCARDED_ERROR} ({reason})")
    assert "cancelled" not in ending  # un échec : l'essai est consommé et compté
    wait = ending["retry_not_before"] - datetime.now(UTC)
    assert ADMISSION_REFUSAL_DELAY - timedelta(minutes=1) < wait <= ADMISSION_REFUSAL_DELAY


@pytest.mark.parametrize("reason", ["missing_price_and_surface", "expired"])
def test_the_last_attempt_of_a_write_refused_at_admission_ends_in_review(reason: str) -> None:
    assert discarded_write_ending(_refused_sale(reason), _claimed(4)) == {
        "succeeded": False,
        "cancelled": True,
        "error_message": f"{WRITE_REFUSED_REVIEW} ({reason}, {DOCUMENT_FACTS_VERSION})",
    }


def test_a_claim_without_its_attempt_budget_is_never_taken_for_the_last_attempt() -> None:
    # Sans ``max_attempts`` dans la prise, rien ne dit que c'est le dernier essai : la tâche échoue, la base borne.
    ending = discarded_write_ending(_refused_sale("expired"), {"id": "tache-pdf", "attempt_count": 9})

    assert "cancelled" not in ending and "retry_not_before" in ending


def _run_current_sale(monkeypatch, sale: AuctionSale, jobs: list[dict[str, object]], upsert) -> tuple[list, list]:
    """Une prise dont les pièces sont déjà à jour : seule l'écriture de fin de passe est en jeu."""
    sale.raw_payload["document_facts_version"] = DOCUMENT_FACTS_VERSION
    finished: list[tuple[str, dict[str, object]]] = []
    deferred: list[tuple[list[dict[str, object]], Exception]] = []
    monkeypatch.setattr(queued_runner, "claim_auction_enrichment_jobs_family_from_supabase", lambda *, family, limit: jobs)
    monkeypatch.setattr(queued_runner, "load_settings", lambda: {"llm_prompt_version": "test"})
    monkeypatch.setattr(queued_runner, "fetch_sale_for_data_refresh", lambda _url: sale)
    monkeypatch.setattr(queued_runner, "restore_persisted_pdf_progress_for_sale", lambda _sale: [])
    monkeypatch.setattr(queued_runner, "documents_are_current", lambda _sale: True)
    monkeypatch.setattr(queued_runner, "enrich_sale_from_pdfs", lambda _sale: pytest.fail("documents are current"))
    monkeypatch.setattr(queued_runner, "settle_source_change_without_documents", lambda _sale: None)
    monkeypatch.setattr(queued_runner, "has_current_fact_analysis", lambda _sale: True)
    monkeypatch.setattr(queued_runner, "sale_needs_position", lambda _sale: False)
    for name in ("fill_tribunal", "classify_sale_procedure", "normalize_asset_features"):
        monkeypatch.setattr(queued_runner, name, lambda _sale: None)
    monkeypatch.setattr(queued_runner, "upsert_sales_to_supabase", upsert)
    monkeypatch.setattr(queued_runner, "defer_budget_jobs", lambda claimed, error: deferred.append((claimed, error)))
    monkeypatch.setattr(
        queued_runner,
        "finish_auction_enrichment_job_in_supabase",
        lambda job_id, **kwargs: finished.append((job_id, kwargs)) or True,
    )
    queued_runner.run_enrichment_queue_batch(limit=len(jobs), family=queued_runner.ENRICHMENT_FAMILY)
    return finished, deferred


def _pdf_job() -> dict[str, object]:
    return {"id": "tache-pdf", "source_url": SALE_URL, "job_type": "pdf", "attempt_count": 1}


def test_a_discarded_final_write_fails_the_pdf_job_instead_of_completing_it(monkeypatch) -> None:
    finished, deferred = _run_current_sale(monkeypatch, _sale(), [_pdf_job()], lambda *_args, **_kwargs: 0)

    assert deferred == []  # ni terminée, ni reportée sans essai
    assert finished == [
        (
            "tache-pdf",
            {"succeeded": False, "error_message": f"{WRITE_DISCARDED_ERROR} (revision_moved)", "attempt_count": 1},
        )
    ]


def test_a_final_write_refused_until_the_last_attempt_cancels_the_pdf_job_for_review(monkeypatch) -> None:
    job = {**_pdf_job(), "attempt_count": 4, "max_attempts": 4}

    finished, deferred = _run_current_sale(
        monkeypatch, _refused_sale("missing_price_and_surface"), [job], lambda *_args, **_kwargs: 0
    )

    assert deferred == []
    assert [(job_id, kwargs["cancelled"], kwargs["error_message"]) for job_id, kwargs in finished] == [
        ("tache-pdf", True, f"{WRITE_REFUSED_REVIEW} (missing_price_and_surface, {DOCUMENT_FACTS_VERSION})")
    ]


def test_a_final_write_that_landed_completes_the_pdf_job(monkeypatch) -> None:
    finished, deferred = _run_current_sale(monkeypatch, _sale(), [_pdf_job()], lambda sales, **_kwargs: len(sales))

    assert deferred == []
    assert [(job_id, kwargs["succeeded"]) for job_id, kwargs in finished] == [("tache-pdf", True)]


def test_a_sale_quarantined_by_the_final_write_completes_the_pdf_job(monkeypatch) -> None:
    def quarantining_write(sales, **_kwargs) -> int:
        sales[0].status = "quarantined"  # écrite et masquée : upsert_sales_to_supabase la compte 0
        return 0

    finished, deferred = _run_current_sale(monkeypatch, _sale(), [_pdf_job()], quarantining_write)

    assert deferred == []
    assert [(job_id, kwargs["succeeded"]) for job_id, kwargs in finished] == [("tache-pdf", True)]


def test_known_limit_a_fact_job_of_the_same_claim_is_completed_although_its_write_was_discarded(monkeypatch) -> None:
    # LIMITE CONNUE, pas un comportement voulu. La passe de faits a pu appeler le modèle (appel payé), son
    # résultat n'est pas enregistré, et sa tâche est quand même « terminée » : c'était déjà le cas avant le lot
    # R6, qui ne borne que la tâche pdf. La faire échouer rappellerait le modèle à chaque essai : c'est une
    # décision de budget, notée dans docs/audits/2026-11-11-file-de-lecture-des-pieces.md. Ce test ne fait que
    # constater l'état actuel, pour qu'un changement soit délibéré.
    fact_job = {"id": "tache-faits", "source_url": SALE_URL, "job_type": "fact_extraction", "attempt_count": 1}

    finished, deferred = _run_current_sale(monkeypatch, _sale(), [_pdf_job(), fact_job], lambda *_args, **_kwargs: 0)

    assert deferred == []
    assert [(job_id, kwargs["succeeded"]) for job_id, kwargs in finished] == [("tache-pdf", False), ("tache-faits", True)]
