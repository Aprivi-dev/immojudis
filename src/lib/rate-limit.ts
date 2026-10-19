import "server-only";
import { createHash } from "node:crypto";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { RateLimitError } from "@/lib/api-errors";

type RpcResult = { data: number | null; error: { message?: string } | null };

/** Seconds until the fixed window containing `now` ends (the Retry-After value). */
export function secondsUntilWindowEnds(windowSeconds: number, now: Date = new Date()): number {
  const elapsed = Math.floor(now.getTime() / 1000) % windowSeconds;
  return Math.max(1, windowSeconds - elapsed);
}

/**
 * Consumes one unit of a per-user fixed-window bucket and throws a RateLimitError
 * (HTTP 429 + Retry-After) once `limit` calls were made in the window.
 */
export async function enforceUserRateLimit({
  userId,
  bucketKey,
  limit,
  windowSeconds,
}: {
  userId: string;
  bucketKey: string;
  limit: number;
  windowSeconds: number;
}): Promise<number> {
  const { data, error } = await supabaseAdmin.rpc("consume_api_rate_limit", {
    p_bucket_key: bucketKey,
    p_limit: limit,
    p_user_id: userId,
    p_window_seconds: windowSeconds,
  });

  if (error) {
    if (error.message?.includes("Rate limit exceeded")) {
      throw new RateLimitError(undefined, secondsUntilWindowEnds(windowSeconds));
    }
    throw new Error(error.message || "Contrôle de débit indisponible.");
  }

  return Number(data ?? 0);
}

/**
 * Same bucket as enforceUserRateLimit, but reports an exhausted quota as `false`
 * instead of throwing. Use it where the caller degrades gracefully.
 */
export async function tryConsumeUserRateLimit(
  input: Parameters<typeof enforceUserRateLimit>[0],
): Promise<boolean> {
  try {
    await enforceUserRateLimit(input);
    return true;
  } catch (error) {
    if (error instanceof RateLimitError) return false;
    throw error;
  }
}

/** Valeur de `clientIpFromRequest` quand la requête ne porte aucune adresse exploitable. */
export const UNKNOWN_CLIENT_IP = "unknown";

/**
 * Best-effort client address. On Vercel, x-real-ip / x-forwarded-for are set by the
 * platform edge and cannot be forged by the caller.
 */
export function clientIpFromRequest(request: Request): string {
  const real = request.headers.get("x-real-ip")?.trim();
  if (real) return real;
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || UNKNOWN_CLIENT_IP;
}

export function hashClientIp(ip: string, salt = process.env.RATE_LIMIT_IP_SALT): string {
  return createHash("sha256")
    .update(`${salt?.trim() || "immojudis-ip-rate-limit"}|${ip}`, "utf8")
    .digest("hex");
}

/**
 * Quota, par fenêtre, d'une requête SANS adresse exploitable : très bas. Derrière la plateforme de
 * Vercel l'adresse est toujours présente ; une requête qui n'en a pas ne vient pas d'un visiteur
 * ordinaire. Elle ne partage donc ni le seau d'une vraie adresse, ni un seau unique « unknown » avec
 * toutes les autres : chaque empreinte (en-têtes `user-agent` et `accept-language`) a son propre seau,
 * de ce quota. L'empreinte ne sert que sans adresse : elle ne permet pas de contourner la limite d'une
 * vraie adresse, et une empreinte falsifiée ne donne jamais le quota d'une adresse identifiée.
 */
export const UNKNOWN_CLIENT_LIMIT = 10;

/** Seau et quota effectifs de la requête : ceux de la politique, ou le seau bas des requêtes sans adresse. */
export function ipRateLimitTarget(
  request: Request,
  bucketKey: string,
  limit: number,
): { bucketKey: string; ipHash: string; limit: number; unknown: boolean } {
  const ip = clientIpFromRequest(request);
  if (ip !== UNKNOWN_CLIENT_IP) {
    return { bucketKey, ipHash: hashClientIp(ip), limit, unknown: false };
  }
  const fingerprint = createHash("sha256")
    .update(
      `${request.headers.get("user-agent") ?? ""}|${request.headers.get("accept-language") ?? ""}`,
      "utf8",
    )
    .digest("hex")
    .slice(0, 16);
  return {
    bucketKey: `${bucketKey}.unknown.${fingerprint}`,
    ipHash: hashClientIp(UNKNOWN_CLIENT_IP),
    limit: Math.min(limit, UNKNOWN_CLIENT_LIMIT),
    unknown: true,
  };
}

/**
 * Compteurs du limiteur par adresse, par instance de la fonction (remis à zéro à chaque démarrage à
 * froid). Ils accompagnent chaque ligne de journal du limiteur : un échec du limiteur ouvre le service
 * (voir `enforceIpRateLimit`), donc sans trace chiffrée une panne durable passerait inaperçue.
 */
const limiterStats = { calls: 0, failures: 0, unidentified: 0, since: new Date().toISOString() };

export function ipRateLimiterStats(): Readonly<typeof limiterStats> {
  return { ...limiterStats };
}

export function resetIpRateLimiterStats(): void {
  limiterStats.calls = 0;
  limiterStats.failures = 0;
  limiterStats.unidentified = 0;
  limiterStats.since = new Date().toISOString();
}

/** Une ligne JSON par échec, avec les compteurs de l'instance : recherchable dans les journaux Vercel. */
function logLimiterFailure(
  bucketKey: string,
  reason: "exception" | "rpc_error",
  message: unknown,
): void {
  limiterStats.failures += 1;
  console.error(
    JSON.stringify({
      scope: "rate-limit",
      event: "ip_limiter_failure",
      outcome: "fail_open",
      reason,
      bucket: bucketKey,
      message: String(message ?? "").slice(0, 200),
      failures: limiterStats.failures,
      calls: limiterStats.calls,
      unidentified: limiterStats.unidentified,
      since: limiterStats.since,
    }),
  );
}

/** Une ligne JSON à la première requête sans adresse, puis toutes les 100 : le cas ne doit pas exister sur Vercel. */
function logUnidentifiedClient(bucketKey: string): void {
  limiterStats.unidentified += 1;
  if (limiterStats.unidentified !== 1 && limiterStats.unidentified % 100 !== 0) return;
  console.warn(
    JSON.stringify({
      scope: "rate-limit",
      event: "ip_unidentified",
      bucket: bucketKey,
      unidentified: limiterStats.unidentified,
      calls: limiterStats.calls,
      since: limiterStats.since,
    }),
  );
}

/**
 * Per-IP fixed-window limiter for anonymous or public proxy routes. Only a salted
 * hash of the address is stored, and rows expire after two days. A failure of the
 * limiter itself fails open (logged as one JSON line with the counters of the instance, see
 * `logLimiterFailure`) so a database incident does not take public pages down; the per-user limiter
 * above stays fail-closed.
 *
 * Une requête sans adresse exploitable ne partage pas un seau « unknown » avec toutes les autres :
 * voir `UNKNOWN_CLIENT_LIMIT`.
 */
export async function enforceIpRateLimit({
  request,
  bucketKey,
  limit,
  windowSeconds,
}: {
  request: Request;
  bucketKey: string;
  limit: number;
  windowSeconds: number;
}): Promise<void> {
  limiterStats.calls += 1;
  const target = ipRateLimitTarget(request, bucketKey, limit);
  if (target.unknown) logUnidentifiedClient(bucketKey);

  let result: RpcResult;
  try {
    result = await supabaseAdmin.rpc("consume_ip_rate_limit", {
      p_bucket_key: target.bucketKey,
      p_ip_hash: target.ipHash,
      p_limit: target.limit,
      p_window_seconds: windowSeconds,
    });
  } catch (error) {
    logLimiterFailure(bucketKey, "exception", error instanceof Error ? error.message : error);
    return;
  }

  if (result.error) {
    if (result.error.message?.includes("Rate limit exceeded")) {
      throw new RateLimitError(undefined, secondsUntilWindowEnds(windowSeconds));
    }
    logLimiterFailure(bucketKey, "rpc_error", result.error.message);
  }
}
