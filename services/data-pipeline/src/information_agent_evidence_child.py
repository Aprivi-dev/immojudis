"""Processus enfants du worker des pièces : ils ouvrent un fichier reçu d'un tiers, isolés du worker.

Sorti de ``information_agent_evidence`` (limite de taille des sources) : lancement (groupe de processus à lui,
environnement réduit sans aucune clé, mémoire bornée) et arrêt (groupe tué, enfant attendu).
"""

from __future__ import annotations

import os
import signal
import subprocess
from pathlib import Path

# Mémoire (espace d'adressage, ``RLIMIT_AS``) d'un processus enfant qui ouvre la pièce (texte natif, OCR d'une page) :
# un PDF hostile qui fait gonfler MuPDF ou Tesseract tue l'enfant, pas le worker. Mesuré le 20/11/2026 (pymupdf
# 1.28.2, Tesseract 5, 4 cœurs) : le texte natif d'un PDF de 300 pages tient sous 128 Mio, l'OCR de la plus grande page
# admise (5 000 x 3 200 px, image de 16 M pixels) échoue sous 160 Mio et passe à 192 Mio. 1 Gio laisse la marge d'un
# runner aux autres bibliothèques ou à plus de fils d'exécution.
CHILD_ADDRESS_SPACE_BYTES = 1024 * 1024 * 1024
# Seules variables transmises à un processus enfant : il ouvre un fichier reçu d'un tiers et ne reçoit aucune clé
# (base, fournisseur de modèles). Chemin des exécutables, langue, et réglages de Tesseract.
CHILD_ENVIRONMENT_KEYS = (
    "PATH",
    "LANG",
    "LANGUAGE",
    "LC_ALL",
    "LC_CTYPE",
    "TMPDIR",
    "TESSDATA_PREFIX",
    "OMP_THREAD_LIMIT",
)


def child_popen_kwargs() -> dict[str, object]:
    """Lancement d'un processus enfant qui ouvre la pièce : groupe à lui (tué en entier), environnement réduit."""
    popen_kwargs: dict[str, object] = {
        "stdout": subprocess.PIPE,
        "stderr": subprocess.DEVNULL,
        "text": True,
        "cwd": str(Path(__file__).resolve().parents[1]),
        "env": {key: os.environ[key] for key in CHILD_ENVIRONMENT_KEYS if key in os.environ},
    }
    if os.name == "posix":
        popen_kwargs["start_new_session"] = True
    return popen_kwargs


def limit_child_memory() -> None:
    """Appelé par le processus enfant avant d'ouvrir la pièce (``CHILD_ADDRESS_SPACE_BYTES``)."""
    if os.name != "posix":
        return
    import resource

    resource.setrlimit(resource.RLIMIT_AS, (CHILD_ADDRESS_SPACE_BYTES, CHILD_ADDRESS_SPACE_BYTES))


def kill_and_collect(process: subprocess.Popen) -> str:
    """Tue le groupe de l'enfant, attend sa fin et rend ce qu'il a écrit.

    Si la sortie ne se ferme pas (un membre du groupe la garde ouverte), l'enfant est tout de même attendu, puis une
    erreur est levée : rien de ce qu'il a écrit n'est sûr.
    """
    kill_process_group(process)
    try:
        stdout, _stderr = process.communicate(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()
        if process.stdout is not None:
            process.stdout.close()
        process.wait()  # SIGKILL reçu : l'attente est courte
        raise RuntimeError("PDF child process output did not close after it was killed") from None
    return stdout or ""


def terminate_process_group(process: subprocess.Popen) -> None:
    if process.poll() is not None:
        return
    kill_process_group(process)
    try:
        process.communicate(timeout=1)
    except Exception:  # whatever stopped the wait, the child must not outlive us
        process.kill()


def kill_process_group(process: subprocess.Popen) -> None:
    if os.name == "posix":
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    else:
        process.kill()
