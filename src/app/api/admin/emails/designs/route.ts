import { getEmailDesigns } from "@/lib/admin-emails/designs";
import { adminRoute } from "@/lib/admin-route-deadline";

// Délai maximal des routes admin : 30 s (voir src/lib/admin-route-deadline.ts).
export const maxDuration = 30;

/** Galerie des aperçus (`?theme=dark` : règles du mode sombre appliquées). Lecture seule. */
export const GET = adminRoute(
  {
    scope: "admin.emails.designs.read",
    fallbackMessage: "Aperçus des emails indisponibles",
    guard: "admin",
  },
  async (request) => {
    const dark = new URL(request.url).searchParams.get("theme") === "dark";
    return getEmailDesigns({ dark });
  },
);
