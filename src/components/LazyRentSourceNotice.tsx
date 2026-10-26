import dynamic from "next/dynamic";

/**
 * `RentSourceNotice` chargé à la demande : la mention (assez longue) s'affiche dans trois écrans qui ne
 * la montrent pas tous (filtre, alertes enregistrées, hypothèses du plafond). Un seul morceau partagé
 * évite d'en embarquer une copie dans chacun (budget de JavaScript client, voir `check-build-budgets.mjs`).
 */
export const LazyRentSourceNotice = dynamic(() =>
  import("@/components/RentSourceNotice").then((module) => module.RentSourceNotice),
);
