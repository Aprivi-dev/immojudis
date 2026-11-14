import { z } from "zod";
import { listEmailHistory } from "@/lib/admin-emails/history";
import { adminRoute } from "@/lib/admin-route-deadline";
import { PublicApiError } from "@/lib/api-errors";

// Délai maximal des routes admin : 30 s (voir src/lib/admin-route-deadline.ts).
export const maxDuration = 30;

const boxSchema = z.enum(["sent", "received"]);

/**
 * Recherche par adresse : le corps JSON, jamais l'URL (les URL finissent dans les journaux de requêtes et
 * l'historique du navigateur).
 */
const searchSchema = z
  .object({
    box: boxSchema,
    address: z.string().max(200).default(""),
    cursor: z.string().max(100).nullish(),
    refresh: z.boolean().default(false),
  })
  .strict();

/**
 * Liste sans adresse : `?box=sent|received`, `&cursor=` (page suivante), `&refresh=1` (relit chez Resend
 * l'état de 20 envois récents au plus). Une adresse dans l'URL est refusée : voir `POST`. Chaque appel est
 * tracé sans adresse.
 */
export const GET = adminRoute(
  {
    scope: "admin.emails.history.read",
    fallbackMessage: "Historique des emails indisponible",
    guard: "admin",
  },
  async (request, { auth }) => {
    const params = new URL(request.url).searchParams;
    if (params.has("address")) {
      throw new PublicApiError("L’adresse se cherche en POST, jamais dans l’URL.", 400);
    }
    return listEmailHistory({
      adminUserId: auth.userId,
      box: boxSchema.parse(params.get("box")),
      cursor: params.get("cursor"),
      address: null,
      refresh: params.get("refresh") === "1",
    });
  },
);

/** Liste avec ou sans adresse, paramètres dans le corps JSON. */
export const POST = adminRoute(
  {
    scope: "admin.emails.history.search",
    fallbackMessage: "Historique des emails indisponible",
    guard: "admin",
  },
  async (request, { auth }) => {
    if (new URL(request.url).search) {
      throw new PublicApiError("Aucun paramètre dans l’URL : tout passe par le corps.", 400);
    }
    const input = searchSchema.parse(await request.json());
    return listEmailHistory({
      adminUserId: auth.userId,
      box: input.box,
      cursor: input.cursor || null,
      address: input.address || null,
      refresh: input.refresh,
    });
  },
);
