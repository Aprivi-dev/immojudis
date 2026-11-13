"""Les deux règles d'empreinte SHA-256, côte à côte : l'écart entre elles est voulu."""

from __future__ import annotations

from src.sha256_digest import is_lowercase_sha256, is_sha256

LOWER = "a" * 64


def test_pipeline_digests_accept_case_and_surrounding_spaces() -> None:
    assert is_sha256(LOWER)
    assert is_sha256("A" * 64)
    assert is_sha256(f" {LOWER}\n")
    assert not is_sha256("a" * 63)
    assert not is_sha256("g" * 64)
    assert not is_sha256(None)


def test_stored_digests_must_be_exactly_lowercase_hex() -> None:
    assert is_lowercase_sha256(LOWER)
    assert not is_lowercase_sha256("A" * 64)
    assert not is_lowercase_sha256(f" {LOWER}")
    assert not is_lowercase_sha256("a" * 65)
