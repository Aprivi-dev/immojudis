import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * One-click objection link (GDPR art. 21) for the supervised information agent. The token is an
 * HMAC of the normalised address, so it needs no storage and never expires: an objection must
 * keep working for as long as the email exists.
 */

const TOKEN_CONTEXT = "immojudis:information-agent:opt-out:v1";

export function normalizeOptOutEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function createInformationAgentOptOutToken(email: string, secret: string): string {
  if (!secret || secret.length < 16) throw new Error("Secret de désinscription invalide.");
  return createHmac("sha256", secret)
    .update(`${TOKEN_CONTEXT}:${normalizeOptOutEmail(email)}`)
    .digest("hex");
}

export function verifyInformationAgentOptOutToken(
  email: string,
  token: string,
  secret: string,
): boolean {
  if (!secret || secret.length < 16 || !/^[a-f0-9]{64}$/.test(token)) return false;
  const expected = Buffer.from(createInformationAgentOptOutToken(email, secret), "hex");
  const received = Buffer.from(token, "hex");
  return expected.length === received.length && timingSafeEqual(expected, received);
}

export function buildInformationAgentOptOutUrl({
  appUrl,
  email,
  secret,
}: {
  appUrl: string;
  email: string;
  secret: string;
}): string {
  const url = new URL("/api/information-agent/opt-out", appUrl);
  url.searchParams.set("e", Buffer.from(normalizeOptOutEmail(email), "utf8").toString("base64url"));
  url.searchParams.set("t", createInformationAgentOptOutToken(email, secret));
  return url.toString();
}

export function parseOptOutEmail(encoded: string | null): string | null {
  if (!encoded || encoded.length > 400 || !/^[A-Za-z0-9_-]+$/.test(encoded)) return null;
  const email = Buffer.from(encoded, "base64url").toString("utf8");
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 320 ? email : null;
}
