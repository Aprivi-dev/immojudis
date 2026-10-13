// Enchère plafond par « compte à rebours » : on part de ce que vaudra le bien,
// on retire la marge de sécurité, puis tout ce qu'il faudra payer en plus du
// prix (travaux, libération, portage, frais de la vente). Ce qui reste est la
// mise à ne pas dépasser. Toutes les valeurs sont en euros.
import {
  computeAcquisitionCosts,
  WORKS_SCENARIOS,
  type AcquisitionCostOptions,
  type AcquisitionCostResult,
} from "@/lib/profitability";

export type CeilingProject = "habiter" | "louer" | "revendre";
export type CeilingProfile = "prudent" | "equilibre" | "offensif";
export type OccupationCase = "libre" | "occupe" | "loue" | "squat" | "inconnu";
export type CeilingWorksKey = "aucun" | "rafraichissement" | "confort" | "premium" | "devis";
export type ValueReliability = "forte" | "correcte" | "fragile" | "saisie";

export const CEILING_PROJECTS: ReadonlyArray<{
  key: CeilingProject;
  label: string;
  summary: string;
}> = [
  {
    key: "habiter",
    label: "Habiter",
    summary: "Payer nettement moins qu’un achat classique du même bien.",
  },
  {
    key: "louer",
    label: "Louer",
    summary: "Atteindre un rendement net cible avec le loyer du secteur.",
  },
  {
    key: "revendre",
    label: "Revendre",
    summary: "Revendre après travaux en gardant une marge après tous les frais.",
  },
];

export const CEILING_PROFILES: ReadonlyArray<{ key: CeilingProfile; label: string }> = [
  { key: "prudent", label: "Prudent" },
  { key: "equilibre", label: "Équilibré" },
  { key: "offensif", label: "Offensif" },
];

/** Marge gardée sous la valeur du bien (habiter, louer) ou marge de revente visée (revendre), en %. */
export const PROFILE_MARGIN_PCT: Record<CeilingProject, Record<CeilingProfile, number>> = {
  habiter: { prudent: 15, equilibre: 10, offensif: 5 },
  louer: { prudent: 15, equilibre: 10, offensif: 5 },
  revendre: { prudent: 20, equilibre: 15, offensif: 10 },
};

/** Rendement net visé pour un projet locatif, en % du coût total. */
export const TARGET_NET_YIELD_PCT: Record<CeilingProfile, number> = {
  prudent: 6,
  equilibre: 5,
  offensif: 4,
};

/** Une rénovation remet le bien au niveau des ventes les mieux placées, sans dépasser le quart supérieur. */
const WORKS_VALUE_UPLIFT_PCT: Record<CeilingWorksKey, number> = {
  aucun: 0,
  rafraichissement: 0,
  confort: 5,
  premium: 10,
  devis: 0,
};

export const WORKS_MONTHS: Record<CeilingWorksKey, number> = {
  aucun: 0,
  rafraichissement: 2,
  confort: 4,
  premium: 6,
  devis: 3,
};

export const WORKS_CONTINGENCY_PCT = 10;
/** Consignation exigée pour enchérir (art. R322-41 CPCE) : 10 % de la mise à prix, 3 000 € minimum. */
export const CONSIGNATION_RATE = 0.1;
export const CONSIGNATION_MINIMUM = 3_000;
const BID_STEP = 500;

export type CeilingHypotheses = {
  project: CeilingProject;
  profile: CeilingProfile;
  /** Remplace la marge du profil quand l'utilisateur la fixe lui-même. */
  customMarginPct?: number | null;
  surface: number | null;
  startingPrice: number | null;
  value: {
    /** Valeur du bien dans l'état moyen des ventes du secteur. */
    amount: number | null;
    source: "estimation" | "mediane" | "saisie" | "absente";
    /** Valeur au prix du quart supérieur des ventes : plafond de la plus-value après travaux. */
    upperAmount: number | null;
    reliability: ValueReliability;
    sampleSize: number | null;
    surfaceEstimated: boolean;
  };
  works: { key: CeilingWorksKey; amount: number; contingencyPct: number; months: number };
  occupation: {
    case: OccupationCase;
    releaseMonths: number;
    releaseCost: number;
    rentedDiscountPct: number;
  };
  carrying: {
    monthlyCharges: number;
    annualPropertyTax: number;
    monthlyInsurance: number;
    financingRatePct: number;
    resaleMonths: number;
  };
  fees: Omit<AcquisitionCostOptions, "works"> & { fpt: number; lawyerFees: number };
  feesSource: { fpt: "document" | "defaut"; consignation: "document" | "regle" };
  rent: {
    monthly: number | null;
    source: "saisi" | "estime" | "absent";
    vacancyPct: number;
    nonRecoverablePct: number;
    targetNetYieldPct?: number | null;
  };
  resale: { sellingCostsPct: number };
  consignation: number | null;
};

export type CeilingStep = {
  key: string;
  label: string;
  amount: number;
  kind: "start" | "add" | "minus" | "subtotal" | "result";
  detail: string;
};

export type CeilingPlan = {
  available: boolean;
  reason?: string;
  maxBid: number;
  /** Faux quand frais et travaux dépassent déjà le budget : aucune enchère n'est rentable. */
  reachable: boolean;
  binding: "valeur" | "rendement";
  /** Projet « Louer » sans loyer exploitable : le rendement ne limite pas le plafond. */
  rentMissing: boolean;
  valueAfterWorks: number;
  marginPct: number;
  dataMarginPct: number;
  marginAmount: number;
  rentedDiscount: number;
  sellingCosts: number;
  valueBudget: number;
  yieldBudget: number | null;
  budget: number;
  worksTotal: number;
  worksContingency: number;
  releaseCost: number;
  carryMonths: number;
  carryingFixed: number;
  financingAtMaxBid: number;
  feesAtMaxBid: AcquisitionCostResult;
  steps: CeilingStep[];
  startingPriceGap: number | null;
};

export function marginPctFor(
  h: Pick<CeilingHypotheses, "project" | "profile" | "customMarginPct">,
) {
  return h.customMarginPct != null && Number.isFinite(h.customMarginPct)
    ? clamp(h.customMarginPct, 0, 50)
    : PROFILE_MARGIN_PCT[h.project][h.profile];
}

/** Marge ajoutée quand la valeur repose sur peu de ventes ou sur une surface estimée. */
export function dataMarginPct(value: CeilingHypotheses["value"]): number {
  if (value.source === "saisie") return 0;
  const fragile = value.reliability === "fragile" || (value.sampleSize ?? 99) < 8;
  return (fragile ? 3 : 0) + (value.surfaceEstimated ? 2 : 0);
}

export function occupationNeedsRelease(occupation: OccupationCase): boolean {
  return occupation === "occupe" || occupation === "squat" || occupation === "inconnu";
}

export function computeCeilingPlan(h: CeilingHypotheses): CeilingPlan {
  const surface = positive(h.surface);
  const value = positive(h.value.amount);
  const feeOptions = { ...h.fees, works: 0 };
  if (!surface || !value) {
    return unavailablePlan(
      !surface ? "Surface du bien manquante" : "Valeur de marché à compléter",
      h,
    );
  }

  const uplift = WORKS_VALUE_UPLIFT_PCT[h.works.key] / 100;
  const ceilingValue = Math.max(value, positive(h.value.upperAmount) ?? value);
  const valueAfterWorks = Math.round(Math.min(value * (1 + uplift), ceilingValue));
  const rentedDiscount =
    h.occupation.case === "loue" && h.project !== "louer"
      ? Math.round(valueAfterWorks * (clamp(h.occupation.rentedDiscountPct, 0, 50) / 100))
      : 0;
  const marginPct = marginPctFor(h);
  const extraPct = dataMarginPct(h.value);
  const marginBase = h.project === "revendre" ? valueAfterWorks : valueAfterWorks - rentedDiscount;
  const marginAmount = Math.round(marginBase * ((marginPct + extraPct) / 100));
  const sellingCosts =
    h.project === "revendre"
      ? Math.round(valueAfterWorks * (clamp(h.resale.sellingCostsPct, 0, 15) / 100))
      : 0;
  const valueBudget = valueAfterWorks - rentedDiscount - marginAmount - sellingCosts;

  const worksBase = Math.max(0, Math.round(h.works.amount || 0));
  const worksContingency =
    h.works.key === "aucun" || h.works.key === "devis"
      ? 0
      : Math.round(worksBase * (clamp(h.works.contingencyPct, 0, 50) / 100));
  const worksTotal = worksBase + worksContingency;
  const release = occupationNeedsRelease(h.occupation.case);
  const releaseCost = release ? Math.max(0, Math.round(h.occupation.releaseCost)) : 0;
  const carryMonths =
    (release ? Math.max(0, h.occupation.releaseMonths) : 0) +
    (worksBase > 0 ? Math.max(0, h.works.months) : 0) +
    (h.project === "revendre" ? Math.max(0, h.carrying.resaleMonths) : 0);
  const monthlyCarry =
    Math.max(0, h.carrying.monthlyCharges) +
    Math.max(0, h.carrying.annualPropertyTax) / 12 +
    Math.max(0, h.carrying.monthlyInsurance);
  const carryingFixed = Math.round(carryMonths * monthlyCarry);
  const financingRate = clamp(h.carrying.financingRatePct, 0, 20) / 100;
  const financing = (price: number, fees: number) =>
    Math.round((price + fees + worksTotal) * financingRate * (carryMonths / 12));

  const yieldBudget = h.project === "louer" ? rentalBudget(h) : null;
  const budget = yieldBudget != null ? Math.min(valueBudget, yieldBudget) : valueBudget;
  const binding = yieldBudget != null && yieldBudget < valueBudget ? "rendement" : "valeur";

  const totalAt = (price: number) => {
    const fees = computeAcquisitionCosts({ price, ...feeOptions });
    return (
      price +
      fees.acquisitionFeesTotal +
      worksTotal +
      releaseCost +
      carryingFixed +
      financing(price, fees.acquisitionFeesTotal)
    );
  };
  const maxBid = solveMaxBid(budget, totalAt);
  const reachable = maxBid > 0;
  const feesAtMaxBid = computeAcquisitionCosts({ price: maxBid, ...feeOptions });
  const financingAtMaxBid = financing(maxBid, feesAtMaxBid.acquisitionFeesTotal);

  const plan: CeilingPlan = {
    available: true,
    maxBid,
    reachable,
    binding,
    rentMissing: h.project === "louer" && yieldBudget == null,
    valueAfterWorks,
    marginPct,
    dataMarginPct: extraPct,
    marginAmount,
    rentedDiscount,
    sellingCosts,
    valueBudget: Math.round(valueBudget),
    yieldBudget: yieldBudget == null ? null : Math.round(yieldBudget),
    budget: Math.round(budget),
    worksTotal,
    worksContingency,
    releaseCost,
    carryMonths,
    carryingFixed,
    financingAtMaxBid,
    feesAtMaxBid,
    steps: [],
    startingPriceGap: positive(h.startingPrice) != null ? maxBid - (h.startingPrice ?? 0) : null,
  };
  plan.steps = buildSteps(h, plan, value);
  return plan;
}

/** Coût total maximal compatible avec le rendement net visé. */
function rentalBudget(h: CeilingHypotheses): number | null {
  const rent = positive(h.rent.monthly);
  if (!rent) return null;
  const annualRent = rent * 12;
  const income =
    annualRent * (1 - clamp(h.rent.vacancyPct, 0, 50) / 100) -
    annualRent * (clamp(h.rent.nonRecoverablePct, 0, 50) / 100) -
    Math.max(0, h.carrying.annualPropertyTax) -
    Math.max(0, h.carrying.monthlyInsurance) * 12;
  const target = targetYieldPct(h);
  return income > 0 && target > 0 ? income / (target / 100) : 0;
}

export function targetYieldPct(h: Pick<CeilingHypotheses, "profile" | "rent">): number {
  const custom = h.rent.targetNetYieldPct;
  return custom != null && Number.isFinite(custom) && custom > 0
    ? clamp(custom, 0.5, 20)
    : TARGET_NET_YIELD_PCT[h.profile];
}

function buildSteps(h: CeilingHypotheses, plan: CeilingPlan, value: number): CeilingStep[] {
  const steps: CeilingStep[] = [
    {
      key: "value",
      label: "Valeur estimée du bien",
      amount: value,
      kind: "start",
      detail: valueDetail(h),
    },
  ];
  if (plan.valueAfterWorks > value) {
    steps.push({
      key: "uplift",
      label: "Plus-value après rénovation",
      amount: plan.valueAfterWorks - value,
      kind: "add",
      detail:
        "Une rénovation complète rapproche le bien des ventes les mieux valorisées du secteur. Nous la limitons au prix du quart supérieur des ventes.",
    });
  }
  if (plan.rentedDiscount > 0) {
    steps.push({
      key: "rented",
      label: "Décote du bien loué",
      amount: -plan.rentedDiscount,
      kind: "minus",
      detail: `Un bien vendu avec son locataire se négocie environ ${h.occupation.rentedDiscountPct} % moins cher : vous ne pourrez ni l’habiter ni le revendre libre avant la fin du bail.`,
    });
  }
  const marginLabel = h.project === "revendre" ? "Marge de revente visée" : "Marge de sécurité";
  const marginDetail =
    h.project === "revendre"
      ? `${plan.marginPct} % du prix de revente : c’est votre bénéfice avant impôt si tout se passe comme prévu.`
      : h.project === "habiter"
        ? `${plan.marginPct} % sous la valeur : l’écart qui justifie d’acheter aux enchères plutôt qu’en agence, et qui absorbe une estimation trop optimiste.`
        : `${plan.marginPct} % sous la valeur : votre coussin si l’estimation est trop optimiste.`;
  steps.push({
    key: "margin",
    label: marginLabel,
    amount: -plan.marginAmount,
    kind: "minus",
    detail:
      plan.dataMarginPct > 0
        ? `${marginDetail} Nous ajoutons ${plan.dataMarginPct} point(s) de prudence : ${dataMarginReason(h.value)}.`
        : marginDetail,
  });
  if (plan.sellingCosts > 0) {
    steps.push({
      key: "selling",
      label: "Frais de revente",
      amount: -plan.sellingCosts,
      kind: "minus",
      detail: `${h.resale.sellingCostsPct} % du prix de revente (agence, diagnostics). Mettez 0 si vous vendez sans intermédiaire.`,
    });
  }
  if (plan.binding === "rendement" && plan.yieldBudget != null) {
    steps.push({
      key: "yield",
      label: "Limite fixée par le loyer",
      amount: -(plan.valueBudget - plan.yieldBudget),
      kind: "minus",
      detail: `Avec ${formatEur(h.rent.monthly ?? 0)} de loyer par mois, le coût total ne doit pas dépasser ${formatEur(plan.yieldBudget)} pour un rendement net de ${targetYieldPct(h)} %.`,
    });
  }
  steps.push({
    key: "budget",
    label: "Coût total maximal",
    amount: plan.budget,
    kind: "subtotal",
    detail: "Tout compris : prix, frais de la vente, travaux, libération et portage.",
  });
  if (plan.worksTotal > 0) {
    steps.push({
      key: "works",
      label: worksLabel(h.works.key),
      amount: -(plan.worksTotal - plan.worksContingency),
      kind: "minus",
      detail: worksDetail(h),
    });
  }
  if (plan.worksContingency > 0) {
    steps.push({
      key: "contingency",
      label: `Imprévus de chantier (${h.works.contingencyPct} %)`,
      amount: -plan.worksContingency,
      kind: "minus",
      detail:
        "Une réserve pour les mauvaises surprises : un chantier dépasse presque toujours le budget initial.",
    });
  }
  if (plan.releaseCost > 0) {
    steps.push({
      key: "release",
      label: "Libération du bien",
      amount: -plan.releaseCost,
      kind: "minus",
      detail: releaseDetail(h),
    });
  }
  const carrying = plan.carryingFixed + plan.financingAtMaxBid;
  if (carrying > 0) {
    steps.push({
      key: "carrying",
      label: `Portage pendant ${plan.carryMonths} mois`,
      amount: -carrying,
      kind: "minus",
      detail: carryingDetail(h, plan),
    });
  }
  steps.push({
    key: "fees",
    label: "Frais de la vente",
    amount: -Math.round(plan.feesAtMaxBid.acquisitionFeesTotal),
    kind: "minus",
    detail: `Droits d’enregistrement, émoluments de l’avocat poursuivant, frais préalables et honoraires de votre avocat, calculés pour une enchère de ${formatEur(plan.maxBid)}.`,
  });
  steps.push({
    key: "ceiling",
    label: "Enchère plafond",
    amount: plan.maxBid,
    kind: "result",
    detail: "Arrondie aux 500 € inférieurs. Au-delà, l’opération ne respecte plus vos objectifs.",
  });
  return steps;
}

function valueDetail(h: CeilingHypotheses): string {
  const surface = `${Math.round(h.surface ?? 0)} m²`;
  if (h.value.source === "saisie") return `Prix au m² que vous avez saisi, appliqué à ${surface}.`;
  const sample = h.value.sampleSize ? ` à partir de ${h.value.sampleSize} ventes comparables` : "";
  const reliability = { forte: "solide", correcte: "correcte", fragile: "fragile", saisie: "" }[
    h.value.reliability
  ];
  return `Estimation Immojudis pour ${surface}${sample} (fiabilité ${reliability}). Elle correspond à un bien dans l’état moyen des ventes du secteur.`;
}

function dataMarginReason(value: CeilingHypotheses["value"]): string {
  const reasons = [];
  if (value.reliability === "fragile" || (value.sampleSize ?? 99) < 8)
    reasons.push("peu de ventes comparables");
  if (value.surfaceEstimated) reasons.push("surface estimée");
  return reasons.join(" et ");
}

function worksLabel(key: CeilingWorksKey): string {
  if (key === "devis") return "Travaux (votre montant)";
  const scenario = WORKS_SCENARIOS.find((item) => item.key === key);
  return scenario ? `Travaux : ${scenario.label.toLowerCase()}` : "Travaux";
}

function worksDetail(h: CeilingHypotheses): string {
  if (h.works.key === "devis")
    return "Montant saisi dans l’onglet Travaux (devis ou détail poste par poste).";
  const scenario = WORKS_SCENARIOS.find((item) => item.key === h.works.key);
  return scenario
    ? `${scenario.pricePerM2.toLocaleString("fr-FR")} €/m² × ${Math.round(h.surface ?? 0)} m² : ${scenario.scope}`
    : "";
}

function releaseDetail(h: CeilingHypotheses): string {
  const intro =
    h.occupation.case === "inconnu"
      ? "Occupation non confirmée : par prudence, nous comptons le coût d’une libération."
      : h.occupation.case === "squat"
        ? "Bien occupé sans droit ni titre : il faudra faire constater et libérer les lieux."
        : "Bien occupé : le jugement d’adjudication vaut titre d’expulsion, mais la procédure prend du temps.";
  return `${intro} Frais de commissaire de justice, serrurier et garde-meubles estimés. Le délai (${h.occupation.releaseMonths} mois, trêve hivernale comprise) est compté dans le portage.`;
}

function carryingDetail(h: CeilingHypotheses, plan: CeilingPlan): string {
  const parts = [];
  if (h.carrying.monthlyCharges > 0)
    parts.push(`charges ${formatEur(h.carrying.monthlyCharges)}/mois`);
  if (h.carrying.annualPropertyTax > 0)
    parts.push(`taxe foncière ${formatEur(h.carrying.annualPropertyTax)}/an`);
  if (h.carrying.monthlyInsurance > 0)
    parts.push(`assurance ${formatEur(h.carrying.monthlyInsurance)}/mois`);
  if (plan.financingAtMaxBid > 0)
    parts.push(
      `coût de l’argent ${h.carrying.financingRatePct} %/an (${formatEur(plan.financingAtMaxBid)})`,
    );
  const periods = [];
  if (plan.releaseCost > 0) periods.push("libération");
  if (plan.worksTotal > 0) periods.push("travaux");
  if (h.project === "revendre") periods.push("revente");
  return `Ce que coûte le bien avant ${h.project === "louer" ? "le premier loyer" : h.project === "habiter" ? "d’emménager" : "la revente"} (${periods.join(", ")}) : ${parts.join(", ")}.`;
}

export type BidEvaluation = {
  price: number;
  fees: AcquisitionCostResult;
  financing: number;
  totalCost: number;
  /** Ce qu'il reste sous le coût total maximal (négatif : dépassement). */
  headroom: number;
  netYieldPct: number | null;
  resaleProfit: number | null;
};

/** Ce que coûte réellement une enchère donnée, avec les mêmes hypothèses que le plafond. */
export function evaluateBid(h: CeilingHypotheses, plan: CeilingPlan, price: number): BidEvaluation {
  const cleanPrice = Math.max(0, price || 0);
  const fees = computeAcquisitionCosts({ price: cleanPrice, ...h.fees, works: 0 });
  const financing = Math.round(
    (cleanPrice + fees.acquisitionFeesTotal + plan.worksTotal) *
      (clamp(h.carrying.financingRatePct, 0, 20) / 100) *
      (plan.carryMonths / 12),
  );
  const totalCost = Math.round(
    cleanPrice +
      fees.acquisitionFeesTotal +
      plan.worksTotal +
      plan.releaseCost +
      plan.carryingFixed +
      financing,
  );
  const rent = positive(h.rent.monthly);
  const income = rent
    ? rent * 12 * (1 - h.rent.vacancyPct / 100) -
      rent * 12 * (h.rent.nonRecoverablePct / 100) -
      h.carrying.annualPropertyTax -
      h.carrying.monthlyInsurance * 12
    : null;
  return {
    price: cleanPrice,
    fees,
    financing,
    totalCost,
    headroom: plan.available ? plan.budget - totalCost : 0,
    netYieldPct:
      h.project === "louer" && income != null && totalCost > 0
        ? Math.round((income / totalCost) * 1000) / 10
        : null,
    resaleProfit:
      h.project === "revendre"
        ? Math.round(plan.valueAfterWorks - plan.sellingCosts - totalCost)
        : null,
  };
}

/**
 * Budget travaux maximal si l'on remporte la vente à `price` : ce qui reste sous
 * le coût total maximal une fois le prix, les frais, la libération et
 * le portage payés. Le montant est un devis (sans imprévus ajoutés).
 */
export function maxWorksAtBid(h: CeilingHypotheses, price: number): number {
  const withoutWorks = computeCeilingPlan({ ...h, works: { ...h.works, key: "devis", amount: 0 } });
  if (!withoutWorks.available) return 0;
  const evaluation = evaluateBid(h, withoutWorks, price);
  const months = withoutWorks.carryMonths + Math.max(0, h.works.months || WORKS_MONTHS.devis);
  const monthlyCarry =
    Math.max(0, h.carrying.monthlyCharges) +
    Math.max(0, h.carrying.annualPropertyTax) / 12 +
    Math.max(0, h.carrying.monthlyInsurance);
  const extraCarry = (months - withoutWorks.carryMonths) * monthlyCarry;
  const rate = (clamp(h.carrying.financingRatePct, 0, 20) / 100) * (months / 12);
  const extraFinancing =
    (price + evaluation.fees.acquisitionFeesTotal) * rate - evaluation.financing;
  const room = evaluation.headroom - extraCarry - extraFinancing;
  return Math.max(0, Math.floor(room / (1 + rate) / 100) * 100);
}

export type CashStep = { when: string; label: string; amount: number | null; detail: string };

/** Les sommes à sortir, dans l'ordre où elles sont dues, pour une enchère donnée. */
export function buildCashPlan(h: CeilingHypotheses, plan: CeilingPlan, price: number): CashStep[] {
  const evaluation = evaluateBid(h, plan, price);
  const consignation = consignationAmount(h);
  const fees = evaluation.fees;
  const duties = Math.round(fees.registrationDuties + fees.csi + fees.vatOnPrice);
  const steps: CashStep[] = [
    {
      when: "Avant l’audience",
      label: "Consignation",
      amount: consignation,
      detail:
        h.feesSource.consignation === "document"
          ? "Montant indiqué dans l’annonce, à remettre à votre avocat (chèque de banque ou caution bancaire). Restituée si vous ne l’emportez pas."
          : "10 % de la mise à prix, 3 000 € minimum, par chèque de banque ou caution bancaire. Restituée si vous ne l’emportez pas.",
    },
    {
      when: "Avant l’audience",
      label: "Honoraires de votre avocat",
      amount: Math.round(fees.lawyerFees),
      detail:
        "Seul un avocat du barreau du tribunal peut enchérir pour vous. Honoraires libres, à convenir avec lui.",
    },
    {
      when: "10 jours après",
      label: "Fin du délai de surenchère",
      amount: null,
      detail:
        "Pendant 10 jours, n’importe qui peut surenchérir d’au moins 10 %. Votre adjudication n’est définitive qu’ensuite.",
    },
    {
      when: "Dans le mois",
      label: "Frais préalables",
      amount: Math.round(fees.fpt),
      detail:
        h.feesSource.fpt === "document"
          ? "Frais de la procédure de saisie, indiqués dans les pièces, payés en plus du prix."
          : "Frais de la procédure de saisie, payés en plus du prix. Leur montant exact est annoncé à l’audience : demandez-le à l’avocat poursuivant.",
    },
    {
      when: "Sous 2 mois",
      label: "Solde du prix et droits",
      amount: Math.round(Math.max(0, price - consignation) + duties + fees.emolumentsTTC),
      detail:
        "Prix moins la consignation, droits d’enregistrement et émoluments. Passé 2 mois, le prix porte intérêt au taux légal, majoré de 5 points deux mois plus tard.",
    },
  ];
  if (plan.releaseCost > 0) {
    steps.push({
      when: "Ensuite",
      label: "Libération du bien",
      amount: plan.releaseCost,
      detail: `Procédure d’expulsion et frais annexes, sur environ ${h.occupation.releaseMonths} mois.`,
    });
  }
  if (plan.worksTotal > 0) {
    steps.push({
      when: "Ensuite",
      label: "Travaux et imprévus",
      amount: plan.worksTotal,
      detail: "À engager une fois le bien libre et les clés remises.",
    });
  }
  return steps;
}

export function consignationAmount(h: Pick<CeilingHypotheses, "consignation" | "startingPrice">) {
  const found = positive(h.consignation);
  if (found) return Math.round(found);
  const start = positive(h.startingPrice) ?? 0;
  return Math.max(CONSIGNATION_MINIMUM, Math.round(start * CONSIGNATION_RATE));
}

export type WorksCeiling = {
  key: CeilingWorksKey;
  label: string;
  works: number;
  plan: CeilingPlan;
};

/** Le plafond pour chaque niveau de travaux, toutes autres hypothèses égales. */
export function ceilingsByWorks(h: CeilingHypotheses): WorksCeiling[] {
  const surface = positive(h.surface) ?? 0;
  const options: Array<{ key: CeilingWorksKey; label: string; amount: number }> = [
    { key: "aucun", label: "Sans travaux", amount: 0 },
    ...WORKS_SCENARIOS.map((scenario) => ({
      key: scenario.key as CeilingWorksKey,
      label: scenario.label,
      amount: Math.round(surface * scenario.pricePerM2),
    })),
  ];
  if (h.works.key === "devis") {
    options.push({ key: "devis", label: "Votre montant", amount: Math.round(h.works.amount) });
  }
  return options.map((option) => {
    const plan = computeCeilingPlan({
      ...h,
      works: {
        key: option.key,
        amount: option.amount,
        contingencyPct: h.works.contingencyPct,
        months: option.key === h.works.key ? h.works.months : WORKS_MONTHS[option.key],
      },
    });
    return { key: option.key, label: option.label, works: option.amount, plan };
  });
}

export type CeilingConfidence = {
  score: number;
  label: "Solide" | "À consolider" | "Indicatif";
  gaps: string[];
};

export function ceilingConfidence(h: CeilingHypotheses): CeilingConfidence {
  const gaps: string[] = [];
  let score = 0;
  const fewSales = h.value.source !== "saisie" && (h.value.sampleSize ?? 99) < 8;
  const reliability = fewSales ? "fragile" : h.value.reliability;
  const valuePoints = { forte: 40, correcte: 30, fragile: 15, saisie: 25 }[reliability];
  score += h.value.source === "absente" ? 0 : valuePoints;
  if (reliability === "fragile") gaps.push("peu de ventes comparables autour du bien");
  if (h.value.surfaceEstimated) {
    score += 8;
    gaps.push("surface estimée, à confirmer dans le procès-verbal descriptif");
  } else score += 20;
  if (h.occupation.case === "inconnu") {
    score += 5;
    gaps.push("occupation non confirmée");
  } else score += 20;
  if (h.feesSource.fpt === "document") score += 20;
  else {
    score += 8;
    gaps.push("frais préalables à demander à l’avocat poursuivant");
  }
  const rounded = Math.min(100, Math.round(score));
  return {
    score: rounded,
    label: rounded >= 75 ? "Solide" : rounded >= 50 ? "À consolider" : "Indicatif",
    gaps,
  };
}

function solveMaxBid(budget: number, totalAt: (price: number) => number): number {
  if (budget <= 0 || totalAt(0) >= budget) return 0;
  let low = 0;
  let high = budget;
  for (let index = 0; index < 48; index += 1) {
    const mid = (low + high) / 2;
    if (totalAt(mid) <= budget) low = mid;
    else high = mid;
  }
  return Math.max(0, Math.floor(low / BID_STEP) * BID_STEP);
}

function unavailablePlan(reason: string, h: CeilingHypotheses): CeilingPlan {
  return {
    available: false,
    reason,
    maxBid: 0,
    reachable: false,
    binding: "valeur",
    rentMissing: h.project === "louer" && positive(h.rent.monthly) == null,
    valueAfterWorks: 0,
    marginPct: marginPctFor(h),
    dataMarginPct: 0,
    marginAmount: 0,
    rentedDiscount: 0,
    sellingCosts: 0,
    valueBudget: 0,
    yieldBudget: null,
    budget: 0,
    worksTotal: 0,
    worksContingency: 0,
    releaseCost: 0,
    carryMonths: 0,
    carryingFixed: 0,
    financingAtMaxBid: 0,
    feesAtMaxBid: computeAcquisitionCosts({ price: 0, ...h.fees, works: 0 }),
    steps: [],
    startingPriceGap: null,
  };
}

function positive(value: number | null | undefined): number | null {
  return value != null && Number.isFinite(value) && value > 0 ? value : null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));
}

function formatEur(value: number): string {
  return `${new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 0 }).format(Math.round(value))} €`;
}
