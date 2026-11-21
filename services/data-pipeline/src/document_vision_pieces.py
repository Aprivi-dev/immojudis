"""Les pièces d'une lecture par un modèle qui lit les pages : téléchargement, PDF utilisables, pages en image.

Partagé par le banc (``scripts/compare_document_vision.py``) et la passe d'écriture (``src.document_vision_pass``) :
les deux lisent les mêmes pièces de la même façon. Le téléchargement est le téléchargement poli du pipeline
(robots.txt, cadence par hôte, sources retirées, garde d'Enchères Publiques), dans un dossier temporaire effacé
ensuite ; une pièce non obtenue est rendue avec son motif, jamais avec un message d'erreur (il pourrait citer la
pièce).
"""

from __future__ import annotations

import hashlib
import tempfile
from collections import Counter
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, Any
from urllib.parse import urlsplit

import httpx
import pymupdf

from src.config import load_settings
from src.document_reading import ReadingDocument
from src.document_vision import PageRef, page_field_score
from src.normalize import clean_text
from src.pdf_deadline import PdfExtractionDeferred
from src.pdf_ocr import (
    OCR_NO_TEXT_METHOD,
    OCR_NO_TEXT_UNVERIFIED_METHOD,
    OCR_PICTURE_NO_TEXT_METHOD,
    extract_page_text_with_ocr_result,
    pdf_document_ocr_budget_scope,
)
from src.pdf_page_analysis import page_has_substantial_image
from src.sources.cloud_transport import SOURCE_HOSTS, configured_transport

if TYPE_CHECKING:
    from src.models import AuctionSale
    from src.pdf_enrichment import PdfEnrichmentStats

# OCR d'une page citée, le temps de la vérification : le même délai qu'une page du pipeline (``src.pdf_ocr``).
OCR_PAGE_SECONDS = 60.0
# Méthodes de ``pdf_ocr`` qui gardent le texte natif faute d'avoir lu quoi que ce soit : pas un texte d'OCR.
_OCR_WITHOUT_TEXT = frozenset({OCR_NO_TEXT_METHOD, OCR_NO_TEXT_UNVERIFIED_METHOD, OCR_PICTURE_NO_TEXT_METHOD})


@dataclass(frozen=True)
class FetchedPieces:
    """Les pièces demandées : le PDF de chacune de celles obtenues, et pour chaque autre, pourquoi elle n'a pas été
    obtenue (un motif de :data:`NO_PDF_REASONS` ; :data:`NO_PDF_OTHER` à défaut)."""

    pdfs: Mapping[str, bytes]
    missing: Mapping[str, str] = field(default_factory=dict)


# Les pièces ``urls`` d'une vente (ligne de la vente, avec au moins son identifiant et son URL source).
FetchPdfs = Callable[[Mapping[str, Any], Sequence[str]], FetchedPieces]

# Pourquoi une page qui parle des champs ne peut pas entrer dans l'extrait envoyé au modèle. D'abord, pourquoi le PDF
# de sa pièce n'a pas été obtenu (:func:`missing_piece_reason`).
NO_PDF = "pièce sans PDF"
NO_PDF_WORD = f"{NO_PDF} : Word"  # pièce téléchargée, document Word
NO_PDF_HTML = f"{NO_PDF} : HTML ou autre format"  # réponse qui n'est ni un PDF ni un document Word
NO_PDF_CAP = f"{NO_PDF} : limite de pièces par vente"  # laissée de côté par la sélection du téléchargeur poli
NO_PDF_ROBOTS = f"{NO_PDF} : robots.txt"  # robots.txt de l'hôte l'interdit
NO_PDF_NETWORK = f"{NO_PDF} : erreur réseau"  # 429, 5xx, délai, connexion, ou robots.txt de l'hôte injoignable
NO_PDF_RELAY = f"{NO_PDF} : relais SOURCE_FETCH_RELAY non disponible"  # hôte servi par le relais, non configuré
# Accès refusé, introuvable, trop lourde, source retirée, lien écarté ou type « other », autre erreur.
NO_PDF_OTHER = f"{NO_PDF} : autre motif"
NO_PDF_REASONS = (NO_PDF_WORD, NO_PDF_HTML, NO_PDF_CAP, NO_PDF_ROBOTS, NO_PDF_NETWORK, NO_PDF_RELAY, NO_PDF_OTHER)
PDF_CHANGED = "PDF modifié depuis la lecture"  # empreinte différente de celle du texte lu
PDF_UNREADABLE = "PDF illisible"  # pymupdf ne l'ouvre pas
PAGE_OUT_OF_RANGE = "page hors bornes"  # numéro de page au-delà des pages du PDF
UNUSABLE_REASONS = (*NO_PDF_REASONS, PDF_CHANGED, PDF_UNREADABLE, PAGE_OUT_OF_RANGE)
_WORD_FORMATS = frozenset({"doc", "docx"})


def missing_piece_reason(
    url: str,
    *,
    file_format: str | None,
    selected: bool,
    selectable_alone: bool,
    document_type: str,
    stats: PdfEnrichmentStats,
    relay_available: bool,
) -> str:
    """Pourquoi le téléchargement poli (``src.pdf_enrichment.download_documents``) n'a pas rendu de PDF pour ``url``.

    ``file_format`` : le format de la pièce téléchargée (None : pas téléchargée). ``selected`` : la sélection du
    téléchargeur l'a retenue ; ``selectable_alone`` : elle la retiendrait seule (une pièce retenue seule mais pas avec
    les autres a été coupée par la limite de pièces par vente). ``stats`` : ce que le téléchargement a noté, pièce par
    pièce. ``relay_available`` : la pièce passerait par le relais des hôtes qui refusent le réseau du runner
    (:func:`relay_configured`).
    """
    if file_format in _WORD_FORMATS:
        return NO_PDF_WORD
    if not selected:
        return NO_PDF_CAP if selectable_alone else NO_PDF_OTHER
    if document_type == "other":
        return NO_PDF_OTHER  # sautée par le téléchargeur sans requête
    permanent = {failure.get("url"): failure.get("reason") for failure in stats.permanent_document_failures}.get(url)
    if url in stats.blocked_document_urls or permanent == "robots_disallowed":
        return NO_PDF_ROBOTS
    parts = urlsplit(url)
    if not relay_available and parts.hostname in SOURCE_HOSTS:
        return NO_PDF_RELAY
    if permanent == "unsupported_response":
        return NO_PDF_HTML
    # Une erreur réseau est notée pour la pièce, ou pour l'origine dont robots.txt n'a pas répondu.
    origins = {url, f"{parts.scheme}://{parts.netloc.lower()}"}
    if permanent is None and any(failure.origin in origins for failure in stats.network_failures):
        return NO_PDF_NETWORK
    return NO_PDF_OTHER


def relay_configured(url: str) -> bool:
    """Le téléchargement de ``url`` passerait par le relais : hôte servi par lui, adresse HTTPS ET jeton présents.

    Même règle que le téléchargement, qui la tient de ``cloud_transport.configured_transport`` : une adresse sans
    jeton (ou l'inverse) fait échouer la requête, le relais n'est pas disponible. Rien n'est envoyé.
    """
    try:
        transport = configured_transport(url)
    except (ValueError, httpx.InvalidURL):
        return False
    if transport is None:
        return False
    transport.close()
    return True


def usable_documents(
    manifest: object, documents: Sequence[ReadingDocument], fetched: FetchedPieces, unreadable: Counter[str]
) -> tuple[dict[int, bytes], list[ReadingDocument], Counter[str]]:
    """Les pièces que l'extrait peut porter : leur PDF par index, ces pièces réduites aux pages que le PDF contient,
    et le décompte, par motif, des pages qui parlent des champs et qui sont écartées.

    Un PDF ne sert que s'il est celui dont le texte a été lu (même empreinte quand le manifeste la donne) et que
    pymupdf l'ouvre. Les numéros de page du manifeste comptent à partir de 1 (``extract_pdf_pages``) : la page n est
    la page d'indice n - 1 pour pymupdf, comme dans ``build_document_excerpt``.
    """
    items = manifest if isinstance(manifest, list) else []
    expected = {clean_text(item.get("url")): item.get("sha256") for item in items if isinstance(item, Mapping)}
    pdfs: dict[int, bytes] = {}
    kept: list[ReadingDocument] = []
    unusable: Counter[str] = Counter()
    for doc in documents:
        scored = [number for number, text in doc.pages.items() if page_field_score(text) > 0]
        content = fetched.pdfs.get(doc.url) if doc.url else None
        sha256 = expected.get(doc.url)
        if content is None:
            unusable[fetched.missing.get(doc.url, NO_PDF_OTHER) if doc.url else NO_PDF_OTHER] += len(scored)
            continue
        if isinstance(sha256, str) and sha256 and hashlib.sha256(content).hexdigest() != sha256:
            unusable[PDF_CHANGED] += len(scored)
            continue
        document = open_pdf(content, unreadable)
        if document is None:
            unusable[PDF_UNREADABLE] += len(scored)
            continue
        with document:
            page_count = document.page_count
        if not sha256 and doc.pages and max(doc.pages) > page_count:
            # Sans empreinte, un PDF plus court que le texte lu n'est pas celui qui a été lu : la pièce entière est
            # écartée, et ses pages restantes ne sont pas réputées être celles du texte.
            unusable[PDF_CHANGED] += len(scored)
            continue
        unusable[PAGE_OUT_OF_RANGE] += sum(1 for number in scored if not 1 <= number <= page_count)
        pages = {number: text for number, text in doc.pages.items() if 1 <= number <= page_count}
        if pages:
            pdfs[doc.index] = content
            kept.append(ReadingDocument(doc.index, doc.label, doc.url, doc.document_type, pages))
    return pdfs, kept, +unusable


def manifest_pages(manifest: object) -> list[tuple[str | None, Mapping[str, Any]]]:
    """Chaque page du manifeste ``pdf_text``, avec l'URL de sa pièce."""
    pages: list[tuple[str | None, Mapping[str, Any]]] = []
    for item in manifest if isinstance(manifest, list) else []:
        if isinstance(item, Mapping):
            url = clean_text(item.get("url"))
            pages += [(url, page) for page in item.get("pages") or [] if isinstance(page, Mapping)]
    return pages


def page_number(page: Mapping[str, Any]) -> int:
    try:
        return int(page.get("page") or 0)
    except (TypeError, ValueError):
        return 0


def ocr_read_pages(manifest: object, documents: Sequence[ReadingDocument]) -> frozenset[PageRef]:
    """Les pages dont le texte gardé par le pipeline vient d'un OCR qui a lu quelque chose."""
    read_by_ocr = {
        (url, page_number(page))
        for url, page in manifest_pages(manifest)
        if str(page.get("method") or "").startswith("ocr_") and page.get("method") not in _OCR_WITHOUT_TEXT
    }
    return frozenset(PageRef(doc.index, n) for doc in documents for n in doc.pages if (doc.url, n) in read_by_ocr)


def open_pdf(content: bytes, unreadable: Counter[str]) -> Any | None:
    """La pièce ouverte par pymupdf, ou None : une pièce qu'il n'ouvre pas est sautée et comptée par type d'erreur
    (jamais par message, qui pourrait citer la pièce), sans arrêter la lecture."""
    try:
        return pymupdf.open(stream=content, filetype="pdf")
    except Exception as exc:  # pymupdf lève selon le défaut FileDataError, RuntimeError, ValueError…
        unreadable[type(exc).__name__] += 1
        return None


def image_pages(
    pdfs: Mapping[int, bytes], pages: Sequence[PageRef], ocr_pages: frozenset[PageRef], unreadable: Counter[str]
) -> frozenset[PageRef]:
    """Parmi ``pages``, celles dont une image couvre une part notable (même seuil que le pipeline pour lancer l'OCR
    d'une page mixte) et dont le texte ne vient pas d'un OCR : la couche texte n'en dit peut-être qu'un en-tête."""
    found: set[PageRef] = set()
    for document_index in sorted({ref.document for ref in pages}):
        content = pdfs.get(document_index)
        document = open_pdf(content, unreadable) if content else None
        if document is None:
            continue
        with document:
            for ref in pages:
                if (
                    ref.document == document_index
                    and ref not in ocr_pages
                    and 1 <= ref.page <= document.page_count
                    and page_has_substantial_image(document[ref.page - 1])
                ):
                    found.add(ref)
    return frozenset(found)


def tesseract_page_reader(pdfs: Mapping[int, bytes], unreadable: Counter[str]) -> Callable[[PageRef], str | None]:
    """OCR d'une page d'une pièce par le Tesseract du pipeline (``src.pdf_ocr``), borné à ``OCR_PAGE_SECONDS``.

    Rend le seul texte lu par l'OCR, sans la couche texte de la page (déjà dans le texte gardé par le pipeline) : un
    titre de lot n'y est pas compté deux fois et la tolérance de l'OCR ne s'applique pas au texte natif. None si
    l'OCR n'a rien lu, a échoué ou n'est pas installé.
    """
    settings = load_settings()

    def read(ref: PageRef) -> str | None:
        content = pdfs.get(ref.document)
        document = open_pdf(content, unreadable) if content else None
        if document is None:
            return None
        try:
            with document:
                if not 1 <= ref.page <= document.page_count:
                    return None
                with pdf_document_ocr_budget_scope(OCR_PAGE_SECONDS):
                    result = extract_page_text_with_ocr_result(document[ref.page - 1], "", settings=settings)
        except PdfExtractionDeferred:
            return None
        return clean_text(result.get("text"))

    return read


def download_sale_pdfs(sale: AuctionSale, urls: Sequence[str]) -> FetchedPieces:
    """Les pièces ``urls`` de la vente, par le téléchargement poli du pipeline (robots.txt, cadence par hôte,
    sources retirées, garde d'Enchères Publiques), dans un dossier temporaire effacé ensuite ; et pour chaque pièce
    non obtenue, pourquoi (:func:`missing_piece_reason`)."""
    from src.pdf_document_selection import select_documents_for_extraction
    from src.pdf_document_types import canonical_document_type
    from src.pdf_enrichment import PdfEnrichmentStats, download_documents

    wanted = set(urls)
    # Copie en mémoire, réduite aux pièces demandées : sans l'état de lecture des pièces, la sélection ne saute pas
    # les pièces déjà lues (celles-là mêmes dont on veut les pages). La vente reçue n'est pas modifiée.
    sale = sale.model_copy(
        update={
            "documents": [document for document in sale.documents if document.get("url") in wanted],
            "raw_payload": {key: value for key, value in sale.raw_payload.items() if key != "document_analysis"},
        }
    )
    # La même sélection que celle du téléchargement, lue avant lui : ce qu'il demandera.
    selected = {document.get("url") for document in select_documents_for_extraction(sale.documents, sale=sale)}
    stats = PdfEnrichmentStats()
    with tempfile.TemporaryDirectory(prefix="document-vision-") as directory:
        downloaded = download_documents(sale, output_root=Path(directory), stats=stats)
        formats = {str(item["url"]): item.get("file_format") for item in downloaded if item.get("url") in wanted}
        pdfs = {
            str(item["url"]): Path(item["file_path"]).read_bytes()
            for item in downloaded
            if item.get("file_format") == "pdf" and item.get("url") in wanted
        }
    missing: dict[str, str] = {}
    for document in sale.documents:
        url = str(document.get("url"))
        if url in pdfs or url in missing:
            continue
        missing[url] = missing_piece_reason(
            url,
            file_format=formats.get(url),
            selected=url in selected,
            selectable_alone=bool(select_documents_for_extraction([document], sale=sale)),
            document_type=canonical_document_type(
                document.get("document_type") or document.get("type"), label=document.get("label"), url=url
            ),
            stats=stats,
            relay_available=relay_configured(url),
        )
    return FetchedPieces(pdfs, missing)
