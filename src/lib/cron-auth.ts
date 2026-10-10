import "server-only";
import { timingSafeEqual } from "node:crypto";
import { serverEnv } from "@/lib/env";

/**
 * Machine-to-machine authentication shared by the Vercel Cron routes and the pipeline
 * callbacks (cache invalidation): `Authorization: Bearer $CRON_SECRET`.
 * Fails closed: without a configured secret every request is refused.
 */
export function cronRequestAuthorized(request: Request): boolean {
  const secret = serverEnv().cronSecret;
  const authorization = request.headers.get("authorization");
  if (!secret || !authorization) return false;
  return safeEqual(authorization, `Bearer ${secret}`);
}

function safeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}
