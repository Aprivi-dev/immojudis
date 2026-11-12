import "server-only";
import { NextResponse } from "next/server";
import { Resend } from "resend";
import { PublicApiError } from "@/lib/api-errors";

/**
 * Réception commune des webhooks Resend (signature Svix) : corps borné, signature vérifiée, et réponse
 * d'erreur. Chaque webhook a son propre secret de signature.
 */

const MAX_WEBHOOK_BODY_BYTES = 256 * 1024;

export class WebhookPayloadTooLargeError extends PublicApiError {
  constructor() {
    super("Webhook trop volumineux.", 413);
    this.name = "WebhookPayloadTooLargeError";
  }
}

export class InvalidWebhookSignatureError extends PublicApiError {
  constructor() {
    super("Signature webhook invalide.", 400);
    this.name = "InvalidWebhookSignatureError";
  }
}

export type ResendWebhookEvent = ReturnType<Resend["webhooks"]["verify"]>;

/** Lit le corps (256 Kio au plus, compté en octets pendant la lecture) et vérifie sa signature Svix. */
export async function readVerifiedResendWebhook(
  request: Request,
  webhookSecret: string,
): Promise<ResendWebhookEvent> {
  const payload = await readBoundedBody(request);
  try {
    // La vérification n'appelle pas l'API de Resend : la clé n'est qu'un paramètre du constructeur.
    return new Resend("re_signature_verification_only").webhooks.verify({
      payload,
      headers: {
        id: requiredHeader(request, "svix-id"),
        timestamp: requiredHeader(request, "svix-timestamp"),
        signature: requiredHeader(request, "svix-signature"),
      },
      webhookSecret,
    });
  } catch {
    throw new InvalidWebhookSignatureError();
  }
}

/**
 * Réponse d'un webhook en échec : 400 ou 413 pour une requête refusée, 500 sinon (Resend rejoue alors
 * l'évènement). Seul le cas 500 est journalisé, par `logFailure`, qui ne doit pas recopier le message (il
 * peut citer une adresse ou un contenu).
 */
export function resendWebhookErrorResponse(
  error: unknown,
  failureMessage: string,
  logFailure: (error: unknown) => void,
): Response {
  const refused = error instanceof PublicApiError;
  if (!refused) logFailure(error);
  return NextResponse.json(
    { error: refused ? error.message : failureMessage },
    { status: refused ? error.status : 500, headers: { "cache-control": "no-store" } },
  );
}

function requiredHeader(request: Request, name: string): string {
  const value = request.headers.get(name)?.trim();
  if (!value) throw new InvalidWebhookSignatureError();
  return value;
}

async function readBoundedBody(request: Request): Promise<string> {
  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_WEBHOOK_BODY_BYTES) {
    throw new WebhookPayloadTooLargeError();
  }
  if (!request.body) return "";

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_WEBHOOK_BODY_BYTES) {
        try {
          await reader.cancel();
        } catch {
          // The size error is the actionable outcome even if the client disconnects.
        }
        throw new WebhookPayloadTooLargeError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}
