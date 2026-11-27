"""Lecture des pièces v5 (candidate) : « check », ce qu'il reste à vérifier pour chaque point."""

from __future__ import annotations

from dataclasses import replace

from src import document_reading as reading
from src.document_reading import (
    PRODUCTION_PROFILE,
    ReadingDocument,
    read_sale_documents,
    revalidate_stored_points,
    validate_reading_points,
)
from src.document_reading_candidate import CANDIDATE_PROFILES, V5_PROFILE
from src.document_reading_check import checked_check

PAGE = (
    "Présence de traces visibles d'infiltration d'eau au plafond du séjour, côté cuisine. "
    "Les combles n'ont pas pu être visités : trappe encombrée. Le loyer déclaré est de 650 euros par mois."
)
QUOTE = "Présence de traces visibles d'infiltration d'eau au plafond du séjour"


def _documents() -> list[ReadingDocument]:
    return [ReadingDocument(index=1, label="Diagnostics", url=None, document_type="diagnostics_techniques",
                            pages={1: PAGE})]


def _point(check: object) -> dict[str, object]:
    return {
        "theme": "etat_travaux", "importance": "attention", "title": "Infiltration au plafond du séjour",
        "explanation": "L'origine de l'eau n'est pas établie.", "document": "D1", "page": 1, "quote": QUOTE,
        "check": check,
    }


def test_v5_is_the_v4_reading_plus_the_check_field() -> None:
    assert CANDIDATE_PROFILES == {"v5": V5_PROFILE}
    assert V5_PROFILE.version == "document_reading_v5" != reading.DOCUMENT_READING_VERSION
    assert V5_PROFILE.check_rule is checked_check
    assert V5_PROFILE.max_output_tokens == 4_800 > PRODUCTION_PROFILE.max_output_tokens
    # Everything but the version, the prompt, the rule on « check » and the room for it is the production profile.
    assert replace(
        V5_PROFILE,
        version=PRODUCTION_PROFILE.version,
        system_prompt=PRODUCTION_PROFILE.system_prompt,
        check_rule=None,
        max_output_tokens=PRODUCTION_PROFILE.max_output_tokens,
    ) == PRODUCTION_PROFILE
    prompt = V5_PROFILE.system_prompt
    assert '"check": "ce qu\'il reste à vérifier' in prompt
    assert "verbe à l'infinitif" in prompt and "ni montant" in prompt
    # Everything the v4 prompt says is still said, in the same order around the two additions.
    assert prompt.startswith(reading.SYSTEM_PROMPT.split("Réponds uniquement")[0])
    assert "check" not in reading.SYSTEM_PROMPT


def test_a_check_proper_to_the_dossier_is_kept_with_its_point() -> None:
    check = "Regarder le plafond du séjour et demander l'accès aux combles lors de la visite"
    points = validate_reading_points([_point(check)], _documents(), check_rule=checked_check)

    assert [point.get("check") for point in points] == [check]


def test_production_ignores_a_check_the_model_writes_anyway() -> None:
    points = validate_reading_points(
        [_point("Regarder le plafond du séjour lors de la visite")], _documents()
    )

    assert len(points) == 1 and "check" not in points[0]


def test_a_refused_check_is_dropped_alone_and_counted() -> None:
    refused = [
        "Vérifier ce point.",  # fits every dossier
        "À voir",  # too short, no infinitive
        "Demandez le bail à l'avocat poursuivant avant la vente",  # addressed to the reader
        "Prévoir 8 000 euros de travaux de reprise du plafond",  # a figure the page does not write
        "Renoncer à cette vente si l'origine de l'eau reste inconnue",  # advice on the decision
        "Appeler le 05 61 00 00 00 pour visiter les combles",  # a contact
        "Lire le diagnostic sur https://exemple.fr/diagnostic avant la visite",  # a link
    ]
    rejections: dict[str, int] = {}
    kept: list[object] = []
    for check in refused:
        points = validate_reading_points([_point(check)], _documents(), check_rule=checked_check, rejections=rejections)
        assert len(points) == 1, check
        kept.append(points[0].get("check"))

    assert kept == [None] * len(refused)
    assert rejections == {"check_dropped": len(refused)}


def test_a_figure_written_by_the_page_may_be_named() -> None:
    check = "Demander le bail qui fonde le loyer de 650 euros déclaré"

    assert checked_check(check, PAGE, QUOTE) == check
    assert checked_check("Demander le bail qui fonde le loyer de 700 euros déclaré", PAGE, QUOTE) is None


def test_pronominal_infinitives_and_a_registered_letter_are_not_refused() -> None:
    for check in (
        "S'assurer de l'accès aux combles lors de la visite",
        "Se renseigner en mairie sur l'origine de l'infiltration",
        "Demander la lettre recommandée adressée à l'occupant",
    ):
        assert checked_check(check, PAGE, QUOTE) == check, check
    assert checked_check("Il est recommandé de visiter les combles avant la vente", PAGE, QUOTE) is None


def test_an_empty_check_is_not_a_rejection() -> None:
    rejections: dict[str, int] = {}
    points = validate_reading_points([_point(""), ], _documents(), check_rule=checked_check, rejections=rejections)

    assert len(points) == 1 and "check" not in points[0]
    assert rejections == {}


def test_the_v5_profile_keeps_the_check_through_a_reading_and_a_replay() -> None:
    check = "Regarder le plafond du séjour et demander l'accès aux combles lors de la visite"
    seen: list[str] = []

    def generate(system_prompt: str, user_prompt: str) -> dict[str, object]:
        seen.append(system_prompt)
        return {"points": [_point(check)]}

    result = read_sale_documents(_documents(), generate_json=generate, profile=V5_PROFILE)

    assert seen == [V5_PROFILE.system_prompt]
    assert result.status == "completed"
    assert [point.get("check") for point in result.points] == [check]
    # Stored points checked again later keep their « check », and lose it alone when it breaks a rule.
    assert [point.get("check") for point in revalidate_stored_points(result.points, _documents(), check_rule=checked_check)] == [check]
    broken = [{**result.points[0], "check": "Vérifier ce point."}]
    replayed = revalidate_stored_points(broken, _documents(), check_rule=checked_check)
    assert len(replayed) == 1 and "check" not in replayed[0]
