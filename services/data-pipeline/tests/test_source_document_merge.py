"""Type d'une pièce sans type quand une source fusionne la fiche dans la vente de la carte."""

from __future__ import annotations

import importlib

import pytest

from src.pdf_document_types import canonical_document_type, refined_document_type
from src.sources.source_features import merge_documents

SOURCES = {
    "encheres_immobilieres": "https://encheresimmobilieres.fr/annonce/123",
    "petites_affiches": "https://www.petitesaffiches.fr/annonce/123",
    "vench": "https://www.vench.fr/vente/123",
    "info_encheres": "https://www.info-encheres.com/annonce-123.html",
    "avoventes": "https://avoventes.fr/enchere/123",
}
DETAIL_HTML = (
    "<html><body><h1>Appartement</h1><p>Description du bien</p>"
    '<a href="/documents/cahier.pdf">Cahier des conditions de vente</a></body></html>'
)
# Une adresse sans « .pdf », un « .pdf » dans le seul libellé, au milieu de l'adresse, en fin d'adresse.
UNTYPED = (
    ("Telecharger", "/telechargement?id=7"),
    ("Annexe.pdf", "/telechargement?id=8"),
    ("Plan", "/doc/plan.pdf?v=2"),
    ("Fiche", "/doc/fiche.pdf"),
)
# Type que chaque site donne au lien de la fiche : il reste propre au site.
DETAIL_LINK_TYPE = {
    "encheres_immobilieres": "pdf",
    "petites_affiches": "pdf",
    "vench": "cahier_conditions",
    "info_encheres": "cahier_conditions",
    "avoventes": "pdf",
}
FIRST_PAGE = "PROCÈS-VERBAL DE DESCRIPTION. L'an deux mille vingt-six, le commissaire de justice soussigné. " * 4


class _DetailClient:
    def __init__(self, html: str, expected_url: str) -> None:
        self.html = html
        self.expected_url = expected_url

    def get(self, url: str) -> str:
        assert url == self.expected_url
        return self.html


@pytest.mark.parametrize("source", sorted(SOURCES))
def test_untyped_documents_of_the_listing_get_one_default_type_when_the_detail_is_merged(source: str) -> None:
    module = importlib.import_module(f"src.sources.{source}")
    source_url = SOURCES[source]
    base = "/".join(source_url.split("/", 3)[:3])
    sale = {
        "source_url": source_url,
        "documents": [{"label": label, "url": base + path} for label, path in UNTYPED],
    }
    errors: list[str] = []

    module._enrich_sale_from_detail(_DetailClient(DETAIL_HTML, source_url), sale, errors)

    assert errors == []
    assert [(document["label"], document["type"]) for document in sale["documents"]] == [
        *((label, "pdf") for label, _ in UNTYPED),
        ("Cahier des conditions de vente", DETAIL_LINK_TYPE[source]),
    ]


def test_the_default_type_leaves_the_classification_to_the_label_then_to_the_first_page() -> None:
    named, unnamed = merge_documents(
        None,
        [
            {"label": "Cahier des conditions de vente", "url": "https://site.test/telechargement?id=1"},
            {"label": "Télécharger", "url": "https://site.test/telechargement?id=2"},
        ],
    )

    assert canonical_document_type(named["type"], label=named["label"], url=named["url"]) == "cahier_conditions_vente"
    # Ni le libellé ni l'adresse ne disent rien : la pièce reste à télécharger (pas « other ») et sa première page
    # la classe. Avec « document », cette page ne serait pas lue.
    assert canonical_document_type(unnamed["type"], label=unnamed["label"], url=unnamed["url"]) == "pdf"
    assert refined_document_type({**unnamed, "pages": [{"page": 1, "text": FIRST_PAGE}]}) == "pv_huissier"
    assert refined_document_type({**unnamed, "type": "document", "pages": [{"page": 1, "text": FIRST_PAGE}]}) == (
        "document"
    )


def test_a_later_reading_of_the_same_document_wins_and_a_published_type_is_kept() -> None:
    merged = merge_documents(
        [{"label": "Ancien libellé", "url": "https://site.test/a"}, "pas une pièce", {"label": "Sans adresse"}],
        [{"label": "PV descriptif", "url": "https://site.test/a", "type": "pv_descriptif"}],
    )

    assert merged == [{"label": "PV descriptif", "url": "https://site.test/a", "type": "pv_descriptif"}]
    assert merge_documents([{"url": "https://site.test/b"}], None) == [
        {"label": "document", "url": "https://site.test/b", "type": "pdf"}
    ]
