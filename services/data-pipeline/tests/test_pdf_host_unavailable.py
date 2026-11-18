"""Pièces d'un site qui ne répond plus ou refuse l'accès (18/11/2026).

Deux sites de pièces ne répondaient plus (délais dépassés, puis robots.txt refusé) : chaque passe échouait sur
toutes ses pièces, consommait un essai et finissait en « checkpoint was not persisted » après quatre essais, sans
nommer la cause. Rejoué sur le banc de la file (``tests/pdf_queue_bench.py``) : vrai code, faux réseau, fausse base.

* robots.txt de l'hôte en panne passagère ou refusé : report sans essai jusqu'à la sonde suivante, tant que la panne
  dure depuis moins de sept jours ;
* erreur réseau de la pièce alors que robots.txt se lit, robots.txt en ``http_error``, panne de plus de sept jours :
  échec visible, essai consommé, nouvel essai espacé.
"""

from __future__ import annotations

import ssl
from datetime import UTC, datetime, timedelta

import httpx
import pytest

from src import document_politeness, queued_runner
from src.document_backlog import is_refused_checkpoint
from src.document_politeness import (
    DocumentPoliteness,
    DocumentRobotsUnavailable,
    document_network_failure,
    host_unavailability,
)
from src.pdf_pass_outcomes import (
    DOCUMENT_NETWORK_FAILURE,
    HOST_OUTAGE_DEFERRAL_LIMIT,
    HOST_UNAVAILABLE_DEFERRAL,
)
from src.sources import robots_policy_store
from src.sources.robots_policy_copies import (
    ACCESS_REFUSED,
    HTTP_ERROR,
    SERVER_ERROR,
    TIMEOUT,
    RobotsFailure,
    SharedPolicy,
)
from src.storage import supabase_client
from src.storage.pdf_checkpoint_rules import _refused
from tests.pdf_queue_bench import QueueBench, pdf_enrichment

REAL_DOWNLOAD_RESPONSE = pdf_enrichment._download_document_response

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
    """Copie commune de robots.txt en mémoire, par origine, avec le compte des échecs consécutifs de
    ``_SAVE_FAILURE_SQL`` ; ``failure`` : celui de ``HOST``."""

    def __init__(self, monkeypatch) -> None:
        self.failures: dict[str, RobotsFailure] = {}
        monkeypatch.setattr(
            robots_policy_store, "load",
            lambda key: SharedPolicy(None, self.failures[key]) if key in self.failures else None,
        )
        monkeypatch.setattr(robots_policy_store, "save_verified", lambda _key, _copy: None)
        monkeypatch.setattr(robots_policy_store, "save_failure", self._save_failure)

    @staticmethod
    def key(host: str) -> str:
        return f"https://{host}:443"

    @property
    def failure(self) -> RobotsFailure | None:
        return self.failures.get(self.key(HOST))

    @failure.setter
    def failure(self, value: RobotsFailure) -> None:
        self.failures[self.key(HOST)] = value

    def _save_failure(self, key: str, failure: RobotsFailure) -> None:
        count = self.failures[key].count + 1 if key in self.failures else 1
        self.failures[key] = RobotsFailure(failure.failure_class, failure.failed_at, count, failure.recorded_by)


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


DOCUMENT_ERRORS = [
    (httpx.ReadTimeout("timed out"), "timeout"),
    (httpx.ConnectError("connection refused"), "no_tcp_response"),
    (503, "server_error"),
    (429, "rate_limited"),
]


# --- Erreur réseau de la pièce, robots.txt lisible : échec visible, essai consommé, nouvel essai espacé


@pytest.mark.parametrize(("failure", "nature"), DOCUMENT_ERRORS)
def test_a_pass_whose_documents_all_fail_on_the_network_spends_its_attempt_and_waits_six_hours(
    bench: QueueBench, monkeypatch, failure: object, nature: str
) -> None:
    # Rien ne prouve que l'hôte entier est en cause : la pièce seule a échoué. L'échec reste visible et compté
    # (quatre essais au plus), mais le suivant attend 6 h au lieu de 30 min.
    bench.publish(DOCUMENTS)
    _site_fails(bench, monkeypatch, failure)

    outcome = bench.drain()

    job = bench.jobs[-1]
    assert (job["status"], job["attempt_count"]) == ("failed", 1)
    assert job["last_error"].startswith(f"{DOCUMENT_NETWORK_FAILURE}: {HOST} ({nature})")
    assert not is_refused_checkpoint(job["last_error"])
    assert _close_to(_wait(job), timedelta(hours=6))
    assert outcome.passes == 1 and outcome.waiting_passes == 0  # le vidage n'enchaîne pas une passe identique
    assert outcome.refused_checkpoints == 0


def test_a_document_that_keeps_failing_ends_failed_after_the_last_attempt(bench: QueueBench, monkeypatch) -> None:
    bench.publish(DOCUMENTS)
    _site_fails(bench, monkeypatch, 503)

    for attempt in range(1, 5):
        bench.drain()
        job = bench.jobs[-1]
        assert (job["status"], job["attempt_count"]) == ("failed", attempt)
        assert _close_to(_wait(job), timedelta(hours=6))
        bench.age(6.02)

    assert job["attempt_count"] == job["max_attempts"]
    assert bench._claim("base-du-banc", job["id"]) is None  # la file ne la reprend plus : échec définitif, compté


# --- robots.txt de l'hôte en panne ou refusé : report sans essai jusqu'à la sonde suivante


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


def test_a_document_redirected_to_a_host_whose_robots_txt_fails_names_that_host(bench: QueueBench, monkeypatch) -> None:
    # La pièce de HOST redirige vers un autre hôte dont robots.txt ne répond pas : c'est cet hôte-là qui est nommé,
    # et sa sonde qui fixe l'échéance (60 min), pas celles de HOST, dont robots.txt se lit.
    other = "miroir.etude.example"
    shared = SharedRobots(monkeypatch)
    robots_requests: list[str] = []

    def fetch_robots(robots_url: str) -> httpx.Response:
        robots_requests.append(robots_url)
        if other in robots_url:
            raise httpx.ReadTimeout("timed out")
        return httpx.Response(404, request=httpx.Request("GET", robots_url))

    def send(url: str, **_kwargs: object) -> httpx.Response:
        bench.requests.append(url)
        location = url.replace(HOST, other)
        return httpx.Response(302, headers={"location": location}, request=httpx.Request("GET", url))

    monkeypatch.setattr(document_politeness, "POLITENESS_ENABLED", True)
    monkeypatch.setattr(pdf_enrichment, "_send_pinned_document_request", send)
    monkeypatch.setattr(pdf_enrichment, "_DOCUMENT_POLITENESS", DocumentPoliteness(
        user_agent=lambda: "immojudis-banc", fetch_robots=fetch_robots, sleep=lambda _s: None, min_delay_seconds=0.0,
    ))
    bench.publish(DOCUMENTS[:1])
    monkeypatch.setattr(pdf_enrichment, "_download_document_response", REAL_DOWNLOAD_RESPONSE)

    bench.drain()

    job = bench.jobs[-1]
    assert shared.failures[SharedRobots.key(other)].failure_class == TIMEOUT
    assert (job["status"], job["attempt_count"]) == ("queued", 0)
    assert job["last_error"].startswith(f"{HOST_UNAVAILABLE_DEFERRAL}: {other} (robots.txt timeout)")
    assert _close_to(_wait(job), timedelta(hours=1))


@pytest.mark.parametrize(
    "robots_answer",
    [
        ssl.SSLError("[SSL: CERTIFICATE_VERIFY_FAILED] certificate verify failed"),
        400,
        ValueError("document target does not resolve to a public address"),  # garde réseau
    ],
)
def test_an_anomaly_of_robots_txt_stays_a_visible_failure(bench: QueueBench, monkeypatch, robots_answer: object) -> None:
    # TLS en échec, 400, URL refusée par le garde réseau : ``http_error``, une anomalie et non une panne de l'hôte.
    shared = SharedRobots(monkeypatch)
    RobotsSite(bench, monkeypatch, robots_answer)
    bench.publish(DOCUMENTS)

    outcome = bench.drain()

    job = bench.jobs[-1]
    assert shared.failure is not None and shared.failure.failure_class == HTTP_ERROR
    assert (job["status"], job["attempt_count"]) == ("failed", 1)
    assert job["last_error"].startswith("Document extraction incomplete; retry required: 3 extraction errors")
    assert _close_to(_wait(job), timedelta(minutes=30))  # l'attente ordinaire d'un échec
    assert outcome.waiting_passes == 0
    assert bench.requests == []


@pytest.mark.parametrize(("failures", "deferred"), [(29, True), (31, False)])
def test_the_deferral_stops_after_seven_days_of_continuous_outage(
    bench: QueueBench, monkeypatch, failures: int, deferred: bool
) -> None:
    # La copie commune garde le dernier échec et le nombre d'échecs consécutifs : espacés de 1 h, 2 h, 4 h puis 6 h,
    # 29 échecs couvrent 157 h (moins de 7 jours), 31 en couvrent 169.
    shared = SharedRobots(monkeypatch)
    last_failed = datetime.now(UTC) - timedelta(minutes=1)
    shared.failure = RobotsFailure(TIMEOUT, last_failed, failures, "documents")
    started = shared.failure.series_started_at()
    assert (datetime.now(UTC) - started < HOST_OUTAGE_DEFERRAL_LIMIT) is deferred
    site = RobotsSite(bench, monkeypatch, httpx.ReadTimeout("timed out"))
    bench.publish(DOCUMENTS)

    bench.drain()

    job = bench.jobs[-1]
    assert site.robots_requests == [] and bench.requests == []  # sonde pas encore due : aucune requête
    assert _close_to(_wait(job), timedelta(hours=6) - timedelta(minutes=1))  # toujours la sonde suivante
    if deferred:
        assert (job["status"], job["attempt_count"]) == ("queued", 0)
        assert job["last_error"].startswith(f"{HOST_UNAVAILABLE_DEFERRAL}: {HOST} (robots.txt timeout)")
    else:
        assert (job["status"], job["attempt_count"]) == ("failed", 1)
        assert job["last_error"].startswith(
            f"{DOCUMENT_NETWORK_FAILURE}: {HOST} (robots.txt timeout since {started.isoformat(timespec='minutes')})"
        )


def test_without_a_trace_of_the_outage_the_attempt_is_spent(bench: QueueBench, monkeypatch) -> None:
    # Copie commune absente ou injoignable : la durée de la panne est inconnue, la tâche ne peut pas attendre sans fin.
    monkeypatch.setattr(robots_policy_store, "load", lambda _key: None)
    monkeypatch.setattr(robots_policy_store, "save_failure", lambda _key, _failure: None)
    RobotsSite(bench, monkeypatch, httpx.ReadTimeout("timed out"))
    bench.publish(DOCUMENTS)

    bench.drain()

    job = bench.jobs[-1]
    assert (job["status"], job["attempt_count"]) == ("failed", 1)
    assert job["last_error"].startswith(f"{DOCUMENT_NETWORK_FAILURE}: {HOST} (robots.txt timeout, outage start unknown)")
    assert _close_to(_wait(job), timedelta(hours=6))


# --- Tâche de faits pendant que la tâche pdf de la vente attend


def _fact_job_behind_a_pdf_job(monkeypatch, pdf_rows: list[dict]) -> list:
    """Une passe de faits prise seule, sans texte des pièces, pendant que la tâche pdf de la vente attend."""
    from src.normalize import normalize_sale

    sale = normalize_sale({
        "source_name": "avoventes", "source_url": "https://vente.etude.example/faits", "description": "Maison",
        "documents": [{"label": "PV", "url": DOCUMENTS[0]}],
    })
    job = {"id": "faits", "source_url": sale.source_url, "job_type": "fact_extraction", "attempt_count": 1,
           "locked_at": "2026-11-18T08:00:00+00:00"}
    deferred: list = []
    seen: list[dict] = []

    def read_jobs(url: str, **kwargs: object) -> httpx.Response:
        seen.append(kwargs["params"])  # type: ignore[arg-type]
        return httpx.Response(200, json=pdf_rows, request=httpx.Request("GET", url))

    monkeypatch.setattr(queued_runner, "claim_auction_enrichment_jobs_family_from_supabase", lambda **_k: [job])
    monkeypatch.setattr(queued_runner, "load_settings", lambda: {"llm_prompt_version": "test"})
    monkeypatch.setattr(queued_runner, "fetch_sale_for_data_refresh", lambda _url: sale)
    monkeypatch.setattr(queued_runner, "settle_source_change_without_documents", lambda _sale: None)
    monkeypatch.setattr(queued_runner, "restore_persisted_pdf_progress_for_sale", lambda _sale: None)
    monkeypatch.setattr(
        supabase_client, "load_settings",
        lambda: {"supabase_url": "https://supabase.example", "supabase_service_role_key": "test-only"},
    )
    monkeypatch.setattr(supabase_client.httpx, "get", read_jobs)
    monkeypatch.setattr(
        queued_runner, "create_llm_client",
        lambda: (_ for _ in ()).throw(AssertionError("no LLM client while the documents are not read")),
    )
    monkeypatch.setattr(queued_runner, "defer_budget_jobs", lambda jobs, error: deferred.append(error))
    monkeypatch.setattr(
        queued_runner, "finish_auction_enrichment_job_in_supabase",
        lambda *_a, **_k: (_ for _ in ()).throw(AssertionError("the fact job must not be finished")),
    )
    assert queued_runner.run_enrichment_queue_batch(limit=1, family=queued_runner.ENRICHMENT_FAMILY) == 1
    assert seen and "next_attempt_at" in seen[0]["select"].split(",")
    return deferred


def test_a_fact_job_waits_for_the_deadline_of_the_deferred_pdf_job(monkeypatch) -> None:
    pdf_due = datetime.now(UTC) + timedelta(hours=4)
    deferred = _fact_job_behind_a_pdf_job(monkeypatch, [
        {"status": "queued", "attempt_count": 0, "max_attempts": 4, "next_attempt_at": pdf_due.isoformat()},
        {"status": "failed", "attempt_count": 4, "max_attempts": 4, "next_attempt_at": None},  # épuisée : ignorée
    ])

    assert len(deferred) == 1
    assert "PDF text cache" in str(deferred[0])
    assert deferred[0].next_attempt_at == pdf_due  # 8 prises par jour au plus, au lieu de 48


def test_a_fact_job_behind_a_running_pdf_job_keeps_the_ordinary_wait(monkeypatch) -> None:
    deferred = _fact_job_behind_a_pdf_job(monkeypatch, [{"status": "running", "attempt_count": 1, "max_attempts": 4}])

    assert len(deferred) == 1
    assert _close_to(deferred[0].next_attempt_at - datetime.now(UTC), timedelta(minutes=30))


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
    # est enregistrée) et ne rencontre que la pièce qui ne répond pas. Rien ne prouve que tout l'hôte est en panne :
    # échec visible, essai consommé, nouvel essai dans 6 h.
    following = bench.jobs[-1]
    assert len(bench.jobs) == 2 and outcome.passes == 2
    assert (following["status"], following["attempt_count"]) == ("failed", 1)
    assert following["last_error"].startswith(f"{DOCUMENT_NETWORK_FAILURE}: {HOST} (timeout)")
    assert _close_to(_wait(following), timedelta(hours=6))


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
    ("error", "host_nature", "document_nature"),
    [
        (httpx.ReadTimeout("timed out"), None, "timeout"),
        (httpx.ConnectTimeout("timed out"), None, "no_tcp_response"),
        (httpx.ConnectError("refused"), None, "no_tcp_response"),
        (_status_error(429), None, "rate_limited"),
        (_status_error(502), None, "server_error"),
        (DocumentRobotsUnavailable("down", failure_class=ACCESS_REFUSED), "robots.txt access_refused", None),
        (DocumentRobotsUnavailable("down", failure_class=TIMEOUT), "robots.txt timeout", None),
        (DocumentRobotsUnavailable("down", failure_class=SERVER_ERROR), "robots.txt server_error", None),
        (DocumentRobotsUnavailable("down", failure_class=HTTP_ERROR), None, None),
        (DocumentRobotsUnavailable("down"), None, None),
        (_status_error(400), None, None),
        (ssl.SSLError("[SSL] handshake"), None, None),
        (ValueError("too many document redirects"), None, None),
    ],
)
def test_only_robots_txt_proves_that_the_whole_host_is_unavailable(
    error: BaseException, host_nature: str | None, document_nature: str | None
) -> None:
    assert host_unavailability(error) == host_nature
    assert document_network_failure(error) == document_nature
