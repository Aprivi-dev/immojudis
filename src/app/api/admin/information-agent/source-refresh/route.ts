import {
  bearerTokenFromRequest,
  requireSupabaseAuthContext,
} from "@/integrations/supabase/auth-middleware";
import {
  adminSourceRefreshRequestSchema,
  adminSourceRefreshStatusQuerySchema,
  getAdminSourceRefreshStatus,
  requestAdminSourceRefresh,
} from "@/lib/admin-source-refresh";
import { adminErrorResponse } from "@/lib/api-route-errors";

export async function GET(request: Request) {
  try {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    const input = adminSourceRefreshStatusQuerySchema.parse(
      Object.fromEntries(new URL(request.url).searchParams.entries()),
    );
    const response = await getAdminSourceRefreshStatus({ auth, input });
    return Response.json(response, {
      headers: { "cache-control": "private, no-store" },
    });
  } catch (error) {
    return adminErrorResponse(error, { fallbackMessage: "Refresh source indisponible." });
  }
}

export async function POST(request: Request) {
  try {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    const input = adminSourceRefreshRequestSchema.parse(await request.json());
    const response = await requestAdminSourceRefresh({ auth, input });
    return Response.json(response, {
      status: 202,
      headers: { "cache-control": "private, no-store" },
    });
  } catch (error) {
    return adminErrorResponse(error, { fallbackMessage: "Refresh source indisponible." });
  }
}
