"""Décodage des photos tierces dans un sous-processus sans secret (point 50)."""

from __future__ import annotations

import ast
import io
import json
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

import pytest
from PIL import Image

from src import photo_image, photo_mirror
from src.photo_mirror import ImageRejected, process_image

SECRETS = {
    "SUPABASE_SERVICE_ROLE_KEY": "service-role-secret-value",
    "SUPABASE_DB_URL": "postgresql://postgres:db-password@db.example.test:5432/postgres",
    "SUPABASE_URL": "https://project.supabase.example.test",
    "REPLICATE_API_TOKEN": "r8_replicate-secret",
    "SOURCE_FETCH_RELAY_TOKEN": "relay-secret",
    "CRON_SECRET": "cron-secret",
    "GITHUB_TOKEN": "ghs_github-secret",
    "AWS_SECRET_ACCESS_KEY": "aws-secret",
}


def _jpeg(width: int = 800, height: int = 600) -> bytes:
    image = Image.new("RGB", (width, height), (200, 120, 40))
    for x in range(0, width, 7):
        for y in range(0, height, 11):
            image.putpixel((x, y), (x % 256, y % 256, 90))
    buffer = io.BytesIO()
    image.save(buffer, "JPEG")
    return buffer.getvalue()


class _Recorder:
    """Enveloppe ``subprocess.run`` : note les arguments réels et le résultat du processus de décodage."""

    def __init__(self, monkeypatch: pytest.MonkeyPatch) -> None:
        self.calls: list[dict[str, Any]] = []
        self.results: list[subprocess.CompletedProcess[bytes]] = []
        real = subprocess.run

        def run(command: list[str], **kwargs: Any) -> subprocess.CompletedProcess[bytes]:
            self.calls.append({"command": command, **kwargs})
            try:
                result = real(command, **kwargs)
            except subprocess.TimeoutExpired:
                raise
            self.results.append(result)
            return result

        monkeypatch.setattr(photo_mirror.subprocess, "run", run)


@pytest.fixture
def secret_environment(monkeypatch: pytest.MonkeyPatch) -> dict[str, str]:
    for name, value in SECRETS.items():
        monkeypatch.setenv(name, value)
    return dict(SECRETS)


def test_the_decoder_environment_is_an_allowlist_without_any_secret(secret_environment: dict[str, str]) -> None:
    parent = {**secret_environment, "PATH": "/usr/bin", "LANG": "C.UTF-8", "HOME": "/root", "PGPASSWORD": "x"}

    environment = photo_mirror.image_decoder_environment(parent)

    assert set(environment) <= {*photo_mirror.IMAGE_DECODER_ENV_ALLOWLIST, "PYTHONDONTWRITEBYTECODE"}
    assert environment["PATH"] == "/usr/bin" and environment["LANG"] == "C.UTF-8"
    flat = json.dumps(environment)
    assert not any(value in flat for value in secret_environment.values())
    assert "HOME" not in environment and "PGPASSWORD" not in environment


def test_the_child_process_really_receives_no_secret_and_an_empty_directory(
    monkeypatch: pytest.MonkeyPatch, secret_environment: dict[str, str]
) -> None:
    recorder = _Recorder(monkeypatch)
    # Un « décodeur » qui décrit ce qu'il voit : son environnement, son répertoire, ses chemins d'import.
    monkeypatch.setattr(
        photo_mirror,
        "image_decoder_command",
        lambda: [
            sys.executable,
            "-I",
            "-c",
            "import json, os, sys; print(json.dumps({'env': dict(os.environ), 'cwd': os.getcwd(),"
            " 'listing': os.listdir('.'), 'flags': sys.flags.isolated}))",
        ],
    )

    with pytest.raises(ImageRejected):  # la sortie n'est pas celle d'un décodeur
        process_image(_jpeg())

    seen = json.loads(recorder.results[0].stdout)
    assert not set(secret_environment) & set(seen["env"])
    assert not any(value in json.dumps(seen["env"]) for value in secret_environment.values())
    assert seen["listing"] == [] and seen["flags"] == 1
    assert Path(seen["cwd"]).resolve() != Path.cwd().resolve()
    call = recorder.calls[0]
    assert call["env"].keys() <= {*photo_mirror.IMAGE_DECODER_ENV_ALLOWLIST, "PYTHONDONTWRITEBYTECODE"}
    assert call["timeout"] == photo_mirror.IMAGE_DECODER_TIMEOUT_SECONDS
    assert call["check"] is False and call["input"].startswith(b"\xff\xd8\xff")


def test_the_real_decoder_runs_isolated_and_the_parent_never_opens_the_image(
    monkeypatch: pytest.MonkeyPatch, secret_environment: dict[str, str]
) -> None:
    def forbidden(*args: object, **kwargs: object) -> None:
        raise AssertionError("Pillow must not decode a third-party image in the parent process")

    monkeypatch.setattr(Image, "open", forbidden)
    recorder = _Recorder(monkeypatch)

    processed = process_image(_jpeg(1000, 700))

    assert (processed.width, processed.height) == (1000, 700)
    assert not processed.single and processed.data_640[:4] == b"RIFF" and processed.data_1600[8:12] == b"WEBP"
    command = recorder.calls[0]["command"]
    assert command[:2] == [sys.executable, "-I"] and Path(command[2]).name == "photo_image.py"
    assert command[3:] == ["--max-pixels", str(photo_mirror.MAX_PIXELS)]
    assert not any(value in " ".join(command) for value in secret_environment.values())


def test_a_timeout_kills_the_decoder_and_rejects_the_photo(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(photo_mirror, "IMAGE_DECODER_TIMEOUT_SECONDS", 0.5)
    monkeypatch.setattr(
        photo_mirror, "image_decoder_command", lambda: [sys.executable, "-I", "-c", "import time; time.sleep(60)"]
    )

    started = time.monotonic()
    with pytest.raises(ImageRejected) as caught:
        process_image(_jpeg())

    assert caught.value.reason == "decode_timeout" and caught.value.permanent
    assert time.monotonic() - started < 10


@pytest.mark.parametrize(
    "code",
    ["import sys; sys.exit(3)", "import os, signal; os.kill(os.getpid(), signal.SIGKILL)"],
)
def test_a_crashed_decoder_rejects_this_photo_only(monkeypatch: pytest.MonkeyPatch, code: str) -> None:
    monkeypatch.setattr(photo_mirror, "image_decoder_command", lambda: [sys.executable, "-I", "-c", code])

    with pytest.raises(ImageRejected) as caught:
        process_image(_jpeg())

    assert caught.value.reason == "decoder_crashed" and caught.value.permanent


@pytest.mark.parametrize(
    "output",
    [
        "not json at all",
        "[1, 2]",
        '{"ok": true, "width": 800}',
        '{"ok": true, "width": 800, "height": 600, "single": true, "len640": 10, "len1600": 0}',
        '{"ok": true, "width": 800, "height": 600, "single": true, "len640": 4, "len1600": 0}\\nabcd',
        '{"ok": true, "width": 800, "height": 600, "single": false, "len640": 0, "len1600": 0}',
    ],
)
def test_an_unreadable_or_inconsistent_decoder_answer_is_a_decode_error(
    monkeypatch: pytest.MonkeyPatch, output: str
) -> None:
    code = f"import sys; sys.stdout.write({output!r}.replace(chr(92) + 'n', chr(10)))"
    monkeypatch.setattr(photo_mirror, "image_decoder_command", lambda: [sys.executable, "-I", "-c", code])

    with pytest.raises(ImageRejected) as caught:
        process_image(_jpeg())

    assert caught.value.reason == "decode_error"


def test_a_refusal_of_the_decoder_keeps_its_reason_and_size(monkeypatch: pytest.MonkeyPatch) -> None:
    code = (
        "import sys; sys.stdout.write('{\"ok\": false, \"reason\": \"too_small\", \"width\": 320, \"height\": 240}\\n')"
    )
    monkeypatch.setattr(photo_mirror, "image_decoder_command", lambda: [sys.executable, "-I", "-c", code])

    with pytest.raises(ImageRejected) as caught:
        process_image(_jpeg())

    assert (caught.value.reason, caught.value.width, caught.value.height) == ("too_small", 320, 240)


def test_the_decoder_never_accepts_more_pixels_than_its_own_ceiling(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(photo_image, "MAX_PIXELS", 100_000)

    with pytest.raises(photo_image.ImageProblem) as caught:
        photo_image.process(_jpeg(600, 400), max_pixels=10**12)

    assert caught.value.reason == "decompression_bomb"


def test_the_decoder_script_speaks_json_then_webp_and_bounds_its_input() -> None:
    script = str(photo_mirror.IMAGE_DECODER_SCRIPT)
    ok = subprocess.run([sys.executable, "-I", script], input=_jpeg(2400, 1600), capture_output=True, check=True)
    header, _, body = ok.stdout.partition(b"\n")
    info = json.loads(header)
    assert info["ok"] is True and (info["width"], info["height"], info["single"]) == (2400, 1600, False)
    assert info["len640"] + info["len1600"] == len(body)

    huge = subprocess.run(
        [sys.executable, "-I", script],
        input=b"\xff\xd8\xff" + b"0" * (photo_image.MAX_INPUT_BYTES + 10),
        capture_output=True,
        check=True,
    )
    assert json.loads(huge.stdout.partition(b"\n")[0]) == {
        "height": None,
        "ok": False,
        "reason": "too_large",
        "width": None,
    }

    bad_usage = subprocess.run([sys.executable, "-I", script, "--nope"], input=b"", capture_output=True, check=False)
    assert bad_usage.returncode != 0


def test_the_decoder_module_imports_nothing_from_the_project() -> None:
    tree = ast.parse(Path(photo_image.__file__ or "").read_text(encoding="utf-8"))
    modules = {
        alias.name.split(".")[0] for node in ast.walk(tree) if isinstance(node, ast.Import) for alias in node.names
    } | {node.module.split(".")[0] for node in ast.walk(tree) if isinstance(node, ast.ImportFrom) and node.module}

    # Standard library and Pillow only: nothing that reads the settings, the database or a secret.
    assert modules <= {
        "__future__", "collections", "contextlib", "dataclasses", "io", "json", "resource", "sys", "warnings", "PIL",
    }
