/**
 * Types, réglages et recherche de scénario de la fiche exemple de l'accueil, sans le moteur
 * d'enchère plafond ni l'annonce exemple : importables côté client. Les données elles-mêmes sont
 * calculées au rendu serveur par `exampleVerdictData` (`src/lib/example-verdict.ts`).
 */

export const EXAMPLE_PROJECTS = ["habiter", "louer", "revendre"] as const;
export const EXAMPLE_OCCUPATIONS = ["libre", "occupe", "loue"] as const;
export const EXAMPLE_WORKS = ["rafraichissement", "confort"] as const;

export type ExampleProject = (typeof EXAMPLE_PROJECTS)[number];
export type ExampleOccupation = (typeof EXAMPLE_OCCUPATIONS)[number];
export type ExampleWorks = (typeof EXAMPLE_WORKS)[number];

export type ExampleScenario = {
  project: ExampleProject;
  occupation: ExampleOccupation;
  works: ExampleWorks;
  ceiling: number;
  /** Travaux et imprévus de chantier. */
  worksTotal: number;
  releaseCost: number;
  releaseMonths: number;
  rentedDiscountPct: number;
  marginPct: number;
  /** « rendement » : c'est le loyer estimé qui fixe la limite (projet locatif). */
  binding: "valeur" | "rendement";
};

export type ExampleVerdictData = {
  title: string;
  /** Première photo de l'annonce exemple (la même sur /annonce-exemple). */
  photo: string;
  city: string;
  surfaceM2: number;
  floor: string | null;
  tribunalName: string;
  hearingInDays: number;
  startingPrice: number;
  value: number;
  valueLow: number;
  valueHigh: number;
  estimateQuality: string | null;
  comparables: number;
  radiusM: number;
  yearsBack: number;
  medianPricePerM2: number;
  sameBuilding: { year: number; month: string; totalPrice: number; surface: number | null } | null;
  startingPricePerM2: number;
  /** Écart de la mise à prix au m² sous la médiane locale, en %. */
  startingGapPct: number;
  occupationPage: number | null;
  condition: string | null;
  dpe: string | null;
  registrationRatePct: number | null;
  scenarios: ExampleScenario[];
};

export function findExampleScenario(
  scenarios: readonly ExampleScenario[],
  project: ExampleProject,
  occupation: ExampleOccupation,
  works: ExampleWorks,
): ExampleScenario | undefined {
  return scenarios.find(
    (scenario) =>
      scenario.project === project &&
      scenario.occupation === occupation &&
      scenario.works === works,
  );
}
