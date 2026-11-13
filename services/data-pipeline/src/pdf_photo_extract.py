"""Extraction des photos d'un PDF de pièce jointe, dans un sous-processus sans secret.

Le cahier des charges ou le procès-verbal descriptif d'une vente contient souvent bien plus de photos du bien
que la page de l'annonce (Cessions de l'État, 66 rue Lafaurie de Monbadon à Bordeaux : une photo sur la page,
neuf dans le cahier des charges). Ce module les retrouve. Comme ``src/photo_image.py``, il lit des octets que
nous ne maîtrisons pas (un PDF tiers, puis ses images) : il est **autonome** (bibliothèque standard, PyMuPDF,
Pillow et ``photo_image.py`` chargé par son chemin, aucun autre import du projet) et se lance seul :

``python -I src/pdf_photo_extract.py --max-photos N``, appelé par ``src.pdf_photos.extract_photos`` avec un
environnement minimal (liste blanche, aucun secret), un répertoire de travail vide, un délai et des plafonds
de processeur et de mémoire. Le PDF arrive sur l'entrée standard ; le résultat sort sur la sortie standard :
une ligne JSON, puis les octets WebP des photos retenues, dans l'ordre de la liste.

* ``{"ok": true, "pages": P, "images": N, "rejected": {motif: nombre}, "photos": [{"sha256", "page",
  "position", "width", "height", "single", "len640", "len1600", "white", "stddev", "colours"}, ...]}`` ;
* ``{"ok": false, "reason": "..."}`` pour un fichier refusé (pas un PDF, chiffré, trop gros…). Un plantage
  n'écrit rien et sort en erreur.

**Parcours.** Les pages (``MAX_PAGES`` au plus) sont lues dans l'ordre ; une image est retenue à la première
page où elle est réellement dessinée (``get_image_info``), car un document réutilise souvent le même objet
image (même ``xref``) d'une page à l'autre, et ses ressources listent parfois toutes les images sur chaque
page. Les images sont dédoublonnées par ``xref`` puis par empreinte SHA-256 du flux brut, rangées par page puis
de haut en bas et de gauche à droite (``position`` : rang d'apparition dans le document, à partir de 1).

**Règle « photo du bien »** (``photo_rejection``), calibrée sur le cahier des charges de Bordeaux (14 images
distinctes : 9 photos, dont certaines en assemblent deux, 2 cartes OpenStreetMap, 2 logos, 1 schéma
d'enveloppe) :

1. taille : petit côté >= 350 px, grand côté >= 500 px, rapport grand/petit <= 2,6 (vignettes, bandeaux,
   pictogrammes) ;
2. sur une réduction à 64 x 64 px : part de pixels blancs (gris > 235) < 0,40 (logos, schémas, pages
   scannées : 0,68 à 0,88 ; photos : 0,00 à 0,09) ;
3. écart type des gris >= 35 (cartes : contraste faible, 10 à 29 selon la mesure ; photos : 42 à 64) ;
4. au moins 1 500 couleurs distinctes en RVB (logos : 330 à 450 ; schéma : 800 ; photos : 2 480 à 3 900).

Une image retenue est ré-encodée par ``photo_image`` (WebP qualité 75, 640 px et 1600 px de large au plus,
sans métadonnée), comme la photo principale copiée par ``src/photo_mirror.py``.
"""

from __future__ import annotations

import hashlib
import importlib.util
import json
import sys
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path
from types import ModuleType

import pymupdf
from PIL import Image, ImageStat


def _load_photo_image() -> ModuleType:
    """``photo_image.py`` (même dossier), chargé par son chemin : ``python -I`` n'ajoute pas ce dossier aux imports."""
    name = "_immojudis_photo_image"
    if name in sys.modules:
        return sys.modules[name]
    spec = importlib.util.spec_from_file_location(name, Path(__file__).resolve().with_name("photo_image.py"))
    if spec is None or spec.loader is None:  # pragma: no cover - le fichier fait partie du dépôt
        raise ImportError("photo_image.py not found")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


photo_image = _load_photo_image()

#: PDF lu au plus (``MAX_PDF_BYTES`` de src/pdf_photos.py, plus une marge pour le voir).
MAX_INPUT_BYTES = 41 * 1024 * 1024
#: Pages parcourues au plus, images distinctes décodées au plus, photos rendues au plus.
MAX_PAGES = 300
MAX_IMAGES_DECODED = 60
MAX_PHOTOS = 12
#: Garde contre les bombes de décompression (même plafond que photo_image).
MAX_PIXELS = photo_image.MAX_PIXELS
#: Plafonds du processus (Linux ; ignorés ailleurs). Un PDF de 40 Mo et ses images tiennent dans 3 Go.
CPU_SECONDS_LIMIT = 150
ADDRESS_SPACE_LIMIT_BYTES = 3 * 1024 * 1024 * 1024

# Règle « photo du bien » (voir la docstring du module).
MIN_SHORT_SIDE = 350
MIN_LONG_SIDE = 500
MAX_ASPECT_RATIO = 2.6
SAMPLE_SIDE = 64
WHITE_LEVEL = 235
MAX_WHITE_SHARE = 0.40
MIN_STDDEV = 35.0
MIN_COLOURS = 1500


@dataclass(frozen=True)
class ImageStats:
    """Mesures sur une réduction à 64 x 64 px."""

    white: float
    stddev: float
    colours: int


def size_rejection(width: int, height: int) -> str | None:
    """``too_small`` ou ``bad_aspect`` d'après les dimensions de l'image (avant tout décodage)."""
    if width <= 0 or height <= 0:
        return "too_small"
    shortest, longest = min(width, height), max(width, height)
    if shortest < MIN_SHORT_SIDE or longest < MIN_LONG_SIDE:
        return "too_small"
    if longest / shortest > MAX_ASPECT_RATIO:
        return "bad_aspect"
    return None


def image_stats(image: Image.Image) -> ImageStats:
    """Part de blanc, écart type des gris et nombre de couleurs, sur une réduction à 64 x 64 px."""
    rgb = image if image.mode == "RGB" else image.convert("RGB")
    sample = rgb.resize((SAMPLE_SIDE, SAMPLE_SIDE), Image.Resampling.BILINEAR)
    gray = sample.convert("L")
    histogram = gray.histogram()
    pixels = SAMPLE_SIDE * SAMPLE_SIDE
    white = sum(histogram[WHITE_LEVEL + 1 :]) / pixels
    stddev = float(ImageStat.Stat(gray).stddev[0])
    colours = len(sample.getcolors(maxcolors=pixels) or ())
    return ImageStats(white=round(white, 4), stddev=round(stddev, 2), colours=colours)


def stats_rejection(stats: ImageStats) -> str | None:
    """``mostly_white`` (logo, schéma, page scannée), ``low_contrast`` (carte) ou ``few_colours`` (dessin)."""
    if stats.white >= MAX_WHITE_SHARE:
        return "mostly_white"
    if stats.stddev < MIN_STDDEV:
        return "low_contrast"
    if stats.colours < MIN_COLOURS:
        return "few_colours"
    return None


def photo_rejection(image: Image.Image) -> str | None:
    """Motif de refus d'une image décodée, ou ``None`` si c'est vraisemblablement une photo du bien."""
    return size_rejection(image.width, image.height) or stats_rejection(image_stats(image))


@dataclass(frozen=True)
class Placement:
    """Première apparition d'une image dans le document."""

    xref: int
    page: int
    top: float
    left: float
    width: int
    height: int


@dataclass
class ExtractedPhoto:
    sha256: str
    page: int
    position: int
    width: int
    height: int
    stats: ImageStats
    data_640: bytes
    data_1600: bytes
    single: bool


@dataclass
class Extraction:
    pages: int = 0
    images: int = 0
    rejected: Counter[str] = field(default_factory=Counter)
    photos: list[ExtractedPhoto] = field(default_factory=list)


class DocumentProblem(Exception):
    """Un fichier inutilisable : ``reason`` est le motif enregistré."""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


def placements(document: pymupdf.Document, *, max_pages: int = MAX_PAGES) -> list[Placement]:
    """Images dessinées, une fois chacune (première page où elle apparaît), dans l'ordre de lecture."""
    found: dict[int, Placement] = {}
    for index in range(min(document.page_count, max_pages)):
        page = document[index]
        for info in page.get_image_info(xrefs=True):
            xref = int(info.get("xref") or 0)
            if xref <= 0 or xref in found:  # 0 : image en ligne, sans objet à extraire
                continue
            x0, y0, _x1, _y1 = info.get("bbox") or (0.0, 0.0, 0.0, 0.0)
            found[xref] = Placement(
                xref=xref,
                page=index + 1,
                top=float(y0),
                left=float(x0),
                width=int(info.get("width") or 0),
                height=int(info.get("height") or 0),
            )
    return sorted(found.values(), key=lambda item: (item.page, round(item.top), round(item.left), item.xref))


def _decode(document: pymupdf.Document, xref: int) -> Image.Image:
    pixmap = pymupdf.Pixmap(document, xref)
    if pixmap.width * pixmap.height > MAX_PIXELS:
        raise DocumentProblem("decompression_bomb")
    if pixmap.alpha:
        pixmap = pymupdf.Pixmap(pixmap, 0)
    if pixmap.colorspace is None or pixmap.colorspace.n != 3:
        pixmap = pymupdf.Pixmap(pymupdf.csRGB, pixmap)
    return Image.frombytes("RGB", (pixmap.width, pixmap.height), pixmap.samples)


def extract(data: bytes, *, max_photos: int = MAX_PHOTOS) -> Extraction:
    """Photos du bien contenues dans un PDF, ré-encodées en WebP, dans l'ordre du document."""
    max_photos = min(max(int(max_photos), 1), MAX_PHOTOS)
    if not data.lstrip()[:5].startswith(b"%PDF-"):
        raise DocumentProblem("not_pdf")
    try:
        document = pymupdf.open(stream=data, filetype="pdf")
    except Exception as exc:  # noqa: BLE001 - tout fichier illisible est refusé de la même façon
        raise DocumentProblem("unreadable_pdf") from exc
    result = Extraction()
    with document:
        # Un PDF protégé par un simple mot de passe propriétaire (impression interdite…) s'ouvre sans mot de
        # passe : seul un mot de passe d'ouverture le rend illisible.
        if document.needs_pass:
            raise DocumentProblem("encrypted")
        result.pages = document.page_count
        try:
            found = placements(document)
        except Exception as exc:  # noqa: BLE001 - page mal formée : le document entier est refusé
            raise DocumentProblem("unreadable_pdf") from exc
        result.images = len(found)
        hashes: set[str] = set()
        decoded = 0
        for rank, placement in enumerate(found, start=1):
            if len(result.photos) >= max_photos:
                # Plafond atteint : les images suivantes ne sont pas examinées.
                result.rejected["over_cap"] += len(found) - rank + 1
                break
            reason = size_rejection(placement.width, placement.height)
            if reason is None and placement.width * placement.height > MAX_PIXELS:
                reason = "decompression_bomb"
            if reason is not None:
                result.rejected[reason] += 1
                continue
            try:
                sha256 = hashlib.sha256(document.xref_stream_raw(placement.xref) or b"").hexdigest()
            except Exception:  # noqa: BLE001
                result.rejected["decode_error"] += 1
                continue
            if sha256 in hashes:
                result.rejected["duplicate"] += 1
                continue
            hashes.add(sha256)
            if decoded >= MAX_IMAGES_DECODED:
                result.rejected["over_decode_budget"] += 1
                continue
            decoded += 1
            try:
                image = _decode(document, placement.xref)
                stats = image_stats(image)
                reason = size_rejection(image.width, image.height) or stats_rejection(stats)
                if reason is not None:
                    result.rejected[reason] += 1
                    continue
                data_640 = photo_image._encode_webp(image, photo_image.WIDTHS[0])
                single = image.width <= photo_image.WIDTHS[0]
                data_1600 = data_640 if single else photo_image._encode_webp(image, photo_image.WIDTHS[1])
            except DocumentProblem as problem:
                result.rejected[problem.reason] += 1
                continue
            except photo_image.ImageProblem as problem:
                result.rejected[problem.reason] += 1
                continue
            except (RuntimeError, ValueError, OSError, MemoryError):
                result.rejected["decode_error"] += 1
                continue
            result.photos.append(
                ExtractedPhoto(
                    sha256=sha256,
                    page=placement.page,
                    position=rank,
                    width=image.width,
                    height=image.height,
                    stats=stats,
                    data_640=data_640,
                    data_1600=data_1600,
                    single=single,
                )
            )
    return result


# --------------------------------------------------------------------------------------------------
# Sous-processus
# --------------------------------------------------------------------------------------------------


def _parse_max_photos(argv: list[str]) -> int:
    if len(argv) == 2 and argv[0] == "--max-photos":
        try:
            return int(argv[1])
        except ValueError:
            pass
    if argv:
        raise SystemExit("usage: pdf_photo_extract.py [--max-photos N]")
    return MAX_PHOTOS


def encode_result(result: Extraction) -> bytes:
    """La ligne JSON, puis les fichiers WebP dans l'ordre de ``photos``."""
    entries: list[dict[str, object]] = []
    body = bytearray()
    for photo in result.photos:
        second = b"" if photo.single else photo.data_1600
        entries.append(
            {
                "sha256": photo.sha256,
                "page": photo.page,
                "position": photo.position,
                "width": photo.width,
                "height": photo.height,
                "single": photo.single,
                "len640": len(photo.data_640),
                "len1600": len(second),
                "white": photo.stats.white,
                "stddev": photo.stats.stddev,
                "colours": photo.stats.colours,
            }
        )
        body += photo.data_640 + second
    header = {
        "ok": True,
        "pages": result.pages,
        "images": result.images,
        "rejected": dict(sorted(result.rejected.items())),
        "photos": entries,
    }
    return json.dumps(header, sort_keys=True).encode("ascii") + b"\n" + bytes(body)


def main(argv: list[str] | None = None) -> int:
    max_photos = _parse_max_photos(list(sys.argv[1:] if argv is None else argv))
    photo_image.apply_resource_limits(CPU_SECONDS_LIMIT, ADDRESS_SPACE_LIMIT_BYTES)
    try:
        pymupdf.TOOLS.mupdf_display_errors(False)
    except Exception:  # noqa: BLE001 - réglage d'affichage seulement
        pass
    data = sys.stdin.buffer.read(MAX_INPUT_BYTES + 1)
    if len(data) > MAX_INPUT_BYTES:
        output = json.dumps({"ok": False, "reason": "too_large"}, sort_keys=True).encode("ascii") + b"\n"
    else:
        try:
            output = encode_result(extract(data, max_photos=max_photos))
        except DocumentProblem as problem:
            output = json.dumps({"ok": False, "reason": problem.reason}, sort_keys=True).encode("ascii") + b"\n"
    out = sys.stdout.buffer
    out.write(output)
    out.flush()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
