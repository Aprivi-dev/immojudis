import { adminRoute } from "@/lib/admin-route-deadline";
import {
  adminLaunchOfferActionSchema,
  getAdminLaunchOffer,
  setAdminLaunchOffer,
} from "@/lib/admin-launch-offer";

// Délai maximal des routes admin : 30 s (voir src/lib/admin-route-deadline.ts).
export const maxDuration = 30;

export const GET = adminRoute(
  {
    scope: "admin.launch-offer.read",
    fallbackMessage: "Offre de lancement indisponible",
    guard: "admin",
  },
  async (_request, { authToken }) => getAdminLaunchOffer(authToken),
);

export const POST = adminRoute(
  {
    scope: "admin.launch-offer.write",
    fallbackMessage: "Offre de lancement non modifiée",
    guard: "admin",
  },
  async (request, { authToken }) => {
    const input = adminLaunchOfferActionSchema.parse(await request.json());
    return setAdminLaunchOffer({ authToken, input });
  },
);
