import { z } from "zod";
import {
  bearerTokenFromRequest,
  requireSupabaseAuthContext,
} from "@/integrations/supabase/auth-middleware";
import { apiRoute } from "@/lib/api-route";
import { documentReadingTeaser, type DocumentReadingResponse } from "@/lib/document-reading";
import { getDocumentReading } from "@/lib/document-reading.server";
import { readSaleThroughDoor, saleFeatureDoor } from "@/lib/entitlements.server";
import { enforceUserRateLimit } from "@/lib/rate-limit";
import { RATE_LIMIT_POLICIES } from "@/lib/rate-limit-policies";

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
    await readSaleThroughDoor(auth, saleId, door, "id");

    const reading = await getDocumentReading(saleId);
    const body: DocumentReadingResponse = full ? reading : documentReadingTeaser(reading);
    return body;
  },
);
