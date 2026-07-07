import type { AcquisitionCostResult } from "@/lib/profitability";
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
  /frais|consignation|caution|cheque|chèque|sequestre|séquestre|paiement|surenchere|surenchère|emolument|émolument|taxe|droit/i;
const CONSIGNATION_KEY = /consignation|caution|cheque|chèque|sequestre|séquestre|garantie/i;
const PAYMENT_KEY = /paiement|payer|delai|délai|surenchere|surenchère|consignation/i;
const COST_CONTEXT =
  /frais|consignation|caution|ch[eè]que|s[ée]questre|paiement|surench[eè]re|[ée]molument|taxe|droit|adjudication/i;

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
  const totalCostAtStartingPriceEur = startingPriceEur ? Math.round(acquisition.totalCost) : null;
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
    emolumentsTtcEur: startingPriceEur ? Math.round(acquisition.emolumentsTTC) : null,
    registrationDutiesEur: startingPriceEur ? Math.round(acquisition.registrationDuties) : null,
    forfaitFraisPoursuiteEur: startingPriceEur ? Math.round(acquisition.fpt) : null,
    consignation,
    paymentTerms,
    sourceFeeSignals,
    summary: summary({ estimatedFeesEur, totalCostAtStartingPriceEur, consignation }),
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
  if (status === "costed") return "Simulation frais à la mise à prix";
  if (status === "source_signals") return "Signaux de frais à chiffrer";
  return "Frais non qualifiés";
}

function summary({
  estimatedFeesEur,
  totalCostAtStartingPriceEur,
  consignation,
}: {
  estimatedFeesEur: number | null;
  totalCostAtStartingPriceEur: number | null;
  consignation: AuctionCostSourceAmount | null;
}): string {
  const parts: string[] = [];
  if (estimatedFeesEur != null) parts.push(`frais simulés ${formatMoney(estimatedFeesEur)}`);
  if (totalCostAtStartingPriceEur != null) {
    parts.push(`coût complet mise à prix ${formatMoney(totalCostAtStartingPriceEur)}`);
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

function findConsignation(sale: AuctionSale): AuctionCostSourceAmount | null {
  const values = flattenSaleSources(sale);
  for (const item of values) {
    if (!CONSIGNATION_KEY.test(item.path) && !CONSIGNATION_KEY.test(cleanText(item.value) ?? "")) {
      continue;
    }
    const amount = moneyValue(item.value);
    if (amount != null) {
      return {
        amountEur: amount,
        label: "Consignation",
        source: item.source,
      };
    }
  }

  for (const candidate of collectTextCandidates(sale)) {
    if (!CONSIGNATION_KEY.test(candidate.text)) continue;
    const amount = moneyValue(candidate.text);
    if (amount != null) {
      return {
        amountEur: amount,
        label: "Consignation",
        source: candidate.source,
      };
    }
  }

  return null;
}

function collectPaymentTerms(sale: AuctionSale): string[] {
  const terms = [
    ...flattenSaleSources(sale)
      .filter(
        (item) => PAYMENT_KEY.test(item.path) || PAYMENT_KEY.test(cleanText(item.value) ?? ""),
      )
      .map((item) => formatSignal(item.value, item.source)),
    ...collectTextCandidates(sale)
      .filter((candidate) => PAYMENT_KEY.test(candidate.text))
      .map((candidate) => formatSignal(candidate.text, candidate.source)),
  ];
  return dedupeStrings(terms).slice(0, 6);
}

function collectSourceFeeSignals(sale: AuctionSale): string[] {
  const signals = [
    ...flattenSaleSources(sale)
      .filter((item) => COST_KEY.test(item.path) || COST_CONTEXT.test(cleanText(item.value) ?? ""))
      .map((item) => formatSignal(item.value, item.source)),
    ...collectTextCandidates(sale)
      .filter((candidate) => COST_CONTEXT.test(candidate.text))
      .map((candidate) => formatSignal(candidate.text, candidate.source)),
  ];
  return dedupeStrings(signals).slice(0, 8);
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

  addCandidate(candidates, sale.description, "Description annonce");
  addCandidate(candidates, sale.source_description, "Description source");
  addCandidate(candidates, sale.llm_display_description, "Description enrichie");
  addCandidate(candidates, sale.about_description, "Description synthétique");
  addCandidate(candidates, sale.investment_summary, "Synthèse investissement");
  addCandidate(candidates, sale.risk_notes, "Notes de risques");

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

  return candidates.filter((candidate) => COST_CONTEXT.test(candidate.text));
}

function riskTexts(risk: SaleRisk): string[] {
  const texts: unknown[] = [risk.risk_label, risk.evidence];
  const evidence = risk.evidence_json;
  if (evidence && typeof evidence === "object") {
    const record = evidence as Record<string, unknown>;
    texts.push(record.excerpt, record.reasoning, record.why_it_matters, record.next_action);
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

function flattenKeyValues(value: unknown, path = ""): Array<{ path: string; value: unknown }> {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => flattenPrimitiveOrObject(item, `${path}[${index}]`));
  }

  return Object.entries(value as Record<string, unknown>).flatMap(([key, item]) =>
    flattenPrimitiveOrObject(item, path ? `${path}.${key}` : key),
  );
}

function flattenPrimitiveOrObject(
  value: unknown,
  path: string,
): Array<{ path: string; value: unknown }> {
  if (value && typeof value === "object") return flattenKeyValues(value, path);
  return [{ path, value }];
}

function moneyValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.round(value);
  const text = cleanText(value);
  if (!text) return null;
  const match = text.match(/(?:EUR|€)?\s*([0-9][0-9\s.,]{2,})(?:\s*(?:EUR|€))?/i);
  if (!match) return null;
  const normalized = match[1].replace(/\s/g, "").replace(",", ".");
  const number = Number.parseFloat(normalized);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : null;
}

function positiveNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function roundOne(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value * 10) / 10 : null;
}

function formatSignal(value: unknown, source: string): string {
  const text = cleanText(value) ?? "Signal frais";
  return `${source} · ${excerpt(text)}`;
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

function normalizeText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[’']/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function excerpt(value: string): string {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > 180 ? `${text.slice(0, 177).trim()}...` : text;
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
