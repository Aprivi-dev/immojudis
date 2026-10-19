"""Reading of the payload written by the isolated PDF OCR child process."""

from __future__ import annotations

import json


def parse_ocr_child_output(stdout: str | None) -> dict[str, object]:
    """Read the JSON payload from the OCR child's stdout.

    A library may print warnings on stdout before the payload (for example a
    deprecation notice at import time). The child always writes its payload as
    the last line, so only that line is parsed.
    """
    lines = [line for line in (stdout or "").splitlines() if line.strip()]
    if not lines:
        return {}
    payload = json.loads(lines[-1])
    return payload if isinstance(payload, dict) else {}
