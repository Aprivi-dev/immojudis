"""Photos des pièces jointes : règle « photo du bien » et extraction dans un sous-processus sans secret.

Aucun PDF réel n'est versionné. Les images et le PDF de ces tests sont fabriqués ici (PyMuPDF, Pillow) ; les
mesures du cahier des charges de Bordeaux (Cessions de l'État, 66 rue Lafaurie de Monbadon) sont reprises en
table de non-régression de la règle.
"""

from __future__ import annotations

import ast
import io
import json
import random
import subprocess
import sys
from pathlib import Path
from typing import Any

import pymupdf
import pytest
from PIL import Image, ImageDraw

from src import pdf_photo_extract, pdf_photos, photo_mirror
from src.pdf_photo_extract import ImageStats, photo_rejection, size_rejection, stats_rejection
from src.photo_mirror import ImageRejected

SECRETS = {
    "SUPABASE_SERVICE_ROLE_KEY": "service-role-secret-value",
    "SUPABASE_DB_URL": "postgresql://postgres:db-password@db.example.test:5432/postgres",
    "REPLICATE_API_TOKEN": "r8_replicate-secret",
}


# --------------------------------------------------------------------------------------------------
# Images de synthèse
# --------------------------------------------------------------------------------------------------


def photo_like(width: int = 700, height: int = 500, seed: int = 1) -> Image.Image:
    """Grandes plages contrastées (lumière, ombre) et grain : ce que donne une photo réduite à 64 px."""
    rng = random.Random(seed)
    small = Image.new("RGB", (12, 8))
    levels = [rng.randrange(10, 225) for _ in range(12 * 8)]
    small.putdata(
        [(level, max(0, level - rng.randrange(0, 30)), min(255, level + rng.randrange(0, 30))) for level in levels]
    )
    image = small.resize((width, height), Image.Resampling.BICUBIC)
    noise = Image.frombytes("RGB", (width, height), rng.randbytes(width * height * 3))
    return Image.blend(image, noise, 0.1)


def map_like(width: int = 700, height: int = 500, seed: int = 2) -> Image.Image:
    """Fond pâle et plat, quelques rues claires : une carte OpenStreetMap."""
    rng = random.Random(seed)
    small = Image.new("RGB", (12, 8))
    small.putdata([(rng.randrange(205, 228), rng.randrange(205, 228), rng.randrange(195, 220)) for _ in range(96)])
    image = small.resize((width, height), Image.Resampling.BICUBIC)
    draw = ImageDraw.Draw(image)
    for _ in range(12):
        y = rng.randrange(height)
        draw.line([(0, y), (width, y + rng.randrange(-80, 80))], fill=(250, 250, 245), width=6)
    return image


def logo_like(width: int = 600, height: int = 500) -> Image.Image:
    """Fond blanc, deux aplats de couleur : un logo."""
    image = Image.new("RGB", (width, height), (255, 255, 255))
    draw = ImageDraw.Draw(image)
    draw.rectangle([150, 150, 300, 300], fill=(0, 35, 149))
    draw.ellipse([320, 180, 450, 310], fill=(237, 41, 57))
    return image


def _encoded(image: Image.Image, kind: str) -> bytes:
    buffer = io.BytesIO()
    image.save(buffer, kind, **({"quality": 85} if kind == "JPEG" else {}))
    return buffer.getvalue()


def tiny_pdf() -> bytes:
    """Trois pages : la même photo deux fois (même objet), une carte, un logo, puis une seconde photo."""
    document = pymupdf.open()
    photo = _encoded(photo_like(), "JPEG")
    second_photo = _encoded(photo_like(seed=7), "JPEG")
    first = document.new_page()
    first.insert_image(pymupdf.Rect(40, 40, 160, 140), stream=_encoded(logo_like(), "PNG"))
    first.insert_image(pymupdf.Rect(60, 200, 540, 540), stream=photo)
    second = document.new_page()
    second.insert_image(pymupdf.Rect(60, 60, 540, 400), stream=_encoded(map_like(), "PNG"))
    second.insert_image(pymupdf.Rect(60, 420, 540, 760), stream=photo)
    third = document.new_page()
    third.insert_image(pymupdf.Rect(60, 60, 540, 400), stream=second_photo)
    data = document.tobytes()
    document.close()
    return data


# --------------------------------------------------------------------------------------------------
# Règle
# --------------------------------------------------------------------------------------------------


def test_a_noisy_contrasted_photo_is_kept() -> None:
    assert photo_rejection(photo_like()) is None


def test_a_flat_pale_map_is_rejected_for_its_low_contrast() -> None:
    assert photo_rejection(map_like()) == "low_contrast"


def test_a_mostly_white_logo_is_rejected() -> None:
    assert photo_rejection(logo_like()) == "mostly_white"


def test_a_small_or_elongated_image_is_rejected_before_any_statistic() -> None:
    assert photo_rejection(photo_like(300, 220)) == "too_small"
    assert photo_rejection(photo_like(600, 340)) == "too_small"  # petit côté sous 350 px
    assert size_rejection(1400, 500) == "bad_aspect"  # bandeau : 2,8 pour 1
    assert size_rejection(500, 350) is None


def test_few_colours_is_a_diagram_even_with_contrast_and_little_white() -> None:
    assert stats_rejection(ImageStats(white=0.10, stddev=60.0, colours=800)) == "few_colours"


# Mesures relevées sur le cahier des charges de Bordeaux (14 images distinctes, réduction à 64 x 64 px) :
# (part de blanc, écart type des gris, couleurs) -> motif attendu.
BORDEAUX_MEASURES = [
    # 9 photos du bien (façade, rue, pièces, escalier, cour ; certaines en assemblent deux)
    ((0.0352, 55.76, 3865), None),
    ((0.0396, 53.33, 3589), None),
    ((0.0815, 63.47, 3575), None),
    ((0.0625, 45.16, 3127), None),
    ((0.0625, 51.83, 2999), None),
    ((0.0684, 58.61, 3369), None),
    ((0.0317, 48.49, 3231), None),
    ((0.0486, 41.91, 2481), None),
    ((0.0625, 53.60, 3786), None),
    # 2 cartes OpenStreetMap (contraste faible ; 26,7 et 28,6 avec une autre mesure, sous le seuil aussi)
    ((0.00, 9.70, 2683), "low_contrast"),
    ((0.05, 13.70, 2606), "low_contrast"),
    ((0.00, 28.60, 2800), "low_contrast"),
    # 2 logos (République française, Finances publiques) et le schéma d'enveloppe
    ((0.77, 58.20, 331), "mostly_white"),
    ((0.87, 30.10, 453), "mostly_white"),
    ((0.68, 28.10, 795), "mostly_white"),
]


@pytest.mark.parametrize(("measure", "expected"), BORDEAUX_MEASURES)
def test_the_rule_separates_the_bordeaux_images(measure: tuple[float, float, int], expected: str | None) -> None:
    white, stddev, colours = measure
    assert stats_rejection(ImageStats(white=white, stddev=stddev, colours=colours)) == expected


# --------------------------------------------------------------------------------------------------
# Extraction (dans ce processus : seuls les tests le font)
# --------------------------------------------------------------------------------------------------


def test_extraction_keeps_the_photos_once_in_document_order() -> None:
    result = pdf_photo_extract.extract(tiny_pdf())

    assert result.pages == 3
    # Le logo, la photo (une seule fois : même objet sur deux pages), la carte, la seconde photo.
    assert result.images == 4
    assert [(photo.page, photo.position) for photo in result.photos] == [(1, 2), (3, 4)]
    assert dict(result.rejected) == {"low_contrast": 1, "mostly_white": 1}
    first = result.photos[0]
    assert (first.width, first.height, first.single) == (700, 500, False)
    assert first.data_640[:4] == b"RIFF" and first.data_1600[8:12] == b"WEBP"
    assert len({photo.sha256 for photo in result.photos}) == 2


def test_extraction_stops_at_the_cap() -> None:
    result = pdf_photo_extract.extract(tiny_pdf(), max_photos=1)

    # La carte et la seconde photo ne sont pas examinées.
    assert len(result.photos) == 1 and result.rejected["over_cap"] == 2


def test_extraction_refuses_what_is_not_a_readable_pdf() -> None:
    with pytest.raises(pdf_photo_extract.DocumentProblem) as caught:
        pdf_photo_extract.extract(b"<html>not a pdf</html>")
    assert caught.value.reason == "not_pdf"

    with pytest.raises(pdf_photo_extract.DocumentProblem) as broken:
        pdf_photo_extract.extract(b"%PDF-1.7\n" + b"\x00" * 200)
    assert broken.value.reason == "unreadable_pdf"


def test_an_encrypted_pdf_is_refused() -> None:
    document = pymupdf.open()
    document.new_page()
    data = document.tobytes(encryption=pymupdf.PDF_ENCRYPT_AES_256, user_pw="secret", owner_pw="owner")
    document.close()

    with pytest.raises(pdf_photo_extract.DocumentProblem) as caught:
        pdf_photo_extract.extract(data)
    assert caught.value.reason == "encrypted"


# --------------------------------------------------------------------------------------------------
# Sous-processus
# --------------------------------------------------------------------------------------------------


def test_the_parent_never_opens_the_pdf_and_the_child_has_no_secret(monkeypatch: pytest.MonkeyPatch) -> None:
    data = tiny_pdf()  # le test, lui, a le droit de fabriquer son PDF

    def forbidden(*args: object, **kwargs: object) -> None:
        raise AssertionError("the parent process must not open a third-party PDF or image")

    calls: list[dict[str, Any]] = []
    real_run = subprocess.run

    def recording_run(command: list[str], **kwargs: Any) -> subprocess.CompletedProcess[bytes]:
        calls.append({"command": command, **kwargs})
        return real_run(command, **kwargs)

    for name, value in SECRETS.items():
        monkeypatch.setenv(name, value)
    monkeypatch.setattr(pymupdf, "open", forbidden)
    monkeypatch.setattr(Image, "open", forbidden)
    monkeypatch.setattr(pdf_photos.subprocess, "run", recording_run)

    extraction = pdf_photos.extract_photos(data)

    assert [(photo.page, photo.position) for photo in extraction.photos] == [(1, 2), (3, 4)]
    assert extraction.pages == 3 and extraction.images == 4
    call = calls[0]
    assert call["command"][:2] == [sys.executable, "-I"]
    assert Path(call["command"][2]).name == "pdf_photo_extract.py"
    assert call["env"].keys() <= {*photo_mirror.IMAGE_DECODER_ENV_ALLOWLIST, "PYTHONDONTWRITEBYTECODE"}
    assert not any(value in json.dumps(call["env"]) for value in SECRETS.values())
    assert call["timeout"] == pdf_photos.EXTRACTOR_TIMEOUT_SECONDS and call["check"] is False
    assert Path(call["cwd"]).resolve() != Path.cwd().resolve()


def test_a_crashed_or_slow_extractor_rejects_the_document_only(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(pdf_photos, "extractor_command", lambda max_photos=12: [sys.executable, "-I", "-c", "raise SystemExit(3)"])
    with pytest.raises(ImageRejected) as crashed:
        pdf_photos.extract_photos(b"%PDF-1.7\n")
    assert crashed.value.reason == "extractor_crashed" and crashed.value.permanent

    monkeypatch.setattr(pdf_photos, "EXTRACTOR_TIMEOUT_SECONDS", 0.5)
    monkeypatch.setattr(
        pdf_photos, "extractor_command", lambda max_photos=12: [sys.executable, "-I", "-c", "import time; time.sleep(30)"]
    )
    with pytest.raises(ImageRejected) as slow:
        pdf_photos.extract_photos(b"%PDF-1.7\n")
    assert slow.value.reason == "extract_timeout"


def test_the_extractor_script_bounds_its_input_and_speaks_json() -> None:
    script = str(pdf_photos.EXTRACTOR_SCRIPT)
    huge = subprocess.run(
        [sys.executable, "-I", script],
        input=b"%PDF-" + b"0" * (pdf_photo_extract.MAX_INPUT_BYTES + 10),
        capture_output=True,
        check=True,
    )
    assert json.loads(huge.stdout.partition(b"\n")[0]) == {"ok": False, "reason": "too_large"}

    not_pdf = subprocess.run([sys.executable, "-I", script], input=b"<html>", capture_output=True, check=True)
    assert json.loads(not_pdf.stdout.partition(b"\n")[0]) == {"ok": False, "reason": "not_pdf"}

    bad_usage = subprocess.run([sys.executable, "-I", script, "--nope"], input=b"", capture_output=True, check=False)
    assert bad_usage.returncode != 0


def test_the_extractor_module_imports_nothing_from_the_project() -> None:
    tree = ast.parse(Path(pdf_photo_extract.__file__ or "").read_text(encoding="utf-8"))
    modules = {
        alias.name.split(".")[0] for node in ast.walk(tree) if isinstance(node, ast.Import) for alias in node.names
    } | {node.module.split(".")[0] for node in ast.walk(tree) if isinstance(node, ast.ImportFrom) and node.module}

    # Bibliothèque standard, PyMuPDF et Pillow ; photo_image.py est chargé par son chemin, sans paquet `src`.
    assert modules <= {
        "__future__", "collections", "dataclasses", "hashlib", "importlib", "json", "pathlib", "resource", "sys",
        "types", "pymupdf", "PIL",
    }


def test_the_extractor_applies_the_decoder_resource_rule_with_its_own_ceilings(monkeypatch) -> None:
    """Une seule règle de plafonds (photo_image.apply_resource_limits) ; chaque processus garde ses valeurs."""
    from types import SimpleNamespace

    applied: list[tuple[int, int]] = []
    monkeypatch.setattr(
        pdf_photo_extract.photo_image, "apply_resource_limits", lambda cpu, memory: applied.append((cpu, memory))
    )
    monkeypatch.setattr(pdf_photo_extract.sys, "stdin", SimpleNamespace(buffer=io.BytesIO(b"<html>")))
    monkeypatch.setattr(pdf_photo_extract.sys, "stdout", SimpleNamespace(buffer=io.BytesIO()))

    assert pdf_photo_extract.main([]) == 0
    assert applied == [(pdf_photo_extract.CPU_SECONDS_LIMIT, pdf_photo_extract.ADDRESS_SPACE_LIMIT_BYTES)]
