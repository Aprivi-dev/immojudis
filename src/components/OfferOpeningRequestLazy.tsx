"use client";

import dynamic from "next/dynamic";

/**
 * « Me prévenir de l'ouverture », chargé à la demande. La demande (et son questionnaire,
 * `OfferOpeningSurvey`) n'apparaît que quand l'offre est fermée, après la lecture de l'état de
 * l'offre dans le navigateur : l'importer statiquement en recopiait le code (une dizaine de Ko)
 * dans chaque route qui la propose (accueil, /offres, aperçus payants d'une vente). Un seul import
 * dynamique, partagé par les quatre usages, en fait un fichier à part que les routes se partagent.
 *
 * Ne pas importer `@/components/OfferOpeningRequest` ailleurs que d'ici : un import statique
 * ferait recopier le module dans la route qui l'importe (voir `scripts/check-build-budgets.mjs`).
 *
 * La place du bouton est réservée pendant le chargement (même hauteur minimale que le bouton) : il
 * n'arrive pas en poussant ce qui suit.
 */
export const OfferOpeningRequest = dynamic(
  () => import("@/components/OfferOpeningRequest").then((module) => module.OfferOpeningRequest),
  { ssr: false, loading: () => <span aria-hidden className="block min-h-11" /> },
);
