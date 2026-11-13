import { NextResponse } from "next/server";
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
import { adminRoute } from "@/lib/admin-route-deadline";

// Délai maximal des routes admin : 30 s (voir src/lib/admin-route-deadline.ts).
export const maxDuration = 30;

export const GET = adminRoute(
  {
    scope: "admin.information-agent.source-refresh.read",
    fallbackMessage: "Refresh source indisponible.",
  },
  async (request) => {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    const input = adminSourceRefreshStatusQuerySchema.parse(
      Object.fromEntries(new URL(request.url).searchParams.entries()),
    );
    return getAdminSourceRefreshStatus({ auth, input });
  },
);

export const POST = adminRoute(
  {
    scope: "admin.information-agent.source-refresh.request",
    fallbackMessage: "Refresh source indisponible.",
  },
  async (request) => {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    const input = adminSourceRefreshRequestSchema.parse(await request.json());
    return NextResponse.json(await requestAdminSourceRefresh({ auth, input }), { status: 202 });
  },
);
