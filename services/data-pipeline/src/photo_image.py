"""Décodage et ré-encodage des photos tierces, dans un sous-processus sans secret (point 50).

Pillow décode des octets que nous ne maîtrisons pas (fichiers de sites tiers). Une faille de décodeur ne doit
pas se trouver dans le processus qui porte ``SUPABASE_SERVICE_ROLE_KEY`` et ``SUPABASE_DB_URL``. Ce module est
donc **autonome** (bibliothèque standard et Pillow, aucun import du projet) et se lance seul :

``python -I src/photo_image.py --max-pixels N``, appelé par ``src.photo_mirror.process_image`` avec un
environnement minimal (liste blanche, aucun secret), un répertoire de travail vide, un délai et des plafonds
de processeur et de mémoire. L'original arrive sur l'entrée standard ; le résultat sort sur la sortie standard :
une ligne JSON, puis les octets WebP.

* ``{"ok": true, "width": W, "height": H, "single": bool, "len640": N, "len1600": M}`` puis les deux fichiers
  (``len1600`` vaut 0 quand l'original fait 640 px de large ou moins : un seul fichier) ;
* ``{"ok": false, "reason": "...", "width": W|null, "height": H|null}`` pour une image refusée (trop petite,
  allongée, mal formée, bombe de décompression…). Un plantage du décodeur n'écrit rien et sort en erreur.

Les bornes sont celles du traitement d'origine : pixels (``--max-pixels``, jamais au-dessus de
``MAX_PIXELS``), taille de sortie (plafond du bucket), tailles minimales et rapport d'aspect du site.
"""

from __future__ import annotations

import io
import json
import sys
import warnings
from collections.abc import Iterator, Mapping
from contextlib import contextmanager
from dataclasses import dataclass

from PIL import Image, ImageCms, ImageOps

WIDTHS = (640, 1600)
WEBP_QUALITY = 75
# Même plafond que le bucket (file_size_limit de la migration).
BUCKET_FILE_LIMIT_BYTES = 2 * 1024 * 1024
PREFIX_BYTES = 64
# Garde contre les bombes de décompression : 40 mégapixels font environ 120 Mo une fois décodés en RGB.
MAX_PIXELS = 40_000_000
# Même règle que shouldRejectRenderedPropertyImage (src/lib/sale-media.ts).
MIN_SHORT_SIDE = 300
MIN_LONG_SIDE = 480
MAX_ASPECT_RATIO = 3.2

#: Un original dépasse rarement 8 Mo (MAX_DOWNLOAD_BYTES de photo_mirror) ; on en lit un peu plus pour le voir.
MAX_INPUT_BYTES = 9 * 1024 * 1024
#: Plafonds du processus de décodage (Linux ; ignorés ailleurs).
CPU_SECONDS_LIMIT = 90
ADDRESS_SPACE_LIMIT_BYTES = 2 * 1024 * 1024 * 1024


class ImageProblem(Exception):
    """Une image qui n'est pas utilisable : ``reason`` est le motif enregistré (jamais retenté)."""

    def __init__(self, reason: str, *, width: int | None = None, height: int | None = None) -> None:
        super().__init__(reason)
        self.reason = reason
        self.width = width
        self.height = height


@dataclass(frozen=True)
class Processed:
    width: int
    height: int
    data_640: bytes
    data_1600: bytes
    #: Un seul fichier : l'original fait 640 px de large ou moins.
    single: bool


def sniff_image_type(head: bytes) -> str:
    """Type d'après les premiers octets : ``jpeg``, ``png`` ou ``webp``. GIF, SVG et le reste sont refusés."""
    if head.startswith(b"\xff\xd8\xff"):
        return "jpeg"
    if head.startswith(b"\x89PNG\r\n\x1a\n"):
        return "png"
    if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return "webp"
    if head[:6] in (b"GIF87a", b"GIF89a"):
        raise ImageProblem("gif_refused")
    stripped = head.lstrip(b"\xef\xbb\xbf \t\r\n").lower()
    if stripped.startswith((b"<svg", b"<?xml", b"<!doctype svg")):
        raise ImageProblem("svg_refused")
    raise ImageProblem("unsupported_type")


def rejection_reason(width: int, height: int) -> str | None:
    """Même règle que ``shouldRejectRenderedPropertyImage`` (src/lib/sale-media.ts)."""
    if not width or not height:
        return None
    shortest, longest = min(width, height), max(width, height)
    if shortest < MIN_SHORT_SIDE or longest < MIN_LONG_SIDE:
        return "too_small"
    if longest / shortest > MAX_ASPECT_RATIO:
        return "too_elongated"
    return None


@contextmanager
def _pixel_limit(max_pixels: int) -> Iterator[None]:
    previous = Image.MAX_IMAGE_PIXELS
    Image.MAX_IMAGE_PIXELS = max_pixels
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            yield
    finally:
        Image.MAX_IMAGE_PIXELS = previous


def _encode_webp(image: Image.Image, width: int) -> bytes:
    """Ré-encode ``image`` à ``width`` px au plus (jamais agrandie), sans aucune métadonnée."""
    if width < image.width:
        height = max(1, round(image.height * width / image.width))
        output = image.resize((width, height), Image.Resampling.LANCZOS, reducing_gap=3.0)
    else:
        output = image.copy()
    # Rien de la source (EXIF, XMP, profil ICC, commentaires) n'est confié à l'encodeur.
    output.info = {}
    buffer = io.BytesIO()
    output.save(buffer, "WEBP", quality=WEBP_QUALITY, method=4)
    data = buffer.getvalue()
    if len(data) > BUCKET_FILE_LIMIT_BYTES:
        raise ImageProblem("output_too_large")
    return data


#: Formats Pillow acceptés pour chaque signature. Un JPEG multi-images (certains appareils et téléphones) s'ouvre
#: en ``MPO`` : même signature d'octets, la première image est la photo.
EXPECTED_FORMATS: Mapping[str, frozenset[str]] = {
    "jpeg": frozenset({"JPEG", "MPO"}),
    "png": frozenset({"PNG"}),
    "webp": frozenset({"WEBP"}),
}


def _to_srgb(image: Image.Image) -> Image.Image:
    """Convertit en sRGB quand l'image porte un profil ICC ; le résultat n'en porte plus.

    Sans cela, le navigateur afficherait le WebP ré-encodé (sans profil, donc lu comme sRGB) avec des couleurs
    décalées pour un original Display P3, Adobe RGB ou CMJN. Un profil illisible est abandonné et les pixels
    sont pris tels quels.
    """
    icc = image.info.get("icc_profile")
    if not icc:
        return image
    has_alpha = image.mode in ("RGBA", "LA", "PA") or (image.mode == "P" and "transparency" in image.info)
    alpha = image.convert("RGBA").getchannel("A") if has_alpha else None
    base = image if image.mode in ("RGB", "L", "CMYK") else image.convert("RGB")
    try:
        source = ImageCms.ImageCmsProfile(io.BytesIO(icc))
        converted = ImageCms.profileToProfile(
            base,
            source,
            ImageCms.createProfile("sRGB"),
            renderingIntent=ImageCms.Intent.PERCEPTUAL,
            outputMode="RGB",
        )
    except (ImageCms.PyCMSError, OSError, ValueError, TypeError):
        converted = base.convert("RGB")
    if converted is None:  # pragma: no cover - seulement quand inPlace est demandé
        converted = base.convert("RGB")
    if alpha is not None:
        converted.putalpha(alpha)
    converted.info = {}
    return converted


def process(data: bytes, *, max_pixels: int = MAX_PIXELS) -> Processed:
    """Contrôle, oriente et ré-encode un original téléchargé en fichiers à héberger."""
    max_pixels = min(max(int(max_pixels), 1), MAX_PIXELS)
    kind = sniff_image_type(data[:PREFIX_BYTES])
    expected = EXPECTED_FORMATS[kind]
    try:
        with _pixel_limit(max_pixels):
            source = Image.open(io.BytesIO(data))
            if source.format not in expected:
                raise ImageProblem("unsupported_type")
            if source.width * source.height > max_pixels:
                raise ImageProblem("decompression_bomb", width=source.width, height=source.height)
            source.load()
            oriented = ImageOps.exif_transpose(source)
            if oriented is None:  # pragma: no cover - in_place n'est jamais demandé
                oriented = source
            width, height = oriented.size
            reason = rejection_reason(width, height)
            if reason is not None:
                raise ImageProblem(reason, width=width, height=height)
            oriented = _to_srgb(oriented)
            if oriented.mode in ("RGBA", "LA") or (oriented.mode == "P" and "transparency" in oriented.info):
                prepared = oriented.convert("RGBA")
            elif oriented.mode != "RGB":
                prepared = oriented.convert("RGB")
            else:
                prepared = oriented
            data_640 = _encode_webp(prepared, WIDTHS[0])
            single = width <= WIDTHS[0]
            data_1600 = data_640 if single else _encode_webp(prepared, WIDTHS[1])
    except ImageProblem:
        raise
    except (Image.DecompressionBombError, Image.DecompressionBombWarning) as exc:
        raise ImageProblem("decompression_bomb") from exc
    except (OSError, ValueError, SyntaxError, EOFError, MemoryError) as exc:
        raise ImageProblem("decode_error") from exc
    return Processed(width=width, height=height, data_640=data_640, data_1600=data_1600, single=single)


# --------------------------------------------------------------------------------------------------
# Sous-processus
# --------------------------------------------------------------------------------------------------


def _apply_resource_limits() -> None:
    """Plafonds de processeur et de mémoire du décodeur, là où le système les connaît (Linux)."""
    try:
        import resource

        resource.setrlimit(resource.RLIMIT_CPU, (CPU_SECONDS_LIMIT, CPU_SECONDS_LIMIT))
        resource.setrlimit(resource.RLIMIT_AS, (ADDRESS_SPACE_LIMIT_BYTES, ADDRESS_SPACE_LIMIT_BYTES))
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    except (ImportError, ValueError, OSError):
        pass


def _parse_max_pixels(argv: list[str]) -> int:
    if len(argv) == 2 and argv[0] == "--max-pixels":
        try:
            return int(argv[1])
        except ValueError:
            pass
    if argv:
        raise SystemExit("usage: photo_image.py [--max-pixels N]")
    return MAX_PIXELS


def main(argv: list[str] | None = None) -> int:
    max_pixels = _parse_max_pixels(list(sys.argv[1:] if argv is None else argv))
    _apply_resource_limits()
    data = sys.stdin.buffer.read(MAX_INPUT_BYTES + 1)
    if len(data) > MAX_INPUT_BYTES:
        header: dict[str, object] = {"ok": False, "reason": "too_large", "width": None, "height": None}
        body = b""
    else:
        try:
            processed = process(data, max_pixels=max_pixels)
        except ImageProblem as problem:
            header = {"ok": False, "reason": problem.reason, "width": problem.width, "height": problem.height}
            body = b""
        else:
            second = b"" if processed.single else processed.data_1600
            header = {
                "ok": True,
                "width": processed.width,
                "height": processed.height,
                "single": processed.single,
                "len640": len(processed.data_640),
                "len1600": len(second),
            }
            body = processed.data_640 + second
    out = sys.stdout.buffer
    out.write(json.dumps(header, sort_keys=True).encode("ascii") + b"\n" + body)
    out.flush()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
