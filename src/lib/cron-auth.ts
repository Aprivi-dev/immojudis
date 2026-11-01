import "server-only";
import { timingSafeEqual } from "node:crypto";
import { serverEnv } from "@/lib/env";

/**
 * Machine-to-machine authentication of the Vercel Cron routes:
 * `Authorization: Bearer $CRON_SECRET`.
 * Fails closed: without a configured secret every request is refused.
 */
export function cronRequestAuthorized(request: Request): boolean {
  return bearerMatches(request, serverEnv().cronSecret);
}

let fallbackWarned = false;

/**
 * Authentication of the callbacks made by the data pipeline (GitHub Actions), today
 * `/api/pipeline/revalidate-sale`: `Authorization: Bearer $PIPELINE_CALLBACK_SECRET`.
 *
 * The pipeline used to share `CRON_SECRET` with the Vercel Cron routes, so a leak from a workflow
 * could also run the crons. TRANSITION: while `PIPELINE_CALLBACK_SECRET` is not set, the callbacks
 * keep working with `CRON_SECRET` (and a warning is logged, once per instance). As soon as it is
 * set, it is the only secret these callbacks accept and `CRON_SECRET` no longer opens them.
 * Fails closed: without any configured secret every request is refused.
 */
export function pipelineCallbackAuthorized(request: Request): boolean {
  const env = serverEnv();
  if (env.pipelineCallbackSecret) return bearerMatches(request, env.pipelineCallbackSecret);

  const authorized = bearerMatches(request, env.cronSecret);
  if (authorized && !fallbackWarned) {
    fallbackWarned = true;
    console.warn(
      JSON.stringify({
        scope: "pipeline-callback-auth",
        event: "cron_secret_fallback",
        message: "PIPELINE_CALLBACK_SECRET absent : le rappel du pipeline utilise CRON_SECRET.",
      }),
    );
  }
  return authorized;
}

function bearerMatches(request: Request, secret: string | undefined): boolean {
  const authorization = request.headers.get("authorization");
  if (!secret || !authorization) return false;
  return safeEqual(authorization, `Bearer ${secret}`);
}

function safeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}
