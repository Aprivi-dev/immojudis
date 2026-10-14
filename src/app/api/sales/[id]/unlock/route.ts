import { NextResponse } from "next/server";
import { z } from "zod";
import {
  bearerTokenFromRequest,
  requireSupabaseAuthContext,
} from "@/integrations/supabase/auth-middleware";
import { apiRouteError } from "@/lib/api-observability";
import { enforceUserRateLimit } from "@/lib/rate-limit";
import { RATE_LIMIT_POLICIES } from "@/lib/rate-limit-policies";
import type { SaleUnlockQuotaReachedResponse } from "@/lib/sale-unlocks";
import { getSaleUnlockStatus, SaleUnlockQuotaError, unlockSale } from "@/lib/sale-unlocks.server";

const saleIdSchema = z.string().uuid();

const PRIVATE_HEADERS = { "cache-control": "private, no-store", vary: "authorization" };

/**
 * « 3 déblocages par mois » (offre Découverte). Où en est le compte ce mois-ci, et cette vente
 * est-elle débloquée ? Lecture seule : rien n'est consommé.
 */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const saleId = saleIdSchema.parse((await context.params).id);
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    await enforceUserRateLimit({
      userId: auth.userId,
      bucketKey: "sale-unlock-status",
      ...RATE_LIMIT_POLICIES.compute,
    });
    const status = await getSaleUnlockStatus(auth, saleId);
    return NextResponse.json({ status }, { headers: PRIVATE_HEADERS });
  } catch (error) {
    return apiRouteError(error, request, "sale-unlock-status", {
      fallbackMessage: "Déblocage indisponible.",
    });
  }
}

/**
 * Débloque cette vente pour le compte connecté : enchère plafond, lecture des pièces, historique,
 * statistiques du tribunal de la vente et pièces officielles, tant qu'elle est en ligne. Le quota
 * du mois de Paris est appliqué par la base, sous verrou par compte. Idempotent : une vente déjà
 * débloquée ne consomme rien. Un compte Analyse n'a rien à débloquer. Aucun appel Stripe.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const saleId = saleIdSchema.parse((await context.params).id);
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    await enforceUserRateLimit({
      userId: auth.userId,
      bucketKey: "sale-unlock",
      ...RATE_LIMIT_POLICIES.compute,
    });
    const result = await unlockSale(auth, saleId);
    return NextResponse.json({ result }, { headers: PRIVATE_HEADERS });
  } catch (error) {
    if (error instanceof SaleUnlockQuotaError) {
      const body: SaleUnlockQuotaReachedResponse = {
        error: "Vous avez utilisé tous vos déblocages de ce mois-ci.",
        code: "unlock_quota_reached",
        status: error.status,
      };
      return NextResponse.json(body, { status: 409, headers: PRIVATE_HEADERS });
    }
    return apiRouteError(error, request, "sale-unlock", {
      fallbackMessage: "Déblocage indisponible.",
    });
  }
}
