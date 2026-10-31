"use client";

import { useEffect } from "react";
import { trackProductEvent } from "@/lib/product-events";

/** Ventes dont le plafond a déjà été compté dans cette page : un seul événement chacune. */
const counted = new Set<string>();

/**
 * Mesure `ceiling_viewed` : le plafond d'enchère de la vente est calculé et affiché à la personne.
 * C'est le vrai usage de la fonction, à la différence de l'estimation servie à l'ouverture de la
 * fiche (`bid_ceiling_calculated`, côté serveur), qui part avant tout calcul. Une fois par vente
 * dans la page ; l'événement ne porte ni l'identifiant de la vente ni celui de la personne (liste
 * fermée de `product-events.ts`). Ne rend rien : monté à côté du bloc de calcul.
 */
export function CeilingViewTracker({ saleId, computed }: { saleId: string; computed: boolean }) {
  useEffect(() => {
    if (!computed || counted.has(saleId)) return;
    counted.add(saleId);
    trackProductEvent("ceiling_viewed");
  }, [computed, saleId]);
  return null;
}
