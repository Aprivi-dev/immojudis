import { useCallback, useState } from "react";
import { saleDetailPath } from "@/lib/navigation";

/**
 * Adresse de la fiche d'une vente depuis la liste, avec le retour vers la recherche.
 *
 * Le HTML rendu par le serveur ne porte PAS ce retour (`?from=/sales?page=2&…`) : sur chaque page
 * du catalogue, il multiplierait les adresses de chaque fiche pour les robots, qui explorent alors
 * autant de variantes d'une même page. L'origine s'ajoute côté navigateur, dès que la personne
 * approche le lien (survol, focus clavier, appui du doigt ou de la souris) : avant le clic, le
 * clic droit, le clic du milieu ou « ouvrir dans un nouvel onglet ». Le bouton « Retour » de la
 * fiche reste donc celui d'avant (voir `safeSalesReturnTo` et `SaleDetailPage`).
 */
export function useSaleDetailLink(saleId: string, returnTo: string) {
  const [armed, setArmed] = useState(false);
  const arm = useCallback(() => setArmed(true), []);
  return {
    href: saleDetailPath(saleId, armed ? returnTo : undefined),
    armProps: { onPointerEnter: arm, onPointerDown: arm, onTouchStart: arm, onFocus: arm },
  };
}
