"""Lecture d'un extrait PDF des pièces par l'API Anthropic, dans le budget partagé des appels aux modèles.

Un appel = un document PDF (bloc ``document`` en base64, placé avant le texte) et une réponse JSON contrainte par un
schéma (``output_config.format``). Règles d'appel des modèles Claude 5.5 : réflexion adaptative, ``effort``
explicite ; ni ``temperature``, ``top_p``, ``top_k``, ``budget_tokens`` ni préremplissage (erreur 400).

Budget : le même que les appels Replicate. Le nombre exact de jetons d'entrée est compté avant l'envoi
(``count_tokens``, gratuit) ; l'appel est réservé dans ``llm_usage_events`` (plafond horaire par fournisseur, clé de
requête) puis dans le budget quotidien (``reserve_prediction`` : grille TOKEN_PRICES, plafond d'entrée du palier de
prix), avec ``max_tokens`` comme plafond de sortie : la réflexion, facturée en sortie, y tient. Après la réponse, le
registre note les jetons facturés.

Aucune nouvelle tentative : le client du SDK est créé avec ``max_retries=0`` et un appel à l'issue incertaine est noté
« ambiguous », comme pour Replicate, pour ne jamais payer deux fois la même lecture.
"""

from __future__ import annotations

import base64
import hashlib
import json
from collections.abc import Mapping
from dataclasses import dataclass, field
from decimal import Decimal
from typing import Any

import anthropic

from src.config import load_settings
from src.enrichment.llm_client import _response_request_status, parse_json_response
from src.llm_requests import (
    LLMRequestTransportAmbiguous,
    record_llm_request,
    release_llm_request,
    reserve_llm_request,
)
from src.pipeline_usage import _prediction_cost, record_prediction, reserve_prediction

HAIKU = "claude-haiku-5-5"
SONNET = "claude-sonnet-5-5"
PROVIDER = "anthropic"
REQUEST_KIND = "document_reading"
# Limite d'un document PDF retenue pour ce lot (32 Mo) ; le nombre de pages envoyées est borné par l'appelant.
MAX_PDF_BYTES = 32 * 1024 * 1024
EFFORT = "medium"
DEFAULT_MAX_TOKENS = 16_000
DEFAULT_MAX_CALLS_PER_HOUR = 60
DEFAULT_TIMEOUT_SECONDS = 300.0


class DocumentReaderRefused(RuntimeError):
    """Le modèle a refusé de répondre (``stop_reason`` = ``refusal``) : aucune valeur, aucun repli côté serveur."""

    def __init__(self) -> None:
        super().__init__("Anthropic model refused to read the document")


@dataclass(frozen=True)
class ReaderCall:
    """Un appel fait : jetons facturés (réflexion comprise en sortie) et coût, sans aucun contenu."""

    succeeded: bool
    input_tokens: int | None
    output_tokens: int | None
    cost_usd: Decimal | None


def _usage_counts(message: Any) -> tuple[int, int] | None:
    usage = getattr(message, "usage", None)
    try:
        return int(usage.input_tokens), int(usage.output_tokens)
    except (AttributeError, TypeError, ValueError):
        return None


@dataclass
class AnthropicDocumentReader:
    model: str
    max_tokens: int = DEFAULT_MAX_TOKENS
    max_calls_per_hour: int = DEFAULT_MAX_CALLS_PER_HOUR
    timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS
    client: Any = None
    usage: list[ReaderCall] = field(default_factory=list)

    def __post_init__(self) -> None:
        if self.client is None:
            api_key = load_settings().get("anthropic_api_key")
            if not api_key:
                raise RuntimeError("ANTHROPIC_API_KEY is missing")
            self.client = anthropic.Anthropic(api_key=str(api_key), max_retries=0, timeout=self.timeout_seconds)

    def _request(self, system_prompt: str, user_prompt: str, pdf: bytes, schema: Mapping[str, Any]) -> dict[str, Any]:
        document = {
            "type": "document",
            "source": {"type": "base64", "media_type": "application/pdf", "data": base64.b64encode(pdf).decode("ascii")},
        }
        return {
            "model": self.model,
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
        counts = _usage_counts(message)
        metrics = {"input_token_count": counts[0], "output_token_count": counts[1]} if counts else {}
        cost, _ = _prediction_cost(self.model, {}, dict(metrics)) if counts else (None, None)
        self.usage.append(ReaderCall(status == "succeeded", *(counts or (None, None)), cost))
        message_id = getattr(message, "id", None)
        record_llm_request(
            reservation_id,
            status=status,
            prediction_id=message_id,
            succeeded=status == "succeeded",
            prompt_chars=prompt_chars,
            system_prompt_chars=system_chars,
            output_chars=output_chars,
            input_tokens_estimate=counts[0] if counts else None,
            output_tokens_estimate=counts[1] if counts else None,
            error_message=error,
        )
        if message_id:
            record_prediction(
                {"id": message_id, "status": "succeeded" if status == "succeeded" else "failed", "metrics": metrics},
                reservation=reservation,
                model=self.model,
            )

    def generate_json_with_pdf(
        self, system_prompt: str, user_prompt: str, pdf: bytes, schema: Mapping[str, Any]
    ) -> dict[str, Any]:
        """Un appel : le PDF, le message et le schéma de réponse. Rend l'objet JSON de la réponse."""
        if not pdf or len(pdf) > MAX_PDF_BYTES:
            raise ValueError("The PDF sent to the reader must be between 1 byte and 32 MB")
        request = self._request(system_prompt, user_prompt, pdf, schema)
        prompt_chars, system_chars = len(user_prompt), len(system_prompt)
        # Nombre exact de jetons d'entrée (PDF compris) : c'est le plafond d'entrée réservé.
        input_tokens = int(self.client.messages.count_tokens(**request).input_tokens)
        reservation_id = reserve_llm_request(
            provider=PROVIDER,
            model=self.model,
            request_kind=REQUEST_KIND,
            attempt_number=1,
            max_calls_per_hour=self.max_calls_per_hour,
            request_key=self._request_key(request, pdf),
        )
        try:
            reservation = reserve_prediction(
                self.model, input_token_ceiling=input_tokens, output_token_ceiling=self.max_tokens
            )
        except Exception as exc:
            release_llm_request(reservation_id, reason=f"autonomous reservation rejected: {exc}")
            raise
        try:
            message = self.client.messages.create(max_tokens=self.max_tokens, **request)
        except anthropic.APIConnectionError as exc:
            # Délai ou connexion coupée : la requête a pu être reçue et facturée.
            record_llm_request(reservation_id, status="ambiguous", prompt_chars=prompt_chars,
                               system_prompt_chars=system_chars, error_message=type(exc).__name__)
            self.usage.append(ReaderCall(False, None, None, None))
            raise LLMRequestTransportAmbiguous(
                "Anthropic request outcome is ambiguous; provider reconciliation is required"
            ) from exc
        except anthropic.RateLimitError as exc:
            record_llm_request(reservation_id, status="rate_limited", prompt_chars=prompt_chars,
                               system_prompt_chars=system_chars, error_message=type(exc).__name__)
            self.usage.append(ReaderCall(False, None, None, None))
            raise
        except anthropic.APIStatusError as exc:
            record_llm_request(reservation_id, status=_response_request_status(exc.status_code),
                               prompt_chars=prompt_chars, system_prompt_chars=system_chars,
                               error_message=f"{type(exc).__name__} {exc.status_code}")
            self.usage.append(ReaderCall(False, None, None, None))
            raise
        stop_reason = getattr(message, "stop_reason", None)
        if stop_reason == "refusal":
            self._record(reservation_id, reservation, message, status="failed", prompt_chars=prompt_chars,
                         system_chars=system_chars, error="refusal")
            raise DocumentReaderRefused()
        text = "".join(
            str(getattr(block, "text", "")) for block in getattr(message, "content", []) if getattr(block, "type", "") == "text"
        )
        if stop_reason != "end_turn":
            # « max_tokens » : réponse coupée (la réflexion a pu tout prendre) ; jamais lue en partie.
            self._record(reservation_id, reservation, message, status="failed", prompt_chars=prompt_chars,
                         system_chars=system_chars, output_chars=len(text), error=f"stop_reason {stop_reason}")
            raise ValueError(f"Anthropic response stopped on {stop_reason}")
        try:
            parsed = parse_json_response(text)
        except ValueError:
            self._record(reservation_id, reservation, message, status="failed", prompt_chars=prompt_chars,
                         system_chars=system_chars, output_chars=len(text), error="invalid JSON")
            raise
        self._record(reservation_id, reservation, message, status="succeeded", prompt_chars=prompt_chars,
                     system_chars=system_chars, output_chars=len(text))
        return parsed
