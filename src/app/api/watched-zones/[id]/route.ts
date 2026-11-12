import { apiRoute } from "@/lib/api-route";
import { z } from "zod";
import {
  bearerTokenFromRequest,
  requireSupabaseAuthContext,
} from "@/integrations/supabase/auth-middleware";
import { deleteWatchedZone, updateWatchedZone, watchedZoneUpdateSchema } from "@/lib/watched-zones";

const zoneIdSchema = z.string().guid();

export const PATCH = apiRoute<{ id: string }>(
  {
    scope: "api.watched-zones.update",
    fallbackMessage: "Mise à jour de zone impossible",
    emptyBody: { zone: null },
  },
  async (request, { params }) => {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    const zoneId = zoneIdSchema.parse(params.id);
    const input = watchedZoneUpdateSchema.parse(await request.json());
    return updateWatchedZone({ auth, zoneId, input });
  },
);

export const DELETE = apiRoute<{ id: string }>(
  { scope: "api.watched-zones.delete", fallbackMessage: "Suppression de zone impossible" },
  async (request, { params }) => {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    const zoneId = zoneIdSchema.parse(params.id);
    return deleteWatchedZone({ auth, zoneId });
  },
);
