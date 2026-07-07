import json
from decimal import Decimal

import pytest

from src.enrichment.extract_structured import (
    LLMExtraction,
    build_reduced_pdf_context,
    enrich_sale_with_llm,
    extract_source_description,
    load_llm_context_for_sale,
)
from src.enrichment.llm_client import ReplicateClient, _retry_sleep_seconds, _stringify_output, parse_json_response
from src.normalize import normalize_sale
from src.pdf_enrichment import sale_storage_id


class FakeReplicateClient:
    calls = 0

    def is_available(self) -> bool:
        return True

    def generate_json(self, system_prompt: str, user_prompt: str):
        self.calls += 1
        return {
            "property_type": "house",
            "surface_m2": 91.4,
            "rooms_count": 4,
            "bedrooms_count": 3,
            "occupancy_status": "rented",
            "occupancy_details": "Bail mentionné dans le cahier.",
            "display_description": (
                "Maison de 91,4 m² décrite par la source, avec occupation locative et "
                "points techniques à vérifier avant l'audience."
            ),
            "legal_risks": ["servitude de passage"],
            "physical_risks": ["amiante"],
            "copropriete": False,
            "servitudes": ["passage"],
            "works_needed": "Rafraîchissement à prévoir",
            "summary": "Maison avec occupation locative et diagnostics mentionnant de l'amiante.",
            "investor_notes": "Vérifier le bail.",
            "confidence": {
                "property_type": 0.8,
                "surface_m2": 0.9,
                "rooms_count": 0.85,
                "bedrooms_count": 0.85,
                "occupancy_status": 0.8,
                "legal_risks": 0.7,
                "physical_risks": 0.7,
                "display_description": 0.9,
                "summary": 0.7,
            },
        }


class LowConfidenceClient(FakeReplicateClient):
    def generate_json(self, system_prompt: str, user_prompt: str):
        payload = super().generate_json(system_prompt, user_prompt)
        payload["confidence"] = {
            "property_type": 0.69,
            "surface_m2": 0.69,
            "rooms_count": 0.69,
            "bedrooms_count": 0.69,
            "occupancy_status": 0.69,
        }
        return payload


class InconsistentBedroomsClient(FakeReplicateClient):
    def generate_json(self, system_prompt: str, user_prompt: str):
        payload = super().generate_json(system_prompt, user_prompt)
        payload["rooms_count"] = 2
        payload["bedrooms_count"] = 4
        payload["confidence"]["rooms_count"] = 0.9
        payload["confidence"]["bedrooms_count"] = 0.9
        return payload


class CorroboratedLowConfidenceCountsClient(FakeReplicateClient):
    def generate_json(self, system_prompt: str, user_prompt: str):
        payload = super().generate_json(system_prompt, user_prompt)
        payload["rooms_count"] = 4
        payload["bedrooms_count"] = 2
        payload["confidence"]["rooms_count"] = 0.62
        payload["confidence"]["bedrooms_count"] = 0.62
        return payload


class FailingReplicateClient(FakeReplicateClient):
    def generate_json(self, system_prompt: str, user_prompt: str):
        raise ValueError("Replicate returned invalid JSON after retry")


class LongDisplayDescriptionClient(FakeReplicateClient):
    def generate_json(self, system_prompt: str, user_prompt: str):
        payload = super().generate_json(system_prompt, user_prompt)
        payload["display_description"] = "Synthèse : " + " ".join(
            f"information{i}" for i in range(140)
        )
        payload["confidence"]["display_description"] = 0.95
        return payload


class LowConfidenceDisplayDescriptionClient(FakeReplicateClient):
    def generate_json(self, system_prompt: str, user_prompt: str):
        payload = super().generate_json(system_prompt, user_prompt)
        payload["confidence"]["display_description"] = 0.4
        return payload


class MissingDisplayDescriptionClient(FakeReplicateClient):
    def generate_json(self, system_prompt: str, user_prompt: str):
        payload = super().generate_json(system_prompt, user_prompt)
        payload["display_description"] = None
        payload["confidence"].pop("display_description", None)
        return payload


class DisplayOnlyClient:
    calls = 0

    def __init__(self) -> None:
        self.system_prompt = ""
        self.user_prompt = ""

    def is_available(self) -> bool:
        return True

    def generate_json(self, system_prompt: str, user_prompt: str):
        self.calls += 1
        self.system_prompt = system_prompt
        self.user_prompt = user_prompt
        return {
            "display_description": (
                "Maison à Bordeaux décrite dans le contexte fourni, avec surface et occupation "
                "à vérifier selon les documents disponibles."
            ),
            "confidence": {"display_description": 0.86},
        }


def test_parse_json_response_handles_markdown_fence() -> None:
    parsed = parse_json_response('```json\n{"surface_m2": 80}\n```')
    assert parsed == {"surface_m2": 80}


def test_replicate_client_formats_output_list_and_payload() -> None:
    client = ReplicateClient(
        api_token="replicate-token-test",
        model="moonshotai/kimi-k2.5",
        max_tokens=123,
        temperature=0.6,
    )

    payload = client._input_payload("system\n\nuser")

    assert "system_prompt" not in payload
    assert payload["prompt"] == "system\n\nuser"
    assert payload["max_tokens"] == 123
    assert payload["temperature"] == 0.6
    assert payload["top_p"] == 1
    assert payload["presence_penalty"] == 0
    assert payload["frequency_penalty"] == 0
    assert parse_json_response(''.join(['{"surface_m2":', "80}"])) == {"surface_m2": 80}
    assert _stringify_output(["", "", "{", '"surface_m2"', ":80}"]) == '{"surface_m2":80}'


def test_replicate_client_accepts_plain_text_for_display_description_mode(monkeypatch) -> None:
    client = ReplicateClient(
        api_token="replicate-token-test",
        model="moonshotai/kimi-k2.5",
        min_interval_seconds=0,
    )
    calls = 0

    def fake_create_prediction(prompt: str, system_prompt: str | None = None):
        nonlocal calls
        calls += 1
        return {"id": "prediction-test"}

    monkeypatch.setattr(client, "_create_prediction", fake_create_prediction)
    monkeypatch.setattr(
        client,
        "_wait_for_output",
        lambda prediction: (
            "Maison de ville comprenant plusieurs niveaux, jardin et garage, avec travaux "
            "à prévoir selon les informations disponibles dans l'annonce."
        ),
    )

    payload = client.generate_json("MODE SYNTHESE STRICTE. Réponds en JSON.", "Texte fourni")

    assert calls == 1
    assert payload == {
        "display_description": (
            "Maison de ville comprenant plusieurs niveaux, jardin et garage, avec travaux "
            "à prévoir selon les informations disponibles dans l'annonce."
        ),
        "confidence": {"display_description": 0.58},
    }


def test_replicate_client_rejects_plain_text_for_full_extraction(monkeypatch) -> None:
    client = ReplicateClient(
        api_token="replicate-token-test",
        model="moonshotai/kimi-k2.5",
        min_interval_seconds=0,
    )
    outputs = [
        "Maison de ville comprenant plusieurs niveaux et un jardin.",
        "Toujours pas un objet JSON valide.",
    ]

    monkeypatch.setattr(client, "_create_prediction", lambda prompt, system_prompt=None: {"id": "prediction-test"})
    monkeypatch.setattr(client, "_wait_for_output", lambda prediction: outputs.pop(0))

    with pytest.raises(ValueError, match="Replicate returned invalid JSON after retry"):
        client.generate_json("MODE EXTRACTION STRICTE.", "Texte fourni")


def test_replicate_client_formats_gemini_payload() -> None:
    client = ReplicateClient(
        api_token="replicate-token-test",
        model="google/gemini-2.5-flash",
        max_tokens=8192,
        temperature=0,
        thinking_budget=0,
        dynamic_thinking=False,
    )

    payload = client._input_payload("user prompt", system_prompt="system prompt")

    assert payload["prompt"] == "user prompt"
    assert payload["system_instruction"] == "system prompt"
    assert payload["max_output_tokens"] == 8192
    assert payload["temperature"] == 0
    assert payload["thinking_budget"] == 0
    assert payload["dynamic_thinking"] is False
    assert "max_tokens" not in payload
    assert "presence_penalty" not in payload


def test_replicate_retry_sleep_uses_retry_after_header() -> None:
    class Response:
        status_code = 503
        headers = {"Retry-After": "7"}

    assert _retry_sleep_seconds(3, Response(), backoff_seconds=20, max_sleep_seconds=180) == 7


def test_replicate_retry_sleep_keeps_429_backoff_conservative() -> None:
    class Response:
        status_code = 429
        headers = {"Retry-After": "1"}

    assert _retry_sleep_seconds(1, Response(), backoff_seconds=20, max_sleep_seconds=180) == 20


def test_replicate_retry_sleep_uses_capped_exponential_backoff() -> None:
    assert _retry_sleep_seconds(1, None, backoff_seconds=20, max_sleep_seconds=50) == 20
    assert _retry_sleep_seconds(3, None, backoff_seconds=20, max_sleep_seconds=50) == 50


def test_llm_extraction_validates_values_and_confidence() -> None:
    extraction = LLMExtraction.model_validate(
        {
            "property_type": "house",
            "rooms_count": "T3",
            "bedrooms_count": "2 chambres",
            "occupancy_status": "free",
            "legal_risks": [{"description": "Procédure en cours"}],
            "physical_risks": None,
            "servitudes": [{"description": "Passage commun"}],
            "works_needed": ["Radiateurs vétustes", "Rafraîchissement"],
            "copropriete": {"shares": "moitié indivise"},
            "confidence": {"surface_m2": 2},
        }
    )

    assert extraction.legal_risks == ["description: Procédure en cours"]
    assert extraction.servitudes == ["description: Passage commun"]
    assert extraction.works_needed == "Radiateurs vétustes; Rafraîchissement"
    assert extraction.occupancy_status == "vacant"
    assert extraction.copropriete is None
    assert extraction.rooms_count == 3
    assert extraction.bedrooms_count == 2
    assert extraction.confidence["surface_m2"] == 1.0


def test_extract_source_description_prefers_usable_source_blocks() -> None:
    sale = normalize_sale(
        {
            "source_name": "vench",
            "source_url": "https://www.vench.fr/vente-source-description.html",
            "description": "Pour consulter l'intégralité des informations disponibles, vous devez être abonné.",
            "raw_text": "Texte de page trop générique.",
            "source_blocks": {
                "description": "Appartement de type trois avec balcon, cave et stationnement privatif.",
                "page_text": "Texte complet de page avec navigation et informations annexes.",
            },
        }
    )

    assert extract_source_description(sale) == (
        "Appartement de type trois avec balcon, cave et stationnement privatif."
    )


def test_enrich_sale_with_llm_uses_cached_pdf_text_and_preserves_reliable_fields(tmp_path, monkeypatch) -> None:
    sale = normalize_sale(
        {
            "source_name": "avoventes",
            "source_url": "https://avoventes.fr/enchere/llm",
            "property_type": "Appartement",
            "source_blocks": {
                "description": "Maison de 91,4 m² avec occupation locative indiquée par la source."
            },
        }
    )
    pdf_dir = tmp_path / "pdf_texts"
    out_dir = tmp_path / "llm_extractions"
    pdf_dir.mkdir()
    monkeypatch.setattr("src.enrichment.extract_structured.PDF_TEXTS_DIR", pdf_dir)
    monkeypatch.setenv("LLM_ENABLED", "true")
    monkeypatch.setenv("LLM_PDF_MAX_CHARS", "5000")
    (pdf_dir / f"{sale_storage_id(sale)}.json").write_text(
        json.dumps([{"label": "PV", "text": "Surface 91,4 m2. Bien loué. Amiante."}]),
        encoding="utf-8",
    )

    stats = enrich_sale_with_llm(sale, client=FakeReplicateClient(), output_dir=out_dir)

    assert stats.analyzed == 1
    assert stats.valid_json == 1
    assert sale.surface_m2 == Decimal("91.4")
    assert sale.rooms_count == 4
    assert sale.bedrooms_count == 3
    assert sale.occupancy_status == "rented"
    assert sale.property_type == "apartment"
    assert sale.raw_payload["llm_display_description"].startswith("Maison de 91,4 m²")
    assert "llm_extraction" in sale.raw_payload
    assert (out_dir / f"{sale_storage_id(sale)}.json").exists()

    second_stats = enrich_sale_with_llm(sale, client=(stats_client := FakeReplicateClient()), output_dir=out_dir)
    assert second_stats.valid_json == 1
    assert stats_client.calls == 0


def test_enrich_sale_with_llm_writes_display_description_without_source_description(tmp_path, monkeypatch) -> None:
    sale = normalize_sale(
        {
            "source_name": "avoventes",
            "source_url": "https://avoventes.fr/enchere/llm-display-from-pdf",
            "title": "Maison à Bordeaux",
        }
    )
    pdf_dir = tmp_path / "pdf_texts"
    pdf_dir.mkdir()
    monkeypatch.setattr("src.enrichment.extract_structured.PDF_TEXTS_DIR", pdf_dir)
    monkeypatch.setenv("LLM_ENABLED", "true")
    monkeypatch.setenv("LLM_PROMPT_VERSION", "auction_llm_v5_test")
    (pdf_dir / f"{sale_storage_id(sale)}.json").write_text(
        json.dumps(
            [
                {
                    "label": "PV descriptif",
                    "document_type": "pv_descriptif",
                    "text": "Maison de 91,4 m2 comprenant séjour, cuisine et trois chambres. Bien loué.",
                }
            ]
        ),
        encoding="utf-8",
    )

    stats = enrich_sale_with_llm(sale, client=FakeReplicateClient(), output_dir=tmp_path / "out")

    assert stats.valid_json == 1
    assert "source_description" not in sale.raw_payload
    assert sale.raw_payload["llm_display_description"].startswith("Maison de 91,4 m²")
    assert sale.raw_payload["llm_prompt_version"] == "auction_llm_v5_test"


def test_enrich_sale_with_llm_can_use_display_description_mode(tmp_path, monkeypatch) -> None:
    sale = normalize_sale(
        {
            "source_name": "avoventes",
            "source_url": "https://avoventes.fr/enchere/llm-display-only",
            "title": "Maison à Bordeaux",
            "source_blocks": {"description": "Maison de 91,4 m2 indiquée comme louée."},
        }
    )
    pdf_dir = tmp_path / "pdf_texts"
    pdf_dir.mkdir()
    monkeypatch.setattr("src.enrichment.extract_structured.PDF_TEXTS_DIR", pdf_dir)
    monkeypatch.setenv("LLM_ENABLED", "true")
    monkeypatch.setenv("LLM_EXTRACTION_MODE", "display_description")
    monkeypatch.setenv("LLM_PROMPT_VERSION", "auction_llm_v6_display_test")
    (pdf_dir / f"{sale_storage_id(sale)}.json").write_text(
        json.dumps([{"label": "PV", "text": "Maison de 91,4 m2. Bien loué."}]),
        encoding="utf-8",
    )
    client = DisplayOnlyClient()

    stats = enrich_sale_with_llm(sale, client=client, output_dir=tmp_path / "out")

    assert stats.valid_json == 1
    assert client.calls == 1
    assert "MODE SYNTHESE STRICTE" in client.system_prompt
    assert "investment_facts" not in client.user_prompt
    assert "display_description" in client.user_prompt
    assert sale.raw_payload["llm_display_description"].startswith("Maison à Bordeaux")
    assert sale.raw_payload["llm_prompt_version"] == "auction_llm_v6_display_test"


def test_enrich_sale_with_llm_normalizes_display_description_length(tmp_path, monkeypatch) -> None:
    sale = normalize_sale(
        {
            "source_name": "avoventes",
            "source_url": "https://avoventes.fr/enchere/llm-display-length",
        }
    )
    pdf_dir = tmp_path / "pdf_texts"
    pdf_dir.mkdir()
    monkeypatch.setattr("src.enrichment.extract_structured.PDF_TEXTS_DIR", pdf_dir)
    monkeypatch.setenv("LLM_ENABLED", "true")
    (pdf_dir / f"{sale_storage_id(sale)}.json").write_text(
        json.dumps([{"label": "PV", "text": "Texte suffisant avec surface, occupation et composition."}]),
        encoding="utf-8",
    )

    enrich_sale_with_llm(sale, client=LongDisplayDescriptionClient(), output_dir=tmp_path / "out")

    display_description = sale.raw_payload["llm_display_description"]
    assert display_description.startswith("information0")
    assert len(display_description.split()) <= 115
    assert "\n" not in display_description
    assert display_description.endswith(".")


def test_enrich_sale_with_llm_builds_fallback_display_description(tmp_path, monkeypatch) -> None:
    sale = normalize_sale(
        {
            "source_name": "avoventes",
            "source_url": "https://avoventes.fr/enchere/llm-display-fallback",
            "city": "Bordeaux",
            "department": "33",
            "has_garden": True,
        }
    )
    pdf_dir = tmp_path / "pdf_texts"
    pdf_dir.mkdir()
    monkeypatch.setattr("src.enrichment.extract_structured.PDF_TEXTS_DIR", pdf_dir)
    monkeypatch.setenv("LLM_ENABLED", "true")
    monkeypatch.setenv("LLM_PROMPT_VERSION", "auction_llm_v5_test")
    (pdf_dir / f"{sale_storage_id(sale)}.json").write_text(
        json.dumps([{"label": "PV", "text": "Maison de 91,4 m2 avec trois chambres. Bien loué."}]),
        encoding="utf-8",
    )

    enrich_sale_with_llm(sale, client=MissingDisplayDescriptionClient(), output_dir=tmp_path / "out")

    display_description = sale.raw_payload["llm_display_description"]
    assert display_description.startswith("Maison à Bordeaux (33).")
    assert "surface de 91,4 m²" in display_description
    assert "4 pièces" in display_description
    assert "3 chambres" in display_description
    assert "jardin" in display_description
    assert "loué" in display_description
    assert sale.raw_payload["llm_display_description_word_count"] == len(display_description.split())
    assert sale.raw_payload["llm_prompt_version"] == "auction_llm_v5_test"


def test_enrich_sale_with_llm_rejects_low_confidence_display_description(tmp_path, monkeypatch) -> None:
    sale = normalize_sale(
        {
            "source_name": "avoventes",
            "source_url": "https://avoventes.fr/enchere/llm-display-low-confidence",
        }
    )
    pdf_dir = tmp_path / "pdf_texts"
    pdf_dir.mkdir()
    monkeypatch.setattr("src.enrichment.extract_structured.PDF_TEXTS_DIR", pdf_dir)
    monkeypatch.setenv("LLM_ENABLED", "true")
    (pdf_dir / f"{sale_storage_id(sale)}.json").write_text(
        json.dumps([{"label": "PV", "text": "Texte suffisant pour déclencher le LLM."}]),
        encoding="utf-8",
    )

    enrich_sale_with_llm(sale, client=LowConfidenceDisplayDescriptionClient(), output_dir=tmp_path / "out")

    assert "llm_display_description" not in sale.raw_payload


def test_enrich_sale_with_llm_can_replace_unreliable_other_property_type(tmp_path, monkeypatch) -> None:
    sale = normalize_sale(
        {
            "source_name": "avoventes",
            "source_url": "https://avoventes.fr/enchere/llm-other",
            "property_type": "Autre",
        }
    )
    pdf_dir = tmp_path / "pdf_texts"
    pdf_dir.mkdir()
    monkeypatch.setattr("src.enrichment.extract_structured.PDF_TEXTS_DIR", pdf_dir)
    monkeypatch.setenv("LLM_ENABLED", "true")
    (pdf_dir / f"{sale_storage_id(sale)}.json").write_text(
        json.dumps([{"label": "PV", "text": "Une maison avec surface."}]),
        encoding="utf-8",
    )

    enrich_sale_with_llm(sale, client=FakeReplicateClient(), output_dir=tmp_path / "out")

    assert sale.property_type == "house"


def test_enrich_sale_with_llm_rejects_low_confidence_structured_values(tmp_path, monkeypatch) -> None:
    sale = normalize_sale(
        {
            "source_name": "avoventes",
            "source_url": "https://avoventes.fr/enchere/llm-low-confidence",
            "property_type": "Autre",
        }
    )
    pdf_dir = tmp_path / "pdf_texts"
    pdf_dir.mkdir()
    monkeypatch.setattr("src.enrichment.extract_structured.PDF_TEXTS_DIR", pdf_dir)
    monkeypatch.setenv("LLM_ENABLED", "true")
    (pdf_dir / f"{sale_storage_id(sale)}.json").write_text(
        json.dumps([{"label": "PV", "text": "Texte ambigu avec surface et occupation."}]),
        encoding="utf-8",
    )

    enrich_sale_with_llm(sale, client=LowConfidenceClient(), output_dir=tmp_path / "out")

    assert sale.surface_m2 is None
    assert sale.rooms_count is None
    assert sale.bedrooms_count is None
    assert sale.occupancy_status is None
    assert sale.property_type == "other"


def test_enrich_sale_with_llm_accepts_low_confidence_counts_when_text_corroborates(tmp_path, monkeypatch) -> None:
    sale = normalize_sale(
        {
            "source_name": "avoventes",
            "source_url": "https://avoventes.fr/enchere/llm-corroborated-counts",
        }
    )
    pdf_dir = tmp_path / "pdf_texts"
    pdf_dir.mkdir()
    monkeypatch.setattr("src.enrichment.extract_structured.PDF_TEXTS_DIR", pdf_dir)
    monkeypatch.setenv("LLM_ENABLED", "true")
    (pdf_dir / f"{sale_storage_id(sale)}.json").write_text(
        json.dumps([{"label": "PV", "text": "Désignation : appartement de type 4 comprenant séjour et deux chambres."}]),
        encoding="utf-8",
    )

    stats = enrich_sale_with_llm(sale, client=CorroboratedLowConfidenceCountsClient(), output_dir=tmp_path / "out")

    assert stats.rooms_extracted == 1
    assert stats.bedrooms_extracted == 1
    assert sale.rooms_count == 4
    assert sale.bedrooms_count == 2


def test_enrich_sale_with_llm_rejects_bedrooms_greater_than_rooms(tmp_path, monkeypatch) -> None:
    sale = normalize_sale(
        {
            "source_name": "avoventes",
            "source_url": "https://avoventes.fr/enchere/llm-inconsistent-counts",
        }
    )
    pdf_dir = tmp_path / "pdf_texts"
    pdf_dir.mkdir()
    monkeypatch.setattr("src.enrichment.extract_structured.PDF_TEXTS_DIR", pdf_dir)
    monkeypatch.setenv("LLM_ENABLED", "true")
    (pdf_dir / f"{sale_storage_id(sale)}.json").write_text(
        json.dumps([{"label": "PV", "text": "Maison T2 avec quatre chambres selon sortie incohérente."}]),
        encoding="utf-8",
    )

    enrich_sale_with_llm(sale, client=InconsistentBedroomsClient(), output_dir=tmp_path / "out")

    assert sale.rooms_count == 2
    assert sale.bedrooms_count is None


def test_enrich_sale_with_llm_records_failure_context(tmp_path, monkeypatch) -> None:
    sale = normalize_sale(
        {
            "source_name": "avoventes",
            "source_url": "https://avoventes.fr/enchere/llm-failure",
            "title": "Maison avec documents",
        }
    )
    pdf_dir = tmp_path / "pdf_texts"
    pdf_dir.mkdir()
    monkeypatch.setattr("src.enrichment.extract_structured.PDF_TEXTS_DIR", pdf_dir)
    monkeypatch.setenv("LLM_ENABLED", "true")
    (pdf_dir / f"{sale_storage_id(sale)}.json").write_text(
        json.dumps([{"label": "PV", "text": "Texte suffisant pour déclencher le LLM."}]),
        encoding="utf-8",
    )

    stats = enrich_sale_with_llm(sale, client=FailingReplicateClient(), output_dir=tmp_path / "out")

    assert stats.errors == 1
    assert stats.error_messages
    assert "https://avoventes.fr/enchere/llm-failure" in stats.error_messages[0]
    assert "invalid JSON" in stats.error_messages[0]


def test_build_reduced_pdf_context_keeps_priority_headers_and_keyword_windows() -> None:
    long_noise = "Texte sans intérêt. " * 300
    payload = [
        {
            "label": "Cahier des conditions de vente.pdf",
            "document_type": "cahier_conditions",
            "text": "PREMIERE PAGE CAHIER. " + long_noise,
        },
        {
            "label": "Diagnostics.pdf",
            "document_type": "diagnostics",
            "text": long_noise + " Le diagnostic mentionne amiante, plomb et DPE. " + long_noise,
        },
    ]

    context = build_reduced_pdf_context(payload, max_chars=4000, first_page_chars=500, window_chars=600)

    assert context is not None
    assert len(context) <= 4000
    assert "PREMIERE PAGE CAHIER" in context
    assert "amiante" in context
    assert "plomb" in context
    assert "DPE" in context


def test_build_reduced_pdf_context_keeps_composition_windows() -> None:
    long_noise = "Texte sans intérêt. " * 300
    payload = [
        {
            "label": "PV descriptif.pdf",
            "document_type": "pv_descriptif",
            "text": long_noise + " Composition : appartement type trois comprenant séjour, cuisine et deux chambres. " + long_noise,
        }
    ]

    context = build_reduced_pdf_context(payload, max_chars=2500, first_page_chars=200, window_chars=700)

    assert context is not None
    assert "Composition" in context
    assert "type trois" in context
    assert "deux chambres" in context


def test_load_llm_context_falls_back_to_raw_text_when_pdf_cache_missing(tmp_path, monkeypatch) -> None:
    sale = normalize_sale(
        {
            "source_name": "avoventes",
            "source_url": "https://avoventes.fr/enchere/no-pdf-cache",
            "raw_text": "Annonce avec mise à prix et occupation mentionnée.",
        }
    )
    monkeypatch.setattr("src.enrichment.extract_structured.PDF_TEXTS_DIR", tmp_path)

    context = load_llm_context_for_sale(sale, max_chars=200)

    assert context is not None
    assert context.startswith("[ANNONCE SOURCE]")
    assert "occupation" in context


def test_load_llm_context_keeps_source_page_when_pdf_cache_exists(tmp_path, monkeypatch) -> None:
    sale = normalize_sale(
        {
            "source_name": "info_encheres",
            "source_url": "https://www.info-encheres.com/example.html",
            "title": "Maison à Bordeaux",
            "raw_text": "Annonce source : maison libre avec jardin.",
            "source_blocks": {
                "description": "Description page source : maison de 120 m² libre de toute occupation.",
                "page_text": "Texte complet page source avec visite le mardi.",
            },
        }
    )
    pdf_dir = tmp_path / "pdf_texts"
    pdf_dir.mkdir()
    monkeypatch.setattr("src.enrichment.extract_structured.PDF_TEXTS_DIR", pdf_dir)
    (pdf_dir / f"{sale_storage_id(sale)}.json").write_text(
        json.dumps([{"label": "PV descriptif", "document_type": "pv_descriptif", "text": "PV : toiture à réviser."}]),
        encoding="utf-8",
    )

    context = load_llm_context_for_sale(sale, max_chars=3000)

    assert context is not None
    assert "[ANNONCE SOURCE]" in context
    assert "Description page source" in context
    assert "Texte complet page source" in context
    assert "PV : toiture à réviser" in context


def test_load_llm_context_includes_structured_extracted_fields(tmp_path, monkeypatch) -> None:
    sale = normalize_sale(
        {
            "source_name": "avoventes",
            "source_url": "https://avoventes.fr/enchere/structured-context",
            "property_type": "Maison",
            "title": "Maison à Bordeaux",
        }
    )
    sale.surface_m2 = Decimal("91.4")
    sale.rooms_count = 4
    sale.bedrooms_count = 3
    sale.occupancy_status = "rented"
    monkeypatch.setattr("src.enrichment.extract_structured.PDF_TEXTS_DIR", tmp_path)

    context = load_llm_context_for_sale(sale, max_chars=2500)

    assert context is not None
    assert "[DONNEES STRUCTUREES EXTRAITES]" in context
    assert "Surface principale: 91.4 m2" in context
    assert "Pièces: 4" in context
    assert "Chambres: 3" in context
    assert "Occupation extraite: rented" in context


def test_load_llm_context_includes_merged_source_pages(tmp_path, monkeypatch) -> None:
    sale = normalize_sale(
        {
            "source_name": "avoventes",
            "source_url": "https://avoventes.fr/main",
            "raw_text": "Annonce Avoventes : appartement T3.",
        }
    )
    sale.raw_payload["merged_sources"] = [
        {
            "source_name": "vench",
            "source_url": "https://www.vench.fr/vente-1.html",
            "raw_payload": {
                "source_name": "vench",
                "source_url": "https://www.vench.fr/vente-1.html",
                "source_blocks": {
                    "titre": "Annonce Vench",
                    "page_text": "Texte Vench : garage et prochaine visite.",
                },
            },
        }
    ]
    monkeypatch.setattr("src.enrichment.extract_structured.PDF_TEXTS_DIR", tmp_path)

    context = load_llm_context_for_sale(sale, max_chars=2500)

    assert context is not None
    assert "Annonce Avoventes" in context
    assert "Annonce Vench" in context
    assert "Texte Vench" in context
