import { authHeaders, readJson } from "@/lib/client-api-core";
import type { LaunchOfferEndSendResult, LaunchOfferEndState } from "@/lib/admin-launch-offer-end";

// Hors de `admin.ts` : ce module n'est chargé qu'avec le bloc du préavis (à la demande), pas par
// chaque page d'administration.
export type { LaunchOfferEndSendResult, LaunchOfferEndState };

export async function fetchAdminLaunchOfferEnd(): Promise<LaunchOfferEndState> {
  const response = await fetch("/api/admin/launch-offer-end", {
    signal: AbortSignal.timeout(30_000),
    headers: await authHeaders(),
    cache: "no-store",
  });

  return readJson<LaunchOfferEndState>(response);
}

/** Les actions du préavis de fin d'offre : date annoncée, essai, envoi d'un lot (sur confirmation). */
export async function postAdminLaunchOfferEnd<T>(body: Record<string, unknown>): Promise<T> {
  const response = await fetch("/api/admin/launch-offer-end", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await authHeaders()) },
    body: JSON.stringify(body),
  });

  return readJson<T>(response);
}
