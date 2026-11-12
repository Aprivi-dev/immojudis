import { NextResponse } from "next/server";
import { z } from "zod";
import { bearerTokenFromRequest } from "@/integrations/supabase/auth-middleware";
import { withAdminDeadline } from "@/lib/admin-route-deadline";
import { assertAdminAuth } from "@/lib/admin-auth.server";
import { EmailHistoryInputError, listEmailHistory } from "@/lib/admin-emails/history";
import { adminErrorResponse } from "@/lib/api-route-errors";

// Délai maximal des routes admin : 30 s (voir src/lib/admin-route-deadline.ts).
export const maxDuration = 30;

const headers = { "cache-control": "private, no-store" };

/**
 * Recherche par adresse : le corps JSON, jamais l'URL (les URL finissent dans les journaux de requêtes et
 * l'historique du navigateur).
 */
const searchSchema = z
  .object({
    box: z.enum(["sent", "received"]),
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
async function handleGET(request: Request) {
  try {
    const auth = await assertAdminAuth(bearerTokenFromRequest(request));
    const params = new URL(request.url).searchParams;
    if (params.has("address")) {
      throw new EmailHistoryInputError("L’adresse se cherche en POST, jamais dans l’URL.");
    }
    const list = await listEmailHistory({
      adminUserId: auth.userId,
      box: params.get("box") === "received" ? "received" : "sent",
      cursor: params.get("cursor"),
      address: null,
      refresh: params.get("refresh") === "1",
    });
    return NextResponse.json(list, { headers });
  } catch (error) {
    return adminErrorResponse(error);
  }
}

/** Liste avec ou sans adresse, paramètres dans le corps JSON. */
async function handlePOST(request: Request) {
  try {
    const auth = await assertAdminAuth(bearerTokenFromRequest(request));
    if (new URL(request.url).search) {
      throw new EmailHistoryInputError("Aucun paramètre dans l’URL : tout passe par le corps.");
    }
    const parsed = searchSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) throw new EmailHistoryInputError("Recherche invalide.");
    const list = await listEmailHistory({
      adminUserId: auth.userId,
      box: parsed.data.box,
      cursor: parsed.data.cursor || null,
      address: parsed.data.address || null,
      refresh: parsed.data.refresh,
    });
    return NextResponse.json(list, { headers });
  } catch (error) {
    return adminErrorResponse(error);
  }
}

export const GET = withAdminDeadline(handleGET);
export const POST = withAdminDeadline(handlePOST);
