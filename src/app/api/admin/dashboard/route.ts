import { NextResponse } from "next/server";
import { bearerTokenFromRequest } from "@/integrations/supabase/auth-middleware";
import {
  adminDashboardQuerySchema,
  getAdminDashboard,
  getAdminDashboardSection,
  type AdminDashboardSection,
} from "@/lib/admin.functions";
import { withAdminDeadline } from "@/lib/admin-route-deadline";
import { adminErrorResponse } from "@/lib/api-route-errors";

// Délai maximal des routes admin : 30 s (voir src/lib/admin-route-deadline.ts).
export const maxDuration = 30;

// `runs` est relu toutes les 10 s pendant un run actif : cache navigateur très court. `ai` et
// `counts` lisent de gros volumes et changent lentement.
const CACHE_CONTROL: Record<AdminDashboardSection | "all", string> = {
  runs: "private, max-age=5",
  ai: "private, max-age=60",
  counts: "private, max-age=60",
  all: "private, max-age=30",
};

async function handleGET(request: Request) {
  try {
    // `?section=runs|ai|counts` ne calcule que la section demandée ; sans paramètre, toutes.
    const { section } = adminDashboardQuerySchema.parse(
      Object.fromEntries(new URL(request.url).searchParams.entries()),
    );
    const authToken = bearerTokenFromRequest(request);
    const dashboard = section
      ? await getAdminDashboardSection(authToken, section)
      : await getAdminDashboard(authToken);
    return NextResponse.json(dashboard, {
      headers: {
        "cache-control": CACHE_CONTROL[section ?? "all"],
        vary: "authorization",
      },
    });
  } catch (error) {
    return adminErrorResponse(error, { fallbackStatus: 500 });
  }
}

export const GET = withAdminDeadline(handleGET);
