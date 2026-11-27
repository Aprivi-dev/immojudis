import { apiRequest } from "@/lib/client-api-core";
import type {
  AdminAutoPublicationAction,
  AutoPublicationView,
  RecentAutoPublications,
} from "@/lib/admin-information-agent-auto-publication";

/**
 * Réglage et publications de la publication automatique (administration seulement). Module à part, importé par le
 * panneau de l'onglet Réglages et par l'onglet Réponses : rien n'entre dans `@/lib/client-api`, partagé avec les
 * pages publiques.
 */
export function fetchAdminAutoPublication(): Promise<AutoPublicationView> {
  return apiRequest<AutoPublicationView>("/api/admin/information-agent/auto-publication");
}

/** Page suivante de la liste « Publiées automatiquement, 30 derniers jours » (onglet Réponses). */
export function fetchAdminRecentAutoPublications(offset: number): Promise<RecentAutoPublications> {
  return apiRequest<RecentAutoPublications>(
    `/api/admin/information-agent/auto-publication/published?offset=${offset}`,
  );
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
