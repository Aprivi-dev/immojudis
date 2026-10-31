"use client";

import { useEffect } from "react";
import { trackProductEvent } from "@/lib/product-events";

/** Le plafond a déjà été compté dans cette page : un seul événement par chargement de page. */
let counted = false;

/**
 * Mesure `ceiling_viewed` : l'enchère plafond de la vente est calculée et affichée à la personne.
 * C'est le vrai usage de la fonction, à la différence de l'estimation servie à l'ouverture de la
 * fiche (`bid_ceiling_calculated`, côté serveur), qui part avant tout calcul. Une fois par
 * chargement de page (le planificateur peut être remonté en changeant d'onglet) ; l'événement ne
 * porte ni l'identifiant de la vente ni celui de la personne (liste fermée de `product-events.ts`).
 * Ne rend rien : monté par `CeilingPlanner`, le bloc de calcul.
 */
export function CeilingViewTracker({ computed }: { computed: boolean }) {
  useEffect(() => {
    if (!computed || counted) return;
    counted = true;
    trackProductEvent("ceiling_viewed");
  }, [computed]);
  return null;
}
