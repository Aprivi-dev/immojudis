"use client";

import Link from "next/link";
import { useLaunchOffer } from "@/hooks/use-launch-offer";
import { LAUNCH_OFFER_SHORT_TEXT } from "@/lib/launch-offer";
import { FREE_ACCESS_LINE } from "@/lib/sale-unlocks";

/**
 * « Gratuit, sans carte bancaire… », ou le résumé d'une ligne de l'offre de lancement quand elle est
 * active, vers /offres. Le texte complet de l'offre (durée, conditions) reste sur l'accueil, dans la
 * carte Découverte de la section des offres.
 */
export function HomeFreeAccessLine({ className }: { className?: string }) {
  const launchOffer = useLaunchOffer().active;
  return (
    <p className={className}>
      <Link href="/offres">{launchOffer ? LAUNCH_OFFER_SHORT_TEXT : FREE_ACCESS_LINE}</Link>
    </p>
  );
}
