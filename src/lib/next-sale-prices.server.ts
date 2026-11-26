import "server-only";
import { analysisCheckoutReadiness } from "@/lib/analysis-checkout-readiness";
import { resolveAnalysisOfferLabel, SALE_UNLOCK_PRICE_LABEL } from "@/lib/analysis-offer";
import { saleUnlockCheckoutReadiness } from "@/lib/sale-unlock-checkout-readiness";
import { unlockNextSaleText } from "@/lib/sale-unlock-purchase-texts";

/**
 * Les prix de la suite, dits sur la fiche publique d'une vente sous « Créer mon compte gratuit » :
 * la vente à l'unité, et l'abonnement s'il se souscrit vraiment. `null` tant que l'achat à l'unité
 * n'est pas ouvert : rien ne propose ce qui ne s'achète pas. Mêmes gardes d'ouverture que
 * `GET /api/billing/offer`. Composé sur le serveur et passé tel quel à la page : la fiche publique
 * n'embarque ni la lecture de l'offre ni ces textes dans son JavaScript (`check-build-budgets.mjs`).
 */
export function publicNextSalePricesText(
  env: Pick<NodeJS.ProcessEnv, string> = process.env,
): string | null {
  if (!saleUnlockCheckoutReadiness(env).open) return null;
  return `Le compte gratuit débloque une vente. ${unlockNextSaleText(
    SALE_UNLOCK_PRICE_LABEL,
    analysisCheckoutReadiness(env).open ? resolveAnalysisOfferLabel() : null,
  )}`;
}
