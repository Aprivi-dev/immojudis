import { getAdminCatalogueQuality } from "@/lib/admin-catalogue-quality.server";
import { adminRoute } from "@/lib/admin-route-deadline";

// Délai maximal des routes admin : 30 s (voir src/lib/admin-route-deadline.ts).
export const maxDuration = 30;

/**
 * Contrôles qualité du catalogue : dernier cliché de la sentinelle et alertes `catalogue.quality.*` ouvertes,
 * mis en forme pour le panneau de /admin/quality. Administrateur seulement, jamais mis en cache.
 */
export const GET = adminRoute(
  {
    scope: "admin.catalogue-quality.read",
    fallbackMessage: "Contrôles qualité du catalogue indisponibles",
    guard: "admin",
  },
  async (_request, { authToken }) => getAdminCatalogueQuality(authToken),
);
