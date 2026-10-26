import { FEE_REGIMES, type FeeRegimeKey } from "@/lib/fee-regime";

/**
 * Vocabulaire des rapports enregistrés (PDF, dossier de financement, page partagée), choisi d'après
 * le régime de frais du plafond (`ceiling_snapshot.regime`). Absent ou inconnu (rapport antérieur
 * aux régimes, vente sans plafond), c'est le vocabulaire du tribunal, celui d'origine : « mise à
 * prix », « enchère », « frais de poursuite ». Une vente notariale par offres n'a ni mise à prix ni
 * enchère : « première offre possible », « offre plafond ».
 */
export type ReportWording = {
  /** « Mise à prix » ou « Première offre possible ». */
  referencePrice: string;
  /** « mise à prix » ou « première offre possible ». */
  referencePriceLower: string;
  /** Intitulé du plafond : « Enchère plafond (simulation) » ou « Offre plafond (simulation) ». */
  ceilingLabel: string;
  /** « Frais adjudication » (tribunal) ou « Frais de la vente » / « Frais de l’opération ». */
  feesHeading: string;
  /** « avant enchère » ou « avant votre offre ». */
  beforeBid: string;
  /** « avant toute enchère » ou « avant toute offre ». */
  beforeAnyBid: string;
  /** « l’enchère plafond » ou « l’offre plafond ». */
  ceilingTermWithArticle: string;
  /** Ce que couvrent les frais estimés par défaut, entre parenthèses du dossier de financement. */
  feesCoverage: string;
  /** Phrase du plafond inférieur au prix de départ. */
  belowStartSentence: string;
};

const capitalize = (value: string) => `${value.charAt(0).toUpperCase()}${value.slice(1)}`;

const NOTARY_FEES_COVERAGE: Partial<Record<FeeRegimeKey, string>> = {
  notary_auction: "émoluments du notaire, droits de mutation, frais d’organisation et de publicité",
  notary_online:
    "émoluments du notaire, droits de mutation, honoraires de négociation et frais de publicité selon l’annonce",
};

export function reportWording(regimeKey: unknown): ReportWording {
  const key = typeof regimeKey === "string" ? (regimeKey as FeeRegimeKey) : null;
  const regime = key ? FEE_REGIMES[key] : undefined;
  const labels = regime?.labels;
  const notarial = regime?.kind === "notarial";
  const byOffers = labels?.byOffers === true;
  const referencePriceLower = labels?.referencePriceTerm ?? "mise à prix";
  return {
    referencePrice: capitalize(referencePriceLower),
    referencePriceLower,
    ceilingLabel: labels?.ceilingSimulationLabel ?? "Enchère plafond (simulation)",
    feesHeading: notarial && labels ? labels.feesStepLabel : "Frais adjudication",
    ceilingTermWithArticle: labels?.ceilingTermWithArticle ?? "l’enchère plafond",
    beforeBid: byOffers ? "avant votre offre" : "avant enchère",
    beforeAnyBid: byOffers ? "avant toute offre" : "avant toute enchère",
    feesCoverage:
      (key ? NOTARY_FEES_COVERAGE[key] : undefined) ??
      "émoluments, droits de mutation, frais de poursuite, honoraires d’avocat",
    belowStartSentence: byOffers
      ? "Plafond inférieur à la première offre possible : ce scénario ne permet pas de faire une offre."
      : "Plafond inférieur à la mise à prix : ce scénario ne permet pas d’enchérir au prix de départ.",
  };
}
