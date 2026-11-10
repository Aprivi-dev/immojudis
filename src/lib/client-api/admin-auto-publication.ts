import { authHeaders, readJson } from "@/lib/client-api-core";
import type {
  AdminAutoPublicationAction,
  AutoPublicationView,
} from "@/lib/admin-information-agent-auto-publication";

/**
 * Réglage de la publication automatique (administration seulement). Module à part, importé par le seul
 * panneau de l'onglet Réglages : rien n'entre dans `@/lib/client-api`, partagé avec les pages publiques.
 */
export async function fetchAdminAutoPublication(): Promise<AutoPublicationView> {
  const response = await fetch("/api/admin/information-agent/auto-publication", {
    signal: AbortSignal.timeout(30_000),
    headers: await authHeaders(),
    cache: "no-store",
  });
  return readJson<AutoPublicationView>(response);
}

/** Changement de mode (arrêt, simulation) ou arrêt d'urgence. */
export async function runAdminAutoPublicationActionClient(
  data: AdminAutoPublicationAction,
): Promise<AutoPublicationView> {
  const response = await fetch("/api/admin/information-agent/auto-publication", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await authHeaders()) },
    body: JSON.stringify(data),
  });
  return readJson<AutoPublicationView>(response);
}
