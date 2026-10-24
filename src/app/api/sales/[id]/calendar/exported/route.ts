import { NextResponse } from "next/server";
import { z } from "zod";
import {
  bearerTokenFromRequest,
  requireSupabaseAuthContext,
} from "@/integrations/supabase/auth-middleware";
import { recordAccountProductEvent } from "@/lib/account-product-events.server";
import { apiRouteError } from "@/lib/api-observability";
import { enforceUserRateLimit } from "@/lib/rate-limit";
import { RATE_LIMIT_POLICIES } from "@/lib/rate-limit-policies";
import type { SaleCalendarRow } from "@/lib/sale-calendar";
import { createPublicSupabaseClient } from "@/lib/supabase-public.server";

const saleIdSchema = z.string().guid();

/**
 * Vrai quand la vente est publiquement visible ET que son audience est exportable (celle d'un
 * téléchargement `.ics` qui aboutit). Une vente inconnue, masquée, reportée ou sans date sourcée ne
 * donne aucun événement. Une panne de la lecture lève : rien n'est enregistré à l'aveugle.
 */
async function isPubliclyExportable(saleId: string): Promise<boolean> {
  const client = createPublicSupabaseClient();
  if (!client) throw new Error("Base de données non configurée.");
  const { data, error } = await client.rpc("get_public_sale_calendar_event", {
    p_sale_id: saleId.toLowerCase(),
  });
  if (error) throw error;
  const row = (Array.isArray(data) ? data[0] : data) as SaleCalendarRow | null | undefined;
  return row?.exportable === true;
}

/**
 * Mesure par compte de « Ajouter à mon agenda » (point 65). Le fichier `.ics` lui-même
 * (`../route.ts`) est public, mis en cache par le CDN et ne connaît aucun compte : le navigateur
 * d'une personne connectée signale ici, après un téléchargement réussi, qu'il a eu lieu. Un visiteur
 * sans compte n'appelle pas cette route, et sans jeton valide elle répond 401 sans rien enregistrer.
 * L'événement ne porte que le compte, la vente et l'heure ; il est conservé 90 jours.
 *
 * Deux garde-fous contre une écriture en masse par un compte (jusqu'à 43 000 lignes par jour avant) :
 * l'événement n'est enregistré que pour une vente que le fichier `.ics` peut réellement exporter,
 * lue avec la clé anonyme par la même fonction publique (`get_public_sale_calendar_event` : vente
 * publiquement visible, audience au tribunal à date sourcée) ; et la base plafonne à 50 exports par
 * compte et par jour (`record_account_product_event`, migration 20261029100300).
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const saleId = saleIdSchema.parse((await context.params).id);
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    await enforceUserRateLimit({
      userId: auth.userId,
      bucketKey: "sale-calendar-exported",
      ...RATE_LIMIT_POLICIES.compute,
    });
    if (!(await isPubliclyExportable(saleId))) {
      return NextResponse.json(
        { recorded: false },
        { headers: { "cache-control": "private, no-store" } },
      );
    }
    const recorded = await recordAccountProductEvent(auth.userId, {
      type: "calendar_exported",
      saleId,
    });
    return NextResponse.json({ recorded }, { headers: { "cache-control": "private, no-store" } });
  } catch (error) {
    return apiRouteError(error, request, "sale-calendar-exported", {
      fallbackMessage: "Mesure indisponible.",
    });
  }
}
