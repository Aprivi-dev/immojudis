import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Signed, expiring unsubscribe links. The token names the user and what to
 * switch off, so a link scanner that merely opens it can neither unsubscribe
 * anyone nor guess another user's link.
 */
export const UNSUBSCRIBE_TOKEN_TTL_DAYS = 365;
/**
 * Même durée, nom d'origine conservé. Tous les emails reviennent pendant des mois (alertes, rappels
 * d'audience, récapitulatif, alerte de résultat) : un lien de désinscription ne doit pas devenir
 * inutilisable pendant que les emails continuent (c'est aussi le lien d'en-tête List-Unsubscribe).
 * Les alertes étaient les seules à 60 jours : un lien d'un ancien email affichait « lien expiré » au
 * lieu de désinscrire.
 */
export const REMINDERS_UNSUBSCRIBE_TOKEN_TTL_DAYS = UNSUBSCRIBE_TOKEN_TTL_DAYS;

/** Durée de validité d'un lien de désinscription, la même pour toutes les portées. */
export function unsubscribeTokenTtlDays(_scope: UnsubscribeScope): number {
  return UNSUBSCRIBE_TOKEN_TTL_DAYS;
}

export type UnsubscribeScope =
  | { kind: "alerts" }
  | { kind: "alert"; alertId: string }
  // Rappels d'audience et avertissements graves: un consentement distinct de celui des alertes.
  | { kind: "reminders" }
  // Récapitulatif hebdomadaire « Ma semaine » : un consentement distinct, une portée dédiée (un lien
  // de rappels ou d'alertes ne le retire pas, et inversement).
  | { kind: "weekly-digest" }
  // Alerte de résultat ou de remise en vente d'une vente suivie : idem.
  | { kind: "sale-results" }
  // Liste d'attente de l'ouverture de l'offre Analyse : l'email d'ouverture (envoi par l'administrateur).
  | { kind: "offer-opening" };

export type UnsubscribeClaims = {
  userId: string;
  scope: UnsubscribeScope;
  expiresAt: number;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function signingKey(env: Pick<NodeJS.ProcessEnv, string> = process.env): string {
  const dedicated = env.EMAIL_UNSUBSCRIBE_SECRET?.trim();
  if (dedicated) return dedicated;
  // Same order as the rest of the code: the legacy service-role key first, then
  // the new-format secret key, so links already sent keep verifying.
  const serviceRole = env.SUPABASE_SERVICE_ROLE_KEY?.trim() || env.SUPABASE_SECRET_KEY?.trim();
  if (!serviceRole)
    throw new Error("Aucun secret disponible pour signer les liens de désinscription.");
  // Derived from the service key with a fixed label, so the raw key never signs
  // anything directly and no extra configuration is needed.
  return createHmac("sha256", serviceRole).update("immojudis:email-unsubscribe:v1").digest("hex");
}

function sign(payload: string, env?: Pick<NodeJS.ProcessEnv, string>): string {
  return createHmac("sha256", signingKey(env)).update(payload).digest("base64url");
}

function scopeToString(scope: UnsubscribeScope): string {
  if (scope.kind === "reminders") return "reminders";
  if (scope.kind === "weekly-digest") return "weekly-digest";
  if (scope.kind === "sale-results") return "sale-results";
  if (scope.kind === "offer-opening") return "offer-opening";
  return scope.kind === "alert" ? `alert:${scope.alertId}` : "alerts";
}

function scopeFromString(value: string): UnsubscribeScope | null {
  if (value === "alerts") return { kind: "alerts" };
  if (value === "reminders") return { kind: "reminders" };
  if (value === "weekly-digest") return { kind: "weekly-digest" };
  if (value === "sale-results") return { kind: "sale-results" };
  if (value === "offer-opening") return { kind: "offer-opening" };
  const match = /^alert:(.+)$/.exec(value);
  return match && UUID_PATTERN.test(match[1]) ? { kind: "alert", alertId: match[1] } : null;
}

export function createUnsubscribeToken({
  userId,
  scope = { kind: "alerts" },
  now = new Date(),
  env,
}: {
  userId: string;
  scope?: UnsubscribeScope;
  now?: Date;
  env?: Pick<NodeJS.ProcessEnv, string>;
}): string {
  const expiresAt = Math.floor(now.getTime() / 1000) + unsubscribeTokenTtlDays(scope) * 86_400;
  const payload = Buffer.from(
    JSON.stringify({ u: userId, s: scopeToString(scope), e: expiresAt }),
  ).toString("base64url");
  return `${payload}.${sign(payload, env)}`;
}

export function verifyUnsubscribeToken(
  token: string | null | undefined,
  { now = new Date(), env }: { now?: Date; env?: Pick<NodeJS.ProcessEnv, string> } = {},
): UnsubscribeClaims | null {
  const claims = readSignedClaims(token, env);
  return claims && claims.expiresAt * 1000 >= now.getTime() ? claims : null;
}

/**
 * Le type de portée d'un jeton dont la signature est valide, même expiré : sert à orienter la
 * personne vers la bonne page quand son lien n'est plus valable (`/compte` pour les rappels,
 * `/alertes` pour les alertes). Ne donne aucun droit : l'action reste réservée à
 * `verifyUnsubscribeToken`.
 */
export function unsubscribeTokenScopeKind(
  token: string | null | undefined,
  { env }: { env?: Pick<NodeJS.ProcessEnv, string> } = {},
): UnsubscribeScope["kind"] | null {
  return readSignedClaims(token, env)?.scope.kind ?? null;
}

/** Décode un jeton dont la signature est valide ; l'expiration est vérifiée par l'appelant. */
function readSignedClaims(
  token: string | null | undefined,
  env?: Pick<NodeJS.ProcessEnv, string>,
): UnsubscribeClaims | null {
  if (!token || token.length > 1_000) return null;
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra !== undefined) return null;

  let expected: string;
  try {
    expected = sign(payload, env);
  } catch {
    return null;
  }
  const given = Buffer.from(signature);
  const wanted = Buffer.from(expected);
  if (given.length !== wanted.length || !timingSafeEqual(given, wanted)) return null;

  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      u?: unknown;
      s?: unknown;
      e?: unknown;
    };
    if (typeof data.u !== "string" || !UUID_PATTERN.test(data.u)) return null;
    if (typeof data.s !== "string" || typeof data.e !== "number") return null;
    const scope = scopeFromString(data.s);
    return scope ? { userId: data.u, scope, expiresAt: data.e } : null;
  } catch {
    return null;
  }
}
