import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { ConfigurationError } from "@/lib/api-errors";
import {
  INFORMATION_AGENT_OPT_OUT_PATH,
  INFORMATION_AGENT_RIGHTS_PATH,
} from "@/lib/information-agent-link-paths";

/**
 * Liens signés de l'agent d'information, tous signés avec `INFORMATION_AGENT_PORTAL_SECRET` : opposition
 * (art. 21 RGPD) et droits (accès, effacement) depuis le pied des emails, dépôt de pièces, empreinte de
 * l'aperçu. Le lien d'opposition est un HMAC de l'adresse normalisée : il ne demande aucun stockage et
 * n'expire jamais, car une opposition doit fonctionner aussi longtemps que l'email existe.
 */

type Env = Readonly<Record<string, string | undefined>>;

/**
 * Longueur minimale du secret, en octets. `scripts/verify-required-env.mjs` et
 * `scripts/verify-production-env.mjs` imposent la même (le test de ce module le vérifie).
 */
export const INFORMATION_AGENT_PORTAL_SECRET_MIN_BYTES = 32;

const OPT_OUT_TOKEN_CONTEXT = "immojudis:information-agent:opt-out:v1";

/** Le secret des liens signés, ou `null` s'il est absent ou trop court. */
export function informationAgentPortalSecret(env: Env = process.env): string | null {
  const secret = env.INFORMATION_AGENT_PORTAL_SECRET?.trim();
  return secret && Buffer.byteLength(secret, "utf8") >= INFORMATION_AGENT_PORTAL_SECRET_MIN_BYTES
    ? secret
    : null;
}

/** Message de refus quand le secret manque : il bloque l'aperçu et l'envoi. */
export const INFORMATION_AGENT_PORTAL_SECRET_MISSING_MESSAGE =
  "Secret du lien d'opposition non configuré : envoi impossible.";

export function requireInformationAgentPortalSecret(env: Env = process.env): string {
  const secret = informationAgentPortalSecret(env);
  if (!secret) throw new ConfigurationError(INFORMATION_AGENT_PORTAL_SECRET_MISSING_MESSAGE);
  return secret;
}

/**
 * Adresse telle qu'elle est signée dans les liens d'opposition, de droits et de dépôt. La changer
 * invaliderait les liens déjà envoyés (le test « jeton connu » le vérifie).
 */
export function normalizeSignedLinkEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function createInformationAgentOptOutToken(email: string, secret: string): string {
  return createHmac("sha256", secret)
    .update(`${OPT_OUT_TOKEN_CONTEXT}:${normalizeSignedLinkEmail(email)}`)
    .digest("hex");
}

export function verifyInformationAgentOptOutToken(
  email: string,
  token: string,
  secret: string,
): boolean {
  if (!/^[a-f0-9]{64}$/.test(token)) return false;
  const expected = Buffer.from(createInformationAgentOptOutToken(email, secret), "hex");
  const received = Buffer.from(token, "hex");
  return expected.length === received.length && timingSafeEqual(expected, received);
}

/** Requête signée (`?e=…&t=…`) commune aux liens d'opposition et de droits. */
function signedEmailSearch(email: string, secret: string): string {
  const params = new URLSearchParams();
  params.set("e", Buffer.from(normalizeSignedLinkEmail(email), "utf8").toString("base64url"));
  params.set("t", createInformationAgentOptOutToken(email, secret));
  return `?${params.toString()}`;
}

/**
 * Chemin signé d'opposition de cette adresse (même lien que celui du pied de l'email). Lève
 * `ConfigurationError` si le secret manque.
 */
export function informationAgentOptOutPath(email: string, env: Env = process.env): string {
  return `${INFORMATION_AGENT_OPT_OUT_PATH}${signedEmailSearch(email, requireInformationAgentPortalSecret(env))}`;
}

/** Chemin signé de la page des droits (accès, effacement) de cette adresse. */
export function informationAgentRightsPath(email: string, env: Env = process.env): string {
  return `${INFORMATION_AGENT_RIGHTS_PATH}${signedEmailSearch(email, requireInformationAgentPortalSecret(env))}`;
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
  return new URL(
    `${INFORMATION_AGENT_OPT_OUT_PATH}${signedEmailSearch(email, secret)}`,
    appUrl,
  ).toString();
}

export function parseOptOutEmail(encoded: string | null): string | null {
  if (!encoded || encoded.length > 400 || !/^[A-Za-z0-9_-]+$/.test(encoded)) return null;
  const email = Buffer.from(encoded, "base64url").toString("utf8");
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 320 ? email : null;
}

/**
 * Adresse prouvée par un lien d'opposition ou de droits (`?e=…&t=…`), ou `null` si le lien est incomplet,
 * falsifié ou si le secret manque.
 */
export function verifiedSignedEmailLink(
  request: Request,
  env: Env = process.env,
): { email: string } | null {
  const params = new URL(request.url).searchParams;
  const email = parseOptOutEmail(params.get("e"));
  const secret = informationAgentPortalSecret(env);
  if (
    !email ||
    !secret ||
    !verifyInformationAgentOptOutToken(email, params.get("t") ?? "", secret)
  ) {
    return null;
  }
  return { email: normalizeSignedLinkEmail(email) };
}
