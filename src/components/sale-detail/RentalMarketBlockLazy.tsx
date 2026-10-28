import dynamic from "next/dynamic";

/**
 * `RentalMarketBlock` chargé à la demande : le bloc (textes, mentions de source, calcul du rendement) n'est pas
 * nécessaire au premier affichage de la fiche, et son module est partagé entre l'aperçu public et la fiche
 * complète (budget de JavaScript client, voir `check-build-budgets.mjs`).
 */
export const RentalMarketBlockLazy = dynamic(() =>
  import("@/components/sale-detail/RentalMarketBlock").then((module) => module.RentalMarketBlock),
);
