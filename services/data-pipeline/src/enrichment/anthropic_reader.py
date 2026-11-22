"""Appels à l'API Anthropic, dans le budget partagé des appels aux modèles.

Deux usages, un seul chemin d'appel (:class:`_AnthropicCaller`) :

- :class:`AnthropicDocumentReader` lit un extrait PDF des pièces : un document PDF (bloc ``document`` en base64,
  placé avant le texte) et une réponse JSON contrainte par un schéma (``output_config.format``) ;
- :class:`AnthropicTextClient` sert les appels de texte et d'image du pipeline quand ``LLM_PROVIDER`` vaut
  ``anthropic`` (``src.enrichment.llm_client.create_llm_client``), derrière la même interface ``generate_json*`` que
  le client Replicate. Leurs prompts décrivent le JSON attendu et leurs appelants le vérifient : aucun n'a de schéma.

Règles d'appel des modèles Claude 5.5 : réflexion adaptative, ``effort`` explicite ; ni ``temperature``, ``top_p``,
``top_k``, ``budget_tokens`` ni préremplissage (erreur 400). ``stop_reason`` est lu avant la réponse.

Budget, le même que celui des appels Replicate, réservé avant l'envoi et dans cet ordre :

1. plafond d'entrée calculé, sans appel (:func:`input_token_ceiling` : pages × ``TOKENS_PER_PAGE`` plus le texte) ;
   le PDF n'est envoyé qu'une fois. Un texte dont ce plafond (un octet UTF-8 pour un jeton) dépasse le palier bas du
   modèle est compté par l'API (``count_tokens``, sans appel payant) ; au-delà du palier, rien n'est réservé ni
   envoyé (``require_lower_price_tier``) ;
2. réservation de l'appel dans ``llm_usage_events`` (plafond horaire par fournisseur, clé de requête) ;
3. écriture des plafonds d'entrée et de sortie sur cette réservation (``record_llm_request_ceiling``) : l'appel en
   vol compte pour son coût maximal dans le budget quotidien partagé, y compris hors exécution autonome ;
4. contrôle du budget quotidien et du palier de prix (``reserve_prediction``), qui voit les plafonds de tous les
   appels en vol : des appels concurrents ne peuvent pas passer ensemble au-dessus du budget ;
5. après la réponse, les jetons facturés remplacent les plafonds (la réflexion est facturée en sortie et tient dans
   ``max_tokens``, le plafond de sortie réservé).

Aucune nouvelle tentative sur une erreur : le client du SDK est créé avec ``max_retries=0`` et un appel à l'issue
incertaine reste noté « ambiguous » avec ses plafonds, comme pour Replicate, pour ne jamais payer deux fois la même
lecture. Seul ``generate_json`` redemande une fois une réponse qui n'est pas du JSON, comme le client Replicate.
"""

from __future__ import annotations

import base64
import hashlib
import json
import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from decimal import Decimal
from typing import Any

import anthropic

from src.config import load_settings
from src.enrichment.llm_client import (
    JSON_FINAL_REMINDER,
    JSON_RETRY_INSTRUCTION,
    VISION_IMAGE_TOKEN_CEILING,
    LLMClientUnavailable,
    LLMProviderOutputRefused,
    _response_request_status,
    parse_json_response,
    validated_image_inputs,
)
from src.llm_requests import (
    LLMRequestTransportAmbiguous,
    record_llm_request,
    record_llm_request_ceiling,
    release_llm_request,
    reserve_llm_request,
)
from src.llm_task_deadline import (
    LLMTaskDeadlineExceeded,
    ensure_llm_task_deadline,
    llm_answer_time_required,
    llm_task_bounded_timeout,
    llm_task_deadline_remaining,
)
from src.pipeline_usage import (
    TOKEN_PRICE_INPUT_LIMITS,
    _prediction_cost,
    _request_cost_eur,
    ledger_token_counts,
    record_prediction,
    require_lower_price_tier,
    reserve_prediction,
)

HAIKU = "claude-haiku-5-5"
SONNET = "claude-sonnet-5-5"
PROVIDER = "anthropic"
REQUEST_KIND = "document_reading"
# Genres d'appel des appels de texte et d'image, les mêmes que ceux du client Replicate (``llm_usage_events``).
TEXT_REQUEST_KIND = "fact_extraction"
VISION_REQUEST_KIND = "vision_analysis"
# Limite d'un document PDF retenue pour ce lot (32 Mo) ; le nombre de pages envoyées est borné par l'appelant.
MAX_PDF_BYTES = 32 * 1024 * 1024
# Tous les appels actuels lisent des pièces ou des réponses : « medium ». « low » serait celui des textes rédigés
# pour l'affichage, dont plus aucun n'est demandé au modèle (synthèse retirée le 09/11/2026, #446).
EFFORT = "medium"
DEFAULT_MAX_TOKENS = 16_000
DEFAULT_MAX_CALLS_PER_HOUR = 60
DEFAULT_TIMEOUT_SECONDS = 300.0
# Dans une passe bornée de bout en bout (file d'enrichissement, ``require_answer_time``), un appel ne part que s'il
# reste ce temps pour lire sa réponse : la même marge que pour Replicate (60 s d'attente et 30 s de lecture).
ANSWER_TIME_SECONDS = 90.0
# Jetons d'entrée d'une page de PDF : texte (1 500 à 3 000 selon la documentation) et image (1 568 au plus).
TOKENS_PER_PAGE = 4_600
# Ce que l'API ajoute au prompt (consigne du schéma de sortie, gabarit de message).
REQUEST_OVERHEAD_TOKENS = 2_048
_DATA_IMAGE_URL = re.compile(r"data:(image/(?:jpeg|png|gif|webp));base64,([A-Za-z0-9+/=\s]+)", re.S)


class DocumentReaderRefused(RuntimeError):
    """Le modèle a refusé de répondre (``stop_reason`` = ``refusal``) : aucune valeur, aucun repli côté serveur."""

    def __init__(self) -> None:
        super().__init__("Anthropic model refused to read the document")


class ReaderOutputCut(ValueError):
    """La réponse s'est arrêtée avant sa fin (``max_tokens``…) : jamais lue en partie."""


class ReaderInvalidJSON(ValueError):
    """La réponse n'est pas l'objet JSON attendu."""


# Reconnus par le blocage de 24 heures d'une même clé de requête (migration 20260920144219) : une lecture qui a
# rendu un JSON invalide n'est pas repayée à l'identique.
INVALID_JSON_MESSAGE = "Invalid JSON from LLM (Anthropic document reader)"
TEXT_INVALID_JSON_MESSAGE = "Invalid JSON from LLM (Anthropic text client)"


@dataclass(frozen=True)
class ReaderCall:
    """Un appel fait : jetons facturés (réflexion comprise en sortie) et coût, sans aucun contenu."""

    succeeded: bool
    input_tokens: int | None
    output_tokens: int | None
    cost_usd: Decimal | None


def pdf_page_count(pdf: bytes) -> int:
    import pymupdf

    with pymupdf.open(stream=pdf, filetype="pdf") as document:
        return int(document.page_count)


def input_token_ceiling(
    pdf_pages: int, system_prompt: str, user_prompt: str, schema: Mapping[str, Any] | None = None
) -> int:
    """Plafond prudent des jetons d'entrée d'un appel (un octet UTF-8 compte au plus un jeton)."""
    parts = (system_prompt, user_prompt, json.dumps(schema, ensure_ascii=False) if schema is not None else "")
    text_bytes = sum(len(part.encode("utf-8")) for part in parts)
    return pdf_pages * TOKENS_PER_PAGE + text_bytes + REQUEST_OVERHEAD_TOKENS


def call_ceiling_cost(model: str, input_tokens: int, max_tokens: int) -> Decimal:
    """Coût maximal d'un appel, en euros (un dollar compté pour un euro)."""
    return _request_cost_eur(model, input_tokens, max_tokens)


def _usage_counts(message: Any) -> tuple[int, int] | None:
    usage = getattr(message, "usage", None)
    try:
        return int(usage.input_tokens), int(usage.output_tokens)
    except (AttributeError, TypeError, ValueError):
        return None


@dataclass
class _AnthropicCaller:
    """Un appel à l'API dans le budget : réservation, envoi, ``stop_reason``, réponse JSON, jetons facturés."""

    model: str
    max_tokens: int = DEFAULT_MAX_TOKENS
    max_calls_per_hour: int = DEFAULT_MAX_CALLS_PER_HOUR
    timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS
    client: Any = None
    usage: list[ReaderCall] = field(default_factory=list)

    # Message noté pour une réponse qui n'est pas du JSON (reconnu par le blocage de 24 heures).
    invalid_json_message = INVALID_JSON_MESSAGE

    def __post_init__(self) -> None:
        if self.client is None:
            api_key = load_settings().get("anthropic_api_key")
            if api_key:
                self.client = anthropic.Anthropic(api_key=str(api_key), max_retries=0, timeout=self.timeout_seconds)

    def _refused(self, request_kind: str) -> Exception:
        return DocumentReaderRefused()

    def _record(
        self,
        reservation_id: str | None,
        reservation: str | None,
        message: Any,
        *,
        status: str,
        prompt_chars: int,
        system_chars: int,
        output_chars: int = 0,
        error: str | None = None,
    ) -> None:
        """Une réponse reçue : ses jetons facturés remplacent les plafonds de la réservation."""
        counts = _usage_counts(message)
        metrics = {"input_token_count": counts[0], "output_token_count": counts[1]} if counts else {}
        cost, _ = _prediction_cost(self.model, {}, dict(metrics)) if counts else (None, None)
        self.usage.append(ReaderCall(status == "succeeded", *(counts or (None, None)), cost))
        ledger = ledger_token_counts(self.model, *counts) if counts else (None, None)
        message_id = getattr(message, "id", None)
        record_llm_request(
            reservation_id,
            status=status,
            prediction_id=message_id,
            succeeded=status == "succeeded",
            prompt_chars=prompt_chars,
            system_prompt_chars=system_chars,
            output_chars=output_chars,
            input_tokens_estimate=ledger[0],
            output_tokens_estimate=ledger[1],
            error_message=error,
        )
        if message_id:
            record_prediction(
                {"id": message_id, "status": "succeeded" if status == "succeeded" else "failed", "metrics": metrics},
                reservation=reservation,
                model=self.model,
            )

    def _record_unanswered(self, reservation_id: str | None, status: str, error: str, prompt_chars: int, system_chars: int) -> None:
        """Aucune réponse lue. « ambiguous » garde les plafonds (l'appel a pu être facturé) ; un refus net de l'API
        (429, erreur 4xx) n'est pas facturé : ses jetons passent à zéro."""
        tokens = None if status == "ambiguous" else 0
        self.usage.append(ReaderCall(False, None, None, None))
        record_llm_request(
            reservation_id,
            status=status,
            prompt_chars=prompt_chars,
            system_prompt_chars=system_chars,
            input_tokens_estimate=tokens,
            output_tokens_estimate=tokens,
            error_message=error,
        )

    def _call(
        self,
        request: dict[str, Any],
        *,
        request_kind: str,
        request_key: str,
        input_ceiling: int,
        prompt_chars: int,
        system_chars: int,
        attempt_number: int = 1,
        timeout: float | None = None,
    ) -> dict[str, Any]:
        """Un appel réservé dans le budget ; rend l'objet JSON de la réponse."""
        # Au-delà du palier bas, rien n'est réservé ni envoyé.
        require_lower_price_tier(self.model, input_ceiling)
        reservation_id = reserve_llm_request(
            provider=PROVIDER,
            model=self.model,
            request_kind=request_kind,
            attempt_number=attempt_number,
            max_calls_per_hour=self.max_calls_per_hour,
            request_key=request_key,
        )
        try:
            record_llm_request_ceiling(reservation_id, input_tokens=input_ceiling, output_tokens=self.max_tokens)
            reservation = reserve_prediction(
                self.model,
                input_token_ceiling=input_ceiling,
                output_token_ceiling=self.max_tokens,
                ceiling_in_ledger=True,
            )
        except Exception as exc:
            release_llm_request(reservation_id, reason=f"budget reservation rejected: {type(exc).__name__}")
            raise
        options = {} if timeout is None else {"timeout": timeout}
        try:
            message = self.client.messages.create(**request, **options)
        except anthropic.APIConnectionError as exc:
            # Délai ou connexion coupée : la requête a pu être reçue et facturée.
            self._record_unanswered(reservation_id, "ambiguous", type(exc).__name__, prompt_chars, system_chars)
            raise LLMRequestTransportAmbiguous(
                "Anthropic request outcome is ambiguous; provider reconciliation is required"
            ) from exc
        except anthropic.RateLimitError as exc:
            self._record_unanswered(reservation_id, "rate_limited", type(exc).__name__, prompt_chars, system_chars)
            raise
        except anthropic.APIStatusError as exc:
            status = _response_request_status(exc.status_code)
            self._record_unanswered(
                reservation_id, status, f"{type(exc).__name__} {exc.status_code}", prompt_chars, system_chars
            )
            raise
        stop_reason = getattr(message, "stop_reason", None)
        if stop_reason == "refusal":
            self._record(reservation_id, reservation, message, status="failed", prompt_chars=prompt_chars,
                         system_chars=system_chars, error="refusal")
            raise self._refused(request_kind)
        text = "".join(
            str(getattr(block, "text", "")) for block in getattr(message, "content", []) if getattr(block, "type", "") == "text"
        )
        if stop_reason != "end_turn":
            # « max_tokens » : réponse coupée (la réflexion a pu tout prendre) ; jamais lue en partie.
            self._record(reservation_id, reservation, message, status="failed", prompt_chars=prompt_chars,
                         system_chars=system_chars, output_chars=len(text), error=f"stop_reason {stop_reason}")
            raise ReaderOutputCut(f"Anthropic response stopped on {stop_reason}")
        try:
            parsed = parse_json_response(text)
        except ValueError as exc:
            self._record(reservation_id, reservation, message, status="failed", prompt_chars=prompt_chars,
                         system_chars=system_chars, output_chars=len(text), error=self.invalid_json_message)
            raise ReaderInvalidJSON(self.invalid_json_message) from exc
        self._record(reservation_id, reservation, message, status="succeeded", prompt_chars=prompt_chars,
                     system_chars=system_chars, output_chars=len(text))
        return parsed


@dataclass
class AnthropicDocumentReader(_AnthropicCaller):
    def __post_init__(self) -> None:
        super().__post_init__()
        if self.client is None:
            raise RuntimeError("ANTHROPIC_API_KEY is missing")

    def _request(self, system_prompt: str, user_prompt: str, pdf: bytes, schema: Mapping[str, Any]) -> dict[str, Any]:
        document = {
            "type": "document",
            "source": {"type": "base64", "media_type": "application/pdf", "data": base64.b64encode(pdf).decode("ascii")},
        }
        return {
            "model": self.model,
            "max_tokens": self.max_tokens,
            "system": system_prompt,
            "messages": [{"role": "user", "content": [document, {"type": "text", "text": user_prompt}]}],
            "thinking": {"type": "adaptive"},
            "output_config": {"effort": EFFORT, "format": {"type": "json_schema", "schema": dict(schema)}},
        }

    def _request_key(self, request: Mapping[str, Any], pdf: bytes) -> str:
        canonical = {
            "model": self.model,
            "max_tokens": self.max_tokens,
            "system": request["system"],
            "text": request["messages"][0]["content"][1]["text"],
            "pdf_sha256": hashlib.sha256(pdf).hexdigest(),
            "output_config": request["output_config"],
        }
        encoded = json.dumps(canonical, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        return hashlib.sha256(encoded.encode("utf-8")).hexdigest()

    def generate_json_with_pdf(
        self, system_prompt: str, user_prompt: str, pdf: bytes, schema: Mapping[str, Any]
    ) -> dict[str, Any]:
        """Un appel : le PDF, le message et le schéma de réponse. Rend l'objet JSON de la réponse."""
        if not pdf or len(pdf) > MAX_PDF_BYTES:
            raise ValueError("The PDF sent to the reader must be between 1 byte and 32 MB")
        input_ceiling = input_token_ceiling(pdf_page_count(pdf), system_prompt, user_prompt, schema)
        request = self._request(system_prompt, user_prompt, pdf, schema)
        return self._call(
            request,
            request_kind=REQUEST_KIND,
            request_key=self._request_key(request, pdf),
            input_ceiling=input_ceiling,
            prompt_chars=len(user_prompt),
            system_chars=len(system_prompt),
        )


def _image_block(image: str) -> dict[str, Any]:
    """Bloc ``image`` d'une adresse HTTPS ou d'une image ``data:`` (JPEG, PNG, GIF ou WebP, en base64)."""
    if image.startswith("https://"):
        return {"type": "image", "source": {"type": "url", "url": image}}
    match = _DATA_IMAGE_URL.fullmatch(image)
    if match is None:
        raise ValueError("Vision data URLs must hold a base64 JPEG, PNG, GIF or WebP image")
    return {
        "type": "image",
        "source": {"type": "base64", "media_type": match.group(1), "data": re.sub(r"\s+", "", match.group(2))},
    }


@dataclass
class AnthropicTextClient(_AnthropicCaller):
    """Client des appels de texte et d'image quand ``LLM_PROVIDER`` vaut ``anthropic``.

    Sans clé, il est créé mais indisponible (``is_available``), comme le client Replicate sans jeton : une passe dont
    tout est déjà en cache n'en a pas besoin. Ses prompts sont ceux qu'écrivent les appelants, filtrés par eux
    (noms des personnes physiques), sans rien de plus : la même entrée que pour Replicate.
    """

    invalid_json_message = TEXT_INVALID_JSON_MESSAGE

    def _refused(self, request_kind: str) -> Exception:
        # Même suite que le refus de Replicate : la tâche de faits est annulée pour relecture, sans nouvel appel.
        return LLMProviderOutputRefused(request_kind=request_kind, provider="Anthropic")

    def is_available(self) -> bool:
        return bool(self.client is not None and self.model)

    def generate_json(
        self,
        system_prompt: str,
        user_prompt: str,
        *,
        _allow_json_retry: bool = True,
    ) -> dict[str, Any]:
        """Un appel ; une seconde, avec une consigne de format, si la réponse n'est pas du JSON (comme Replicate)."""
        attempts = 2 if _allow_json_retry else 1
        prompt = f"{user_prompt}{JSON_FINAL_REMINDER}"
        for attempt in range(1, attempts + 1):
            try:
                return self._generate(
                    system_prompt, [{"type": "text", "text": prompt}], request_kind=TEXT_REQUEST_KIND, attempt_number=attempt
                )
            except ReaderInvalidJSON:
                if attempt >= attempts:
                    raise
                prompt = f"{user_prompt}{JSON_RETRY_INSTRUCTION}{JSON_FINAL_REMINDER}"
        raise AssertionError("unreachable")  # pragma: no cover

    def generate_json_once(self, system_prompt: str, user_prompt: str) -> dict[str, Any]:
        """Un seul appel, sans nouvelle demande sur une réponse invalide (passes facultatives)."""
        return self.generate_json(system_prompt, user_prompt, _allow_json_retry=False)

    def generate_json_with_images(
        self,
        system_prompt: str,
        user_prompt: str,
        image_inputs: Sequence[str],
    ) -> dict[str, Any]:
        """Un appel avec 1 à 4 images (placées avant le texte), sans nouvelle demande."""
        images = validated_image_inputs(image_inputs)
        content = [*(_image_block(image) for image in images), {"type": "text", "text": f"{user_prompt}{JSON_FINAL_REMINDER}"}]
        return self._generate(system_prompt, content, request_kind=VISION_REQUEST_KIND, image_count=len(images))

    def _input_ceiling(self, request: Mapping[str, Any], text_ceiling: int, timeout: float) -> int:
        """Plafond d'entrée : octets du texte et images comptées au plus haut ; au-delà du palier bas, compté par l'API.

        Le comptage (``count_tokens``) n'appelle pas le modèle et n'est pas facturé ; il ne sert que quand le plafond
        prudent dépasse le palier (une longue lecture des pièces : 90 000 caractères passent 100 000 octets).
        """
        tier = TOKEN_PRICE_INPUT_LIMITS.get(self.model)
        if tier is None or text_ceiling <= tier[0]:
            return text_ceiling
        counted = self.client.messages.count_tokens(
            model=request["model"], system=request["system"], messages=request["messages"], timeout=timeout
        )
        return int(counted.input_tokens) + REQUEST_OVERHEAD_TOKENS

    def _generate(
        self,
        system_prompt: str,
        content: list[dict[str, Any]],
        *,
        request_kind: str,
        attempt_number: int = 1,
        image_count: int = 0,
    ) -> dict[str, Any]:
        if not self.is_available():
            raise LLMClientUnavailable("ANTHROPIC_API_KEY is missing")
        ensure_llm_task_deadline("starting Anthropic request")
        remaining = llm_task_deadline_remaining()
        if llm_answer_time_required() and remaining is not None and remaining < min(self.timeout_seconds, ANSWER_TIME_SECONDS):
            raise LLMTaskDeadlineExceeded("starting an Anthropic request too close to the deadline", remaining=remaining)
        request: dict[str, Any] = {
            "model": self.model,
            "max_tokens": self.max_tokens,
            "system": system_prompt,
            "messages": [{"role": "user", "content": content}],
            "thinking": {"type": "adaptive"},
            "output_config": {"effort": EFFORT},
        }
        user_text = str(content[-1]["text"])
        timeout = llm_task_bounded_timeout(self.timeout_seconds, "sending Anthropic request")
        text_ceiling = input_token_ceiling(0, system_prompt, user_text) + image_count * VISION_IMAGE_TOKEN_CEILING
        input_ceiling = self._input_ceiling(request, text_ceiling, timeout)
        encoded = json.dumps(request, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        return self._call(
            request,
            request_kind=request_kind,
            request_key=hashlib.sha256(encoded.encode("utf-8")).hexdigest(),
            input_ceiling=input_ceiling,
            prompt_chars=len(user_text),
            system_chars=len(system_prompt),
            attempt_number=attempt_number,
            timeout=llm_task_bounded_timeout(timeout, "sending Anthropic request"),
        )
