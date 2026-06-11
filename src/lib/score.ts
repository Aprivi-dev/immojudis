// Shared Immojudis Score semantics — used by the score ring, sale cards and the
// detail page so the band, colour and wording stay consistent everywhere.

export type ScoreBandKey = "strong" | "good" | "fair" | "weak";

export type ScoreBand = {
  key: ScoreBandKey;
  /** Short decision-oriented label shown next to the score. */
  label: string;
  /** CSS custom property (functional signal palette) used for the ring/accents. */
  colorVar: string;
};

export function scoreBand(score: number): ScoreBand {
  if (score >= 80)
    return { key: "strong", label: "Opportunité", colorVar: "var(--signal-opportunity)" };
  if (score >= 60) return { key: "good", label: "Intéressant", colorVar: "var(--signal-verified)" };
  if (score >= 40) return { key: "fair", label: "À surveiller", colorVar: "var(--signal-watch)" };
  return { key: "weak", label: "Risqué", colorVar: "var(--signal-risk)" };
}

/** One-line, decision-oriented recommendation derived from the score band. */
export function scoreRecommendation(score: number): string {
  const band = scoreBand(score).key;
  if (band === "strong") return "Dossier à fort potentiel — à instruire en priorité.";
  if (band === "good") return "Dossier intéressant — à étudier de près.";
  if (band === "fair") return "À surveiller — plusieurs points à lever avant d'enchérir.";
  return "Risque élevé — n'enchérir qu'après vérifications approfondies.";
}

export type ConfidenceLevel = "high" | "medium" | "low";

export function confidenceLevel(confidence: number | null | undefined): ConfidenceLevel | null {
  if (confidence == null) return null;
  if (confidence >= 0.75) return "high";
  if (confidence >= 0.5) return "medium";
  return "low";
}

export function confidenceLabel(confidence: number | null | undefined): string | null {
  const level = confidenceLevel(confidence);
  if (level === "high") return "Confiance élevée";
  if (level === "medium") return "Confiance modérée";
  if (level === "low") return "Confiance faible";
  return null;
}
