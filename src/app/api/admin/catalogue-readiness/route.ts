import { NextResponse } from "next/server";
import { bearerTokenFromRequest } from "@/integrations/supabase/auth-middleware";
import {
  adminCatalogueReadinessActionSchema,
  adminCatalogueReadinessQuerySchema,
  getAdminCatalogueReadinessOverview,
  runAdminCatalogueReadinessAction,
} from "@/lib/admin-catalogue-readiness";
import { adminErrorResponse } from "@/lib/api-route-errors";

export async function GET(request: Request) {
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

export async function PATCH(request: Request) {
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
