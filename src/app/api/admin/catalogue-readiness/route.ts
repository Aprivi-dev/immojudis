import { bearerTokenFromRequest } from "@/integrations/supabase/auth-middleware";
import {
  adminCatalogueReadinessActionSchema,
  adminCatalogueReadinessQuerySchema,
  getAdminCatalogueReadinessOverview,
  runAdminCatalogueReadinessAction,
} from "@/lib/admin-catalogue-readiness";
import { adminRoute } from "@/lib/admin-route-deadline";

// Délai maximal des routes admin : 30 s (voir src/lib/admin-route-deadline.ts).
export const maxDuration = 30;

export const GET = adminRoute(
  { scope: "admin.catalogue-readiness.read", fallbackMessage: "Maturité catalogue indisponible" },
  async (request) => {
    const input = adminCatalogueReadinessQuerySchema.parse(
      Object.fromEntries(new URL(request.url).searchParams.entries()),
    );
    return getAdminCatalogueReadinessOverview(bearerTokenFromRequest(request), input);
  },
);

export const PATCH = adminRoute(
  { scope: "admin.catalogue-readiness.write", fallbackMessage: "Maturité catalogue indisponible" },
  async (request) => {
    const authToken = bearerTokenFromRequest(request);
    const input = adminCatalogueReadinessActionSchema.parse(await request.json());
    return runAdminCatalogueReadinessAction({ authToken, input });
  },
);
