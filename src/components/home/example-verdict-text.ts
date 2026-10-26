import { formatNumber, formatPrice } from "@/lib/format";
import type {
  ExampleOccupation,
  ExampleProject,
  ExampleScenario,
  ExampleWorks,
} from "@/lib/example-verdict-shared";

/** Libellés des réglages de la fiche exemple de l'accueil (sans le moteur : chargé côté client). */
export const PROJECT_LABEL: Record<ExampleProject, string> = {
  habiter: "Habiter",
  louer: "Louer",
  revendre: "Revendre",
};

export const OCCUPATION_LABEL: Record<ExampleOccupation, string> = {
  libre: "Libre",
  occupe: "Occupé",
  loue: "Loué",
};

export const WORKS_LABEL: Record<ExampleWorks, string> = {
  rafraichissement: "Rafraîchissement",
  confort: "Rénovation confort",
};

/** Ce qui explique le plafond d'un scénario, en une ou deux phrases courtes. */
export function scenarioExplanation(scenario: ExampleScenario): string {
  const parts: string[] = [];
  if (scenario.binding === "rendement") {
    parts.push("Louer : le loyer estimé fixe la limite (rendement).");
  } else if (scenario.project === "revendre") {
    parts.push(
      `Revendre : marge de sécurité de ${formatNumber(scenario.marginPct)} % et frais de revente.`,
    );
  }
  if (scenario.occupation === "occupe") {
    parts.push(
      `Occupé : ${formatPrice(scenario.releaseCost)} et ${formatNumber(scenario.releaseMonths)} mois pour libérer le bien.`,
    );
  } else if (scenario.occupation === "libre") {
    parts.push("Libre : pas de délai de libération.");
  } else if (scenario.project !== "louer") {
    parts.push(`Loué : décote de ${formatNumber(scenario.rentedDiscountPct)} % sur la valeur.`);
  }
  parts.push(
    `${WORKS_LABEL[scenario.works]} : ${formatPrice(scenario.worksTotal)} de travaux avec imprévus.`,
  );
  return parts.join(" ");
}
