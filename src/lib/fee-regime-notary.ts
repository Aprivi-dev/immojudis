// Régimes de frais des ventes notariales : la vente à la bougie (vente aux enchères volontaire) et
// la vente interactive (par offres). Ils reprennent la structure de `FeeRegime`
// (`fee-regime-definitions.ts`, dont ce module n'importe que les types) avec leurs barèmes, leurs
// frais et leurs textes. Les valeurs viennent du rapport de recherche du 26/10/2026 ; aucun autre
// chiffre n'est inventé : ce qu'aucune source ne donne (débours et formalités du notaire, délais
// de la vente interactive) est écrit « à confirmer » dans les textes.
import {
  NOTARY_AUCTION_FEE_REGIME_TERMS,
  NOTARY_ONLINE_FEE_REGIME_TERMS,
} from "@/lib/fee-regime-labels";
import type { EmolumentBracket } from "@/lib/profitability";
import type { ConsignationRule, FeeRegime, FeeRegimeLabels } from "@/lib/fee-regime-definitions";

// ─── Barèmes des émoluments du notaire ───────────────────────────────────
// Tarif des notaires : taux HT appliqués tranche par tranche au prix, mêmes seuils de tranches que
// le barème de l'avocat poursuivant du tribunal (6 500 €, 17 000 €, 60 000 €). Valeurs relevées sur
// des sources secondaires concordantes (copies du tarif, arrêtés du 25/02/2026 applicables du
// 01/03/2026 au 29/02/2028) dans le rapport de recherche du 26/10/2026 ; À CONFIRMER SUR LÉGIFRANCE
// avant toute évolution. Après le 29/02/2028, le barème est à revérifier.
export const NOTARY_EMOLUMENT_SCALE_REFERENCE =
  "tarif des notaires (arrêtés du 25/02/2026, applicables du 01/03/2026 au 29/02/2028)";
export const NOTARY_EMOLUMENT_SCALE_DATE = "26/10/2026";

/** Barème « adjudication volontaire » : vente à la bougie. 7,74 / 3,192 / 2,129 / 1,597 % HT. */
export const NOTARY_AUCTION_EMOLUMENT_BRACKETS: readonly EmolumentBracket[] = [
  { upTo: 6_500, rate: 0.0774 },
  { upTo: 17_000, rate: 0.03192 },
  { upTo: 60_000, rate: 0.02129 },
  { upTo: Infinity, rate: 0.01597 },
];

/** Barème de gré à gré : vente interactive. 3,870 / 1,596 / 1,064 / 0,799 % HT. */
export const NOTARY_ONLINE_EMOLUMENT_BRACKETS: readonly EmolumentBracket[] = [
  { upTo: 6_500, rate: 0.0387 },
  { upTo: 17_000, rate: 0.01596 },
  { upTo: 60_000, rate: 0.01064 },
  { upTo: Infinity, rate: 0.00799 },
];

/**
 * Frais d'organisation et de publicité d'une vente à la bougie : 2 % HT du prix (TVA en sus). Ils
 * entrent dans la base des droits de mutation (BOFiP).
 */
export const NOTARY_AUCTION_ORGANIZATION_FEE_RATE = 0.02;

/** Garantie à déposer : lue dans l'annonce, sinon 20 % de la mise à prix, montant à confirmer. */
export const NOTARY_AUCTION_CONSIGNATION_RULE: ConsignationRule = {
  rate: 0.2,
  minimum: 0,
  reference: "valeur par défaut (conditions de la vente)",
  estimated: true,
};

/** Surenchère d'une vente à la bougie quand l'annonce la prévoit : au moins 10 %, sous 10 jours. */
export const NOTARY_AUCTION_OVERBID = { minimumIncreasePct: 10, windowDays: 10 } as const;
/** Paiement du prix d'une vente à la bougie : sous 45 jours. */
export const NOTARY_AUCTION_PAYMENT_DAYS = 45;

const OUTSIDE_DISBURSEMENTS = "Hors débours et formalités du notaire.";
const RELEASE_OUTSIDE_COURT =
  "Bien occupé, délai et coût à confirmer : hors vente judiciaire, il n’y a pas de titre d’expulsion automatique.";
/** Mention obligatoire d'une vente interactive. */
export const NOTARY_ONLINE_RESERVE_NOTICE =
  "Le vendeur n’est pas tenu de retenir la meilleure offre ; prix de réserve inconnu.";

export const NOTARY_AUCTION_FEE_REGIME_LABELS: FeeRegimeLabels = {
  ...NOTARY_AUCTION_FEE_REGIME_TERMS,
  referencePriceTerm: "mise à prix",
  bidVerb: "enchérir",
  byOffers: false,
  ceilingStepLabel: "Enchère plafond",
  ceilingStepDetail:
    "Arrondie aux 500 € inférieurs. Au-delà, l’opération ne respecte plus vos objectifs.",
  feesStepLabel: "Frais de la vente",
  feesStepDetail: (amount) =>
    `Droits d’enregistrement, émoluments du notaire, frais d’organisation et de publicité, calculés pour une enchère de ${amount}. ${OUTSIDE_DISBURSEMENTS}`,
  releaseOccupiedIntro: RELEASE_OUTSIDE_COURT,
  marginWhy:
    "l’écart qui justifie d’acheter aux enchères plutôt qu’en agence, et qui absorbe une estimation trop optimiste",
  planner: {
    title: "Votre enchère plafond",
    intro:
      "Le montant à ne pas dépasser à la vente à la bougie, une fois comptés la valeur du bien, votre marge, les travaux, la libération, le portage et les frais de la vente.",
    resultEyebrow: "Enchère plafond (simulation)",
    checklistTitle: "À vérifier avant la vente",
    ceilingBeforeSaleAdvice:
      "Fixez votre plafond avant la vente et tenez-vous-y pendant les enchères.",
    priceLabel: "Prix d’adjudication",
    emolumentsLabel: "Émoluments du notaire",
    lawyerLabel: null,
    preliminaryLabel: null,
    organizationLabel: "Frais d’organisation et de publicité",
    simulatorTitle: "Si vous l’emportez à…",
    simulatorInputLabel: "Montant de l’enchère simulée",
    cashIntro: (amount) =>
      `Pour une adjudication à ${amount}, dans l’ordre où les sommes sont dues.`,
    prepareLabel: "Préparer mon enchère",
    scopeNote: OUTSIDE_DISBURSEMENTS,
    footnote:
      "Aide à la décision calculée avec vos hypothèses : elle ne remplace ni la lecture des conditions de la vente (cahier des charges) ni les conseils du notaire. Aucun prix d’adjudication n’est garanti.",
  },
  cash: {
    consignation: {
      when: "Avant la vente",
      label: "Garantie à déposer",
      documentDetail:
        "Montant indiqué dans l’annonce, à déposer avant les enchères selon les conditions de la vente.",
      detail: "Par défaut 20 % de la mise à prix : montant à lire dans les conditions de la vente.",
    },
    overbid: {
      when: `${NOTARY_AUCTION_OVERBID.windowDays} jours après`,
      label: "Fin du délai de surenchère",
      detail: `Prévue par l’annonce : surenchère d’au moins ${NOTARY_AUCTION_OVERBID.minimumIncreasePct} % dans un délai de ${NOTARY_AUCTION_OVERBID.windowDays} jours. Votre adjudication n’est définitive qu’ensuite.`,
    },
    balance: {
      when: "Sous 45 jours",
      label: "Solde du prix, droits et frais",
      detail: `Prix moins la garantie, droits d’enregistrement, émoluments du notaire, frais d’organisation et de publicité. Paiement du prix sous ${NOTARY_AUCTION_PAYMENT_DAYS} jours : délai à confirmer dans les conditions de la vente. ${OUTSIDE_DISBURSEMENTS}`,
    },
  },
};

export const NOTARY_ONLINE_FEE_REGIME_LABELS: FeeRegimeLabels = {
  ...NOTARY_ONLINE_FEE_REGIME_TERMS,
  referencePriceTerm: "première offre possible",
  bidVerb: "offrir",
  byOffers: true,
  ceilingStepLabel: "Offre plafond",
  ceilingStepDetail: `Arrondie aux 500 € inférieurs. Au-delà, l’opération ne respecte plus vos objectifs. ${NOTARY_ONLINE_RESERVE_NOTICE}`,
  feesStepLabel: "Frais de l’opération",
  feesStepDetail: (amount) =>
    `Droits d’enregistrement, émoluments du notaire, honoraires de négociation si l’acquéreur les paie et frais de publicité, calculés pour une offre de ${amount}. ${OUTSIDE_DISBURSEMENTS}`,
  releaseOccupiedIntro: RELEASE_OUTSIDE_COURT,
  marginWhy:
    "l’écart qui justifie d’acheter par offre plutôt qu’en agence, et qui absorbe une estimation trop optimiste",
  planner: {
    title: "Votre offre plafond",
    intro:
      "Le montant maximum à ne pas dépasser dans une vente par offres, une fois comptés la valeur du bien, votre marge, les travaux, la libération, le portage et les frais.",
    resultEyebrow: "Offre plafond (simulation)",
    checklistTitle: "À vérifier avant votre offre",
    ceilingBeforeSaleAdvice:
      "Fixez votre offre plafond avant de déposer une offre et tenez-vous-y.",
    priceLabel: "Prix de votre offre",
    emolumentsLabel: "Émoluments du notaire",
    lawyerLabel: null,
    preliminaryLabel: null,
    negotiationLabel: "Honoraires de négociation",
    advertisingLabel: "Frais de publicité",
    simulatorTitle: "Si votre offre est retenue à…",
    simulatorInputLabel: "Montant de l’offre simulée",
    cashIntro: (amount) =>
      `Pour une offre retenue à ${amount}, dans l’ordre où les sommes sont dues.`,
    prepareLabel: "Préparer mon offre",
    scopeNote: OUTSIDE_DISBURSEMENTS,
    reserveNotice: NOTARY_ONLINE_RESERVE_NOTICE,
    footnote: `Aide à la décision calculée avec vos hypothèses : elle ne remplace ni la lecture des conditions de la vente ni les conseils du notaire. Aucun prix n’est garanti. ${NOTARY_ONLINE_RESERVE_NOTICE}`,
  },
  cash: {
    offers: {
      when: "Pendant la période d’offres",
      label: "Offre",
      detail: `Aucune garantie indiquée dans l’annonce. ${NOTARY_ONLINE_RESERVE_NOTICE}`,
    },
    precontract: {
      when: "Si votre offre est retenue",
      label: "Avant-contrat",
      detail:
        "Signé avec l’acheteur retenu : sommes à verser, conditions suspensives et délais à confirmer dans les conditions de la vente.",
    },
    balance: {
      when: "À la signature de l’acte",
      label: "Prix, droits et frais",
      detail: `Prix, droits d’enregistrement, émoluments du notaire, honoraires de négociation si l’acquéreur les paie et frais de publicité. ${OUTSIDE_DISBURSEMENTS}`,
    },
  },
};

export const NOTARY_AUCTION_FEE_REGIME: FeeRegime = {
  key: "notary_auction",
  kind: "notarial",
  version: "2026-10-26.1",
  emolumentScale: {
    reference: NOTARY_EMOLUMENT_SCALE_REFERENCE,
    date: NOTARY_EMOLUMENT_SCALE_DATE,
    brackets: NOTARY_AUCTION_EMOLUMENT_BRACKETS,
  },
  defaultPreliminaryFees: 0,
  defaultLawyerFees: 0,
  consignation: NOTARY_AUCTION_CONSIGNATION_RULE,
  organizationFeeRate: NOTARY_AUCTION_ORGANIZATION_FEE_RATE,
  buyerFeesFromListing: false,
  labels: NOTARY_AUCTION_FEE_REGIME_LABELS,
};

export const NOTARY_ONLINE_FEE_REGIME: FeeRegime = {
  key: "notary_online",
  kind: "notarial",
  version: "2026-10-26.1",
  emolumentScale: {
    reference: NOTARY_EMOLUMENT_SCALE_REFERENCE,
    date: NOTARY_EMOLUMENT_SCALE_DATE,
    brackets: NOTARY_ONLINE_EMOLUMENT_BRACKETS,
  },
  defaultPreliminaryFees: 0,
  defaultLawyerFees: 0,
  consignation: null,
  organizationFeeRate: 0,
  buyerFeesFromListing: true,
  labels: NOTARY_ONLINE_FEE_REGIME_LABELS,
};
