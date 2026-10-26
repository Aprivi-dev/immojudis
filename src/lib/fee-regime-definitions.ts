// Régime de frais : tout ce qui change d'un type de vente à l'autre dans le calcul de l'enchère
// plafond (barème d'émoluments, frais par défaut, consignation, vocabulaire). À ne pas confondre
// avec les profils prudent / équilibré / offensif (`CeilingProfile`), qui sont des choix de
// l'utilisateur et non des règles de la vente.
//
// Module pur, sans import de `sale-procedure` : le moteur (`bid-ceiling-engine`) et le simulateur de
// frais l'importent sans alourdir leur lot. Le lien avec une vente donnée (`feeRegimeForSale`) et
// l'interrupteur par régime sont dans `fee-regime.ts`; le vocabulaire seul, sans les barèmes, dans
// `fee-regime-labels.ts`.
import {
  DEFAULT_PRELIMINARY_FEES,
  DEFAULTS,
  EMOLUMENT_SCALE_DATE,
  EMOLUMENT_SCALE_REFERENCE,
  TRIBUNAL_EMOLUMENT_BRACKETS,
  type EmolumentBracket,
} from "@/lib/profitability";
import { TRIBUNAL_FEE_REGIME_TERMS, type FeeRegimeTerms } from "@/lib/fee-regime-labels";
import type { FeeRegimeKey } from "@/lib/fee-regime-open";

/** Une ligne du calendrier de trésorerie : quand, quoi, et l'explication. */
export type CashStepText = { when: string; label: string; detail: string };

/**
 * Les textes qui dépendent du régime. Ils servent de repli tant qu'un régime ne les redéfinit pas :
 * le régime tribunal reprend mot pour mot les textes écrits jusqu'ici dans le moteur et dans le
 * planificateur.
 */
export type FeeRegimeLabels = FeeRegimeTerms & {
  /** Dernière étape du calcul. */
  ceilingStepLabel: string;
  ceilingStepDetail: string;
  /** Étape « frais de la vente » ; `amount` est l'enchère plafond déjà mise en forme (« 120 000 € »). */
  feesStepLabel: string;
  feesStepDetail: (amount: string) => string;
  /** Début de l'explication de la libération d'un bien occupé. */
  releaseOccupiedIntro: string;
  planner: {
    title: string;
    intro: string;
    /** Étiquette du montant dans l'encadré du résultat. */
    resultEyebrow: string;
    checklistTitle: string;
    ceilingBeforeSaleAdvice: string;
    /** Intitulé du prix dans le simulateur « Si vous l’emportez à… ». */
    priceLabel: string;
    emolumentsLabel: string;
    lawyerLabel: string;
    preliminaryLabel: string;
  };
  cash: {
    /** `detail` : règle du régime ; `documentDetail` : montant lu dans l'annonce. */
    consignation: CashStepText & { documentDetail: string };
    lawyer: CashStepText;
    overbid: CashStepText;
    /** `detail` : montant par défaut ; `documentDetail` : lu dans les pièces ; `enteredDetail` : saisi. */
    preliminary: CashStepText & { documentDetail: string; enteredDetail: string };
    balance: CashStepText;
  };
};

/** Textes du régime tribunal : ceux qui étaient écrits dans le moteur et dans le planificateur. */
export const TRIBUNAL_FEE_REGIME_LABELS: FeeRegimeLabels = {
  ...TRIBUNAL_FEE_REGIME_TERMS,
  ceilingStepLabel: "Enchère plafond",
  ceilingStepDetail:
    "Arrondie aux 500 € inférieurs. Au-delà, l’opération ne respecte plus vos objectifs.",
  feesStepLabel: "Frais de la vente",
  feesStepDetail: (amount) =>
    `Droits d’enregistrement, émoluments de l’avocat poursuivant, frais préalables et honoraires de votre avocat, calculés pour une enchère de ${amount}.`,
  releaseOccupiedIntro:
    "Bien occupé : le jugement d’adjudication vaut titre d’expulsion, mais la procédure prend du temps.",
  planner: {
    title: "Votre enchère plafond",
    intro:
      "Le montant à ne pas dépasser à l’audience, une fois comptés la valeur du bien, votre marge, les travaux, la libération, le portage et tous les frais de la vente.",
    resultEyebrow: "Enchère plafond (simulation)",
    checklistTitle: "À vérifier avant l’audience",
    ceilingBeforeSaleAdvice:
      "Fixez votre plafond avant l’audience et donnez-le à votre avocat : les enchères vont vite.",
    priceLabel: "Prix d’adjudication",
    emolumentsLabel: "Émoluments de l’avocat poursuivant",
    lawyerLabel: "Honoraires de votre avocat",
    preliminaryLabel: "Frais préalables",
  },
  cash: {
    consignation: {
      when: "Avant l’audience",
      label: "Consignation",
      documentDetail:
        "Montant indiqué dans l’annonce, à remettre à votre avocat (chèque de banque ou caution bancaire). Restituée si vous ne l’emportez pas.",
      detail:
        "10 % de la mise à prix, 3 000 € minimum, par chèque de banque ou caution bancaire. Restituée si vous ne l’emportez pas.",
    },
    lawyer: {
      when: "Avant l’audience",
      label: "Honoraires de votre avocat",
      detail:
        "Seul un avocat du barreau du tribunal peut enchérir pour vous. Honoraires libres, à convenir avec lui.",
    },
    overbid: {
      when: "10 jours après",
      label: "Fin du délai de surenchère",
      detail:
        "Pendant 10 jours, n’importe qui peut surenchérir d’au moins 10 %. Votre adjudication n’est définitive qu’ensuite.",
    },
    preliminary: {
      when: "Dans le mois",
      label: "Frais préalables",
      documentDetail:
        "Frais de la procédure de saisie, indiqués dans les pièces, payés en plus du prix.",
      enteredDetail:
        "Frais de la procédure de saisie, montant que vous avez saisi, payés en plus du prix.",
      detail:
        "Frais de la procédure de saisie, payés en plus du prix. Leur montant exact est à lire dans le cahier des conditions de vente.",
    },
    balance: {
      when: "Sous 2 mois",
      label: "Solde du prix et droits",
      detail:
        "Prix moins la consignation, droits d’enregistrement et émoluments. Passé 2 mois, le prix porte intérêt au taux légal, majoré de 5 points deux mois plus tard.",
    },
  },
};

/** Garantie à déposer pour enchérir : part de la mise à prix, avec un minimum. */
export type ConsignationRule = {
  rate: number;
  minimum: number;
  /** Texte de loi, pour les mentions et les tests. */
  reference: string;
};

export type EmolumentScale = {
  reference: string;
  /** Date de relevé du barème (jj/mm/aaaa). */
  date: string;
  brackets: readonly EmolumentBracket[];
};

export type FeeRegime = {
  key: FeeRegimeKey;
  /** À changer avec toute règle du régime (barème, frais par défaut, consignation, textes). */
  version: string;
  emolumentScale: EmolumentScale;
  /** Frais préalables retenus quand l'annonce ne les chiffre pas. */
  defaultPreliminaryFees: number;
  /** Honoraires de l'avocat enchérisseur retenus par défaut (TTC, hors émoluments tarifés). */
  defaultLawyerFees: number;
  /** `null` : le régime n'exige aucune consignation. */
  consignation: ConsignationRule | null;
  labels: FeeRegimeLabels;
};

/** Consignation exigée pour enchérir (art. R322-41 CPCE) : 10 % de la mise à prix, 3 000 € minimum. */
export const TRIBUNAL_CONSIGNATION_RULE: ConsignationRule = {
  rate: 0.1,
  minimum: 3_000,
  reference: "art. R322-41 CPCE",
};

export const TRIBUNAL_FEE_REGIME: FeeRegime = {
  key: "tribunal",
  version: "2026-10-26.1",
  emolumentScale: {
    reference: EMOLUMENT_SCALE_REFERENCE,
    date: EMOLUMENT_SCALE_DATE,
    brackets: TRIBUNAL_EMOLUMENT_BRACKETS,
  },
  defaultPreliminaryFees: DEFAULT_PRELIMINARY_FEES,
  defaultLawyerFees: DEFAULTS.lawyerFees,
  consignation: TRIBUNAL_CONSIGNATION_RULE,
  labels: TRIBUNAL_FEE_REGIME_LABELS,
};

/** Les régimes définis : les autres clés de `FeeRegimeKey` n'ont pas encore de règles. */
export const FEE_REGIMES: Readonly<Partial<Record<FeeRegimeKey, FeeRegime>>> = {
  tribunal: TRIBUNAL_FEE_REGIME,
};

/** Textes du régime d'une hypothèse ; sans régime, ceux du tribunal (comportement d'origine). */
export function labelsOf(source: { regime?: FeeRegime | null }): FeeRegimeLabels {
  return (source.regime ?? TRIBUNAL_FEE_REGIME).labels;
}

/** Règle de consignation du régime d'une hypothèse ; sans régime, celle du tribunal. */
export function consignationRuleOf(source: { regime?: FeeRegime | null }): ConsignationRule | null {
  return source.regime ? source.regime.consignation : TRIBUNAL_CONSIGNATION_RULE;
}
