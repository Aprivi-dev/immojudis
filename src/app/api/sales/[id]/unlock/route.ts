import { NextResponse } from "next/server";
import { z } from "zod";
import {
  bearerTokenFromRequest,
  requireSupabaseAuthContext,
} from "@/integrations/supabase/auth-middleware";
import { recordAccountProductEvent } from "@/lib/account-product-events.server";
import { apiRoute } from "@/lib/api-route";
import { enforceUserRateLimit } from "@/lib/rate-limit";
import { RATE_LIMIT_POLICIES } from "@/lib/rate-limit-policies";
import type { SaleUnlockQuotaReachedResponse } from "@/lib/sale-unlocks";
import { getSaleUnlockStatus, SaleUnlockQuotaError, unlockSale } from "@/lib/sale-unlocks.server";

const saleIdSchema = z.string().guid();

/**
 * « 3 déblocages par mois » (offre Découverte). Où en est le compte ce mois-ci, et cette vente
 * est-elle débloquée ? Lecture seule : rien n'est consommé.
 */
export const GET = apiRoute<{ id: string }>(
  { scope: "sale-unlock-status", fallbackMessage: "Déblocage indisponible." },
  async (request, { params }) => {
    const saleId = saleIdSchema.parse(params.id);
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    await enforceUserRateLimit({
      userId: auth.userId,
      bucketKey: "sale-unlock-status",
      ...RATE_LIMIT_POLICIES.compute,
    });
    const status = await getSaleUnlockStatus(auth, saleId);
    return { status };
  },
);

/**
 * Débloque cette vente pour le compte connecté : enchère plafond, lecture des pièces, historique,
 * statistiques du tribunal de la vente et pièces officielles, tant qu'elle est en ligne. Le quota
 * du mois de Paris est appliqué par la base, sous verrou par compte. Idempotent : une vente déjà
 * débloquée ne consomme rien. Un compte Analyse n'a rien à débloquer. Aucun appel Stripe.
 */
export const POST = apiRoute<{ id: string }>(
  { scope: "sale-unlock", fallbackMessage: "Déblocage indisponible." },
  async (request, { params }) => {
    const saleId = saleIdSchema.parse(params.id);
    const auth = await requireSupabaseAuthContext(bearerTokenFromRequest(request));
    await enforceUserRateLimit({
      userId: auth.userId,
      bucketKey: "sale-unlock",
      ...RATE_LIMIT_POLICIES.compute,
    });
    let result: Awaited<ReturnType<typeof unlockSale>>;
    try {
      result = await unlockSale(auth, saleId);
    } catch (error) {
      if (!(error instanceof SaleUnlockQuotaError)) throw error;
      await recordAccountProductEvent(auth.userId, { type: "quota_reached", quota: "unlocks" });
      // Le client lit `code` et `status` pour afficher le quota du mois : corps propre à ce 409.
      const body: SaleUnlockQuotaReachedResponse = {
        error: "Vous avez utilisé tous vos déblocages de ce mois-ci.",
        code: "unlock_quota_reached",
        status: error.status,
      };
      return NextResponse.json(body, { status: 409 });
    }
    // Mesure par compte : seul un déblocage réellement consommé compte (ni vente déjà débloquée, ni
    // compte Analyse).
    if (result.consumed)
      await recordAccountProductEvent(auth.userId, { type: "sale_unlocked", saleId });
    return { result };
  },
);
