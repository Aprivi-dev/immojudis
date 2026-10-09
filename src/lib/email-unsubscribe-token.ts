import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Signed, expiring unsubscribe links. The token names the user and what to
 * switch off, so a link scanner that merely opens it can neither unsubscribe
 * anyone nor guess another user's link.
 */
export const UNSUBSCRIBE_TOKEN_TTL_DAYS = 60;

export type UnsubscribeScope = { kind: "alerts" } | { kind: "alert"; alertId: string };

export type UnsubscribeClaims = {
  userId: string;
  scope: UnsubscribeScope;
  expiresAt: number;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function signingKey(env: Pick<NodeJS.ProcessEnv, string> = process.env): string {
  const dedicated = env.EMAIL_UNSUBSCRIBE_SECRET?.trim();
  if (dedicated) return dedicated;
  const serviceRole = env.SUPABASE_SERVICE_ROLE_KEY?.trim();
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
  return scope.kind === "alert" ? `alert:${scope.alertId}` : "alerts";
}

function scopeFromString(value: string): UnsubscribeScope | null {
  if (value === "alerts") return { kind: "alerts" };
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
  const expiresAt = Math.floor(now.getTime() / 1000) + UNSUBSCRIBE_TOKEN_TTL_DAYS * 86_400;
  const payload = Buffer.from(
    JSON.stringify({ u: userId, s: scopeToString(scope), e: expiresAt }),
  ).toString("base64url");
  return `${payload}.${sign(payload, env)}`;
}

export function verifyUnsubscribeToken(
  token: string | null | undefined,
  { now = new Date(), env }: { now?: Date; env?: Pick<NodeJS.ProcessEnv, string> } = {},
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
    if (data.e * 1000 < now.getTime()) return null;
    const scope = scopeFromString(data.s);
    return scope ? { userId: data.u, scope, expiresAt: data.e } : null;
  } catch {
    return null;
  }
}
