import { apiRoute } from "@/lib/api-route";
import {
  bearerTokenFromRequest,
  requireSupabaseAuthContext,
} from "@/integrations/supabase/auth-middleware";
import {
  deleteFollowedSaleSnapshot,
  listFollowedSaleSnapshots,
  updateFollowedSaleSnapshot,
} from "@/lib/followed-sale-snapshots";
import {
  followedSaleSnapshotDeleteSchema,
  followedSaleSnapshotUpdateSchema,
} from "@/lib/followed-sale-snapshots-shared";

// Après l'audience (point 70) : instantanés des ventes suivies, gardés 6 mois au plus dans l'espace
// du compte. Lecture, suppression et bilan (statut, prix final) par le propriétaire seul (RLS) ;
// l'API ne crée jamais d'instantané.

export const GET = apiRoute(
  {
    scope: "api.favorites.snapshots.list",
    fallbackMessage: "Ventes passées indisponibles",
    emptyBody: { snapshots: [] },
  },
  async (request) => {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    return listFollowedSaleSnapshots({ auth });
  },
);

export const DELETE = apiRoute(
  { scope: "api.favorites.snapshots.remove", fallbackMessage: "Retrait impossible" },
  async (request) => {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    const url = new URL(request.url);
    const { id } = followedSaleSnapshotDeleteSchema.parse({ id: url.searchParams.get("id") });
    return deleteFollowedSaleSnapshot({ auth, id });
  },
);

export const PUT = apiRoute(
  {
    scope: "api.favorites.snapshots.update",
    fallbackMessage: "Enregistrement du bilan impossible",
  },
  async (request) => {
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    const input = followedSaleSnapshotUpdateSchema.parse(await request.json());
    return updateFollowedSaleSnapshot({ auth, input });
  },
);
