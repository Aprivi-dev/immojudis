import { apiRoute } from "@/lib/api-route";
import {
  bearerTokenFromRequest,
  requireSupabaseAuthContext,
} from "@/integrations/supabase/auth-middleware";
import { createWatchedZone, listWatchedZones, watchedZoneInputSchema } from "@/lib/watched-zones";

export const GET = apiRoute(
  {
    scope: "api.watched-zones.list",
    fallbackMessage: "Zones surveillées indisponibles",
    emptyBody: { zones: [] },
  },
  async (request) => {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    const url = new URL(request.url);
    const includeInactive = url.searchParams.get("includeInactive") === "true";
    return listWatchedZones({ auth, includeInactive });
  },
);

export const POST = apiRoute(
  {
    scope: "api.watched-zones.create",
    fallbackMessage: "Création de zone impossible",
    emptyBody: { zone: null },
  },
  async (request) => {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    const input = watchedZoneInputSchema.parse(await request.json());
    return createWatchedZone({ auth, input });
  },
);
