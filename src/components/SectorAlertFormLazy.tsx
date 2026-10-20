"use client";

import dynamic from "next/dynamic";

/**
 * Le formulaire de création d'une alerte de secteur (droits, zone, consentement), chargé à la
 * demande. Un seul import dynamique, partagé par le bouton des pages publiques (`SectorAlertCta`,
 * pour une personne connectée seulement) et par la page de confirmation (`CreateAlertPage`) : les
 * deux l'importaient chacun à leur façon (un import statique et un dynamique), d'où trois copies du
 * module dans les fichiers du site.
 *
 * Ne pas importer `@/components/SectorAlertForm` ailleurs que d'ici (voir
 * `scripts/check-build-budgets.mjs`).
 */
export const SectorAlertForm = dynamic(
  () => import("@/components/SectorAlertForm").then((module) => module.SectorAlertForm),
  { ssr: false, loading: () => null },
);
