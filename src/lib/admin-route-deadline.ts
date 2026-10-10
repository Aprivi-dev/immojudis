import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";
import { NextResponse } from "next/server";
import { resolveRequestId } from "@/lib/request-id";

/**
 * Délai maximal d'une route /api/admin/*. La plateforme coupe à `maxDuration` (30 s dans chaque
 * route.ts, valeur littérale exigée par Next) : on répond nous-mêmes un peu avant, avec un
 * message clair, plutôt que de laisser l'administrateur devant une requête qui expire sans
 * explication (les routes admin ont dépassé 300 s le 4 octobre).
 */
export const ADMIN_ROUTE_TIMEOUT_MS = 28_000;
/** Valeur à exporter comme `maxDuration` dans chaque route admin (secondes). */
export const ADMIN_ROUTE_MAX_DURATION_SECONDS = 30;
export const ADMIN_TIMEOUT_CODE = "ADMIN_TIMEOUT";

const READ_TIMEOUT_MESSAGE =
  "Cette requête admin a dépassé le délai de 30 secondes et a été interrompue. Réessayez dans un instant ; si le problème persiste, réduisez la page affichée ou consultez les journaux du serveur.";
const WRITE_TIMEOUT_MESSAGE =
  "Cette action admin a dépassé le délai de 30 secondes. Elle a pu aboutir malgré tout : actualisez la liste et vérifiez son état avant de la relancer.";

export class AdminRouteTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`La route admin a dépassé ${Math.round(timeoutMs / 1000)} s.`);
    this.name = "AdminRouteTimeoutError";
  }
}

type DeadlineStore = { signal: AbortSignal };
const deadlineStorage = new AsyncLocalStorage<DeadlineStore>();

/** Signal de la route admin en cours (aborté au dépassement du délai), s'il y en a une. */
export function adminDeadlineSignal(): AbortSignal | undefined {
  return deadlineStorage.getStore()?.signal;
}

/**
 * À appeler entre deux étapes d'un traitement long (pages successives, boucle de lecture) :
 * interrompt le travail de fond dès que la réponse 504 est partie.
 */
export function throwIfAdminDeadlineExceeded(): void {
  const signal = deadlineStorage.getStore()?.signal;
  if (signal?.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new AdminRouteTimeoutError(ADMIN_ROUTE_TIMEOUT_MS);
  }
}

export function adminTimeoutResponse(request: Request, timeoutMs = ADMIN_ROUTE_TIMEOUT_MS) {
  const requestId = resolveRequestId(request.headers.get("x-request-id"));
  const isRead = request.method === "GET" || request.method === "HEAD";
  console.error(
    JSON.stringify({
      scope: "admin.api",
      requestId,
      status: 504,
      code: ADMIN_TIMEOUT_CODE,
      method: request.method,
      path: safePath(request),
      timeoutMs,
    }),
  );
  return NextResponse.json(
    {
      error: isRead ? READ_TIMEOUT_MESSAGE : WRITE_TIMEOUT_MESSAGE,
      code: ADMIN_TIMEOUT_CODE,
      requestId,
    },
    {
      status: 504,
      headers: { "x-request-id": requestId, "cache-control": "no-store" },
    },
  );
}

function safePath(request: Request): string {
  try {
    return new URL(request.url).pathname;
  } catch {
    return "";
  }
}

/**
 * Enveloppe un handler de route admin : au bout de `timeoutMs`, la réponse est une 504 JSON
 * `{ error, code: "ADMIN_TIMEOUT", requestId }` et le signal exposé par `adminDeadlineSignal()`
 * est aborté. Le travail déjà lancé n'est pas annulé par magie : les boucles longues doivent
 * appeler `throwIfAdminDeadlineExceeded()`.
 */
export function withAdminDeadline<Args extends [Request, ...unknown[]]>(
  handler: (...args: Args) => Promise<Response>,
  { timeoutMs = ADMIN_ROUTE_TIMEOUT_MS }: { timeoutMs?: number } = {},
): (...args: Args) => Promise<Response> {
  return async (...args: Args) => {
    const [request] = args;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<Response>((resolve) => {
      timer = setTimeout(() => {
        controller.abort(new AdminRouteTimeoutError(timeoutMs));
        resolve(adminTimeoutResponse(request, timeoutMs));
      }, timeoutMs);
    });
    try {
      return await Promise.race([
        deadlineStorage.run({ signal: controller.signal }, () => handler(...args)),
        timeout,
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
}
