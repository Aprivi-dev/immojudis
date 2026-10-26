import type { AcquisitionCostResult } from "@/lib/profitability";
import { excerpt, flattenKeyValues, normalizeText } from "@/lib/analysis-text";
import { asRecordOrNull } from "@/lib/guards";
import { getSaleProcedure } from "@/lib/sale-procedure";
import type { AuctionSale, SaleRisk } from "@/lib/types";

export type AuctionCostSourceAmount = {
  amountEur: number;
  label: string;
  source: string;
};

export type AuctionCostAnalysis = {
  available: boolean;
  status: "costed_with_consignation" | "costed" | "source_signals" | "missing";
  confidence: "high" | "medium" | "low";
  confidenceLabel: string;
  startingPriceEur: number | null;
  estimatedFeesEur: number | null;
  estimatedFeesPct: number | null;
  totalCostAtStartingPriceEur: number | null;
  totalCostAtSimulatedPriceEur: number | null;
  emolumentsTtcEur: number | null;
  registrationDutiesEur: number | null;
  forfaitFraisPoursuiteEur: number | null;
  consignation: AuctionCostSourceAmount | null;
  paymentTerms: string[];
  sourceFeeSignals: string[];
  summary: string;
  nextActions: string[];
  limitations: string[];
};

type TextCandidate = {
  text: string;
  source: string;
};

const COST_KEY =
  /frais|consignation|caution|garantie|cheque|chèque|sequestre|séquestre|paiement|surenchere|surenchère|emolument|émolument|taxe|droit/i;
const PAYMENT_KEY = /paiement|payer|delai|délai|surenchere|surenchère|consignation/i;
const COST_CONTEXT =
  /frais|consignation|caution|garantie|ch[eè]que|s[ée]questre|paiement|surench[eè]re|[ée]molument|taxe|droits?\s+(?:d[’']enregistrement|de\s+mutation)/i;

export function buildAuctionCostAnalysis({
  sale,
  acquisition,
}: {
  sale: AuctionSale;
  acquisition: AcquisitionCostResult;
}): AuctionCostAnalysis {
  const startingPriceEur =
    positiveNumber(sale.starting_price_eur) ?? positiveNumber(acquisition.price);
  const estimatedFeesEur = startingPriceEur ? Math.round(acquisition.acquisitionFeesTotal) : null;
  const totalCostAtSimulatedPriceEur = positiveNumber(acquisition.price)
    ? Math.round(acquisition.totalCost)
    : null;
  const totalCostAtStartingPriceEur =
    acquisition.price === startingPriceEur ? totalCostAtSimulatedPriceEur : null;
  const consignation = findConsignation(sale);
  const paymentTerms = collectPaymentTerms(sale);
  const sourceFeeSignals = collectSourceFeeSignals(sale);
  const status = resolveStatus({ estimatedFeesEur, consignation, sourceFeeSignals, paymentTerms });
  const confidence = resolveConfidence(status);

  return {
    available: status !== "missing",
    status,
    confidence,
    confidenceLabel: confidenceLabel(status),
    startingPriceEur,
    estimatedFeesEur,
    estimatedFeesPct: roundOne(acquisition.acquisitionFeesPct),
    totalCostAtStartingPriceEur,
    totalCostAtSimulatedPriceEur,
    emolumentsTtcEur: startingPriceEur ? Math.round(acquisition.emolumentsTTC) : null,
    registrationDutiesEur: startingPriceEur ? Math.round(acquisition.registrationDuties) : null,
    forfaitFraisPoursuiteEur: startingPriceEur ? Math.round(acquisition.fpt) : null,
    consignation,
    paymentTerms,
    sourceFeeSignals,
    summary: summary({ estimatedFeesEur, totalCostAtSimulatedPriceEur, consignation }),
    nextActions: nextActions({ consignation, paymentTerms, sourceFeeSignals }),
    limitations: limitations(status),
  };
}

function resolveStatus({
  estimatedFeesEur,
  consignation,
  sourceFeeSignals,
  paymentTerms,
}: {
  estimatedFeesEur: number | null;
  consignation: AuctionCostSourceAmount | null;
  sourceFeeSignals: string[];
  paymentTerms: string[];
}): AuctionCostAnalysis["status"] {
  if (estimatedFeesEur != null && consignation) return "costed_with_consignation";
  if (estimatedFeesEur != null) return "costed";
  if (consignation || sourceFeeSignals.length || paymentTerms.length) return "source_signals";
  return "missing";
}

function resolveConfidence(
  status: AuctionCostAnalysis["status"],
): AuctionCostAnalysis["confidence"] {
  if (status === "costed_with_consignation") return "high";
  if (status === "costed") return "medium";
  return "low";
}

function confidenceLabel(status: AuctionCostAnalysis["status"]): string {
  if (status === "costed_with_consignation") {
    return "Simulation frais + consignation source";
  }
  if (status === "costed") return "Simulation des frais";
  if (status === "source_signals") return "Signaux de frais à chiffrer";
  return "Frais non qualifiés";
}

function summary({
  estimatedFeesEur,
  totalCostAtSimulatedPriceEur,
  consignation,
}: {
  estimatedFeesEur: number | null;
  totalCostAtSimulatedPriceEur: number | null;
  consignation: AuctionCostSourceAmount | null;
}): string {
  const parts: string[] = [];
  if (estimatedFeesEur != null) parts.push(`frais simulés ${formatMoney(estimatedFeesEur)}`);
  if (totalCostAtSimulatedPriceEur != null) {
    parts.push(`coût complet au prix simulé ${formatMoney(totalCostAtSimulatedPriceEur)}`);
  }
  if (consignation) parts.push(`consignation repérée ${formatMoney(consignation.amountEur)}`);
  return parts.length ? `${parts.join(" · ")}.` : "Frais et consignation à confirmer.";
}

function nextActions({
  consignation,
  paymentTerms,
  sourceFeeSignals,
}: {
  consignation: AuctionCostSourceAmount | null;
  paymentTerms: string[];
  sourceFeeSignals: string[];
}): string[] {
  const actions = [
    "Relire le cahier des conditions pour confirmer frais taxés, frais préalables et frais particuliers.",
  ];
  if (consignation) {
    actions.push("Vérifier le montant, le bénéficiaire et la forme exacte de la consignation.");
  } else {
    actions.push("Identifier le montant de consignation exigé avant l'audience.");
  }
  if (paymentTerms.length) {
    actions.push("Reporter les délais de paiement et de surenchère dans le dossier de suivi.");
  } else {
    actions.push(
      "Faire confirmer délai de paiement, délai de surenchère et modalités de règlement.",
    );
  }
  if (sourceFeeSignals.length) {
    actions.push(
      "Ajouter les frais spécifiques trouvés dans les sources à la simulation de plafond.",
    );
  }
  return actions.slice(0, 4);
}

function limitations(status: AuctionCostAnalysis["status"]): string[] {
  const items = [
    "La simulation de frais ne remplace pas le décompte exact du cahier des conditions ou du conseil.",
    "Les frais particuliers, frais taxés, travaux et impayés éventuels peuvent modifier le coût complet.",
  ];
  if (status !== "costed_with_consignation") {
    items.unshift(
      "Le montant de consignation ou certains frais source ne sont pas encore confirmés.",
    );
  }
  return items;
}

/**
 * Consignation exigée pour enchérir. On lit d'abord les faits typés (montant vérifié dans la
 * procédure de la vente, puis `deposit_eur` lu par le pipeline dans l'annonce notariale), puis le
 * texte et les blocs de la source : ceux-ci ne donnent un montant que s'il est sans ambiguïté.
 */
export function findConsignation(sale: AuctionSale): AuctionCostSourceAmount | null {
  return structuredConsignation(sale) ?? consignationFromSourceText(sale);
}

function structuredConsignation(sale: AuctionSale): AuctionCostSourceAmount | null {
  const guarantee = getSaleProcedure(sale).procedure?.rules.guarantee;
  // `regulatory_verified` (minimum légal calculé sur la mise à prix) n'est pas un montant lu.
  if (guarantee?.status === "case_verified") {
    const amount = positiveNumber(guarantee.amount_eur);
    if (amount != null) {
      return {
        amountEur: Math.round(amount),
        label: "Consignation",
        source: "Procédure de vente vérifiée",
      };
    }
  }
  const deposit = positiveNumber(saleConditions(sale)?.deposit_eur);
  if (deposit != null) {
    return {
      amountEur: Math.round(deposit),
      label: "Consignation",
      source: "Annonce notariale",
    };
  }
  return null;
}

/**
 * `sale_conditions` lues par le pipeline dans l'annonce notariale. Trois emplacements :
 *  - `sale.sale_conditions` : la projection de la base servie au compte Analyse et au compte qui a
 *    débloqué la vente (`app_private.public_sale_conditions`, liste blanche de champs) : c'est ce
 *    qui donne à un compte qui a débloqué la vente la même consignation qu'au compte Analyse ;
 *  - `raw_payload.source_property_features.sale_conditions` : forme certaine (écrite par le
 *    pipeline), mais `raw_payload` n'est pas exposé au navigateur ni à la vue des ventes débloquées :
 *    cette branche ne sert aujourd'hui que côté serveur ;
 *  - `source_blocks.listing_completeness.source_property_features.sale_conditions` : forme projetée
 *    lue par `property-characteristics.ts`, où chaque fait est un `claim` (`{ state, value }`). Aucune
 *    migration ni code du dépôt n'écrit ce fait : la forme n'est pas vérifiée, on accepte donc le
 *    dictionnaire direct ou un `claim` observé dont la valeur est ce dictionnaire.
 */
function saleConditions(sale: AuctionSale): Record<string, unknown> | null {
  const fromView = asRecordOrNull(sale.sale_conditions);
  if (fromView) return fromView;
  const fromPayload = asRecordOrNull(
    asRecordOrNull(asRecordOrNull(sale.raw_payload)?.source_property_features)?.sale_conditions,
  );
  if (fromPayload) return fromPayload;
  const projected = asRecordOrNull(
    asRecordOrNull(
      asRecordOrNull(sale.source_blocks?.listing_completeness)?.source_property_features,
    )?.sale_conditions,
  );
  if (!projected) return null;
  if (projected.state === undefined) return projected;
  return projected.state === "observed" ? asRecordOrNull(projected.value) : null;
}

function consignationFromSourceText(sale: AuctionSale): AuctionCostSourceAmount | null {
  const amounts = new Map<number, AuctionCostSourceAmount>();
  const add = (amount: number | null, source: string) => {
    if (amount != null) amounts.set(amount, { amountEur: amount, label: "Consignation", source });
  };
  const sources = dedicatedFeeSources(sale);
  for (const item of sources) {
    const key = item.path.split(".").at(-1) ?? "";
    if (/^(?:montant_)?(?:consignation|caution|garantie)(?:_eur|_amount)?$/i.test(key)) {
      add(moneyValue(item.value), item.source);
    }
  }
  const texts = [
    ...sources.map((item) => ({ text: cleanText(item.value), source: item.source })),
    { text: sale.source_description ?? sale.description, source: "Description source" },
  ];
  for (const { text, source } of texts) {
    if (!text) continue;
    // Do not take the first number in a paragraph mentioning a deposit. In
    // particular, a starting price or a percentage is not a deposit amount.
    const pattern =
      /\b(?:consignation|caution|garantie)(?:\s+(?:de|d['’]un|d['’]une|est|fixée|fixe|à|bancaire|irrévocable|montant)){0,6}\s*[:=]?\s*([0-9][0-9\s.,]*?)\s*(?:EUR\b|€|euros?\b)/gi;
    for (const match of text.matchAll(pattern)) add(moneyValue(match[1]), source);
  }
  return amounts.size === 1 ? [...amounts.values()][0] : null;
}

function collectPaymentTerms(sale: AuctionSale): string[] {
  const terms = [
    ...dedicatedFeeSources(sale)
      .filter(
        (item) => PAYMENT_KEY.test(item.path) || PAYMENT_KEY.test(cleanText(item.value) ?? ""),
      )
      .map((item) => formatSignal(item.value, item.source, PAYMENT_KEY)),
    ...collectTextCandidates(sale)
      .filter((candidate) => PAYMENT_KEY.test(candidate.text))
      .map((candidate) => formatSignal(candidate.text, candidate.source, PAYMENT_KEY)),
  ];
  return dedupeStrings(terms).slice(0, 6);
}

function collectSourceFeeSignals(sale: AuctionSale): string[] {
  const signals = [
    ...dedicatedFeeSources(sale)
      .filter((item) => COST_KEY.test(item.path) || COST_CONTEXT.test(cleanText(item.value) ?? ""))
      .map((item) => formatSignal(item.value, item.source)),
    ...collectTextCandidates(sale)
      .filter((candidate) => COST_CONTEXT.test(candidate.text))
      .map((candidate) => formatSignal(candidate.text, candidate.source)),
  ];
  return dedupeStrings(signals).slice(0, 8);
}

function dedicatedFeeSources(sale: AuctionSale) {
  return flattenSaleSources(sale).filter(
    ({ path }) =>
      !/(?:^|\.)(?:page_text|description|titre|titre_detail|related|similar|autres_annonces)(?:$|\.|\[)/i.test(
        path,
      ) &&
      (COST_KEY.test(path) || /conditions|payment_terms/i.test(path)),
  );
}

function flattenSaleSources(
  sale: AuctionSale,
): Array<{ path: string; value: unknown; source: string }> {
  return [
    ...flattenKeyValues(sale.source_blocks ?? {}).map((item) => ({
      ...item,
      source: "Données source",
    })),
    ...Object.entries(sale.source_blocks_by_source ?? {}).flatMap(([sourceName, blocks]) =>
      flattenKeyValues(blocks).map((item) => ({
        ...item,
        source: `Données source ${sourceName}`,
      })),
    ),
  ];
}

function collectTextCandidates(sale: AuctionSale): TextCandidate[] {
  const candidates: TextCandidate[] = [];
  addCandidate(candidates, sale.source_description ?? sale.description, "Description source");

  for (const document of sale.documents_rich ?? []) {
    addCandidate(
      candidates,
      `${document.type ?? ""} ${document.document_type ?? ""} ${document.label ?? ""}`,
      "Pièces du dossier",
    );
  }

  for (const risk of sale.risks ?? []) {
    for (const text of riskTexts(risk)) addCandidate(candidates, text, "Preuves de risques");
  }

  return candidates;
}

function riskTexts(risk: SaleRisk): string[] {
  const texts: unknown[] = [risk.risk_label, risk.evidence];
  const evidence = risk.evidence_json;
  if (evidence && typeof evidence === "object") {
    const record = evidence as Record<string, unknown>;
    texts.push(record.excerpt);
  }
  for (const occurrence of risk.occurrences ?? []) {
    texts.push(occurrence.document_label, occurrence.document_type, occurrence.excerpt);
  }
  return texts.map(cleanText).filter((text): text is string => Boolean(text));
}

function addCandidate(candidates: TextCandidate[], value: unknown, source: string) {
  const text = cleanText(value);
  if (text) candidates.push({ text, source });
}

function moneyValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.round(value);
  const text = cleanText(value);
  if (!text) return null;
  const match = text.match(/^(?:EUR|€)?\s*([0-9][0-9\s.,]*)(?:\s*(?:EUR|€|euros?))?$/i);
  if (!match) return null;
  const compact = match[1].replace(/\s/g, "");
  const normalized = compact.includes(",")
    ? compact.replace(/\./g, "").replace(",", ".")
    : /^\d{1,3}(?:\.\d{3})+$/.test(compact)
      ? compact.replace(/\./g, "")
      : compact;
  const number = Number.parseFloat(normalized);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : null;
}

function positiveNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function roundOne(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value * 10) / 10 : null;
}

function formatSignal(value: unknown, source: string, pattern = COST_CONTEXT): string {
  const text = cleanText(value) ?? "Signal frais";
  const match = pattern.exec(text);
  // Keep the cost clause visible even when the source starts with a long heading.
  const start = Math.max(0, (match?.index ?? 0) - 45);
  const boundary = start ? text.indexOf(" ", start) : 0;
  const offset = boundary >= 0 && boundary < (match?.index ?? 0) ? boundary + 1 : start;
  return `${source} · ${offset ? "… " : ""}${excerpt(text.slice(offset))}`;
}

function dedupeStrings(values: string[]): string[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = normalizeText(value);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function formatMoney(value: number): string {
  return `${new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 0 }).format(value)} €`;
}

function cleanText(value: unknown): string | null {
  if (typeof value === "string" || typeof value === "number") {
    const text = String(value).replace(/\s+/g, " ").trim();
    return text || null;
  }
  if (Array.isArray(value)) {
    const text = value.map(cleanText).filter(Boolean).join(" ");
    return text || null;
  }
  return null;
}
