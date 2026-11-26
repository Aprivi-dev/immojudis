"use client";

import { useSaleUnlockPurchaseOffer } from "@/hooks/use-sale-unlock-purchase-offer";
import { nonBreakingUnits } from "@/lib/non-breaking-units";
import { unlockNextSaleText } from "@/lib/sale-unlock-purchase-texts";

/**
 * Les prix de la suite, pour une session sans compte lu dans l'écran des comptes : la vente à
 * l'unité, et l'abonnement s'il se souscrit vraiment. Rien tant que l'achat à l'unité n'est pas
 * ouvert ou que l'offre n'est pas lue ; les montants viennent de l'offre lue. La fiche publique dit
 * les mêmes prix sans ce composant : son texte est composé sur le serveur
 * (`publicNextSalePricesText`).
 */
export function NextSalePrices({ testId }: { testId: string }) {
  const offer = useSaleUnlockPurchaseOffer();
  if (offer.status !== "ready" || !offer.purchase) return null;
  const prices = unlockNextSaleText(
    offer.purchase.label,
    offer.analysisOpen ? offer.analysisLabel : null,
  );
  return (
    <span data-testid={testId} className="block w-full">
      {nonBreakingUnits(prices)}
    </span>
  );
}
