"use client";

import Link from "next/link";
import { NextSalePrices } from "@/components/sale-detail/NextSalePrices";
import { useAnalysisCheckoutOpen } from "@/hooks/use-analysis-checkout-open";

/**
 * Plafond verrouillé d'un visiteur (C12, 08/11) : « choisissez l’offre Analyse » seulement quand la garde
 * d'ouverture du paiement le permet ; sinon (fermée ou encore inconnue), le déblocage gratuit seul. Les prix
 * de la suite sont dits en dessous quand l'achat à l'unité est ouvert. Composant à part pour que la lecture
 * de l'offre ne parte que pour un visiteur.
 */
export function VisitorCeilingSignupAction({ signupHref }: { signupHref: string }) {
  const checkoutOpen = useAnalysisCheckoutOpen();
  return (
    <>
      <Link href={signupHref}>Créez un compte gratuit</Link>, puis débloquez la vente
      {checkoutOpen === true ? " ou choisissez l’offre Analyse" : null}
      {/* Les prix dès la première visite (25/11/2026), seulement quand l'achat à l'unité est ouvert. */}
      <NextSalePrices testId="visitor-next-sale" />
    </>
  );
}
