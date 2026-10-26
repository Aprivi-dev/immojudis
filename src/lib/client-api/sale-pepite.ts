import { authHeaders, readJson } from "@/lib/client-api-core";
import type { PepitePayload } from "@/lib/sale-pepite-view";

export type PepiteView = "criteria" | "detail";

/**
 * Repère « Pépite » d'une vente (`GET /api/sales/[id]/pepite`). `criteria` : le nom des critères, ouvert à tous
 * (visiteur compris, sans jeton). `detail` : avec le montant, pour un compte qui a le droit au plafond ; un 401 ou un 403
 * (session expirée, droit absent) retombe sur le niveau `criteria`. `null` : la vente n'est pas (ou plus) une pépite
 * publiable (404), y compris en mode « shadow ».
 */
export async function fetchSalePepite(
  saleId: string,
  view: PepiteView,
): Promise<PepitePayload | null> {
  let headers: HeadersInit = { accept: "application/json" };
  if (view === "detail") {
    try {
      headers = await authHeaders();
    } catch {
      // Pas de session lisible : les critères, sans montant.
      return fetchSalePepite(saleId, "criteria");
    }
  }
  const response = await fetch(`/api/sales/${encodeURIComponent(saleId)}/pepite?view=${view}`, {
    headers,
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status === 404) return null;
  // Le droit manque (403) ou la session a expiré (401) : le niveau « criteria », sans aucun montant.
  if ((response.status === 403 || response.status === 401) && view === "detail") {
    return fetchSalePepite(saleId, "criteria");
  }
  return readJson<PepitePayload>(response);
}
