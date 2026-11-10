import { queryOptions } from "@tanstack/react-query";
import { ADMIN_PAGE_SIZE as PAGE_SIZE } from "@/lib/admin-pagination";
import {
  fetchAdminCatalogueReadiness,
  fetchAdminInformationAgentAutopilot,
  fetchAdminInformationAgentMissions,
  fetchAdminInformationAgentReview,
  fetchAdminInformationAgentUnrouted,
} from "@/lib/client-api";

/**
 * Requêtes partagées entre les panneaux de l'agent et le bandeau de synthèse. Une seule définition
 * par liste : la clé identique fait que le bandeau et le panneau se partagent la même réponse (une
 * seule requête au chargement), et l'invalidation par préfixe les rafraîchit ensemble.
 */
export const CATALOGUE_READINESS_QUERY_KEY = ["admin-catalogue-readiness"] as const;
export const AUTOPILOT_QUERY_KEY = ["admin-information-agent-autopilot"] as const;
export const MISSIONS_QUERY_KEY = ["admin-information-agent-missions"] as const;
export const REVIEW_QUERY_KEY = ["admin-information-agent-review"] as const;
export const UNROUTED_QUERY_KEY = ["admin-information-agent-unrouted"] as const;

export const catalogueReadinessQuery = (offset: number) =>
  queryOptions({
    queryKey: [...CATALOGUE_READINESS_QUERY_KEY, offset],
    queryFn: () => fetchAdminCatalogueReadiness({ offset, limit: PAGE_SIZE }),
    staleTime: 30_000,
  });

export const autopilotQuery = () =>
  queryOptions({
    queryKey: AUTOPILOT_QUERY_KEY,
    queryFn: fetchAdminInformationAgentAutopilot,
    staleTime: 30_000,
  });

export const missionsQuery = (offset: number) =>
  queryOptions({
    queryKey: [...MISSIONS_QUERY_KEY, offset],
    queryFn: () => fetchAdminInformationAgentMissions({ offset, limit: PAGE_SIZE }),
    staleTime: 30_000,
  });

export const reviewQuery = (offset: number) =>
  queryOptions({
    queryKey: [...REVIEW_QUERY_KEY, offset],
    queryFn: () => fetchAdminInformationAgentReview({ offset, limit: PAGE_SIZE }),
    staleTime: 30_000,
  });

export const unroutedQuery = (offset: number) =>
  queryOptions({
    queryKey: [...UNROUTED_QUERY_KEY, offset],
    queryFn: () => fetchAdminInformationAgentUnrouted({ offset, limit: PAGE_SIZE }),
    staleTime: 30_000,
  });
