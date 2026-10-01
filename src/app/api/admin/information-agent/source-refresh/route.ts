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
    return adminSourceRefreshError(error);
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
    return adminSourceRefreshError(error);
  }
}

function adminSourceRefreshError(error: unknown): Response {
  const message = error instanceof Error ? error.message : "Refresh source indisponible.";
  const status = message.startsWith("Unauthorized")
    ? 401
    : message.startsWith("Forbidden")
      ? 403
      : 400;
  return Response.json({ error: message }, { status });
}
