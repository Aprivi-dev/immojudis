import { apiRequest } from "@/lib/client-api-core";
import type {
  AdminAutoPublicationAction,
  AutoPublicationView,
} from "@/lib/admin-information-agent-auto-publication";

/**
 * Réglage de la publication automatique (administration seulement). Module à part, importé par le seul
 * panneau de l'onglet Réglages : rien n'entre dans `@/lib/client-api`, partagé avec les pages publiques.
 */
export function fetchAdminAutoPublication(): Promise<AutoPublicationView> {
  return apiRequest<AutoPublicationView>("/api/admin/information-agent/auto-publication");
}

/** Changement de mode (arrêt, simulation) ou arrêt d'urgence. */
export function runAdminAutoPublicationActionClient(
  data: AdminAutoPublicationAction,
): Promise<AutoPublicationView> {
  return apiRequest<AutoPublicationView>("/api/admin/information-agent/auto-publication", {
    method: "POST",
    body: data,
  });
}
