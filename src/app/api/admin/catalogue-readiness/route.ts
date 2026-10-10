import { NextResponse } from "next/server";
import { bearerTokenFromRequest } from "@/integrations/supabase/auth-middleware";
import {
  adminCatalogueReadinessActionSchema,
  adminCatalogueReadinessQuerySchema,
  getAdminCatalogueReadinessOverview,
  runAdminCatalogueReadinessAction,
} from "@/lib/admin-catalogue-readiness";
import { adminErrorResponse } from "@/lib/api-route-errors";
import { withAdminDeadline } from "@/lib/admin-route-deadline";

// Délai maximal des routes admin : 30 s (voir src/lib/admin-route-deadline.ts).
export const maxDuration = 30;

async function handleGET(request: Request) {
  try {
    const input = adminCatalogueReadinessQuerySchema.parse(
      Object.fromEntries(new URL(request.url).searchParams.entries()),
    );
    const response = await getAdminCatalogueReadinessOverview(
      bearerTokenFromRequest(request),
      input,
    );
    return NextResponse.json(response, {
      headers: { "cache-control": "private, no-store" },
    });
  } catch (error) {
    return adminErrorResponse(error, { fallbackMessage: "Maturité catalogue indisponible" });
  }
}

async function handlePATCH(request: Request) {
  try {
    const input = adminCatalogueReadinessActionSchema.parse(await request.json());
    const response = await runAdminCatalogueReadinessAction({
      authToken: bearerTokenFromRequest(request),
      input,
    });
    return NextResponse.json(response, {
      headers: { "cache-control": "private, no-store" },
    });
  } catch (error) {
    return adminErrorResponse(error, { fallbackMessage: "Maturité catalogue indisponible" });
  }
}

export const GET = withAdminDeadline(handleGET);
export const PATCH = withAdminDeadline(handlePATCH);
