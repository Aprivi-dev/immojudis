"use client";

import Link from "next/link";
import { useSaleUnlockPurchaseOffer } from "@/hooks/use-sale-unlock-purchase-offer";
import { formatDate } from "@/lib/format";
import { nonBreakingUnits } from "@/lib/non-breaking-units";

/**
 * Le texte de `TrialEndedOfferNote`, une fois l'offre lue : rien tant que l'abonnement ne se
 * souscrit pas vraiment. Le prix de la vente à l'unité n'est cité que si cet achat est ouvert, et
 * comme ce qui vient après le déblocage gratuit : la note ne sait pas si le compte l'a utilisé, et
 * rien ne s'achète à l'unité avant (CGU, article 2 bis). Les montants viennent de l'offre lue,
 * jamais d'ici. Chargé à la demande par `TrialEndedOfferNote`.
 */
export function TrialEndedOfferOpen({ endedAt }: { endedAt: string }) {
  const offer = useSaleUnlockPurchaseOffer();
  if (offer.status !== "ready" || !offer.analysisOpen) return null;
  const unit = offer.purchase
    ? ` Une fois le déblocage de votre compte gratuit utilisé, chaque vente s’ouvre aussi à l’unité pour ${offer.purchase.label}.`
    : "";
  return (
    <p
      role="note"
      data-testid="trial-ended-offer-open"
      className="mb-3 rounded-lg border border-gold/30 bg-gold/10 px-4 py-2 text-sm text-brand-navy"
    >
      {nonBreakingUnits(
        `Votre essai gratuit de l’offre Analyse s’est terminé le ${formatDate(endedAt)}. L’offre est ouverte à la souscription : ${offer.analysisLabel}, sans engagement.${unit}`,
      )}{" "}
      <Link href="/offres#tarifs" className="font-semibold underline underline-offset-4">
        Voir les offres
      </Link>
    </p>
  );
}
