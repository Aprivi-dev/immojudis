import type {
  LandProjectAnalysis,
  LandProjectKind,
  LandProjectParameters,
  LandReport,
  LandRuleEvidence,
  LandRuleTopic,
} from "./land-report-types";

const PROJECT_LABELS: Record<LandProjectKind, string> = {
  extension: "Extension",
  height: "Surélévation",
  construction: "Nouvelle construction",
  division: "Division parcellaire",
  destination: "Changement de destination",
};

const PROJECT_TOPICS: Record<LandProjectKind, LandRuleTopic[]> = {
  extension: ["footprint", "height", "setbacks", "green_space", "access_networks", "appearance"],
  height: ["height", "setbacks", "appearance", "green_space"],
  construction: [
    "destination",
    "footprint",
    "height",
    "setbacks",
    "green_space",
    "parking",
    "access_networks",
    "appearance",
  ],
  division: ["destination", "footprint", "access_networks", "parking", "green_space"],
  destination: ["destination", "parking", "access_networks", "appearance"],
};

type LandReportInput = Pick<LandReport, "planning" | "risks" | "rules">;

/** Returns a cautious starting card for each supported project type. */
export function buildLandProjectAnalyses(report: LandReportInput): LandProjectAnalysis[] {
  return (Object.keys(PROJECT_LABELS) as LandProjectKind[]).map((kind) =>
    analyseLandProject(report, { kind }),
  );
}

/**
 * Connects user-supplied project parameters to extracted rule evidence. This function
 * never returns an authorization or a buildable-area calculation: complete coverage
 * only changes the wording from "information missing" to "conditions to review".
 */
export function analyseLandProject(
  report: LandReportInput,
  parameters: LandProjectParameters,
): LandProjectAnalysis {
  const kind = parameters.kind;
  const title = PROJECT_LABELS[kind];
  const relevantRules = report.rules.rules.filter((rule) =>
    PROJECT_TOPICS[kind].includes(rule.topic),
  );
  const missingInformation = missingProjectInformation(kind, parameters);
  const checks = checksForProject({
    report,
    relevantRules,
    kind,
    completeCoverage: report.rules.completeCoverage,
  });

  if (!report.rules.completeCoverage) {
    missingInformation.push(
      "Couverture du règlement incomplète : vérifier le document et les pièces non extraites avant toute conclusion.",
    );
  }
  if (relevantRules.length === 0) {
    missingInformation.push(
      "Aucune règle de zone exploitable pour ce projet : retrouver l'article applicable dans le règlement officiel.",
    );
  }
  if (report.planning.locationStatus === "unresolved" || report.planning.zones.length === 0) {
    missingInformation.push("Parcelle et zone PLU à confirmer sur le contour cadastral.");
  }

  const dedupedMissing = dedupe(missingInformation);
  const status: LandProjectAnalysis["status"] =
    dedupedMissing.length === 0 ? "conditions_to_review" : "insufficient_information";

  return {
    kind,
    title,
    status,
    summary:
      status === "conditions_to_review"
        ? `${title} : règles documentées à confronter aux conditions du projet et aux autres pièces officielles.`
        : `${title} : informations insuffisantes ; aucune conclusion de droit à construire ou d'autorisation n'est formulée.`,
    rules: relevantRules,
    checks,
    missingInformation: dedupedMissing,
  };
}

function missingProjectInformation(
  kind: LandProjectKind,
  parameters: LandProjectParameters,
): string[] {
  const missing: string[] = [];
  switch (kind) {
    case "extension":
      requireNumber(parameters.addedSurfaceM2, "Surface ajoutée projetée", missing);
      requireNumber(parameters.existingFootprintM2, "Emprise au sol existante", missing);
      requireNumber(parameters.plannedFootprintM2, "Emprise au sol projetée", missing);
      requireText(parameters.intendedUse, "Destination ou sous-destination projetée", missing);
      break;
    case "height":
      requireNumber(parameters.currentHeightM, "Hauteur actuelle", missing);
      requireNumber(parameters.plannedHeightM, "Hauteur projetée", missing);
      requireText(parameters.intendedUse, "Destination ou sous-destination projetée", missing);
      break;
    case "construction":
      requireNumber(parameters.plannedFootprintM2, "Emprise au sol projetée", missing);
      requireText(parameters.intendedUse, "Destination ou sous-destination projetée", missing);
      break;
    case "division":
      missing.push("Nombre, limites, accès et réseaux des lots projetés");
      break;
    case "destination":
      missing.push("Destination juridique actuelle du local");
      requireText(parameters.intendedUse, "Destination ou sous-destination projetée", missing);
      break;
  }
  return missing;
}

function checksForProject({
  report,
  relevantRules,
  kind,
  completeCoverage,
}: {
  report: LandReportInput;
  relevantRules: LandRuleEvidence[];
  kind: LandProjectKind;
  completeCoverage: boolean;
}): string[] {
  const checks = relevantRules.map(
    (rule) =>
      `${rule.title} · ${rule.zoneLabels.join(", ")} · page ${rule.page}${
        rule.article ? ` · ${rule.article}` : ""
      }`,
  );
  if (checks.length === 0) {
    checks.push("Aucune preuve textuelle de zone n'est disponible pour ce type de projet.");
  }
  if (!completeCoverage) {
    checks.push(
      "Couverture partielle : les pages ou annexes non extraites doivent être vérifiées.",
    );
  }
  if (report.planning.zones.length > 0) {
    checks.push(
      `Zone(s) à recouper avec le contour cadastral : ${report.planning.zones
        .map((zone) => zone.label || zone.type)
        .filter(Boolean)
        .join(", ")}.`,
    );
  }
  if (report.risks.findings.length > 0) {
    checks.push(
      "Croiser les règles PLU avec les contraintes de risques et leurs documents réglementaires.",
    );
  }
  checks.push(projectAction(kind));
  checks.push(
    "Une règle extraite décrit le document ; elle ne vaut ni droit disponible ni autorisation.",
  );
  return dedupe(checks);
}

function projectAction(kind: LandProjectKind): string {
  switch (kind) {
    case "extension":
      return "Contrôler l'emprise, les reculs, la hauteur, les espaces libres et les conditions propres à l'existant.";
    case "height":
      return "Contrôler la hauteur, les niveaux, la toiture, les reculs et les règles patrimoniales éventuelles.";
    case "construction":
      return "Contrôler destination, implantation, emprise, hauteur, accès, réseaux, stationnement et aspect extérieur.";
    case "division":
      return "Contrôler les accès, réseaux, lots projetés, prescriptions et formalités de division.";
    case "destination":
      return "Contrôler destination, sous-destination, stationnement, accès, aspect extérieur et changement d'usage éventuel.";
  }
}

function requireNumber(value: number | null | undefined, label: string, missing: string[]): void {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) missing.push(label);
}

function requireText(value: string | null | undefined, label: string, missing: string[]): void {
  if (!value?.trim()) missing.push(label);
}

function dedupe(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
