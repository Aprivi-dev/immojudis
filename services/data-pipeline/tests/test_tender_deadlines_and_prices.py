"""Appels d'offres (Cessions de l'État, AGRASC, notaires) : date limite, échéance passée et prix annoncé.

Phrases réelles relevées le 03/11/2026 dans les cahiers des charges et les pages des ventes encore « à venir ».
"""

from __future__ import annotations

from datetime import UTC, date, datetime, timedelta
from decimal import Decimal

from src.admission import closes_expired_offer_deadline
from src.lifecycle import mark_past_sales
from src.models import AuctionSale
from src.pdf_enrichment import enrich_sale_from_pdf_text
from src.pdf_offer_deadline import (
    apply_page_offer_deadline,
    extract_offer_deadline_from_documents,
    offer_deadline_candidates,
    offer_deadline_sale_date,
    record_offer_deadline,
)
from src.pdf_starting_price import _extract_starting_price_with_evidence

_MONTHS = ("janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre",
           "novembre", "décembre")


def _deadlines(text: str) -> list[str]:
    return [str(item["offer_deadline"]) for item in offer_deadline_candidates(text)]


def _french(day: date) -> str:
    return f"{day.day} {_MONTHS[day.month - 1]} {day.year}"


def _document(text: str) -> dict[str, object]:
    return {
        "label": "2_Condition_de_vente_-_Cahier_des_charges.pdf",
        "url": "https://example.test/ccv.pdf",
        "text": text,
        "pages": [{"page": 4, "text": text}],
        "complete": True,
        "extraction_status": "extracted",
    }


def _tender(source_name: str = "cessions_etat", **values: object) -> AuctionSale:
    defaults: dict[str, object] = {
        "source_name": source_name,
        "source_url": f"https://example.test/{source_name}/bien",
        "surface_m2": Decimal("161"),
        "status": "upcoming",
    }
    return AuctionSale(**{**defaults, **values})


# --- 1. Libellés de date limite ------------------------------------------------------------------------------


def test_real_tender_deadline_wordings_are_read() -> None:
    assert _deadlines(
        "Ces plis sont, soit transmis par voie postale, par lettre recommandée avec accusé de réception, soit remis "
        "directement contre récépissé au plus tard le mardi 8 décembre 2026 à 12h (jour et heure limite tant du "
        "récépissé que de l’accusé de réception postal) sous peine d’irrecevabilité"
    )[0] == "2026-12-08T11:00:00+00:00"
    assert _deadlines(
        "au plus tard le 25 novembre 2026 à 12h (jour et heure limite tant du récépissé que de l’accusé de réception"
    ) == ["2026-11-25T11:00:00+00:00"]
    # « midi » est 12 h, heure de Paris.
    assert set(_deadlines(
        "Ce pli sera remis directement contre récépissé au plus tard le vendredi 13 novembre 2026 à midi (jour et "
        "heure limite du récépissé de remise) sous peine d’irrecevabilité"
    )) == {"2026-11-13T11:00:00+00:00"}
    # Vente notariale interactive : la fin de la période d'offres.
    assert _deadlines(
        "La vente IMMO-INTERACTIF aura lieu : Du 5 novembre 2026 à 13h30 Au 6 novembre 2026 à 13h30. 6 – Choix"
    ) == ["2026-11-06T12:30:00+00:00"]
    assert _deadlines(
        "Date limite de réception des offres fermes : vendredi 20 novembre 2026 à 12 heures (heure locale de Paris)."
    ) == ["2026-11-20T11:00:00+00:00"]
    assert _deadlines("Début de vente : Le 26/05/2026 à 14:00 Date de fin de vente : Le 28/05/2026 à 16:00 Mise") == [
        "2026-05-28T14:00:00+00:00"
    ]
    assert _deadlines("Ce pli devra être impérativement transmis : - Au plus tard le 15/10/2025 à 18h. - Adressé") == [
        "2025-10-15T16:00:00+00:00"
    ]
    assert _deadlines("Ce pli devra être impérativement reçu : - au plus tard le jeudi 22 février 2024 à 16H00 -") == [
        "2024-02-22T15:00:00+00:00"
    ]
    assert _deadlines(
        "– soit remise directement en mains propres contre récépissé, au plus tard le 10 décembre 2026 à 15 h, sous "
        "peine d’irrecevabilité, À l’adresse"
    ) == ["2026-12-10T14:00:00+00:00"]


def test_au_plus_tard_outside_an_offer_context_is_not_a_deadline() -> None:
    assert _deadlines("L'acte signé au plus tard le 15 mars 2027.") == []
    assert _deadlines("Le candidat dont l'offre est retenue signera l'acte de vente au plus tard le 15 mars 2027.") == []
    assert _deadlines(
        "Les candidats désirant visiter l’Immeuble doivent en formuler la demande au moins 48 heures avant la date de "
        "visite souhaitée et au plus tard le 21 octobre 2026 exclusivement en français"
    ) == []
    assert _deadlines(
        "Les questions seront déposées dans l'espace notarial jusqu’au vendredi 30 octobre 2026 à midi (12h00) au plus "
        "tard (heure locale de Paris). Les réponses seront faites le vendredi 6 novembre 2026 au plus tard"
    ) == []
    assert _deadlines("Les offres retenues : paiement du prix au plus tard le 2 janvier 2027.") == []
    # The calendar row after the deadline (Bougival): only the deadline is read.
    assert _deadlines(
        "Date limite de réception du dossier 10/12/2026 à 16h00 d'offre Date de sélection du lauréat Au plus tard le "
        "07/01/2027 Cahier des charges"
    ) == ["2026-12-10T15:00:00+00:00"]
    assert _deadlines(
        "L'offre vaut acceptation de régulariser l’acte de vente des biens dans le respect du calendrier de la "
        "consultation, savoir au plus tard le 29 janvier 2027"
    ) == []


def test_the_same_day_written_twice_is_one_deadline_with_its_time() -> None:
    selected = extract_offer_deadline_from_documents([_document(
        "Date limite de réception des offres Mercredi 25 février 2026 Date limite d'ouverture des plis Jeudi 5 mars "
        "2026. DATE LIMITE DE RÉCEPTION DES CANDIDATURES LE MERCREDI 25 FÉVRIER 2026 À 14 HEURES Les plis"
    )])

    assert selected is not None
    assert selected["ambiguous"] is False
    assert selected["offer_deadline"] == "2026-02-25T13:00:00+00:00"


def test_the_agrasc_page_deadline_is_read_from_the_page_text() -> None:
    sale = _tender(
        "agrasc",
        raw_text=(
            "Date limite pour poser des questions dans le cadre du Dossier d’Informations : vendredi 6 novembre 2026 "
            "à 12 heures (heure locale de Paris). Date limite de réception des offres fermes : vendredi 20 novembre "
            "2026 à 12 heures (heure locale de Paris). Notification par l’AGRASC au candidat retenu"
            "\n\n--- PDF TEXT ENRICHMENT ---\nDate limite de remise des offres : 1er mars 2020"
        ),
    )

    extraction = record_offer_deadline(sale, [], complete_texts=True)

    assert extraction is not None
    assert extraction["offer_deadline"] == "2026-11-20T11:00:00+00:00"
    assert extraction["document_type"] == "source_page"
    assert sale.raw_payload["pdf_offer_deadline_extraction"]["document_url"] == sale.source_url


def test_the_conditions_of_sale_outrank_the_page() -> None:
    ahead = date.today() + timedelta(days=40)
    sale = _tender(raw_text=f"Date de fin de vente : Le {(ahead + timedelta(days=3)).strftime('%d/%m/%Y')} à 16:00")

    extraction = record_offer_deadline(
        sale, [_document(f"Date limite de remise des offres : {_french(ahead)} à 12h00.")], complete_texts=True
    )

    assert extraction is not None and extraction["document_type"] == "cahier_conditions_vente"


def test_a_page_deadline_still_ahead_dates_a_tender_without_attachments() -> None:
    ahead = date.today() + timedelta(days=17)
    sale = _tender("agrasc", raw_text=f"Date limite de réception des offres fermes : {_french(ahead)} à 12 heures.")

    apply_page_offer_deadline(sale)

    assert sale.sale_date is not None and sale.sale_date.date() == ahead
    assert sale.raw_payload["pdf_sale_date_extraction"]["document_type"] == "source_page"
    assert sale.raw_payload["pdf_fact_provenance"]["sale_date"]["document_url"] == sale.source_url

    # A passed page deadline is left to the document re-read, which closes the published row.
    past = _tender("agrasc", raw_text="Date limite de réception des offres fermes : 20 novembre 2020 à 12 heures.")
    apply_page_offer_deadline(past)
    assert past.sale_date is None
    # A judicial sale page is never read for an offer deadline.
    judicial = _tender("licitor", raw_text=f"Date limite de réception des offres : {_french(ahead)}.")
    apply_page_offer_deadline(judicial)
    assert judicial.sale_date is None


# --- 2. Échéance passée ---------------------------------------------------------------------------------------


def test_a_passed_deadline_closes_the_call_for_offers() -> None:
    passed = date.today() - timedelta(days=20)
    sale = _tender(updated_at=datetime.now(UTC))
    text = (
        "Ces plis sont, soit transmis par voie postale, par lettre recommandée avec accusé de réception, au plus tard "
        f"le vendredi {_french(passed)} à 12h00 (jour et heure limite tant du récépissé que de l’accusé de réception "
        "postal) sous peine d’irrecevabilité."
    )

    enrich_sale_from_pdf_text(sale, [_document(text)])

    assert sale.sale_date is not None and sale.sale_date.date() == passed
    assert sale.status == "past"
    extraction = sale.raw_payload["pdf_sale_date_extraction"]
    assert extraction["sale_date_kind"] == "offer_deadline" and extraction["offer_deadline_expired"] is True
    assert "pdf_sale_date_rejected" not in sale.raw_payload
    provenance = sale.raw_payload["pdf_fact_provenance"]
    assert provenance["sale_date"]["document_url"] == "https://example.test/ccv.pdf"
    assert provenance["status"]["value"] == "past" and provenance["status"]["baseline"] == "upcoming"
    # The enrichment write carries it to the published row (publication_rejection would drop an expired sale).
    assert closes_expired_offer_deadline(sale)
    assert mark_past_sales([sale]).marked_past == 0  # already past


def test_a_passed_deadline_is_not_forced_on_other_sales_or_without_certainty() -> None:
    passed = _french(date.today() - timedelta(days=20))
    judicial = _tender("licitor")
    enrich_sale_from_pdf_text(judicial, [_document(f"Date limite de remise des offres : {passed} à 12h00.")])
    assert judicial.sale_date is None and judicial.status == "upcoming"

    ambiguous = _tender()
    enrich_sale_from_pdf_text(ambiguous, [
        _document(f"Date limite de remise des offres : {passed} à 12h00."),
        {**_document(f"Date limite de remise des offres : {_french(date.today() - timedelta(days=50))}."),
         "url": "https://example.test/ccv-2.pdf"},
    ])
    assert ambiguous.sale_date is None and ambiguous.status == "upcoming"
    assert not closes_expired_offer_deadline(ambiguous)


def test_the_future_guard_is_kept() -> None:
    now = datetime(2026, 11, 3, tzinfo=UTC)
    far = {"value": now + timedelta(days=800), "offer_deadline": "x", "ambiguous": False, "date_only": False}
    assert offer_deadline_sale_date(far, allow_expired=True, now=now)["value"] is None
    soon = {**far, "value": now + timedelta(days=30)}
    assert offer_deadline_sale_date(soon, allow_expired=True, now=now)["value"] == soon["value"]
    gone = {**far, "value": now - timedelta(days=400)}
    candidate = offer_deadline_sale_date(gone, allow_expired=True, now=now)
    assert candidate["value"] == gone["value"] and candidate["offer_deadline_expired"] is True
    assert offer_deadline_sale_date(gone, now=now)["value"] is None
    # A date-only deadline is open until the end of its Paris day.
    today = {**far, "value": datetime(2026, 11, 3, tzinfo=UTC), "date_only": True}
    assert "offer_deadline_expired" not in offer_deadline_sale_date(today, allow_expired=True, now=now + timedelta(hours=20))


def test_a_closed_tender_is_written_only_by_a_document_re_read_of_a_published_row() -> None:
    sale = _tender(sale_date=datetime(2025, 10, 15, 16, tzinfo=UTC), status="past")
    sale.raw_payload["pdf_sale_date_extraction"] = {"sale_date_kind": "offer_deadline", "offer_deadline_expired": True}
    assert not closes_expired_offer_deadline(sale)  # never read from the database
    sale.updated_at = datetime.now(UTC)
    assert closes_expired_offer_deadline(sale)
    sale.raw_payload["pdf_sale_date_extraction"] = {"sale_date_kind": "offer_deadline"}
    assert not closes_expired_offer_deadline(sale)


# --- 3. Prix annoncé ------------------------------------------------------------------------------------------


def _price(text: str) -> tuple[Decimal, str] | None:
    result = _extract_starting_price_with_evidence(text, tender=True)
    return (result["value"], result["price_kind"]) if result else None


def test_tender_price_announcements_are_read_from_their_figure() -> None:
    assert _price(
        "Ces frais sont inclus dans le prix de départ FAI indiqué sur le site de DEUX MILLIONS QUATRE-VINGT-SEIZE MILLE "
        "EUROS (2 096 000,00 EUR)."
    ) == (Decimal("2096000.00"), "prix_de_depart")
    assert _price("La mise à prix de ce bien a été fixée à soixante-quinze mille euros (75 000 €) frais d’acquisition") == (
        Decimal("75000"), "mise_a_prix"
    )
    assert _price("Pour être examiné, le montant minimum de l’offre devra être de : Six mille quatre cent euros (6 400 €).") == (
        Decimal("6400"), "prix_minimum"
    )
    assert _price("un prix minimum net vendeur d'un montant de 43.000,00 euros.") == (Decimal("43000.00"), "prix_minimum")
    assert _price("Prix d'appel : Le bien est mis à prix à hauteur de 95 000 €, frais d'agence inclus") == (
        Decimal("95000"), "prix_d_appel"
    )
    assert _price("La MISE A PRIX est fixée à : QUATRE CENT CINQUANTE MILLE EUROS (450 000,00 EUR)") == (
        Decimal("450000.00"), "mise_a_prix"
    )
    assert _price(
        "La mise à prix minimum pour cette cession est fixée à ONZE MILLE TROIS CENT EUROS (11 300€)"
    ) == (Decimal("11300"), "mise_a_prix")
    assert _price("Le montant minimum de l'offre devra être de CENT SOIXANTE-DEUX EUROS (162,00 €).") == (
        Decimal("162.00"), "prix_minimum"
    )


def test_deposits_and_fees_are_never_the_announced_price() -> None:
    assert _price("Un dépôt de garantie de 10 % du prix minimum de 43 000 € est exigé.") is None
    assert _price("La consignation de la mise à prix est fixée à 5 000 €.") is None
    assert _price("Le prix minimum : frais de dossier de 3 000 €.") is None
    assert _price("La mise à prix est fixée à 10 % du prix.") is None
    # A figure left blank is not replaced by a later number.
    assert _price(
        "Le PRIX DE DEPART est fixé à QUATRE CENT QUATRE-VINGT- DIX-NEUF MILLE EUROS ( ) MODE ET CONDITIONS 12 - 5 000 €"
    ) is None
    # Outside a call for offers, only the court « mise à prix » wordings are read.
    assert _extract_starting_price_with_evidence("La MISE A PRIX est fixée à : CENT MILLE EUROS (100 000 EUR)") is None


def test_a_re_read_tender_gets_its_price_with_provenance() -> None:
    sale = _tender()
    enrich_sale_from_pdf_text(sale, [_document("Le dossier est complet.")])
    assert sale.starting_price_eur is None

    enrich_sale_from_pdf_text(sale, [_document(
        "2 - INDICATION RELATIVE AU PRIX. La MISE A PRIX est fixée à : QUATRE CENT CINQUANTE MILLE EUROS "
        "(450 000,00 EUR). Un dépôt de garantie de 45 000 € est exigé."
    )])

    assert sale.starting_price_eur == Decimal("450000.00")
    extraction = sale.raw_payload["starting_price_extraction"]
    assert extraction["status"] == "extracted" and extraction["price_kind"] == "mise_a_prix"
    assert sale.raw_payload["pdf_fact_provenance"]["starting_price_eur"]["document_url"] == "https://example.test/ccv.pdf"

    judicial = _tender("licitor")
    enrich_sale_from_pdf_text(judicial, [_document("Le montant minimum de l'offre devra être de 2 000 €.")])
    assert judicial.starting_price_eur is None
