from __future__ import annotations

import pytest

from tests.clock_offset import install_from_environment, unavailable_reason

# Job hebdomadaire « horloge +60 jours » : sans la variable IMMOJUDIS_TEST_CLOCK_OFFSET_DAYS, rien ne change.
_CLOCK_OFFSET_DAYS = install_from_environment()


def pytest_report_header(config) -> str | None:
    if _CLOCK_OFFSET_DAYS is None:
        return None
    return unavailable_reason() or f"horloge décalée de {_CLOCK_OFFSET_DAYS:g} jours (time-machine)"


@pytest.fixture(autouse=True)
def _drop_shared_postgres_connections():
    """The per-process connection cache must never leak between tests."""
    yield
    from src.storage import supabase_client

    for key in list(supabase_client._SHARED_CONNECTIONS):
        supabase_client._discard_shared_connection(key)


@pytest.fixture(autouse=True)
def _fresh_base_reads():
    """Les lectures en base mémorisées par la garde d'écho valent pour un passage : jamais d'un test à l'autre."""
    from src import base_reads

    base_reads.reset()
    yield
    base_reads.reset()


@pytest.fixture(autouse=True)
def _no_reference_communes_lookup(monkeypatch):
    """Le repli « nom de commune unique » de ``infer_missing_department`` lit ``reference_communes`` en base.

    Les tests tournent sans base, même si ``SUPABASE_DB_URL`` est posée dans l'environnement ; ceux du
    repli fournissent eux-mêmes leur index.
    """
    from src import commune_department_lookup

    monkeypatch.setattr(commune_department_lookup, "load_unique_commune_departments", dict)
    commune_department_lookup.reset_cache()
    yield
    commune_department_lookup.reset_cache()


@pytest.fixture(autouse=True)
def _no_reference_communes_centroids(monkeypatch):
    """Le point au centre de la commune (``src.municipality_location``) lit ``reference_communes`` en base.

    Les tests tournent sans base ; ceux du point communal fournissent eux-mêmes leurs communes.
    """
    from src import municipality_location

    monkeypatch.setattr(municipality_location, "load_communes", list)
    municipality_location.reset_cache()
    yield
    municipality_location.reset_cache()


@pytest.fixture(autouse=True)
def _no_network_image_checks(monkeypatch):
    """Listing images are HEAD-checked in production; tests must stay offline.

    Tests of the check itself switch it back on explicitly.
    """
    monkeypatch.setenv("IMAGE_VALIDATION_ENABLED", "false")
    from src import image_validation

    image_validation.reset_image_validator()


@pytest.fixture(autouse=True)
def _information_sufficiency_gate_off_by_default(monkeypatch):
    """La porte « informations suffisantes » est active en production (voir information_sufficiency).

    Les tests historiques du pipeline publient des ventes minimales (ni adresse, ni surface, ni e-mail) pour
    vérifier la mécanique de publication, pas la règle de rétention : ils tournent porte ouverte. Les tests de
    la règle la réactivent explicitement avec ``IMMOJUDIS_INFORMATION_SUFFICIENCY_GATE=on``.
    """
    from src import information_sufficiency

    monkeypatch.setenv(information_sufficiency.GATE_ENV, "off")
    information_sufficiency.set_active_blocklist(information_sufficiency.NO_BLOCKLIST)
    information_sufficiency.set_active_court_registry(information_sufficiency.NO_COURT_REGISTRY)


@pytest.fixture(autouse=True)
def _no_document_politeness_waits(monkeypatch):
    """Document downloads fetch robots.txt and wait 2 s per host in production."""
    from src import document_politeness

    monkeypatch.setattr(document_politeness, "POLITENESS_ENABLED", False)


@pytest.fixture(autouse=True)
def _sources_not_withdrawn_by_default(monkeypatch):
    """L'état livré ne retire aucune source du catalogue (voir ``src.source_withdrawal``).

    Les tests des collecteurs tournent source ouverte, sans base ; les tests du retrait
    (``test_source_withdrawal.py``) posent eux-mêmes l'état qu'ils vérifient.
    """
    from src import source_withdrawal

    source_withdrawal.reset_cache()
    monkeypatch.setattr(source_withdrawal, "withdrawn_sources", lambda db_url=None: frozenset())


@pytest.fixture
def merge_trigger_present(monkeypatch):
    """Simule la base où le déclencheur de report des données des comptes est déployé.

    Les fonctions de suppression de lignes fusionnées refusent sans lui (``src.merge_guards``) ; les tests
    du refus ne l'utilisent pas et posent eux-mêmes ``merge_trigger_deployed``.
    """
    from src import merge_guards

    monkeypatch.setattr(merge_guards, "merge_trigger_deployed", lambda db_url: True)


@pytest.fixture(autouse=True)
def _no_document_prefetch_processes(monkeypatch):
    """Le vidage des pièces prépare les ventes suivantes dans des processus à part : jamais dans les tests."""
    monkeypatch.setenv("DOCUMENT_BACKLOG_PREFETCH_WORKERS", "0")


@pytest.fixture(autouse=True)
def _single_worker_lane_by_default(monkeypatch):
    """Les réglages de la voie parallèle (``src.enrichment_lane_settings``) viennent du workflow : jamais de
    l'environnement de la machine qui lance les tests. Sans eux, travailleur unique, verrous exclusifs, pas de tours
    par hôte ; les tests de la voie parallèle les posent eux-mêmes."""
    from src import enrichment_lane_settings

    for name in (
        enrichment_lane_settings.GENERAL_WORKERS_ENV,
        enrichment_lane_settings.WORKER_LOCK_MODE_ENV,
        enrichment_lane_settings.HOST_TURNS_ENV,
    ):
        monkeypatch.delenv(name, raising=False)


@pytest.fixture(autouse=True)
def _no_pending_collection(monkeypatch):
    """La voie d'enrichissement lit en base si une collecte est demandée (``src.collection_priority``) : jamais ici.

    Sans base, aucune collecte n'est demandée et le tour des sources est libre ; les tests de la priorité posent
    eux-mêmes la réponse.
    """
    from src import collection_priority

    monkeypatch.setattr(collection_priority, "collection_pending_now", lambda: False)
    monkeypatch.setattr(collection_priority, "yield_to_sources", lambda: False)


@pytest.fixture(autouse=True)
def _free_locks_around_scheduled_units(monkeypatch):
    """Le lanceur prend le tour des sources et le verrou du catalogue (``src.source_traffic``, ``src.autonomous_runner``).

    Accordés d'emblée ici ; les tests de ces verrous les rétablissent ou les remplacent eux-mêmes.
    """
    import sys
    from contextlib import contextmanager

    from src import source_traffic

    @contextmanager
    def granted(*_args, **_kwargs):
        yield True

    monkeypatch.setattr(source_traffic, "source_traffic_turn", granted)
    runner = sys.modules.get("src.autonomous_runner")
    if runner is not None:
        monkeypatch.setattr(runner, "_catalogue_writer", granted)
