"""Adapters from the versioned corpus manifest to existing test fixtures."""

from __future__ import annotations

import importlib.util
import sys
from collections.abc import Mapping
from pathlib import Path
from typing import Any

from src.normalize import normalize_sale

_MATRIX_PATH = Path(__file__).with_name("test_source_parser_matrix.py")
_MATRIX_MODULE_NAME = "immojudis_existing_source_parser_matrix"


def run_fixture(case: Mapping[str, Any]):
    """Execute one fixture referenced by the corpus manifest.

    The source parser matrix remains the fixture owner. The manifest stores a
    stable case name and provenance pointer rather than copying HTML into a
    second benchmark file.
    """

    fixture = case.get("fixture") or {}
    kind = fixture.get("kind")
    if kind == "existing_test_matrix":
        matrix = _load_matrix_module()
        cases = {item.name: item for item in matrix.CASES}
        fixture_case = cases.get(fixture.get("case"))
        if fixture_case is None:
            raise KeyError(f"source parser matrix case not found: {fixture.get('case')}")
        return normalize_sale(fixture_case.parse())
    if kind == "existing_normalization_fixture":
        if fixture.get("path") != "tests/test_normalize.py" or fixture.get("variant") != 0:
            raise ValueError(f"unsupported normalization fixture reference: {fixture}")
        return normalize_sale(
            {
                "source_name": "avoventes",
                "source_url": "https://avoventes.fr/enchere/occ-unknown-0",
                "occupancy_status": "occupation à vérifier",
            }
        )
    raise ValueError(f"unsupported extraction corpus fixture kind: {kind!r}")


def _load_matrix_module():
    existing = sys.modules.get(_MATRIX_MODULE_NAME)
    if existing is not None:
        return existing
    spec = importlib.util.spec_from_file_location(_MATRIX_MODULE_NAME, _MATRIX_PATH)
    if spec is None or spec.loader is None:
        raise ImportError(f"cannot load source parser matrix: {_MATRIX_PATH}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[_MATRIX_MODULE_NAME] = module
    spec.loader.exec_module(module)
    return module


__all__ = ["run_fixture"]
