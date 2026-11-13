import { apiFetch, readJson } from "@/lib/client-api-core";
import type { PepitePayload } from "@/lib/sale-pepite-view";

export type PepiteView = "criteria" | "detail";

/**
 * Repère « Pépite » d'une vente (`GET /api/sales/[id]/pepite`). `criteria` : le nom des critères, ouvert à tous
 * (visiteur compris, sans jeton). `detail` : avec le montant, pour un compte qui a le droit au plafond ; une session
 * illisible, un 401 ou un 403 (session expirée, droit absent) retombe sur le niveau `criteria`. `null` : la vente
 * n'est pas (ou plus) une pépite publiable (404), y compris en mode « shadow ».
 */
export async function fetchSalePepite(
  saleId: string,
  view: PepiteView,
): Promise<PepitePayload | null> {
  const request = apiFetch(`/api/sales/${encodeURIComponent(saleId)}/pepite?view=${view}`, {
    anonymous: view === "criteria",
  });
  const response = view === "detail" ? await request.catch(() => null) : await request;
  if (response?.status === 404) return null;
  if (!response || (view === "detail" && (response.status === 403 || response.status === 401))) {
    return fetchSalePepite(saleId, "criteria");
  }
  return readJson<PepitePayload>(response);
}
