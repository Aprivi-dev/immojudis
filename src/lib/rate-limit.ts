import "server-only";
import { createHash } from "node:crypto";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { RateLimitError } from "@/lib/api-errors";

type RpcResult = { data: number | null; error: { message?: string } | null };

type RateLimitRpcClient = {
  rpc(
    name: "consume_api_rate_limit",
    args: {
      p_bucket_key: string;
      p_limit: number;
      p_user_id: string;
      p_window_seconds: number;
    },
  ): Promise<RpcResult>;
  // Added by 20261010000000_api_ip_rate_limit.sql, hence absent from the generated types.
  rpc(
    name: "consume_ip_rate_limit",
    args: {
      p_bucket_key: string;
      p_ip_hash: string;
      p_limit: number;
      p_window_seconds: number;
    },
  ): Promise<RpcResult>;
};

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
  const client = supabaseAdmin as unknown as RateLimitRpcClient;
  const { data, error } = await client.rpc("consume_api_rate_limit", {
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

/**
 * Best-effort client address. On Vercel, x-real-ip / x-forwarded-for are set by the
 * platform edge and cannot be forged by the caller.
 */
export function clientIpFromRequest(request: Request): string {
  const real = request.headers.get("x-real-ip")?.trim();
  if (real) return real;
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || "unknown";
}

export function hashClientIp(ip: string, salt = process.env.RATE_LIMIT_IP_SALT): string {
  return createHash("sha256")
    .update(`${salt?.trim() || "immojudis-ip-rate-limit"}|${ip}`, "utf8")
    .digest("hex");
}

/**
 * Per-IP fixed-window limiter for anonymous or public proxy routes. Only a salted
 * hash of the address is stored, and rows expire after two days. A failure of the
 * limiter itself fails open (logged) so a database incident does not take public
 * pages down; the per-user limiter above stays fail-closed.
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
  const client = supabaseAdmin as unknown as RateLimitRpcClient;
  let result: RpcResult;
  try {
    result = await client.rpc("consume_ip_rate_limit", {
      p_bucket_key: bucketKey,
      p_ip_hash: hashClientIp(clientIpFromRequest(request)),
      p_limit: limit,
      p_window_seconds: windowSeconds,
    });
  } catch (error) {
    console.error("[rate-limit] IP limiter unavailable", error);
    return;
  }

  if (result.error) {
    if (result.error.message?.includes("Rate limit exceeded")) {
      throw new RateLimitError(undefined, secondsUntilWindowEnds(windowSeconds));
    }
    console.error("[rate-limit] IP limiter error", result.error.message);
  }
}
