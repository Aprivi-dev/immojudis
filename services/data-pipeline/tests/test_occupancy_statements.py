"""Occupation (libre / occupé / loué) lue phrase par phrase : extraits réels de l'audit du 03/11/2026.

Chaque extrait vient d'une vente en ligne (préfixe d'identifiant en commentaire), page source ou pièce jointe.
"""

import pytest

import src.pdf_enrichment  # noqa: F401  (loads pdf_fact_extraction without a circular import)
from src.known_document_backfill import _backfill_document_occupancy_from_known
from src.normalize import normalize_occupancy_status, normalize_sale
from src.occupancy_statements import occupancy_from_text, occupancy_status_from_text, read_occupancy_statement
from src.pdf_fact_extraction import enrich_sale_from_pdf_text
from src.sources.licitor_extraction import extract_licitor_fields
from tests.test_licitor_extraction import MULTI_LOT_TEXT


def _doc(document_type: str, text: str) -> dict[str, object]:
    return {
        "label": document_type,
        "url": f"https://example.test/{document_type}.pdf",
        "document_type": document_type,
        "text": text,
        "pages": [{"page": 1, "text": text, "confidence": 0.9, "method": "pymupdf_text"}],
    }


def _pdf_sale(url: str, **fields: object):
    return normalize_sale({"source_name": "avoventes", "source_url": url, "property_type": "Maison", **fields})


# Règle 1 — une clause type du cahier des conditions de vente n'est pas une déclaration sur le bien.
@pytest.mark.parametrize(
    "clause",
    [
        # 1bbaf24b, cf175380 (CCV, article « Entrée en jouissance »)
        "b) Si l'immeuble est loué, par la perception des loyers ou fermages a partir du 1er jour du terme qui suit "
        "la vente forcée ou en cas de surenchère",
        "a) Si l'immeuble est libre de location et d'occupation ou occupé, en tout ou partie par des personnes ne "
        "justifiant d'aucun droit ni titre, à l'expiration du délai de surenchère",
        "c) Si l'immeuble est loué partiellement, l'entrée en jouissance aura lieu, pour les parties libres de "
        "location selon le paragraphe a) ci-dessus et pour les parties louées selon le paragraphe b)",
        "La sommation, lorsque le bien fait l'objet d'un bail, d'avoir à indiquer au Commissaire de justice les nom, "
        "prénom et adresse du preneur",
        "Il tiendra compte, en sus et sans diminution de son prix, aux différents locataires, des loyers qu'ils "
        "auraient payés d'avance",
        "la commune peut déléguer ce droit à un Office Public d'Habitation à Loyer Modéré",
        "Arrêté préfectoral relatif à l'information des acquéreurs et des locataires de biens immobiliers",
        # 1bbaf24b, cf175380 (page avoventes) : « tenant » est ici un participe, pas un locataire.
        "Devant Madame le Juge de l'Exécution du Tribunal Judiciaire de LORIENT, tenant son audience au Palais de "
        "Justice de ladite ville",
        # 9b85bc05 (cahier des charges, obligations du bailleur reproduites)
        "c) d'entretenir les locaux en état de servir à l'usage prévu par le contrat et d'y faire toutes les "
        "réparations, autres que locatives, nécessaires à l'entretien normal des locaux loués",
        # c200ec4b, e8de7de4 (curateur aux successions vacantes)
        "Laurent GUILLON en matière de successions vacantes, n°2025",
        # Cessions : nature de terrain et équipement, pas une occupation.
        "Terrain occupé (présence d'une construction à démolir)",
        "porte anti-squat qui sera retirée après la vente",
        # 28b03ba9, ac0a06ba (notaires)
        "Vente d'un terrain libre de toute construction cadastrée MT 301",
        "ce terrain libre choix de constructeur bénéficie d' une emprise au sol",
        "Le bien est inoccupé par le liquidé saisi",
    ],
)
def test_template_or_unrelated_wording_is_not_an_occupancy(clause: str) -> None:
    assert read_occupancy_statement(clause) is None


def test_lorient_page_is_no_longer_rented() -> None:
    sale = normalize_sale({
        "source_name": "avoventes",
        "source_url": "https://avoventes.fr/enchere/vente-sur-saisie-immobiliere-maison-dhabitation-a-quiberon-56",
        "raw_text": "VENTE SUR SAISIE IMMOBILIERE - Maison d'habitation à Quiberon (56). Visites fixées au Mardi 13 "
        "octobre 2026 de 14h à 15h. Devant Madame le Juge de l'Exécution du Tribunal Judiciaire de LORIENT, tenant "
        "son audience au Palais de Justice de ladite ville.",
    })

    assert sale.occupancy_status is None


def test_conditions_of_sale_clauses_do_not_make_the_companion_a_tenant() -> None:
    # cf175380 : « occupée par son compagnon… à titre de résidence principale » s'affichait « loué ».
    sale = _pdf_sale("https://example.test/hennebont")
    ccv = (
        "OCCUPATION DES BIENS La maison est occupée par son compagnon et ses enfants à titre de résidence principale.\n"
        "b) Si l'immeuble est loué, par la perception des loyers ou fermages a partir du 1er jour du terme.\n"
        "Il tiendra compte aux différents locataires, des loyers qu'ils auraient payés d'avance."
    )
    pv = (
        "CONDITIONS D'OCCUPATION DES LIEUX | La maison est occupée par son compagnon et ses enfants, à titre de "
        "résidence principale, Toutefois, il semblerait que les occupants soient en cours de déménagement"
    )

    enrich_sale_from_pdf_text(sale, [_doc("cahier_conditions_vente", ccv), _doc("pv_huissier", pv)])

    assert sale.occupancy_status == "owner_occupied"


# Règle 2 — tournures reconnues.
@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("Le bien immobilier est libre.", "vacant"),
        ("La maison est vide depuis 2019.", "vacant"),
        ("Les lieux sont vides et inoccupés.", "vacant"),
        # 2d00c99c
        ("Au moment de l'établissement du procès-verbal de description les locaux étaient vides de tout occupant et "
         "en travaux.", "vacant"),
        # 464e35f2
        ("Un appartement de 39,85 m² loi Carrez, au 2ème étage, portant le n°4, à l'état brut Les lieux sont en "
         "l'état inhabitables et inhabités", "vacant"),
        ("OCCUPATION Les biens mis en vente sont inoccupés.", "vacant"),
        # ab16e277 (notaires, situation locative « INCONNU »)
        ("Studio à vendre, libre de toute occupation, 17 rue alphonse Penaud PARIS 20è.", "vacant"),
        # Cessions de l'État (cahiers des charges)
        ("2 171 m2 humide Libre d'occupation VENDEUR : Direction", "vacant"),
        ("3 - SITUATION D'OCCUPATION L'immeuble est libre de toute location et occupation", "vacant"),
        ("3 – Situation d’occupation L’immeuble est cédé libre de toute occupation ou de location", "vacant"),
        ("Occupation : L'ensemble immobilier sera libre de toute occupation au 31 décembre 2025", "vacant"),
        ("L’immeuble est aujourd’hui occupé par CANOPE, et devrait être libéré au plus tard à la fin du mois "
         "d’août 2027 (date à affiner par CANOPE)", "occupied"),
        ("Les lieux sont occupés par Monsieur X.", "occupied"),
        ("Monsieur X et Madame X occupent le bien.", "occupied"),
        ("La maison est occupée par Madame X.", "occupied"),
        # 255efc64, 36d01128, d9566156, c42b5d3e, bbb8af18
        ("OCCUPATION : Ces biens et droits immobiliers sont occupés par la partie saisie", "owner_occupied"),
        ("Le bien est occupé par le(s) propriétaire(s).", "owner_occupied"),
        ("Occupée par les propriétaires actuels", "owner_occupied"),
        ("Les lieux sont occupés par l'un des propriétaires.", "owner_occupied"),
        ("OCCUPATION : le bien est occupé par les débiteurs .", "owner_occupied"),
        ("Les biens sont concédés à la location.", "rented"),
        # 85585e3b
        ("Le bien est actuellement loué , mais en cours d'expulsion suite à une décision d'expulsion", "rented"),
        ("CONDITIONS D'OCCUPATION Le bien est actuellement loué.", "rented"),
        # 5501827c (notaires)
        ("Immeuble entier à restaurer 1 local commercial à rénover et 4 appartements F2 loués Rouen", "rented"),
        # 74fa1215, d0880e3d : s'affichait « loué ».
        ("OCCUPATION : Le bien faisait l’objet d’un contrat de location pour un loyer mensuel de 550 euros charges "
         "comprises. Le locataire a quitté les lieux.", "vacant"),
        # b6a184a0
        ("Les deux maisons sont occupées sans droit ni titre", "squatted"),
    ],
)
def test_occupancy_statements_are_recognised(text: str, expected: str) -> None:
    assert occupancy_status_from_text(text) == expected


# Règle 3 — une tournure prudente n'est pas un statut certain.
@pytest.mark.parametrize(
    "text",
    [
        # 583f58c2
        "Au jour du procès-verbal descriptif (avril 2026), le bien semble inoccupé depuis de nombreux mois.",
        # e062bdbd
        "Sur la commune de CHÂTEAUNEUF DE GRASSE (06740) 154 Chemin du Cayan, UNE PROPRIÉTÉ paraissant inoccupée, "
        "comprenant : UNE MAISON PRINCIPALE",
        # 4fd9ae64, b54668c1 (licitor)
        "Cadastrée section AC n°749 pour 2a 59ca Les biens sont, semble-t-il, occupés Mise à prix : 200 000 €",
        # db0898ad
        "Occupation : le bien semble occupé par le débiteur saisi",
        # b30544f2
        "OCCUPATION : A priori libre de toute occupation.",
    ],
)
def test_hedged_wording_is_unknown_with_its_evidence(text: str) -> None:
    decision = occupancy_from_text(text)

    assert (decision.status, decision.reason) == ("unknown", "hedged")
    assert decision.evidence


def test_on_site_report_that_only_hedges_is_not_a_certain_vacancy() -> None:
    # 0a429622 : la page dit « Les lieux sont inoccupés », le PV seulement « semble être inoccupée ».
    sale = _pdf_sale("https://example.test/lussac", raw_text="Les lieux sont inoccupés.")
    assert sale.occupancy_status == "vacant"

    enrich_sale_from_pdf_text(sale, [
        _doc("annonce_vente", "Total surface : 00 ha 43 a 48 ca Les lieux sont inoccupés"),
        _doc("pv_huissier", "Je pénètre à l’intérieur de la maison et je constate que celle-ci semble être "
                            "inoccupée depuis un certain temps"),
    ])

    assert sale.occupancy_status == "unknown"
    evidence = sale.raw_payload["pdf_fact_provenance"]["occupancy_status"]["evidence"]
    assert "semble être inoccupée" in evidence and "Page source : vacant" in evidence


# Règle 4 — preuves mixtes ou contradictoires : jamais un statut certain.
@pytest.mark.parametrize(
    "text",
    [
        # 00c12ad5
        "Au RDC : 1 appartement de 50,14 m² – Le tout en très mauvais état. Libre de toute occupation. - Au 1er "
        "étage : 1 appartement T3 de 56,82 m² – Le tout en mauvais état Occupé suivant contrat de location en date "
        "du 01 avril 2004.",
        # 1d0262fa
        "Garages, cour intérieure et bâtiment annexe. Ledit bien est partiellement occupé.",
        # 3a3a2ed0
        "Certains disposent d’un bail d’habitation d’autres non.",
        # 25cc00e4
        "Occupation du ROC : par une locataire mais le bail d'habitation n'a pas été fourni moyennant un loyer de "
        "600€ charges comprises Occupation 1er étage : libre de toute occupation",
        # b2573631 (licitor)
        "Un appartement, au rez-de-chaussée, de trois pièces principales, combles aménagés, cellier (inoccupé) Un "
        "appartement, au rez-de-jardin, de trois pièces principales, cave, cellier, terrasse (occupé)",
    ],
)
def test_mixed_or_contradictory_statements_are_unknown(text: str) -> None:
    assert occupancy_status_from_text(text) == "unknown"


def test_published_criterion_contradicted_by_the_description_is_unknown() -> None:
    # 971512d7 (Enchères Publiques, Rouen) : critère « Libre », descriptif « occupés par leur propriétaire ».
    sale = normalize_sale({
        "source_name": "encheres_publiques",
        "source_url": "https://www.encheres-publiques.com/evenements/test/lots/971512d7",
        "occupancy_status": "vacant",
        "description": "Un parking portant le numéro B01 (lot n°23). Occupation : Les lieux sont occupés par leur "
        "propriétaire actuelle.",
        "source_blocks": {"occupation": "Libre de toute occupation"},
        "raw_text": "Occupation: Libre de toute occupation Visites: 03/09/2026 10:00 - 12:00",
    })

    assert sale.occupancy_status == "unknown"


def test_documents_describing_a_free_unit_and_a_rented_one_are_unknown() -> None:
    # 2370be52 : le 11 bis est libre, le 11 est loué (bail commercial) ; s'affichait « loué ».
    sale = _pdf_sale("https://example.test/erdeven")
    pv = (
        "CONDITIONS D'OCCUPATION DES LIEUX Le 11 bis rue Nationale 56410 ERDEVEN (appartement au 1er étage et "
        "grenier) est libre de toute occupation.\n"
        "Le 11 rue Nationale 56410 ERDEVEN est loué par la société dénommée SARL LE BOULICAUT, tant la partie "
        "commerciale que la partie habitation."
    )

    enrich_sale_from_pdf_text(sale, [_doc("pv_huissier", pv)])

    assert sale.occupancy_status == "unknown"


def test_page_status_contradicted_by_the_on_site_report_is_unknown() -> None:
    sale = _pdf_sale("https://example.test/page-libre", raw_text="OCCUPATION : Les lieux sont libres.")
    assert sale.occupancy_status == "vacant"

    enrich_sale_from_pdf_text(sale, [_doc("pv_huissier", "Les lieux sont occupés par Monsieur X et ses enfants.")])

    assert sale.occupancy_status == "unknown"
    trace = sale.raw_payload["pdf_fact_provenance"]["occupancy_status"]
    assert trace["baseline"] == "vacant" and "occupés par Monsieur X" in trace["evidence"]


def test_documents_refine_a_generic_page_status() -> None:
    sale = _pdf_sale("https://example.test/occupe", raw_text="Occupé.")
    assert sale.occupancy_status == "occupied"

    enrich_sale_from_pdf_text(sale, [_doc("pv_huissier", "Les biens sont occupés par la partie saisie.")])

    assert sale.occupancy_status == "owner_occupied"


def test_delivery_free_at_the_sale_wins_over_a_temporary_convention() -> None:
    # c200ec4b (Cessions de l'État, Agde) : occupé par convention précaire, libre au jour de l'adjudication.
    sale = _pdf_sale("https://example.test/agde")
    ccv = (
        "Il est précisé qu’au jour de la publication du présent cahier des charges le BIEN MIS EN VENTE est occupé à "
        "titre de parking et d'aire d'exposition.\n"
        "Au jour de l'adjudication, le vendeur déclare que la convention d'occupation précaire sera arrivé à son "
        "terme et que le terrain sera libre de toute occupation."
    )

    enrich_sale_from_pdf_text(sale, [_doc("cahier_conditions_vente", ccv)])

    assert sale.occupancy_status == "vacant"


# Règle 5 — pas de « libre » par défaut.
def test_stale_vacant_without_label_or_statement_is_dropped() -> None:
    # 2335f176, 40b7ecbb… (notaires) et 7cb6c799 (Enchères Publiques) : « vacant » repris d'une ancienne ligne.
    for source_name in ("notaires", "encheres_publiques"):
        sale = normalize_sale({
            "source_name": source_name,
            "source_url": f"https://example.test/{source_name}/stale",
            "occupancy_status": "vacant",
            "raw_text": "VNI-112026 Une propriété aux beaux volumes, entourée de verdure.",
        })
        assert sale.occupancy_status is None


@pytest.mark.parametrize(
    "evidence",
    [
        {"occupancy_status": "LIBRE"},
        {"occupancy_status": "vacant", "source_factual_snapshot": {"occupancy_status": "LIBRE"}},
        {"occupancy_status": "vacant", "source_blocks": {"occupation": "Libre de toute occupation"}},
        {"occupancy_status": "vacant", "raw_text": "MAISON MITOYENNE R+2 (116m²) – LIBRE"},
    ],
)
def test_published_vacancy_label_or_statement_is_kept(evidence: dict[str, object]) -> None:
    sale = normalize_sale({"source_name": "notaires", "source_url": "https://example.test/notaires/libre", **evidence})

    assert sale.occupancy_status == "vacant"


def test_source_labels_still_map_to_the_enum() -> None:
    assert normalize_occupancy_status("LOUE") == "rented"
    assert normalize_occupancy_status("OCCUPE") == "occupied"
    assert normalize_occupancy_status("INCONNU") == "unknown"
    assert normalize_occupancy_status("Partiellement occupé") == "unknown"
    assert normalize_occupancy_status("porte anti-squat") is None


def test_licitor_reads_occupancy_inside_a_long_paragraph() -> None:
    # 464e35f2 : la phrase était dans un paragraphe de plus de 110 caractères, donc ignorée.
    text = MULTI_LOT_TEXT.replace(
        "Cadastré section AB n°12 pour 10a 59ca\nLibre",
        "Cadastré section AB n°12 pour 10a 59ca, avec un appartement de 39,85 m² loi Carrez, au 2ème étage, "
        "portant le n°4, à l'état brut Les lieux sont en l'état inhabitables et inhabités",
    )

    lots = extract_licitor_fields(text)["source_property_features"]["lots"]

    assert lots[1]["occupancy_status"] == "vacant"
    assert "inhabitables et inhabités" in lots[1]["occupancy_text"][0]


def test_occupancy_read_in_the_documents_survives_a_page_without_one() -> None:
    # Cessions de l'État : la page relue remettait à vide le « libre » lu dans le cahier des charges.
    known = {
        "occupancy_status": None,
        "raw_payload": {"pdf_fact_provenance": {"occupancy_status": {"source": "pdf", "value": "vacant"}}},
    }
    sale: dict[str, object] = {"occupancy_status": None}

    assert _backfill_document_occupancy_from_known(sale, known) == 1
    assert sale["occupancy_status"] == "vacant"
    assert _backfill_document_occupancy_from_known({"occupancy_status": "rented"}, known) == 0
    assert _backfill_document_occupancy_from_known({"occupancy_status": None}, {"raw_payload": {}}) == 0
