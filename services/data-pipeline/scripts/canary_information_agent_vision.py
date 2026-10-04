"""Run a bounded synthetic vision canary for the configured Replicate model.

The default mode is offline and creates a local geometric PNG only. ``--live``
is an explicit opt-in for one Qwen3.7-Plus inference; it refuses Supabase and
autonomous-run credentials so no customer data or production mutation can be
involved. The report contains aggregate status only, never the image or model
response.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
from pathlib import Path
from typing import Any

import fitz

sys.dont_write_bytecode = True

PIPELINE_ROOT = Path(__file__).resolve().parents[1]
if str(PIPELINE_ROOT) not in sys.path:
    sys.path.insert(0, str(PIPELINE_ROOT))

from src.config import load_settings  # noqa: E402
from src.enrichment.llm_client import ReplicateClient  # noqa: E402
from src.information_agent_semantic import (  # noqa: E402
    MAX_VISION_IMAGE_BYTES,
    PHOTO_SEMANTIC_PROCESSOR_VERSION,
    analyze_photo_evidence,
    image_bytes_to_data_url,
)

VISION_MODEL = "qwen/qwen3-7-plus"


def build_synthetic_photo() -> bytes:
    """Create a synthetic blue rectangle and red circle without user data."""
    document = fitz.open()
    page = document.new_page(width=400, height=300)
    page.draw_rect(fitz.Rect(45, 65, 220, 230), color=(0, 0, 1), fill=(0.2, 0.4, 1))
    page.draw_circle((310, 150), 70, color=(1, 0, 0), fill=(1, 0.1, 0.1))
    pixmap = page.get_pixmap(matrix=fitz.Matrix(1, 1), colorspace=fitz.csRGB, alpha=False)
    content = pixmap.tobytes("png")
    document.close()
    return content


def _safe_settings(settings: dict[str, Any]) -> None:
    if (
        settings.get("supabase_url")
        or settings.get("supabase_service_role_key")
        or settings.get("supabase_db_url")
        or os.getenv("PIPELINE_AUTONOMOUS_RUN_ID")
    ):
        raise RuntimeError("Vision canary refuses production database or autonomous-run credentials")


def run(*, live: bool) -> dict[str, object]:
    content = build_synthetic_photo()
    if len(content) > MAX_VISION_IMAGE_BYTES:
        raise RuntimeError("Synthetic canary image exceeds the vision input bound")
    report: dict[str, object] = {
        "processor_version": PHOTO_SEMANTIC_PROCESSOR_VERSION,
        "synthetic": True,
        "image_bytes": len(content),
        "image_sha256": hashlib.sha256(content).hexdigest(),
        "max_inferences": 1,
        "live": live,
    }
    if not live:
        report.update({"status": "dry_run", "provider_called": False})
        return report

    settings = load_settings()
    _safe_settings(settings)
    token = os.getenv("REPLICATE_API_TOKEN")
    if not token:
        raise RuntimeError("REPLICATE_API_TOKEN is required for --live")
    model = str(os.getenv("REPLICATE_MODEL") or settings.get("replicate_model") or "")
    if model.split(":", 1)[0].lower() != VISION_MODEL:
        raise RuntimeError(f"--live requires {VISION_MODEL}; configured model is not an approved vision contract")
    data_url = image_bytes_to_data_url(content, "image/png")
    if data_url is None:
        raise RuntimeError("Synthetic image could not be encoded for vision input")
    client = ReplicateClient(
        api_token=token,
        model=model,
        max_tokens=256,
        max_retries=0,
        min_interval_seconds=0,
    )
    result = analyze_photo_evidence(
        image_data_urls=[data_url],
        generate_json_with_images=client.generate_json_with_images,
        model=model,
        # The production worker keeps the stricter 25 s deadline. The
        # isolated canary allows a single cold-start inference up to 60 s.
        timeout_seconds=60,
    )
    observed_text = " ".join(
        [result.description or "", *(observation.text for observation in (result.observations or []))]
    ).casefold()
    observation_match = {
        "blue_rectangle": any(term in observed_text for term in ("blue", "bleu"))
        and any(term in observed_text for term in ("rectangle", "rectangular")),
        "red_circle": any(term in observed_text for term in ("red", "rouge"))
        and any(term in observed_text for term in ("circle", "cercle", "round")),
    }
    canary_passed = result.status == "completed" and all(observation_match.values())
    report.update(
        {
            "status": result.status,
            "provider_called": True,
            "model": model.split(":", 1)[0],
            "review_required": True,
            "visual_understanding": result.metadata().get("visual_understanding"),
            "observation_count": len(result.observations or []),
            "observation_match": observation_match,
            "canary_passed": canary_passed,
            "error_code": result.error_code,
        }
    )
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--live",
        action="store_true",
        help="Make exactly one paid provider inference with the local synthetic image.",
    )
    args = parser.parse_args()
    try:
        report = run(live=args.live)
    except Exception as exc:
        report = {
            "processor_version": PHOTO_SEMANTIC_PROCESSOR_VERSION,
            "synthetic": True,
            "live": args.live,
            "status": "error",
            "provider_called": False,
            "error_code": type(exc).__name__,
        }
    print(json.dumps(report, ensure_ascii=False, sort_keys=True))
    return 0 if report.get("status") == "dry_run" or report.get("canary_passed") is True else 1


if __name__ == "__main__":
    raise SystemExit(main())
