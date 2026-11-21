from __future__ import annotations

from datetime import date
from decimal import Decimal

import pymupdf
import pytest

from src import document_vision as vision
from src.document_reading import ReadingDocument, SoldLot
from src.document_vision import (
    ACCEPTED,
    CANDIDATE,
    DISAGREEMENT,
    REJECTED,
    UNKNOWN_STATUS,
    Claim,
    PageRef,
    Reading,
    SaleContext,
)

TODAY = date(2026, 11, 21)
FILLER = "Le présent cahier est déposé au greffe du tribunal judiciaire. " * 2


def _doc(index: int, pages: dict[int, str]) -> ReadingDocument:
    return ReadingDocument(index=index, label="Cahier", url=f"https://example.test/{index}.pdf", document_type="cahier", pages=pages)


def _claim(value: object, quote: str) -> dict[str, object]:
    return {"valeur": value, "citation": quote, "page": 1}


def _pdf(*texts: str) -> bytes:
    document = pymupdf.open()
    for text in texts:
        document.new_page(width=595, height=842).insert_text((72, 72), text)
    content = document.tobytes()
    document.close()
    return content


PAGE = PageRef(1, 1)
PAGE_TEXT = (
    "Désignation : un appartement de type T3 comprenant 3 pièces principales, d'une surface habitable de "
    "62,40 m², soit une superficie loi Carrez de 61,8 m². Le bien est occupé par un locataire en vertu d'un "
    "bail du 1er mars 2020. Les visites auront lieu le 3 et le 10 décembre 2026 à 10 heures."
)


def _context(text: str = PAGE_TEXT, **kwargs: object) -> SaleContext:
    return SaleContext(page_texts={PAGE: text}, **kwargs)  # type: ignore[arg-type]


def _reading(**claims: dict[str, object]) -> Reading:
    return _reading_saying("non", **claims)


def _reading_saying(several_lots: str, **claims: dict[str, object]) -> Reading:
    return vision.parse_reading({"plusieurs_lots": several_lots, "champs": claims}, list(claims), [PAGE])


# --- Choix des pages ----------------------------------------------------------------------------------------------


def test_page_selection_keeps_at_most_ten_pages_about_the_fields_in_dossier_order() -> None:
    rich = "Surface habitable 50 m², 3 pièces, bien libre, visite le 3 décembre. " + FILLER
    plain = "Surface de 40 m2. " + FILLER
    empty = FILLER
    documents = [
        _doc(1, {number: plain for number in range(1, 9)} | {9: empty}),
        _doc(2, {1: empty, 2: rich, 3: rich, 4: plain}),
    ]

    pages = vision.select_vision_pages(documents)

    assert len(pages) == 10
    assert PageRef(2, 2) in pages and PageRef(2, 3) in pages
    assert PageRef(1, 9) not in pages and PageRef(2, 1) not in pages
    assert pages == sorted(pages)
    # Richest first: the two rich pages are kept, then plain pages in dossier order up to ten.
    assert PageRef(2, 4) not in pages


TEMPLATE_PAGE = (
    "Conformément à la loi Carrez, la superficie du lot est mentionnée. Si le bien est loué, l'adjudicataire fera "
    "son affaire du bail et des locataires ; les pièces de la procédure et la visite des lieux. " + FILLER
)


def _typed(index: int, document_type: str, pages: dict[int, str]) -> ReadingDocument:
    return ReadingDocument(index=index, label="Pièce", url=f"https://example.test/{index}.pdf", document_type=document_type, pages=pages)


def test_report_and_visit_pages_are_not_crowded_out_by_template_clauses() -> None:
    report = "Séjour, cuisine, deux chambres : 3 pièces principales, surface habitable de 62 m². Le logement est occupé. "
    visits = "Visites : le 3 décembre 2026 de 10 heures à 11 heures. " + FILLER
    documents = [
        _typed(1, "cahier_conditions_vente", {number: TEMPLATE_PAGE for number in range(1, 13)} | {13: visits}),
        _typed(2, "pv_huissier", {1: FILLER, 2: report + FILLER}),
    ]
    assert vision.page_field_score(TEMPLATE_PAGE) > vision.page_field_score(report) > vision.page_field_score(visits)

    pages = vision.select_vision_pages(documents)

    assert len(pages) == 10
    assert PageRef(2, 2) in pages and PageRef(1, 13) in pages


def test_each_field_is_looked_for_first_in_the_piece_that_states_it() -> None:
    past_visit = "Le 3 mars 2026, lors de la visite, surface habitable de 62 m². " + FILLER
    sale_visits = "Visites le 3 décembre 2026. " + FILLER
    documents = [_typed(1, "pv_huissier", {1: past_visit}), _typed(2, "cahier_conditions_vente", {4: sale_visits})]
    assert vision.select_vision_pages(documents, max_pages=1) == [PageRef(1, 1)]  # surface habitable d'abord
    visits_only = [_typed(1, "pv_huissier", {1: "Le 3 mars 2026, lors de la visite. " + FILLER}), documents[1]]
    assert vision.select_vision_pages(visits_only, max_pages=1) == [PageRef(2, 4)]


@pytest.mark.parametrize("pages", [vision.MAX_PAGES, 15])
def test_selection_stays_below_the_haiku_price_tier(pages: int) -> None:
    from src.enrichment.anthropic_reader import input_token_ceiling

    refs = [PageRef(index, number) for index in range(1, 4) for number in range(100, 100 + pages)][:pages]
    prompt = vision.build_user_prompt(refs, vision.FIELDS, today=TODAY, sold_lot=SoldLot(number=2, lot_count=3, label="x" * 120))
    assert input_token_ceiling(pages, vision.SYSTEM_PROMPT, prompt, vision.response_schema(vision.FIELDS)) < 100_000


def test_page_without_any_field_word_is_never_sent() -> None:
    assert vision.select_vision_pages([_doc(1, {1: FILLER})]) == []
    assert vision.page_field_score("Le bien est libre de toute occupation ; contenance 12 a 50 ca") >= 2


def test_excerpt_keeps_only_the_selected_pages_in_order_and_skips_missing_ones() -> None:
    pdfs = {1: _pdf("D1 page un", "D1 page deux", "D1 page trois"), 2: _pdf("D2 page un"), 3: b"not a pdf"}
    wanted = [PageRef(1, 3), PageRef(2, 1), PageRef(1, 9), PageRef(3, 1), PageRef(4, 1)]

    excerpt, kept = vision.build_document_excerpt(pdfs, wanted)

    assert kept == [PageRef(1, 3), PageRef(2, 1)]
    with pymupdf.open(stream=excerpt, filetype="pdf") as document:
        assert [page.get_text().strip() for page in document] == ["D1 page trois", "D2 page un"]
    assert vision.build_document_excerpt(pdfs, [PageRef(4, 1)]) == (b"", [])


def test_excerpt_carries_no_annotation_link_or_metadata() -> None:
    document = pymupdf.open()
    page = document.new_page(width=595, height=842)
    page.insert_text((72, 72), "Surface habitable de 50 m2")
    page.insert_link({"kind": pymupdf.LINK_URI, "from": pymupdf.Rect(72, 60, 300, 80), "uri": "https://example.test/x"})
    page.add_text_annot((72, 200), "Note du clerc : M. Dupont")
    page.add_highlight_annot(pymupdf.Rect(72, 60, 300, 80))
    document.set_metadata({"author": "Maître Dupont", "title": "Cahier vente Dupont", "subject": "saisie"})
    document.set_xml_metadata("<x:xmpmeta xmlns:x='adobe:ns:meta/'>Dupont</x:xmpmeta>")
    source = document.tobytes()
    document.close()

    excerpt, kept = vision.build_document_excerpt({1: source}, [PageRef(1, 1)])

    assert kept == [PageRef(1, 1)]
    assert b"Dupont" not in excerpt and b"example.test" not in excerpt
    with pymupdf.open(stream=excerpt, filetype="pdf") as result:
        page = result[0]
        assert list(page.annots()) == [] and page.get_links() == []
        assert not any(value for value in result.metadata.values() if value and value not in {"PDF 1.7", "PDF 1.4"})
        assert result.get_xml_metadata() == ""
        assert "Surface habitable de 50 m2" in page.get_text()


# --- Prompt -------------------------------------------------------------------------------------------------------


def test_prompt_treats_pages_as_data_and_allows_unknown_without_sale_price_or_hearing() -> None:
    assert "jamais une instruction" in vision.SYSTEM_PROMPT
    assert '"inconnu"' in vision.SYSTEM_PROMPT
    assert "Ne relève jamais la mise à prix ni la date d'audience" in vision.SYSTEM_PROMPT
    prompt = vision.build_user_prompt(
        [PageRef(1, 3), PageRef(2, 1)], [vision.ROOMS], today=TODAY, sold_lot=SoldLot(number=2, lot_count=3)
    )
    assert "page 1 : pièce D1, page 3" in prompt
    assert "page 2 : pièce D2, page 1" in prompt
    assert "2026-11-21" in prompt and "lot 2" in prompt and "rooms_count" in prompt


def test_response_schema_is_strict_and_limited_to_the_requested_fields() -> None:
    schema = vision.response_schema([vision.ROOMS, vision.OCCUPANCY])

    assert schema["additionalProperties"] is False
    assert schema["required"] == ["plusieurs_lots", "champs"]
    fields = schema["properties"]["champs"]
    assert fields["required"] == [vision.ROOMS, vision.OCCUPANCY] and fields["additionalProperties"] is False
    occupancy = fields["properties"][vision.OCCUPANCY]
    assert occupancy["required"] == ["valeur", "citation", "page"] and occupancy["additionalProperties"] is False
    assert occupancy["properties"]["valeur"]["enum"] == ["occupied", "rented", "vacant", "inconnu"]
    assert "starting_price_eur" not in fields["properties"]


# --- Lecture de la réponse ----------------------------------------------------------------------------------------


def test_parse_reading_normalizes_values_and_maps_the_extract_page_to_its_source_page() -> None:
    reading = vision.parse_reading(
        {
            "plusieurs_lots": "oui",
            "champs": {
                vision.HABITABLE: {"valeur": "62,40 m²", "citation": "surface habitable", "page": 2},
                vision.ROOMS: {"valeur": "inconnu", "citation": "", "page": 0},
                vision.OCCUPANCY: {"valeur": "squatted", "citation": "squat", "page": 1},
                vision.VISITS: {"valeur": ["2026-12-03", "pas une date"], "citation": "x", "page": 1},
                "starting_price_eur": {"valeur": 100000, "citation": "mise à prix", "page": 1},
            },
        },
        [vision.HABITABLE, vision.ROOMS, vision.OCCUPANCY, vision.VISITS, vision.LAND],
        [PageRef(1, 4), PageRef(3, 2)],
    )

    assert reading.several_lots is True
    assert reading.claims[vision.HABITABLE] == Claim("value", Decimal("62.40"), "surface habitable", PageRef(3, 2))
    assert reading.claims[vision.ROOMS].status == "unknown"
    assert reading.claims[vision.OCCUPANCY].status == "invalid"
    assert reading.claims[vision.VISITS].status == "invalid"
    assert reading.claims[vision.LAND].status == "unknown"
    assert "starting_price_eur" not in reading.claims


@pytest.mark.parametrize("page", [0, 3, True, "1", None])
def test_claim_pointing_to_a_page_that_was_not_sent_is_invalid(page: object) -> None:
    raw = {"valeur": 3, "citation": "3 pièces", "page": page}
    assert vision.parse_claim(vision.ROOMS, raw, [PAGE, PageRef(1, 2)]).status == "invalid"


def test_non_object_payload_is_invalid_for_every_field() -> None:
    reading = vision.parse_reading("not json", [vision.ROOMS], [PAGE])
    assert reading.claims[vision.ROOMS].status == "invalid"


# --- Citation vérifiée --------------------------------------------------------------------------------------------


def test_each_field_is_kept_only_with_an_exact_quote_that_states_the_value() -> None:
    reading = _reading(
        habitable_surface_m2=_claim(62.4, "surface habitable de 62,40 m²"),
        carrez_surface_m2=_claim(61.8, "superficie loi Carrez de 61,8 m²"),
        rooms_count=_claim(3, "comprenant 3 pièces principales"),
        occupancy_status=_claim("rented", "Le bien est occupé par un locataire en vertu d'un bail"),
        visit_dates=_claim(["2026-12-03", "2026-12-10"], "Les visites auront lieu le 3 et le 10 décembre 2026"),
    )

    verdicts = vision.primary_verdicts(reading, _context(), today=TODAY)

    assert {name: verdict.status for name, verdict in verdicts.items()} == dict.fromkeys(reading.claims, CANDIDATE)
    assert verdicts[vision.VISITS].value == frozenset({date(2026, 12, 3), date(2026, 12, 10)})


@pytest.mark.parametrize(
    ("field_name", "claim", "reason"),
    [
        (vision.HABITABLE, _claim(62.4, "surface habitable de 62,40 m² au total"), "citation_introuvable"),
        (vision.HABITABLE, _claim(70, "surface habitable de 62,40 m²"), "valeur_absente_de_la_citation"),
        (vision.HABITABLE, _claim(61.8, "superficie loi Carrez de 61,8 m²"), "citation_hors_champ"),
        (vision.LAND, _claim(62.4, "surface habitable de 62,40 m²"), "citation_hors_champ"),
        (vision.ROOMS, _claim(4, "comprenant 3 pièces principales"), "valeur_absente_de_la_citation"),
        (vision.OCCUPANCY, _claim("vacant", "Le bien est occupé par un locataire"), "valeur_absente_de_la_citation"),
        (vision.VISITS, _claim(["2026-12-04"], "le 3 et le 10 décembre 2026"), "valeur_absente_de_la_citation"),
    ],
)
def test_quote_that_is_missing_or_does_not_state_the_value_is_rejected(
    field_name: str, claim: dict[str, object], reason: str
) -> None:
    verdicts = vision.primary_verdicts(_reading(**{field_name: claim}), _context(), today=TODAY)
    assert verdicts[field_name] == vision.Verdict(REJECTED, reason)


def test_quote_must_be_on_the_page_it_names() -> None:
    reading = vision.parse_reading(
        {"champs": {vision.ROOMS: {"valeur": 3, "citation": "comprenant 3 pièces principales", "page": 2}}},
        [vision.ROOMS],
        [PAGE, PageRef(1, 2)],
    )
    context = _context()
    context.page_texts[PageRef(1, 2)] = FILLER
    verdict = vision.primary_verdicts(reading, context, today=TODAY)[vision.ROOMS]
    assert verdict.reason == "citation_introuvable" and verdict.detail == vision.OTHER_PAGE


def test_quote_found_by_the_v1_rule_is_marked_exact() -> None:
    verdicts = vision.primary_verdicts(_reading(rooms_count=_claim(3, "comprenant 3 pièces principales")), _context(), today=TODAY)
    assert verdicts[vision.ROOMS].detail == vision.EXACT
    assert verdicts[vision.ROOMS].quote == "comprenant 3 pièces principales"


# --- Normalisation symétrique -------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("page_text", "quote"),
    [
        # Espaces insécables (fine ou non) et retours à la ligne.
        ("Surface habitable de 62,40 m² au relevé.", "Surface habitable de 62,40 m²"),
        ("Surface\nhabitable :  62,40 m² au relevé.", "Surface habitable : 62,40 m²"),
        # « m² » écrit avec l'exposant, « m2 » dans la citation, et l'inverse.
        ("Surface habitable de 62,40 m² au relevé.", "Surface habitable de 62,40 m2"),
        ("Surface habitable de 62,40 m2 au relevé.", "Surface habitable de 62,40 m²"),
        # Ligature typographique.
        ("Une superﬁcie habitable de 62,40 m² au relevé.", "Une superficie habitable de 62,40 m²"),
        # Apostrophes et tirets typographiques.
        ("D’une surface habitable – 62,40 m² au relevé.", "D'une surface habitable - 62,40 m²"),
        # Césure en fin de ligne.
        ("Une surface habi-\ntable de 62,40 m² au relevé.", "Une surface habitable de 62,40 m²"),
        # Accent décomposé (lettre puis accent combinant) et guillemets.
        ("La « surface habitable » relevée est de 62,40 m².", "La surface habitable relevée est de 62,40 m²"),
        ("Surface habitable relevée : 62,40 m².", "Surface habitable relevée : 62,40 m²"),
    ],
)
def test_quote_is_found_despite_typographic_differences(page_text: str, quote: str) -> None:
    reading = _reading(habitable_surface_m2=_claim(62.4, quote))
    verdict = vision.primary_verdicts(reading, _context(page_text + " " + FILLER), today=TODAY)[vision.HABITABLE]
    assert verdict.status == CANDIDATE
    assert verdict.detail in {vision.NORMALIZED, vision.EXACT}


def test_ligature_oe_is_two_letters_on_both_sides() -> None:
    text = "Au cœur du bourg, une maison de 4 pièces principales. " + FILLER
    reading = _reading(rooms_count=_claim(4, "Au coeur du bourg, une maison de 4 pièces principales"))
    verdict = vision.primary_verdicts(reading, _context(text), today=TODAY)[vision.ROOMS]
    assert verdict.status == CANDIDATE and verdict.detail == vision.NORMALIZED


@pytest.mark.parametrize(
    ("page_text", "quote"),
    [
        # Un autre mot, une lettre de plus ou de moins, un autre chiffre : jamais retrouvée.
        ("Surface habitable de 62,40 m².", "Surface utile de 62,40 m²"),
        ("Un appartement de 62,40 m² habitables.", "Un apartement de 62,40 m² habitables"),
        ("Surface habitable de 62,40 m².", "Surface habitable de 62,45 m²"),
        # Un tiret entre deux chiffres reste.
        ("Surface habitable de 10-12 m² environ.", "Surface habitable de 1012 m²"),
    ],
)
def test_normalization_never_accepts_a_different_text(page_text: str, quote: str) -> None:
    assert vision.find_quote(page_text, quote, ocr=False) is None


def test_found_quote_maps_back_to_the_text_of_the_page() -> None:
    page_text = "Désignation :\nune surface habi-\ntable de 62,40 m² relevée."
    start, end, tolerated = vision.find_quote(page_text, "surface habitable de 62,40 m2", ocr=False)  # type: ignore[misc]
    assert page_text[start:end] == "surface habi-\ntable de 62,40 m²"
    assert tolerated is False


@pytest.mark.parametrize(
    ("page_text", "quote"),
    [
        # Le passage ne peut pas commencer ni finir au milieu d'un nombre de la page.
        ("Une surface habitable de 125 m² au relevé.", "surface habitable de 12"),
        ("Une maison de 12 pièces principales.", "2 pièces principales"),
        ("Un terrain de 1 245 m² de jardin attenant.", "245 m² de jardin"),
        ("Un terrain de 1\u202f245 m² de jardin attenant.", "245 m² de jardin"),
        ("Une surface habitable de 12,5 m² au relevé.", "surface habitable de 12"),
        ("Une surface habitable de 12.5 m² au relevé.", "surface habitable de 12"),
        ("La contenance totale est de 1 245 m².", "contenance totale est de 1"),
    ],
)
def test_quote_never_cuts_a_number_of_the_page(page_text: str, quote: str) -> None:
    assert vision.find_quote(page_text, quote, ocr=False) is None
    assert vision.find_quote(page_text, quote, ocr=True) is None


@pytest.mark.parametrize(
    ("page_text", "quote", "found"),
    [
        # Un nombre entier, séparé par une espace ou un signe d'un autre nombre, reste trouvé.
        ("Une maison de 2 pièces principales, 12 pièces au total.", "2 pièces principales", "2 pièces principales"),
        ("Visites le 3 décembre 2026 10h00 à 12h00.", "Visites le 3 décembre 2026", "Visites le 3 décembre 2026"),
        ("Surface habitable de 10-12 m² environ.", "habitable de 10", "habitable de 10"),
        # Une occurrence qui coupe un nombre est sautée au profit de la suivante.
        ("De 12 pièces principales en tout, dont 2 pièces principales à l'étage.", "2 pièces principales", "2 pièces principales"),
    ],
)
def test_quote_bounded_by_whole_numbers_is_found(page_text: str, quote: str, found: str) -> None:
    start, end, _ = vision.find_quote(page_text, quote, ocr=False)  # type: ignore[misc]
    assert page_text[start:end] == found


# --- OCR ----------------------------------------------------------------------------------------------------------

OCR_PAGE_TEXT = "Désignation : surface hahitable de 62,40 m² au relevé du métreur. " + FILLER
OCR_QUOTE = "surface habitable de 62,40 m² au relevé"


def test_isolated_ocr_substitution_is_tolerated_on_an_ocr_page_only() -> None:
    reading = _reading(habitable_surface_m2=_claim(62.4, OCR_QUOTE))
    ocr = _context(OCR_PAGE_TEXT, ocr_pages=frozenset({PAGE}))
    verdict = vision.primary_verdicts(reading, ocr, today=TODAY)[vision.HABITABLE]
    assert verdict.status == CANDIDATE and verdict.detail == vision.OCR_TOLERANCE

    native = vision.primary_verdicts(reading, _context(OCR_PAGE_TEXT), today=TODAY)[vision.HABITABLE]
    assert native.reason == "citation_introuvable" and native.detail == vision.NATIVE_TEXT_DIFFERS


@pytest.mark.parametrize(
    "page_text",
    [
        # Plus d'une substitution pour une citation de moins de 40 caractères (clé de 33 : une seule permise).
        "surface hahitahle de 62,40 m² au relevé",
        "surface hahitable de 62,40 m² au relevá",
        # Une insertion ou une suppression n'est pas une substitution.
        "surface habittable de 62,40 m² au relevé",
        "surface habiable de 62,40 m² au relevé",
        # Une substitution sur un chiffre, même isolée.
        "surface habitable de 82,40 m² au relevé",
    ],
)
def test_ocr_tolerance_is_bounded(page_text: str) -> None:
    assert vision.find_quote(page_text + " " + FILLER, OCR_QUOTE, ocr=True) is None


def test_ocr_tolerance_grows_with_the_quote_and_stops_at_three() -> None:
    quote = "Le bien est occupé par un locataire en vertu d'un bail du premier mars deux mille vingt, toujours en cours"
    assert len(vision.match_key(quote)[0]) >= 80
    three = quote.replace("bien", "bicn").replace("locataire", "locatairc").replace("vertu", "vcrtu")
    four = three.replace("premier", "prcmier")
    assert vision.find_quote(three, quote, ocr=True) is not None
    assert vision.find_quote(four, quote, ocr=True) is None
    # Deux substitutions voisines ne sont pas des caractères isolés.
    assert vision.find_quote(quote.replace("bien", "bicm"), quote, ocr=True) is None
    assert vision.find_quote(quote.replace("bien", "bicn"), quote, ocr=True) is not None
    # Une citation courte n'a droit à aucune substitution.
    assert vision.find_quote("3 pieccs", "3 pièces", ocr=True) is None


def test_image_page_without_text_is_read_by_ocr_once_for_every_field() -> None:
    header = "Procès-verbal de description dressé par l'huissier de justice soussigné."
    read: list[PageRef] = []

    def ocr(ref: PageRef) -> str:
        read.append(ref)
        return PAGE_TEXT

    reading = _reading(
        habitable_surface_m2=_claim(62.4, "surface habitable de 62,40 m²"),
        rooms_count=_claim(3, "comprenant 3 pièces principales"),
    )
    context = _context(header, image_pages=frozenset({PAGE}), ocr_reader=ocr)
    verdicts = vision.primary_verdicts(reading, context, today=TODAY)
    assert {verdict.detail for verdict in verdicts.values()} == {vision.BENCH_OCR}
    assert {verdict.status for verdict in verdicts.values()} == {CANDIDATE}
    assert read == [PAGE]
    # Le second lecteur relit la même page : pas de second OCR.
    vision.final_verdicts(verdicts, reading, context, today=TODAY)
    assert read == [PAGE]


@pytest.mark.parametrize("ocr_reader", [None, lambda ref: None])
def test_image_page_that_ocr_cannot_read_is_reported_without_text(ocr_reader: object) -> None:
    header = "Procès-verbal de description dressé par l'huissier de justice soussigné."
    reading = _reading(rooms_count=_claim(3, "comprenant 3 pièces principales"))
    context = _context(header, image_pages=frozenset({PAGE}), ocr_reader=ocr_reader)
    verdict = vision.primary_verdicts(reading, context, today=TODAY)[vision.ROOMS]
    assert verdict.reason == "citation_introuvable" and verdict.detail == vision.NO_TEXT


def test_ocr_text_that_does_not_hold_the_quote_is_reported_as_different() -> None:
    reading = _reading(rooms_count=_claim(3, "comprenant 3 pièces principales"))
    context = _context(FILLER, image_pages=frozenset({PAGE}), ocr_reader=lambda ref: "Une page de photographies du bien.")
    verdict = vision.primary_verdicts(reading, context, today=TODAY)[vision.ROOMS]
    assert verdict.detail == vision.OCR_TEXT_DIFFERS


# --- « Inconnu » --------------------------------------------------------------------------------------------------


def test_unknown_says_whether_the_value_was_on_the_pages_sent() -> None:
    unknown = _reading(rooms_count={"valeur": "inconnu"}, land_surface_m2={"valeur": "inconnu"},
                       carrez_surface_m2={"valeur": "inconnu"})
    unsent = PageRef(1, 7)
    context = _context(dossier_pages={PAGE: PAGE_TEXT, unsent: "Terrain d'une contenance de 12 a 50 ca. " + FILLER})
    verdicts = vision.primary_verdicts(unknown, context, today=TODAY)
    assert verdicts[vision.ROOMS].detail == vision.CUE_SENT  # « 3 pièces » était envoyé : le modèle n'a pas répondu
    assert verdicts[vision.LAND].detail == vision.CUE_NOT_SENT
    assert verdicts[vision.CARREZ].detail == vision.CUE_SENT
    nothing = _context("Le présent cahier est déposé au greffe. " + FILLER)
    assert vision.primary_verdicts(unknown, nothing, today=TODAY)[vision.ROOMS].detail == vision.NO_CUE


def test_unknown_after_past_visit_dates_says_so() -> None:
    text = "Visite le 3 novembre 2026. " + FILLER
    past = _reading(visit_dates=_claim(["2026-11-03"], "Visite le 3 novembre 2026"))
    assert vision.primary_verdicts(past, _context(text), today=TODAY)[vision.VISITS].detail == vision.PAST_VISITS


def test_land_contenance_in_ares_and_centiares_states_square_metres() -> None:
    text = "Une parcelle cadastrée section AB n° 12 pour une contenance de 12 a 50 ca. " + FILLER
    reading = _reading(land_surface_m2=_claim(1250, "pour une contenance de 12 a 50 ca"))
    assert vision.primary_verdicts(reading, _context(text), today=TODAY)[vision.LAND].status == CANDIDATE


def test_unknown_is_a_valid_answer_that_publishes_nothing() -> None:
    verdicts = vision.primary_verdicts(_reading(rooms_count={"valeur": "inconnu"}), _context(), today=TODAY)
    assert verdicts[vision.ROOMS].status == UNKNOWN_STATUS
    assert vision.cited_pages(verdicts) == []


def test_only_future_visit_dates_are_kept() -> None:
    text = "Visites le 3 novembre 2026 et le 3 décembre 2026. " + FILLER
    reading = _reading(visit_dates=_claim(["2026-11-03", "2026-12-03"], "Visites le 3 novembre 2026 et le 3 décembre 2026"))
    verdict = vision.primary_verdicts(reading, _context(text), today=TODAY)[vision.VISITS]
    assert verdict.value == frozenset({date(2026, 12, 3)})

    past = _reading(visit_dates=_claim(["2026-11-03"], "Visites le 3 novembre 2026"))
    assert vision.primary_verdicts(past, _context(text), today=TODAY)[vision.VISITS].status == UNKNOWN_STATUS


@pytest.mark.parametrize(
    ("page_text", "quote", "dates", "accepted"),
    [
        # The day must be bound to its month: « le 10 décembre à 3 h » does not say 3 December.
        ("Visite le 10 décembre à 3 h. ", "Visite le 10 décembre à 3 h", ["2026-12-03"], False),
        ("Visite le 10 décembre à 3 h. ", "Visite le 10 décembre à 3 h", ["2026-12-10"], True),
        # A number after « lot » is no day, even in a comma list before a month.
        ("Visite du lot 3, 10 décembre 2026. ", "Visite du lot 3, 10 décembre 2026", ["2026-12-03"], False),
        ("Visite du lot 3, 10 décembre 2026. ", "Visite du lot 3, 10 décembre 2026", ["2026-12-10"], True),
        ("Visites les 3, 10 et 17 décembre 2026. ", "Visites les 3, 10 et 17 décembre 2026", ["2026-12-03"], True),
        # A written year must be the year of the date: an elapsed year does not prove a future date.
        ("Visite le 3 décembre 2025. ", "Visite le 3 décembre 2025", ["2026-12-03"], False),
        ("Visite le 03/12/2025 à 10h. ", "Visite le 03/12/2025 à 10h", ["2026-12-03"], False),
        ("Visite le 03/12/26 à 10h. ", "Visite le 03/12/26 à 10h", ["2026-12-03"], True),
        # Without a year, only the next occurrence after today.
        ("Visite le 3 décembre. ", "Visite le 3 décembre", ["2026-12-03"], True),
        ("Visite le 3 décembre. ", "Visite le 3 décembre", ["2027-12-03"], False),
        ("Visite le 15 janvier. ", "Visite le 15 janvier", ["2027-01-15"], True),
        # A list of days before one month still binds each day.
        ("Visites le 3 et le 10 décembre 2026. ", "Visites le 3 et le 10 décembre 2026", ["2026-12-03", "2026-12-10"], True),
        ("Visite le 1er décembre 2026. ", "Visite le 1er décembre 2026", ["2026-12-01"], True),
    ],
)
def test_visit_day_is_bound_to_its_month_and_year(page_text: str, quote: str, dates: list[str], accepted: bool) -> None:
    reading = _reading(visit_dates=_claim(dates, quote))
    verdict = vision.primary_verdicts(reading, _context(page_text + FILLER), today=TODAY)[vision.VISITS]
    assert (verdict.status == CANDIDATE) is accepted


# --- Surfaces -----------------------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("page_text", "quote", "value", "accepted"),
    [
        # A number of the quote that is no surface (year, lot, rooms) proves nothing.
        ("Acquis en 2020, surface habitable de 45 m². ", "Acquis en 2020, surface habitable de 45 m²", 2020, False),
        ("Lot 62, surface habitable de 45 m². ", "Lot 62, surface habitable de 45 m²", 62, False),
        ("Surface habitable de 45 m² et 3 pièces. ", "Surface habitable de 45 m² et 3 pièces", 3, False),
        ("Acquis en 2020, surface habitable de 45 m². ", "Acquis en 2020, surface habitable de 45 m²", 45, True),
        # A number without unit, right after « surface » with no other number between.
        ("Surface habitable : 45,30 ", "Surface habitable : 45,30", 45.3, True),
        ("Surface habitable relevée en 2020 : 45 ", "Surface habitable relevée en 2020 : 45", 45, False),
        ("Un logement de 45 mètres carrés habitables. ", "Un logement de 45 mètres carrés habitables", 45, True),
    ],
)
def test_surface_value_must_be_written_as_a_surface(page_text: str, quote: str, value: object, accepted: bool) -> None:
    reading = _reading(habitable_surface_m2=_claim(value, quote))
    verdict = vision.primary_verdicts(reading, _context(page_text + FILLER), today=TODAY)[vision.HABITABLE]
    assert (verdict.status == CANDIDATE) is accepted


# --- Cohérence ----------------------------------------------------------------------------------------------------


@pytest.mark.parametrize("situation", [vision.SEVERAL_LOTS, vision.LOT_UNCERTAIN, vision.ONE_LOT_GUARDED])
def test_sale_whose_lot_cannot_be_identified_is_rejected_whatever_the_reader_says(situation: str) -> None:
    for several in ("non", "oui"):
        reading = _reading_saying(several, rooms_count=_claim(3, "comprenant 3 pièces principales"))
        verdict = vision.primary_verdicts(reading, _context(lot_situation=situation), today=TODAY)[vision.ROOMS]
        assert verdict == vision.Verdict(REJECTED, "lot_non_identifie")
        assert verdict.detail == situation


def test_designated_lot_named_by_the_quote_is_a_candidate() -> None:
    named = "Le lot 1 comprend 3 pièces principales. " + FILLER
    identified = _context(named, sold_lot=SoldLot(number=1, lot_count=2))
    naming = _reading_saying("oui", rooms_count=_claim(3, "Le lot 1 comprend 3 pièces principales"))
    assert vision.primary_verdicts(naming, identified, today=TODAY)[vision.ROOMS].status == CANDIDATE


def test_known_lot_that_the_quote_does_not_name_is_rejected() -> None:
    context = _context(sold_lot=SoldLot(number=1, lot_count=2))
    reading = _reading(rooms_count=_claim(3, "comprenant 3 pièces principales"))
    assert vision.primary_verdicts(reading, context, today=TODAY)[vision.ROOMS] == vision.Verdict(REJECTED, "lot_non_nomme")


def test_quote_naming_another_lot_than_the_sold_one_is_rejected() -> None:
    text = "Le lot 2 comprend 3 pièces principales. " + FILLER
    reading = _reading(rooms_count=_claim(3, "Le lot 2 comprend 3 pièces principales"))
    context = _context(text, sold_lot=SoldLot(number=1, lot_count=2))
    assert vision.primary_verdicts(reading, context, today=TODAY)[vision.ROOMS].reason == "autre_lot"


# --- Lot unique d'après la fiche ----------------------------------------------------------------------------------


def test_one_lot_sale_does_not_need_a_quote_naming_a_lot_when_the_reader_says_several() -> None:
    # Lecteur trompé par des lots de copropriété : la citation ne nomme aucun lot, le dossier n'a pas de titres de lots.
    text = "Le lot numéro 12 et le lot numéro 45 (cave). Un appartement comprenant 3 pièces principales. " + FILLER
    reading = _reading_saying("oui", rooms_count=_claim(3, "Un appartement comprenant 3 pièces principales"))
    context = _context(text, dossier_pages={PAGE: text})
    assert vision.primary_verdicts(reading, context, today=TODAY)[vision.ROOMS].status == CANDIDATE


def test_one_lot_sale_keeps_the_rejection_when_the_quote_names_a_lot() -> None:
    text = "Lot 2 : un appartement comprenant 3 pièces principales. " + FILLER
    reading = _reading_saying("oui", rooms_count=_claim(3, "Lot 2 : un appartement comprenant 3 pièces principales"))
    verdict = vision.primary_verdicts(reading, _context(text), today=TODAY)[vision.ROOMS]
    assert verdict == vision.Verdict(REJECTED, "lot_non_identifie") and verdict.detail == vision.ONE_LOT


def test_one_lot_sale_keeps_the_rejection_when_the_dossier_is_divided_in_lots() -> None:
    # La fiche ne voit qu'un lot, mais le cahier en vend deux sous des titres : le lot voisin ne doit pas passer.
    first = "PREMIER LOT Une maison comprenant 5 pièces principales. " + FILLER
    second = "DEUXIEME LOT Un appartement comprenant 3 pièces principales. " + FILLER
    reading = _reading_saying("oui", rooms_count=_claim(5, "Une maison comprenant 5 pièces principales"))
    context = _context(first, dossier_pages={PAGE: first, PageRef(1, 2): second})
    verdict = vision.primary_verdicts(reading, context, today=TODAY)[vision.ROOMS]
    assert verdict.reason == "lot_non_identifie" and verdict.detail == vision.ONE_LOT

    # Sans l'avis du lecteur, rien ne change par rapport au lot V1.
    said_one = _reading_saying("non", rooms_count=_claim(5, "Une maison comprenant 5 pièces principales"))
    assert vision.primary_verdicts(said_one, context, today=TODAY)[vision.ROOMS].status == CANDIDATE


def test_one_lot_sale_keeps_the_rejection_when_the_dossier_names_two_lots_in_lower_case() -> None:
    text = "Lot n° 1 : une maison d'habitation. Lot n° 2 : un terrain à bâtir d'une contenance de 850 m². " + FILLER
    quote = "un terrain à bâtir d'une contenance de 850 m²"
    context = _context(text, dossier_pages={PAGE: text})
    verdict = vision.primary_verdicts(_reading_saying("oui", land_surface_m2=_claim(850, quote)), context, today=TODAY)
    assert verdict[vision.LAND].reason == "lot_non_identifie" and verdict[vision.LAND].detail == vision.ONE_LOT


def test_second_reader_saying_several_lots_on_a_divided_dossier_rejects_the_candidate() -> None:
    first = "PREMIER LOT Une maison comprenant 5 pièces principales. " + FILLER
    context = _context(first, dossier_pages={PAGE: first, PageRef(1, 2): "DEUXIEME LOT Un terrain. " + FILLER})
    claim = _claim(5, "Une maison comprenant 5 pièces principales")
    primary = vision.primary_verdicts(_reading_saying("non", rooms_count=claim), context, today=TODAY)
    final = vision.final_verdicts(primary, _reading_saying("oui", rooms_count=claim), context, today=TODAY)
    assert final[vision.ROOMS] == vision.Verdict(REJECTED, "lot_non_identifie")


# --- Section du lot vendu -----------------------------------------------------------------------------------------

TWO_LOTS = (
    "PREMIER LOT Une maison d'habitation comprenant 5 pièces principales. "
    "DEUXIEME LOT Un appartement comprenant 3 pièces principales. " + FILLER
)
MAISON = _claim(5, "Une maison d'habitation comprenant 5 pièces principales")
APPARTEMENT = _claim(3, "Un appartement comprenant 3 pièces principales")


@pytest.mark.parametrize(
    ("sold", "claim", "accepted"),
    [
        (2, APPARTEMENT, True),
        (1, MAISON, True),
        # Le lot voisin ne passe jamais.
        (2, MAISON, False),
        (1, APPARTEMENT, False),
    ],
)
def test_quote_under_the_title_of_the_sold_lot_is_accepted_and_the_neighbour_lot_never(
    sold: int, claim: dict[str, object], accepted: bool
) -> None:
    context = _context(TWO_LOTS, sold_lot=SoldLot(number=sold, lot_count=2), dossier_pages={PAGE: TWO_LOTS})
    verdict = vision.primary_verdicts(_reading(rooms_count=claim), context, today=TODAY)[vision.ROOMS]
    assert (verdict.status == CANDIDATE) is accepted
    if not accepted:
        assert verdict.reason == "lot_non_nomme"


def test_title_of_the_sold_lot_on_the_previous_page_of_the_same_piece_counts() -> None:
    title_page = "Désignation des biens mis en vente. " + FILLER + " DEUXIEME LOT"
    description = "Un appartement comprenant 3 pièces principales. " + FILLER
    cited = PageRef(1, 5)
    reading = vision.parse_reading({"champs": {vision.ROOMS: APPARTEMENT}}, [vision.ROOMS], [cited])

    def verdict(previous: PageRef, sold: int) -> vision.Verdict:
        context = SaleContext(
            sold_lot=SoldLot(number=sold, lot_count=3),
            page_texts={cited: description},
            dossier_pages={previous: title_page, cited: description},
        )
        return vision.primary_verdicts(reading, context, today=TODAY)[vision.ROOMS]

    assert verdict(PageRef(1, 4), sold=2).status == CANDIDATE
    assert verdict(PageRef(1, 4), sold=1).reason == "lot_non_nomme"
    # Page précédente d'une autre pièce, ou deux pages plus haut : pas de section.
    assert verdict(PageRef(2, 4), sold=2).reason == "lot_non_nomme"
    assert verdict(PageRef(1, 3), sold=2).reason == "lot_non_nomme"


@pytest.mark.parametrize(
    "text",
    [
        # Un autre titre entre celui du lot vendu et la citation.
        "DEUXIEME LOT Une cave. TROISIEME LOT Un appartement comprenant 3 pièces principales. " + FILLER,
        # Le titre du lot vendu apparaît deux fois dans la pièce (rappel ou lot de copropriété en capitales).
        "PREMIER LOT Un immeuble dont le LOT N° 2 forme un logement. DEUXIEME LOT Un appartement comprenant 3 pièces "
        "principales. " + FILLER,
        # Un lot de copropriété nommé dans la phrase n'est pas un titre de lot de vente.
        "PREMIER LOT Dans l'immeuble, le lot n° 2 : Un appartement comprenant 3 pièces principales. " + FILLER,
        # Un numéro voisin d'un mot de copropriété n'est pas un titre de lot de vente.
        "PREMIER LOT Le LOT N° 2 de l'état descriptif de division : Un appartement comprenant 3 pièces principales. "
        + FILLER,
    ],
)
def test_section_of_the_sold_lot_is_not_assumed_from_an_ambiguous_title(text: str) -> None:
    context = _context(text, sold_lot=SoldLot(number=2, lot_count=3), dossier_pages={PAGE: text})
    verdict = vision.primary_verdicts(_reading(rooms_count=APPARTEMENT), context, today=TODAY)[vision.ROOMS]
    assert verdict.reason == "lot_non_nomme"


NEIGHBOUR_QUOTE = "un appartement de 4 pièces d'une surface habitable de 85 m²"


@pytest.mark.parametrize(
    "text",
    [
        # Le titre du lot voisin, suivi d'un mot de copropriété, n'est pas un titre pour lot_titles : la citation
        # ne doit pas se rattacher pour autant au titre du lot vendu.
        "LOT N° 2 : appartement de 3 pièces, 60 m². LOT N° 3 : copropriété Les Pins, " + NEIGHBOUR_QUOTE + ".",
        "LOT N° 2 : appartement de 3 pièces, 60 m². LOT N° 3 de l'état descriptif : " + NEIGHBOUR_QUOTE + ".",
        # Titre du lot voisin écrit avec le symbole ordinal (U+00BA) ou en minuscules.
        "LOT N° 2 : appartement de 3 pièces, 60 m². LOT Nº 3 : " + NEIGHBOUR_QUOTE + ".",
        "LOT N° 2 : appartement de 3 pièces, 60 m². Lot n° 3 : " + NEIGHBOUR_QUOTE + ".",
    ],
)
def test_neighbour_lot_never_hides_behind_the_title_of_the_sold_lot(text: str) -> None:
    context = _context(text + " " + FILLER, sold_lot=SoldLot(number=2, lot_count=3), dossier_pages={PAGE: text})
    reading = _reading(habitable_surface_m2=_claim(85, NEIGHBOUR_QUOTE))
    verdict = vision.primary_verdicts(reading, context, today=TODAY)[vision.HABITABLE]
    assert verdict.status == REJECTED and verdict.reason in {"lot_non_nomme", "autre_lot"}


def test_another_lot_number_on_the_previous_page_after_the_title_breaks_the_section() -> None:
    title_page = "DEUXIEME LOT Une cave. Lot n° 3 : une maison. " + FILLER
    description = "Un appartement comprenant 3 pièces principales. " + FILLER
    cited = PageRef(1, 5)
    reading = vision.parse_reading({"champs": {vision.ROOMS: APPARTEMENT}}, [vision.ROOMS], [cited])
    context = SaleContext(
        sold_lot=SoldLot(number=2, lot_count=3),
        page_texts={cited: description},
        dossier_pages={PageRef(1, 4): title_page, cited: description},
    )
    assert vision.primary_verdicts(reading, context, today=TODAY)[vision.ROOMS].reason == "lot_non_nomme"


@pytest.mark.parametrize(
    ("text", "titles"),
    [
        ("PREMIER LOT x DEUXIÈME LOT y 3ÈME LOT", [1, 2, 3]),
        ("LOT N° 2 puis LOT NUMÉRO 3 puis LOT 1", [2, 3, 1]),
        ("le lot n° 2, Lot 3, premier lot", []),
        ("LOT N° 12", []),
        # Le symbole ordinal masculin (U+00BA) à la place du degré.
        ("LOT Nº 2 puis LOT Nº3", [2, 3]),
    ],
)
def test_lot_titles_are_capitalised_sale_lot_headings(text: str, titles: list[int]) -> None:
    assert [number for _, number in vision.lot_titles(text, 9)] == titles


def test_surface_incompatible_with_the_number_of_rooms_rejects_both() -> None:
    text = "Appartement de 5 pièces d'une surface habitable de 20 m². " + FILLER
    reading = _reading(
        habitable_surface_m2=_claim(20, "surface habitable de 20 m²"),
        rooms_count=_claim(5, "Appartement de 5 pièces"),
    )
    verdicts = vision.primary_verdicts(reading, _context(text), today=TODAY)
    assert verdicts[vision.HABITABLE] == vision.Verdict(REJECTED, "surface_incoherente_pieces")
    assert verdicts[vision.ROOMS] == vision.Verdict(REJECTED, "surface_incoherente_pieces")


# --- Occupation asymétrique ---------------------------------------------------------------------------------------


def test_vacant_needs_an_explicit_free_statement_and_no_contrary_word_on_the_pages_read() -> None:
    free = "Lors de la visite, le bien est libre de toute occupation. " + FILLER
    reading = _reading(occupancy_status=_claim("vacant", "le bien est libre de toute occupation"))
    assert vision.primary_verdicts(reading, _context(free), today=TODAY)[vision.OCCUPANCY].status == CANDIDATE

    context = _context(free)
    context.page_texts[PageRef(1, 2)] = "Un bail commercial a été consenti. " + FILLER
    assert vision.primary_verdicts(reading, context, today=TODAY)[vision.OCCUPANCY].reason == "libre_contredit"


@pytest.mark.parametrize(
    "text",
    [
        "Le bien est loué.",
        "La maison est louée depuis 2019.",
        "Un loyer mensuel de 600 euros.",
        "Contrat de location du 2 mars 2020.",
        "Le preneur a donné congé.",
        "Un bail commercial a été consenti.",
        "Présence d'un locataire.",
        "Un occupant a été rencontré.",
        "Le logement est occupé.",
        "Les lieux sont occupés par la famille du débiteur.",
        "Un squat a été constaté.",
        "Le local est squatté.",
        "Occupé sans droit ni titre.",
        "Le saisi y demeure avec ses enfants.",
        "Le débiteur y demeure.",
        "État d'occupation : voir le procès-verbal.",
        "La maison est habitée par le débiteur.",
        "Le saisi réside sur place.",
        "Un résident a ouvert la porte.",
    ],
)
def test_every_contrary_word_contradicts_vacant(text: str) -> None:
    assert vision.pages_contradict_vacant([text])


@pytest.mark.parametrize(
    "text",
    [
        "Le logement est non occupé, inoccupée depuis 2024.",
        "Le bien est libre de toute location et libre de toute occupation.",
        "Libre d'occupant, sans locataire.",
        "Aucun bail en cours.",
        "Ni loué ni occupé.",
    ],
)
def test_fixed_negations_do_not_contradict_vacant(text: str) -> None:
    assert not vision.pages_contradict_vacant([text])


@pytest.mark.parametrize(
    "text",
    [
        # A negation never crosses a line nor a form heading: the next line says the opposite.
        "Ascenseur : non\nLoué : oui",
        "Ascenseur non\nBail commercial en cours",
        "Garage : sans\nLocataire : M. Dupont",
        "Cave : aucune Location en cours",
        "Garage : sans\tlocataire principal : M. Dupont\nLocataire : M. Martin",
        "Non : occupé",
        # A fixed expression followed by « : » is a form heading, not a negation.
        "Parking : sans locataire : M. Dupont",
        "Logement non occupé : non",
    ],
)
def test_a_negation_that_is_not_a_fixed_contiguous_expression_negates_nothing(text: str) -> None:
    assert vision.pages_contradict_vacant([text])


@pytest.mark.parametrize(
    "text",
    [
        # Prudence: a template clause of the conditions of sale contradicts « libre » too.
        "Si le bien est loué ou occupé, l'adjudicataire fera son affaire personnelle des baux, locations et "
        "occupations, sans recours contre le poursuivant.",
        "L'adjudicataire fera son affaire des locataires éventuels.",
        # Real statements that a template-clause filter would swallow.
        "Appartement loué selon bail à loyer modéré.",
        "Le logement est occupé par le saisi, en cas de besoin le bail sera produit.",
        "Le bien est occupé par la famille du débiteur, entrée en jouissance à l'adjudication.",
        "Lot 2 : loué, si le bien est vendu libre le prix change",
    ],
)
def test_template_clauses_and_sentences_that_look_like_them_contradict_vacant(text: str) -> None:
    assert vision.pages_contradict_vacant([text])


def test_vacant_is_contradicted_by_any_page_of_the_dossier_even_one_not_sent() -> None:
    free = "Lors de la visite, le bien est libre de toute occupation. " + FILLER
    reading = _reading(occupancy_status=_claim("vacant", "le bien est libre de toute occupation"))
    context = _context(free)
    context.dossier_texts = (free, FILLER, "Page 37 : le saisi y demeure. " + FILLER)
    assert vision.primary_verdicts(reading, context, today=TODAY)[vision.OCCUPANCY].reason == "libre_contredit"


def test_occupied_or_rented_are_accepted_on_agreement_even_with_contrary_words() -> None:
    reading = _reading(occupancy_status=_claim("rented", "Le bien est occupé par un locataire en vertu d'un bail"))
    candidates = vision.primary_verdicts(reading, _context(), today=TODAY)
    final = vision.final_verdicts(candidates, reading, _context(), today=TODAY)
    assert final[vision.OCCUPANCY] == vision.Verdict(ACCEPTED, value="rented", page=PAGE)


# --- Second lecteur -----------------------------------------------------------------------------------------------


def test_values_are_kept_only_when_the_second_reader_agrees_within_the_field_tolerance() -> None:
    primary = vision.primary_verdicts(
        _reading(habitable_surface_m2=_claim(62.4, "surface habitable de 62,40 m²"),
                 rooms_count=_claim(3, "comprenant 3 pièces principales")),
        _context(),
        today=TODAY,
    )
    text = PAGE_TEXT.replace("62,40", "63,10")
    second = _reading(
        habitable_surface_m2=_claim(63.1, "surface habitable de 63,10 m²"),
        rooms_count={"valeur": "inconnu"},
    )

    final = vision.final_verdicts(primary, second, _context(text), today=TODAY)

    assert final[vision.HABITABLE].status == ACCEPTED
    assert final[vision.ROOMS] == vision.Verdict(DISAGREEMENT, "second_inconnu")


@pytest.mark.parametrize(
    ("field_name", "first", "second", "agree"),
    [
        (vision.HABITABLE, Decimal("50"), Decimal("51"), True),
        (vision.HABITABLE, Decimal("50"), Decimal("51.1"), False),
        (vision.LAND, Decimal("1000"), Decimal("1020"), True),
        (vision.LAND, Decimal("1000"), Decimal("1021"), False),
        (vision.ROOMS, 3, 3, True),
        (vision.ROOMS, 3, 4, False),
        (vision.OCCUPANCY, "occupied", "rented", False),
    ],
)
def test_tolerances_are_those_of_auction_fact_fields(field_name: str, first: object, second: object, agree: bool) -> None:
    assert vision.values_agree(field_name, first, second) is agree


def test_different_value_or_unverified_quote_from_the_second_reader_is_a_disagreement() -> None:
    primary = vision.primary_verdicts(_reading(rooms_count=_claim(3, "comprenant 3 pièces principales")), _context(), today=TODAY)
    other_value = _reading(rooms_count=_claim(3, "trois pièces inventées"))
    assert vision.final_verdicts(primary, other_value, _context(), today=TODAY)[vision.ROOMS].reason == "second_non_verifie"
    assert vision.final_verdicts(primary, None, _context(), today=TODAY)[vision.ROOMS].status == DISAGREEMENT


def test_second_reader_only_rereads_the_pages_cited_by_candidates() -> None:
    verdicts = {
        vision.ROOMS: vision.Verdict(CANDIDATE, value=3, page=PageRef(2, 5)),
        vision.HABITABLE: vision.Verdict(CANDIDATE, value=Decimal(50), page=PageRef(1, 1)),
        vision.LAND: vision.Verdict(REJECTED, "citation_introuvable"),
    }
    assert vision.cited_pages(verdicts) == [PageRef(1, 1), PageRef(2, 5)]


# --- Comparaison avec la fiche ------------------------------------------------------------------------------------


def test_comparison_with_the_sale_uses_the_same_tolerances_and_reads_visit_texts() -> None:
    assert vision.compare_with_sale(vision.HABITABLE, Decimal("62.4"), Decimal("62"), today=TODAY) == "same"
    assert vision.compare_with_sale(vision.HABITABLE, Decimal("62.4"), None, today=TODAY) == "empty"
    assert vision.compare_with_sale(vision.OCCUPANCY, "rented", "unknown", today=TODAY) == "empty"
    assert vision.compare_with_sale(vision.ROOMS, 3, 4, today=TODAY) == "different"
    visits = ["Le 3 décembre 2026 de 10h à 12h", "10/12/2026 14h"]
    assert vision.compare_with_sale(
        vision.VISITS, frozenset({date(2026, 12, 3), date(2026, 12, 10)}), visits, today=TODAY
    ) == "same"
    assert vision.compare_with_sale(vision.VISITS, frozenset({date(2026, 12, 3)}), ["2026-11-02"], today=TODAY) == "empty"
