from __future__ import annotations

import json
from decimal import Decimal

from src.official_sources.judilibre import JudilibreDecision
from src.outcome_ingestion.judilibre_extraction import (
    extract_judilibre_candidate_facts,
    parse_french_money,
)


def _decision(
    text: str,
    *,
    zones: dict[str, object] | None = None,
) -> JudilibreDecision:
    payload: dict[str, object] = {
        "id": "synthetic-decision",
        "jurisdiction": "tj",
        "decision_date": "2026-07-30",
        "text": text,
        "timeline": None,
        "titlesAndSummaries": [],
    }
    if zones is not None:
        payload["zones"] = zones
    return JudilibreDecision.model_validate(payload)


def _claims_by_type(text: str) -> dict[str, list[dict[str, object]]]:
    result = extract_judilibre_candidate_facts(_decision(text))
    claims: dict[str, list[dict[str, object]]] = {}
    for claim in result.normalized_fields()["claims"]:
        assert isinstance(claim, dict)
        claims.setdefault(str(claim["claim_type"]), []).append(claim)
    return claims


def test_extracts_starting_and_hammer_prices_as_distinct_review_only_claims() -> None:
    text = (
        "La mise à prix est fixée à la somme de 80 000,00 euros. "
        "PAR CES MOTIFS Le juge adjuge le bien au prix principal de 125.000 euros."
    )

    result = extract_judilibre_candidate_facts(_decision(text))
    claims = result.normalized_fields()["claims"]

    assert [claim["claim_type"] for claim in claims] == [
        "starting_price_eur",
        "hammer_price_eur",
        "procedural_event",
    ]
    assert claims[0]["normalized_value"] == "80000.00"
    assert claims[1]["normalized_value"] == "125000.00"
    assert claims[0]["currency"] == claims[1]["currency"] == "EUR"
    assert claims[2]["normalized_value"] == "adjudication_pronounced"
    assert result.status == "candidate_facts_extracted"


def test_deposit_fees_debt_and_costs_are_never_promoted_to_sale_prices() -> None:
    text = (
        "La consignation représente 10 % de la mise à prix, avec un minimum de 3 000 euros. "
        "La créance est de 220 000 euros et les dépens de 1 500 euros."
    )

    result = extract_judilibre_candidate_facts(_decision(text))

    assert result.normalized_fields()["claims"] == []
    assert result.status == "no_candidate_facts"


def test_future_adjudication_on_a_starting_price_is_not_a_hammer_price() -> None:
    text = "L'adjudication aura lieu sur la mise à prix de 90 000 euros."

    claims = _claims_by_type(text)

    assert claims["starting_price_eur"][0]["normalized_value"] == "90000.00"
    assert "hammer_price_eur" not in claims


def test_future_conditional_and_negated_adjudications_are_not_outcomes() -> None:
    texts = (
        "PAR CES MOTIFS Le bien sera adjugé au prix principal de 100 000 euros.",
        "PAR CES MOTIFS Le bien serait adjugé au prix principal de 110 000 euros.",
        "PAR CES MOTIFS Le juge n’adjuge pas le bien au prix de 130 000 euros.",
    )

    for text in texts:
        claims = _claims_by_type(text)
        assert "hammer_price_eur" not in claims
        assert all(
            claim["normalized_value"] != "adjudication_pronounced"
            for claim in claims.get("procedural_event", [])
        )


def test_passive_modal_future_and_conditional_adjudications_are_not_outcomes() -> None:
    texts = (
        "PAR CES MOTIFS Le bien devrait être adjugé au prix de 100 000 euros.",
        "PAR CES MOTIFS Le bien pourrait être adjugé au prix de 101 000 euros.",
        "PAR CES MOTIFS Le bien devra être adjugé au prix de 102 000 euros.",
        "PAR CES MOTIFS Le bien peut être adjugé au prix de 103 000 euros.",
        "PAR CES MOTIFS Le bien sera prochainement adjugé au prix de 104 000 euros.",
        "PAR CES MOTIFS Le bien va être adjugé au prix de 105 000 euros.",
        "PAR CES MOTIFS Si le bien est adjugé au prix de 106 000 euros.",
        "PAR CES MOTIFS Ordonne que le bien soit adjugé au prix de 107 000 euros.",
        "PAR CES MOTIFS Le bien doit être adjugé au prix de 108 000 euros.",
        "PAR CES MOTIFS Le juge adjugera le bien au prix de 109 000 euros.",
        "PAR CES MOTIFS Le juge ne peut adjuger le bien au prix de 110 000 euros.",
    )

    for text in texts:
        claims = _claims_by_type(text)
        assert "hammer_price_eur" not in claims
        assert all(
            claim["normalized_value"] != "adjudication_pronounced"
            for claim in claims.get("procedural_event", [])
        )


def test_all_common_adjudication_negations_are_rejected() -> None:
    texts = (
        "PAR CES MOTIFS Le bien n’a pas été adjugé au prix de 114 000 euros.",
        "PAR CES MOTIFS Le bien n’est pas adjugé au prix de 115 000 euros.",
        "PAR CES MOTIFS Le bien ne peut pas être adjugé au prix de 116 000 euros.",
        "PAR CES MOTIFS Le juge n’adjuge aucun bien au prix de 117 000 euros.",
        "PAR CES MOTIFS Le juge n’adjuge jamais le bien au prix de 118 000 euros.",
        "PAR CES MOTIFS Le juge n’adjuge plus le bien au prix de 119 000 euros.",
    )

    for text in texts:
        claims = _claims_by_type(text)
        assert "hammer_price_eur" not in claims
        assert all(
            claim["normalized_value"] != "adjudication_pronounced"
            for claim in claims.get("procedural_event", [])
        )


def test_non_property_use_of_adjuge_is_not_an_auction_result() -> None:
    text = (
        "PAR CES MOTIFS Le juge adjuge à la société le bénéfice de ses conclusions "
        "pour la somme de 10 000 euros au titre des dépens."
    )

    assert extract_judilibre_candidate_facts(_decision(text)).normalized_fields()["claims"] == []

    prior_adjudicataire = (
        "PAR CES MOTIFS Déclare irrecevable le recours formé par la société, adjudicataire du bien "
        "acquis moyennant le prix de 75 000 euros."
    )
    assert extract_judilibre_candidate_facts(_decision(prior_adjudicataire)).normalized_fields()["claims"] == []


def test_annulled_or_reversed_adjudication_is_not_an_outcome() -> None:
    texts = (
        "PAR CES MOTIFS Annule le jugement qui adjuge le bien au prix de 100 000 euros.",
        "PAR CES MOTIFS Infirme la décision qui adjuge le lot pour la somme de 120 000 euros.",
    )

    for text in texts:
        claims = _claims_by_type(text)
        assert "hammer_price_eur" not in claims
        assert all(
            claim["normalized_value"] != "adjudication_pronounced"
            for claim in claims.get("procedural_event", [])
        )


def test_requested_negated_or_annulled_starting_price_is_not_promoted() -> None:
    texts = (
        "Le créancier demande que la mise à prix soit fixée à 80 000 euros.",
        "La mise à prix ne peut être fixée à 90 000 euros.",
        "Le tribunal annule la mise à prix fixée à 100 000 euros.",
    )

    for text in texts:
        assert "starting_price_eur" not in _claims_by_type(text)


def test_starting_price_adjustments_select_the_new_amount() -> None:
    texts = (
        "Le juge porte la mise à prix de 80 000 euros à 100 000 euros.",
        "Le juge ramène la mise à prix de 100 000 euros à 80 000 euros.",
        "La mise à prix est portée de 90 000 euros à 120 000 euros.",
    )

    expected = ("100000.00", "80000.00", "120000.00")
    for text, amount in zip(texts, expected, strict=True):
        claims = _claims_by_type(text)
        assert [claim["normalized_value"] for claim in claims["starting_price_eur"]] == [amount]


def test_chained_starting_price_adjustments_fail_closed() -> None:
    texts = (
        "Le juge porte la mise à prix de 80 000 euros à 100 000 euros puis à 120 000 euros.",
        "La mise à prix, portée de 80 000 euros à 100 000 euros, est finalement relevée à 120 000 euros.",
        "Le juge porte la mise à prix de 80 000 euros à 100 000 euros puis la relève à 120 000 euros.",
        "La mise à prix est portée à 100 000 euros puis à 120 000 euros.",
    )

    for text in texts:
        assert "starting_price_eur" not in _claims_by_type(text)


def test_refused_or_later_reversed_starting_price_is_not_promoted() -> None:
    texts = (
        "Le juge refuse de fixer la mise à prix à 80 000 euros.",
        "Le juge refuse que la mise à prix soit fixée à 80 000 euros.",
        "Le juge refuse de retenir la mise à prix fixée à 80 000 euros.",
        "Le juge dit n’y avoir lieu de fixer la mise à prix à 80 000 euros.",
        "La mise à prix a été fixée à 80 000 euros par le jugement désormais infirmé.",
    )

    for text in texts:
        assert "starting_price_eur" not in _claims_by_type(text)


def test_modal_future_negative_or_attributed_starting_prices_are_not_promoted() -> None:
    texts = (
        "La mise à prix devra être fixée à 82 000 euros.",
        "La mise à prix devrait être fixée à 83 000 euros.",
        "La mise à prix pourrait être fixée à 81 000 euros.",
        "La mise à prix peut être fixée à 84 000 euros.",
        "La mise à prix sera prochainement fixée à 85 000 euros.",
        "La mise à prix va être fixée à 86 000 euros.",
        "Si la mise à prix est fixée à 87 000 euros.",
        "La mise à prix n’a pas été fixée à 88 000 euros.",
        "La mise à prix n’est pas fixée à 89 000 euros.",
        "Selon le débiteur, la mise à prix est fixée à 90 000 euros.",
        "Selon le créancier, la mise à prix est fixée à 91 000 euros.",
        "Le créancier indique que la mise à prix est fixée à 92 000 euros.",
        "Le créancier conclut à ce que la mise à prix soit fixée à 93 000 euros.",
        "Le débiteur conteste la mise à prix fixée à 94 000 euros.",
    )

    for text in texts:
        assert "starting_price_eur" not in _claims_by_type(text)


def test_outcome_extraction_requires_an_explicit_dispositive_section() -> None:
    text = (
        "Le jugement infirmé avait adjugé le bien au prix de 95 000 euros. "
        "Selon le créancier, le bien a été adjugé au prix de 96 000 euros, ce qui est contesté."
    )

    assert extract_judilibre_candidate_facts(_decision(text)).normalized_fields()["claims"] == []


def test_hammer_nominal_phrases_in_reversal_costs_or_debt_context_are_rejected() -> None:
    texts = (
        "PAR CES MOTIFS Annule l’adjudication prononcée au prix principal de 100 000 euros.",
        "PAR CES MOTIFS Infirme le jugement ayant constaté l’adjudication prononcée au prix de 100 000 euros.",
        "PAR CES MOTIFS Annule le prix principal d’adjudication fixé à 100 000 euros.",
        "PAR CES MOTIFS Dit que les frais seront calculés sur le prix d’adjudication fixé à 100 000 euros.",
        "PAR CES MOTIFS Fixe la créance au prix d’adjudication de 100 000 euros.",
    )

    for text in texts:
        assert "hammer_price_eur" not in _claims_by_type(text)


def test_modal_negative_or_requested_nominal_hammer_prices_are_rejected() -> None:
    texts = (
        "PAR CES MOTIFS Le prix d’adjudication devrait être fixé à 120 000 euros.",
        "PAR CES MOTIFS Le prix d’adjudication ne peut être fixé à 122 000 euros.",
        "PAR CES MOTIFS Le prix d’adjudication n’a pas été fixé à 123 000 euros.",
        "PAR CES MOTIFS Il n’y a pas lieu de fixer le prix d’adjudication à 124 000 euros.",
        "PAR CES MOTIFS Rejette la demande tendant à fixer le prix d’adjudication à 125 000 euros.",
        "PAR CES MOTIFS Le créancier demande que le prix d’adjudication soit fixé à 126 000 euros.",
    )

    for text in texts:
        assert "hammer_price_eur" not in _claims_by_type(text)

    positive = _claims_by_type(
        "PAR CES MOTIFS Fixe le prix d’adjudication à 127 000 euros."
    )
    assert positive["hammer_price_eur"][0]["normalized_value"] == "127000.00"


def test_narrative_reference_to_attacked_dispositive_is_not_a_section_marker() -> None:
    text = "Le dispositif du jugement attaqué adjuge le bien au prix de 111 000 euros."

    assert extract_judilibre_candidate_facts(_decision(text)).normalized_fields()["claims"] == []


def test_explicit_dispositive_heading_remains_a_valid_fallback_marker() -> None:
    text = "DISPOSITIF : Le juge adjuge le bien au prix de 112 000 euros."

    claims = _claims_by_type(text)
    assert claims["hammer_price_eur"][0]["normalized_value"] == "112000.00"


def test_reformed_referenced_adjudication_or_price_is_not_promoted() -> None:
    texts = (
        "PAR CES MOTIFS Réforme le jugement qui adjuge le bien au prix de 112 000 euros.",
        "PAR CES MOTIFS Réforme le jugement en ce qu’il fixe le prix d’adjudication à 113 000 euros.",
    )

    for text in texts:
        claims = _claims_by_type(text)
        assert "hammer_price_eur" not in claims
        assert all(
            claim["normalized_value"] != "adjudication_pronounced"
            for claim in claims.get("procedural_event", [])
        )


def test_adjacent_costs_ruling_does_not_hide_valid_hammer_price() -> None:
    text = (
        "PAR CES MOTIFS Le juge adjuge le bien au prix de 100 000 euros. "
        "Fixe les dépens à 2 000 euros."
    )

    assert _claims_by_type(text)["hammer_price_eur"][0]["normalized_value"] == "100000.00"


def test_starting_price_accepts_colon_and_eur_typography() -> None:
    claims = _claims_by_type("La mise à prix : 80 000 EUR.")

    assert claims["starting_price_eur"][0]["normalized_value"] == "80000.00"


def test_conflicting_hammer_prices_are_marked_ambiguous_and_omitted() -> None:
    text = (
        "PAR CES MOTIFS Le juge adjuge le premier lot au prix de 100 000 euros. "
        "Le juge adjuge le second lot au prix de 140 000 euros."
    )

    result = extract_judilibre_candidate_facts(_decision(text))
    claims = result.normalized_fields()["claims"]

    assert all(claim["claim_type"] != "hammer_price_eur" for claim in claims)
    assert result.normalized_fields()["ambiguous_claim_types"] == ["hammer_price_eur"]


def test_money_parser_handles_french_grouping_without_float_rounding() -> None:
    assert parse_french_money("185 000,00") == Decimal("185000.00")
    assert parse_french_money("185\u202f000,50") == Decimal("185000.50")
    assert parse_french_money("185.000,75") == Decimal("185000.75")
    assert parse_french_money("185000") == Decimal("185000.00")
    assert parse_french_money("0") is None


def test_procedural_events_require_explicit_dispositive_phrases() -> None:
    text = (
        "PAR CES MOTIFS Ordonne la réitération des enchères. "
        "Déclare recevable la déclaration de surenchère."
    )

    claims = _claims_by_type(text)["procedural_event"]

    assert {claim["normalized_value"] for claim in claims} == {
        "reiteration_requested",
        "surenchere_filed",
    }


def test_reversed_referenced_procedural_events_are_not_promoted() -> None:
    texts = (
        "PAR CES MOTIFS Annule le jugement qui ordonne le report de la vente.",
        "PAR CES MOTIFS Infirme le jugement qui déclare les enchères désertes.",
        "PAR CES MOTIFS Annule le jugement qui déclare recevable la surenchère.",
    )

    for text in texts:
        assert "procedural_event" not in _claims_by_type(text)


def test_reversal_en_ce_que_pronoun_variants_do_not_promote_report() -> None:
    references = ("qu'il", "qu’elle", "qu'ils", "qu’elles")

    for reference in references:
        text = f"PAR CES MOTIFS Infirme la décision en ce {reference} ordonne le report de la vente."
        assert "procedural_event" not in _claims_by_type(text)

    reformed = (
        "PAR CES MOTIFS Réforme le jugement en ce qu’il ordonne le report de la vente."
    )
    assert "procedural_event" not in _claims_by_type(reformed)


def test_incompatible_terminal_events_are_omitted_as_ambiguous() -> None:
    text = (
        "PAR CES MOTIFS Ordonne le report de la vente. "
        "Le juge adjuge le bien au prix de 140 000 euros."
    )

    result = extract_judilibre_candidate_facts(_decision(text))
    claims = result.normalized_fields()["claims"]

    assert all(claim["claim_type"] != "procedural_event" for claim in claims)
    assert "procedural_event" in result.normalized_fields()["ambiguous_claim_types"]


def test_official_dispositive_zone_works_without_a_lexical_marker() -> None:
    text = "Exposé sans marqueur. Le juge adjuge le bien au prix de 125 000 euros."
    start = text.index("Le juge")

    result = extract_judilibre_candidate_facts(
        _decision(text, zones={"dispositif": [{"start": start, "end": len(text)}]})
    )
    claims = result.normalized_fields()["claims"]

    assert {claim["claim_type"] for claim in claims} == {
        "hammer_price_eur",
        "procedural_event",
    }


def test_all_official_dispositive_fragments_are_scanned() -> None:
    first = "Déclare recevable la déclaration de surenchère."
    second = "Le juge adjuge le lot au prix de 140 000 euros."
    text = f"Historique non opératoire. {first} Intermède. {second}"
    first_start = text.index(first)
    second_start = text.index(second)
    zones = {
        "dispositif": [
            {"start": first_start, "end": first_start + len(first)},
            {"start": second_start, "end": second_start + len(second)},
        ]
    }

    result = extract_judilibre_candidate_facts(_decision(text, zones=zones))
    claims = result.normalized_fields()["claims"]

    assert any(claim["normalized_value"] == "surenchere_filed" for claim in claims)
    hammer_claim = next(claim for claim in claims if claim["normalized_value"] == "140000.00")
    hammer_anchor = result.field_provenance()["claims"][hammer_claim["claim_id"]]
    assert hammer_anchor["start_utf8"] == len(
        text[: text.index("adjuge", second_start)].encode("utf-8")
    )


def test_malformed_official_zone_fails_closed_but_starting_price_stays_full_text() -> None:
    text = (
        "La mise à prix est fixée à 80 000 euros. "
        "PAR CES MOTIFS Le juge adjuge le bien au prix de 125 000 euros."
    )

    result = extract_judilibre_candidate_facts(
        _decision(text, zones={"dispositif": [{"start": "invalid", "end": len(text)}]})
    )
    claims = result.normalized_fields()["claims"]

    assert [claim["claim_type"] for claim in claims] == ["starting_price_eur"]
    assert claims[0]["normalized_value"] == "80000.00"


def test_starting_price_is_scanned_outside_valid_dispositive_zones() -> None:
    text = (
        "La mise à prix est fixée à 70 000 euros. "
        "Le juge adjuge le bien au prix de 105 000 euros."
    )
    start = text.index("Le juge")

    claims = extract_judilibre_candidate_facts(
        _decision(text, zones={"dispositif": [{"start": start, "end": len(text)}]})
    ).normalized_fields()["claims"]

    assert {claim["claim_type"] for claim in claims} == {
        "starting_price_eur",
        "hammer_price_eur",
        "procedural_event",
    }


def test_hash_only_provenance_is_stable_and_contains_no_judicial_prose() -> None:
    private_text = (
        "Mme Personne ne doit jamais apparaître dans la projection. "
        "PAR CES MOTIFS Le juge adjuge le bien pour la somme de 111 000 euros."
    )
    first = extract_judilibre_candidate_facts(_decision(private_text))
    second = extract_judilibre_candidate_facts(_decision(private_text))

    assert first == second
    projection = first.normalized_fields()
    provenance = first.field_provenance()
    serialized = json.dumps({"projection": projection, "provenance": provenance}, ensure_ascii=False)
    assert "Mme Personne" not in serialized
    assert "adjuge le bien" not in serialized
    assert "quote" not in serialized
    assert "snippet" not in serialized
    assert "text" not in provenance
    claim = projection["claims"][0]
    anchor = provenance["claims"][claim["claim_id"]]
    assert claim["evidence_hash"] == anchor["evidence_sha256"]
    assert anchor["source_pointer"] == "/text"
    assert anchor["start_utf8"] < anchor["end_utf8"]

    changed = extract_judilibre_candidate_facts(_decision(private_text.replace("111 000", "112 000")))
    assert changed.normalized_fields()["claims"][0]["evidence_hash"] != claim["evidence_hash"]


def test_missing_text_stays_unknown_instead_of_becoming_a_negative_outcome() -> None:
    decision = _decision("")
    result = extract_judilibre_candidate_facts(decision)

    assert result.status == "not_extracted_missing_text"
    assert result.normalized_fields()["text_available"] is False
    assert result.normalized_fields()["claims"] == []
    assert result.field_provenance()["claims"] == {}
