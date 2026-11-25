"use client";

import Link from "next/link";
import { useSaleUnlockPurchaseOffer } from "@/hooks/use-sale-unlock-purchase-offer";
import { nonBreakingUnits } from "@/lib/non-breaking-units";
import { unlockNextSaleText } from "@/lib/sale-unlocks";

/**
 * Plafond verrouillé d'un visiteur (C12, 08/11) : « choisissez l’offre Analyse » seulement quand la garde
 * d'ouverture du paiement le permet ; sinon (fermée ou encore inconnue), le déblocage gratuit seul. Les prix
 * de la suite sont dits en dessous quand l'achat à l'unité est ouvert. Composant à part pour que la lecture
 * de l'offre ne parte que pour un visiteur.
 */
export function VisitorCeilingSignupAction({ signupHref }: { signupHref: string }) {
  const offer = useSaleUnlockPurchaseOffer();
  const ready = offer.status === "ready" ? offer : null;
  return (
    <>
      <Link href={signupHref}>Créez un compte gratuit</Link>, puis débloquez la vente
      {ready?.analysisOpen ? " ou choisissez l’offre Analyse" : null}
      {ready?.purchase ? (
        // Les prix dès la première visite (25/11/2026), seulement quand l'achat à l'unité est ouvert.
        <span data-testid="visitor-next-sale" className="block">
          {nonBreakingUnits(
            unlockNextSaleText(
              ready.purchase.label,
              ready.analysisOpen ? ready.analysisLabel : null,
            ),
          )}
        </span>
      ) : null}
    </>
  );
}
