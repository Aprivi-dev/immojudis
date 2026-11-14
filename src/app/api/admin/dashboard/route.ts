import { NextResponse } from "next/server";
import {
  adminDashboardQuerySchema,
  getAdminDashboard,
  getAdminDashboardSection,
  type AdminDashboardSection,
} from "@/lib/admin.server";
import { adminRoute } from "@/lib/admin-route-deadline";

// Délai maximal des routes admin : 30 s (voir src/lib/admin-route-deadline.ts).
export const maxDuration = 30;

// `runs` est relu toutes les 10 s pendant un run actif : cache navigateur très court. `counts`
// lit de gros volumes et change lentement.
const CACHE_CONTROL: Record<AdminDashboardSection | "all", string> = {
  runs: "private, max-age=5",
  counts: "private, max-age=60",
  all: "private, max-age=30",
};

export const GET = adminRoute(
  {
    scope: "admin.dashboard.read",
    fallbackMessage: "Tableau de bord indisponible",
    guard: "admin",
  },
  async (request, { authToken }) => {
    // `?section=runs|counts` ne calcule que la section demandée ; sans paramètre, toutes.
    const { section } = adminDashboardQuerySchema.parse(
      Object.fromEntries(new URL(request.url).searchParams.entries()),
    );
    const dashboard = section
      ? await getAdminDashboardSection(authToken, section)
      : await getAdminDashboard(authToken);
    return NextResponse.json(dashboard, {
      headers: {
        "cache-control": CACHE_CONTROL[section ?? "all"],
        vary: "authorization",
      },
    });
  },
);
