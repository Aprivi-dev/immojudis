import { z } from "zod";
import {
  bearerTokenFromRequest,
  requireSupabaseAuthContext,
} from "@/integrations/supabase/auth-middleware";
import { NotFoundError } from "@/lib/api-errors";
import { apiRoute } from "@/lib/api-route";
import { documentReadingTeaser, type DocumentReadingResponse } from "@/lib/document-reading";
import { getDocumentReading } from "@/lib/document-reading.server";
import { saleFeatureDoor } from "@/lib/property-reports";
import { enforceUserRateLimit } from "@/lib/rate-limit";
import { RATE_LIMIT_POLICIES } from "@/lib/rate-limit-policies";
import { DETAIL_VIEW, DISCOVERY_VIEW } from "@/lib/sale-views";

const saleIdSchema = z.string().guid();

/**
 * « Lecture des pièces ». Analyse, or a sale the account unlocked: the points with their
 * verified quotes. Other signed-in accounts: how many points were found, never their content.
 * The sale must be visible to the caller first.
 */
export const GET = apiRoute<{ id: string }>(
  { scope: "document-reading", fallbackMessage: "Lecture des pièces indisponible." },
  async (request, { params }) => {
    const saleId = saleIdSchema.parse(params.id);
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    await enforceUserRateLimit({
      userId: auth.userId,
      bucketKey: "document-reading",
      ...RATE_LIMIT_POLICIES.compute,
    });
    // Analyse, or a Découverte account that unlocked this very sale (« 3 déblocages par mois »).
    const door = await saleFeatureDoor(auth, "property.documentReading", saleId);
    const full = door !== null;
    // The full catalogue view is for the offer; an unlock only needs to know the sale is online.
    const { data: sale, error } = await auth.supabase
      .from(door === "plan" ? DETAIL_VIEW : DISCOVERY_VIEW)
      .select("id")
      .eq("id", saleId)
      .maybeSingle();
    if (error) throw error;
    if (!sale) throw new NotFoundError("Vente introuvable.");

    const reading = await getDocumentReading(saleId);
    const body: DocumentReadingResponse = full ? reading : documentReadingTeaser(reading);
    return body;
  },
);
