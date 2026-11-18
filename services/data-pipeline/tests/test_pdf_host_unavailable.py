"""Pièces d'un site qui ne répond plus ou refuse l'accès : report sans essai consommé (18/11/2026).

Deux sites de pièces ne répondaient plus (délais dépassés, puis robots.txt refusé) : chaque passe échouait sur
toutes ses pièces, consommait un essai et finissait en « checkpoint was not persisted » après quatre essais, sans
nommer la cause. Rejoué sur le banc de la file (``tests/pdf_queue_bench.py``) : vrai code, faux réseau, fausse base.
Les contre-tests gardent l'échec visible quand la pièce elle-même est en cause ou quand une pièce a été lue.
"""

from __future__ import annotations

import ssl
from datetime import UTC, datetime, timedelta

import httpx
import pytest

from src import document_politeness
from src.document_backlog import is_refused_checkpoint
from src.document_politeness import DocumentPoliteness, DocumentRobotsUnavailable, host_unavailability
from src.pdf_pass_outcomes import HOST_UNAVAILABLE_DEFERRAL
from src.sources import robots_policy_store
from src.sources.robots_policy_copies import ACCESS_REFUSED, RobotsFailure, SharedPolicy
from src.storage import supabase_client
from src.storage.pdf_checkpoint_rules import _refused
from tests.pdf_queue_bench import QueueBench, pdf_enrichment

HOST = "pieces.etude.example"
DOCUMENTS = [f"https://{HOST}/vente/piece-{index}.pdf" for index in range(3)]
NO_CHECKPOINT = "(no checkpoint: no_progress_entries)"


@pytest.fixture
def bench(monkeypatch, tmp_path):
    bench = QueueBench(monkeypatch, tmp_path)
    yield bench
    bench.close()


def _wait(job: dict) -> timedelta:
    return job["next_attempt_at"] - datetime.now(UTC)


def _close_to(wait: timedelta, expected: timedelta) -> bool:
    return expected - timedelta(minutes=2) < wait <= expected + timedelta(minutes=1)


def _site_fails(bench: QueueBench, monkeypatch, failure: object) -> None:
    """Chaque requête de pièce vers ``HOST`` échoue : exception levée, ou réponse HTTP rendue."""

    def respond(url: str, **_kwargs: object) -> httpx.Response:
        bench.requests.append(url)
        if isinstance(failure, int):
            return httpx.Response(failure, request=httpx.Request("GET", url))
        raise failure  # type: ignore[misc]

    monkeypatch.setattr(pdf_enrichment, "_download_document_response", respond)


class SharedRobots:
    """Copie commune de robots.txt en mémoire, avec le compte des échecs consécutifs de ``_SAVE_FAILURE_SQL``."""

    def __init__(self, monkeypatch) -> None:
        self.failure: RobotsFailure | None = None
        monkeypatch.setattr(robots_policy_store, "load", lambda _key: SharedPolicy(None, self.failure) if self.failure else None)
        monkeypatch.setattr(robots_policy_store, "save_verified", lambda _key, _copy: None)
        monkeypatch.setattr(robots_policy_store, "save_failure", self._save_failure)

    def _save_failure(self, _key: str, failure: RobotsFailure) -> None:
        count = self.failure.count + 1 if self.failure is not None else 1
        self.failure = RobotsFailure(failure.failure_class, failure.failed_at, count, failure.recorded_by)


class RobotsSite:
    """Le vrai contrôle robots.txt des pièces devant un site dont robots.txt échoue ; un worker neuf par visite."""

    def __init__(self, bench: QueueBench, monkeypatch, robots_answer: object) -> None:
        self.bench, self.monkeypatch, self.robots_answer = bench, monkeypatch, robots_answer
        self.robots_requests: list[str] = []
        monkeypatch.setattr(document_politeness, "POLITENESS_ENABLED", True)

        def through_politeness(url: str, **kwargs: object) -> httpx.Response:
            with pdf_enrichment._DOCUMENT_POLITENESS.turn(url):
                return bench._respond(url, **kwargs)  # type: ignore[arg-type]

        monkeypatch.setattr(pdf_enrichment, "_download_document_response", through_politeness)
        self.new_worker()

    def _fetch_robots(self, robots_url: str) -> httpx.Response:
        self.robots_requests.append(robots_url)
        if isinstance(self.robots_answer, int):
            return httpx.Response(self.robots_answer, request=httpx.Request("GET", robots_url))
        raise self.robots_answer  # type: ignore[misc]

    def new_worker(self) -> None:
        politeness = DocumentPoliteness(
            user_agent=lambda: "immojudis-banc", fetch_robots=self._fetch_robots, sleep=lambda _s: None,
            min_delay_seconds=0.0,
        )
        self.monkeypatch.setattr(pdf_enrichment, "_DOCUMENT_POLITENESS", politeness)


# --- Site injoignable : report sans essai, cause nommée


@pytest.mark.parametrize(
    ("failure", "nature"),
    [
        (httpx.ReadTimeout("timed out"), "timeout"),
        (httpx.ConnectError("connection refused"), "no_tcp_response"),
        (503, "server_error"),
        (429, "rate_limited"),
    ],
)
def test_a_pass_whose_documents_all_fail_on_the_site_is_deferred_without_spending_an_attempt(
    bench: QueueBench, monkeypatch, failure: object, nature: str
) -> None:
    bench.publish(DOCUMENTS)
    _site_fails(bench, monkeypatch, failure)

    outcome = bench.drain()

    job = bench.jobs[-1]
    assert (job["status"], job["attempt_count"]) == ("queued", 0)  # l'essai est rendu
    assert job["last_error"].startswith(f"{HOST_UNAVAILABLE_DEFERRAL}: {HOST} ({nature})")
    assert "checkpoint" not in job["last_error"]
    # Sans échec de robots.txt connu, la tâche attend le plus long espacement de la sonde.
    assert _close_to(_wait(job), timedelta(hours=6))
    assert outcome.passes == 1 and outcome.waiting_passes == 1  # le vidage n'enchaîne pas une passe identique
    assert outcome.refused_checkpoints == 0


def test_timeouts_of_robots_txt_defer_the_job_until_each_next_probe(bench: QueueBench, monkeypatch) -> None:
    # Le cas du 15/11/2026 : robots.txt du site ne répond plus. Chaque visite est reportée jusqu'à la sonde suivante
    # de la copie commune (60 min, 2 h, 4 h) : la tâche revient de plus en plus tard, le site n'est interrogé qu'une
    # fois par sonde, aucune pièce n'est demandée et aucun essai n'est consommé.
    SharedRobots(monkeypatch)
    site = RobotsSite(bench, monkeypatch, httpx.ReadTimeout("timed out"))
    bench.publish(DOCUMENTS)

    waits = []
    for hours in (1, 2, 4):
        bench.drain()
        job = bench.jobs[-1]
        assert (job["status"], job["attempt_count"]) == ("queued", 0)
        assert job["last_error"].startswith(f"{HOST_UNAVAILABLE_DEFERRAL}: {HOST} (robots.txt timeout)")
        waits.append(_wait(job))
        assert _close_to(waits[-1], timedelta(hours=hours))
        bench.age(hours + 0.02)
        site.new_worker()

    assert waits == sorted(waits)
    assert len(site.robots_requests) == 3  # une lecture de robots.txt par sonde, aucune entre deux
    assert bench.requests == []  # aucune pièce demandée au site


def test_a_site_that_refuses_robots_txt_defers_the_job_until_the_next_probe(bench: QueueBench, monkeypatch) -> None:
    # Le cas du 17/11/2026 : le site répond 403 à robots.txt (« access_refused »).
    shared = SharedRobots(monkeypatch)
    site = RobotsSite(bench, monkeypatch, 403)
    bench.publish(DOCUMENTS)

    bench.drain()
    job = bench.jobs[-1]
    assert shared.failure is not None and shared.failure.failure_class == ACCESS_REFUSED
    assert (job["status"], job["attempt_count"]) == ("queued", 0)
    assert job["last_error"].startswith(f"{HOST_UNAVAILABLE_DEFERRAL}: {HOST} (robots.txt access_refused)")
    assert _close_to(_wait(job), timedelta(hours=1))

    # Un autre worker avant la sonde : aucune requête au site, même échéance.
    site.new_worker()
    bench.age(0.5)
    bench.drain()
    assert len(site.robots_requests) == 1
    assert _close_to(_wait(job), timedelta(minutes=30))

    # À la sonde, robots.txt est relu, refusé encore : l'attente double.
    bench.age(0.52)
    site.new_worker()
    bench.drain()
    assert len(site.robots_requests) == 2
    assert (job["status"], job["attempt_count"]) == ("queued", 0)
    assert _close_to(_wait(job), timedelta(hours=2))
    assert bench.requests == []


# --- Contre-tests : ce qui tient à la pièce, ou une passe qui a lu quelque chose, reste un échec visible


def test_an_error_of_the_document_itself_still_spends_an_attempt_and_names_its_cause(
    bench: QueueBench, monkeypatch
) -> None:
    bench.publish(DOCUMENTS[:1])

    def ocr_fails(*_args: object, **_kwargs: object) -> dict:
        raise RuntimeError("OCR en échec")

    monkeypatch.setattr(pdf_enrichment, "extract_attached_document", ocr_fails)

    outcome = bench.drain()

    job = bench.jobs[-1]
    assert (job["status"], job["attempt_count"]) == ("failed", 1)
    # La cause d'origine d'abord : le refus « no_progress_entries » (rien à enregistrer) n'est pas l'échec.
    assert job["last_error"].startswith("Document extraction incomplete; retry required: 1 extraction errors")
    assert job["last_error"].endswith(NO_CHECKPOINT)
    assert not is_refused_checkpoint(job["last_error"]) and outcome.refused_checkpoints == 0


def test_a_pass_that_read_one_document_keeps_the_ordinary_failure(bench: QueueBench, monkeypatch) -> None:
    # Une pièce lue, une autre sur un site qui ne répond pas : comportement d'avant, inchangé. La lecture est
    # enregistrée (point d'étape) et la tâche échoue avec son essai consommé.
    readable, unreachable = "https://autre-site.example/vente/cahier.pdf", DOCUMENTS[0]
    bench.publish([readable, unreachable])
    real_respond = bench._respond

    def respond(url: str, **kwargs: object) -> httpx.Response:
        if url == unreachable:
            bench.requests.append(url)
            raise httpx.ReadTimeout("timed out")
        return real_respond(url, **kwargs)  # type: ignore[arg-type]

    monkeypatch.setattr(pdf_enrichment, "_download_document_response", respond)

    outcome = bench.drain()

    mixed = bench.jobs[0]
    assert (mixed["status"], mixed["attempt_count"]) == ("failed", 1)
    assert mixed["last_error"] == "Document extraction incomplete; retry required: 1 extraction errors, 0 failed documents"
    assert bench.manifest["documents_extracted"] == 1
    # Le point d'étape a créé la génération suivante, que le vidage enchaîne : sa passe ne lit rien (la pièce lue
    # est enregistrée) et ne rencontre que le site injoignable. Elle attend ce site, sans essai consommé.
    following = bench.jobs[-1]
    assert len(bench.jobs) == 2 and outcome.passes == 2
    assert (following["status"], following["attempt_count"]) == ("queued", 0)
    assert following["last_error"].startswith(f"{HOST_UNAVAILABLE_DEFERRAL}: {HOST} (timeout)")


@pytest.mark.parametrize("reason", ["revision_moved", "obsolete_revision"])
def test_a_checkpoint_refused_for_another_reason_keeps_its_prefix(bench: QueueBench, monkeypatch, reason: str) -> None:
    bench.publish(DOCUMENTS[:2])
    real_extract = pdf_enrichment.extract_attached_document

    def second_fails(file_path: object, document: dict | None = None) -> dict:
        if document and document.get("url") == DOCUMENTS[1]:
            raise RuntimeError("OCR en échec")
        return real_extract(file_path, document=document)

    monkeypatch.setattr(pdf_enrichment, "extract_attached_document", second_fails)
    monkeypatch.setattr(
        supabase_client,
        "_persist_pdf_document_checkpoint_payload_to_supabase",
        lambda sale, *_args, **_kwargs: bool(_refused(sale.source_url, reason)),
    )

    outcome = bench.drain()

    job = bench.jobs[-1]
    assert (job["status"], job["attempt_count"]) == ("failed", 1)
    assert job["last_error"].startswith(
        f"PDF document checkpoint was not persisted; retry required: {reason}: Document extraction incomplete"
    )
    assert outcome.refused_checkpoints == 1


# --- La règle : ce qui tient au site, ce qui tient à la pièce


def _status_error(status: int) -> httpx.HTTPStatusError:
    request = httpx.Request("GET", f"https://{HOST}/vente/piece.pdf")
    return httpx.HTTPStatusError("status", request=request, response=httpx.Response(status, request=request))


@pytest.mark.parametrize(
    ("error", "nature"),
    [
        (httpx.ReadTimeout("timed out"), "timeout"),
        (httpx.ConnectTimeout("timed out"), "no_tcp_response"),
        (httpx.ConnectError("refused"), "no_tcp_response"),
        (_status_error(429), "rate_limited"),
        (_status_error(502), "server_error"),
        (DocumentRobotsUnavailable("down", failure_class=ACCESS_REFUSED), "robots.txt access_refused"),
        (DocumentRobotsUnavailable("down"), "robots.txt unverifiable"),
        (_status_error(400), None),
        (ssl.SSLError("[SSL] handshake"), None),
        (ValueError("too many document redirects"), None),
    ],
)
def test_host_unavailability_names_only_failures_of_the_site(error: BaseException, nature: str | None) -> None:
    assert host_unavailability(error) == nature
