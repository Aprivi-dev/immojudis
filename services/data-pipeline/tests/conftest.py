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
    monkeypatch.delenv(information_sufficiency.MIN_ADDRESS_ENV, raising=False)
    information_sufficiency.set_active_blocklist(information_sufficiency.NO_BLOCKLIST)


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
