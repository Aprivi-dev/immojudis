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
