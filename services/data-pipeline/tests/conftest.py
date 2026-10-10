from __future__ import annotations

import pytest


@pytest.fixture(autouse=True)
def _drop_shared_postgres_connections():
    """The per-process connection cache must never leak between tests."""
    yield
    from src.storage import supabase_client

    for key in list(supabase_client._SHARED_CONNECTIONS):
        supabase_client._discard_shared_connection(key)


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
    """Document downloads fetch robots.txt and wait 1.5 s per host in production."""
    from src import document_politeness

    monkeypatch.setattr(document_politeness, "POLITENESS_ENABLED", False)
